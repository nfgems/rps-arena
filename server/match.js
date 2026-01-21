/**
 * Match management for RPS Arena
 * Game loop, state management, and match lifecycle
 */

const db = require('./database');
const physics = require('./physics');
const protocol = require('./protocol');
const logger = require('./logger');
const payments = require('./payments');
const lobby = require('./lobby');
const session = require('./session');
const { sendAlert, AlertType } = require('./alerts');
const config = require('./config');

// Debug mode - set to true for verbose logging during development
const DEBUG_MATCH = process.env.DEBUG_MATCH === 'true' || false;

// Active matches (in-memory for real-time game state)
const activeMatches = new Map();

// Track consecutive tick errors per match for recovery decisions
const matchTickErrors = new Map();

// Health monitor interval reference
let healthMonitorInterval = null;

// How often to check game loop health (ms)
const HEALTH_CHECK_INTERVAL = 2000; // 2 seconds (reduced from 5s for faster stall detection)

// Maximum time since last tick before considering game loop stalled (ms)
const MAX_TICK_STALENESS = 2000; // 2 seconds (60 ticks at 30Hz)

// Reconnection grace period (seconds) - how long a disconnected player can reconnect before elimination
const RECONNECT_GRACE_PERIOD = parseInt(process.env.RECONNECT_GRACE_PERIOD || '30', 10);

// Showdown mode constants
const SHOWDOWN_FREEZE_DURATION = 3000; // 3 seconds freeze when showdown starts (shows "SHOWDOWN" text)
const SHOWDOWN_HEARTS_TO_WIN = 2; // First player to capture this many hearts wins

// ============================================
// State Persistence (Crash Recovery)
// ============================================

// State schema version - increment when state format changes
const CURRENT_STATE_VERSION = 1;

// Versions compatible with current code (allows forward-compatible migrations)
const COMPATIBLE_STATE_VERSIONS = [1];

// Save state every N ticks (5 ticks at 30Hz = ~167ms between saves)
const PERSISTENCE_INTERVAL = 5;

// Maximum age of saved state before considering it unrecoverable (5 minutes)
const MAX_STATE_AGE_MS = 5 * 60 * 1000;

/**
 * Save current match state to database for crash recovery
 * Non-blocking: errors are logged but don't affect game loop
 * @param {Object} match - Match object
 */
function persistMatchState(match) {
  const state = {
    lobbyId: match.lobbyId,
    countdownRemaining: match.countdownRemaining || 0,
    snapshotCounter: match.snapshotCounter || 0,
    players: match.players.map(p => ({
      id: p.id,
      walletAddress: p.walletAddress,
      username: p.username,
      role: p.role,
      x: p.x,
      y: p.y,
      targetX: p.targetX,
      targetY: p.targetY,
      alive: p.alive,
      frozen: p.frozen,
      connected: p.connected,
      disconnectedAt: p.disconnectedAt || null, // HIGH-1: Persist grace period timestamp
      lastInputSequence: p.lastInputSequence,
    })),
  };

  const result = db.saveMatchState(
    match.id,
    match.tick,
    match.status,
    state,
    CURRENT_STATE_VERSION
  );

  if (!result) {
    console.warn(`[STATE] Failed to save state for match ${match.id} at tick ${match.tick}`);
  }
}

/**
 * Check if a saved state version is compatible with current code
 * @param {number} version - State version to check
 * @returns {boolean}
 */
function isStateVersionCompatible(version) {
  return COMPATIBLE_STATE_VERSIONS.includes(version);
}

/**
 * Check if a saved state is too old to resume
 * @param {string} updatedAt - ISO timestamp of last update
 * @returns {boolean}
 */
function isStateTooOld(updatedAt) {
  const stateAge = Date.now() - new Date(updatedAt).getTime();
  return stateAge > MAX_STATE_AGE_MS;
}

/**
 * Void a match during crash recovery and refund all players
 * IMPORTANT: Checks on-chain state to prevent double-spend if payout was sent but DB not updated
 *
 * @param {string} matchId - Match UUID
 * @param {number} lobbyId - Lobby ID
 * @param {Object} state - Saved state with player info
 * @param {string} reason - Reason for voiding
 * @param {string} matchStartTime - When the match started (ISO timestamp) for filtering old payouts
 */
async function voidAndRefundFromRecovery(matchId, lobbyId, state, reason, matchStartTime = null) {
  // CRITICAL: Check on-chain if a payout was already sent from this lobby wallet
  // This prevents double-spend if server crashed after payout but before DB update
  const lobbyData = lobby.getLobby(lobbyId);
  if (lobbyData && lobbyData.deposit_address) {
    // Pass matchStartTime to filter out payouts from previous matches in same lobby
    const onChainCheck = await payments.checkRecentPayoutFromLobby(lobbyData.deposit_address, matchStartTime);

    if (onChainCheck.payoutDetected) {
      // Payout was already sent! Do NOT refund - just mark match as finished
      console.log(`[RECOVERY] PAYOUT ALREADY DETECTED on-chain for match ${matchId}. Skipping refund to prevent double-spend.`);

      // Try to find the winner from the payout transfer
      const winnerPayoutUsdc = payments.WINNER_PAYOUT / 10 ** payments.USDC_DECIMALS;
      const payoutTransfer = onChainCheck.transfers.find(t => t.amount === winnerPayoutUsdc);

      // Update match as finished (not void) with the detected tx hash
      db.setMatchWinner(matchId, null, winnerPayoutUsdc, payoutTransfer?.txHash || 'recovered_from_chain');

      // Clean up persisted state
      db.deleteMatchState(matchId);

      // Reset lobby (no refunds needed)
      lobby.resetLobby(lobbyId);

      // Send alert about recovered payout
      sendAlert(AlertType.MATCH_RECOVERED, {
        matchId,
        lobbyId,
        result: 'finished_recovered',
        reason: 'payout_detected_on_chain',
        payoutTxHash: payoutTransfer?.txHash,
        payoutRecipient: payoutTransfer?.to,
        playerCount: state?.players?.length || 0,
      }).catch(err => console.error('Alert send failed:', err.message));

      console.log(`[RECOVERY] Match ${matchId} marked as finished (payout already on-chain: ${payoutTransfer?.txHash})`);
      return;
    }
  }

  // No payout detected - safe to void and refund
  // Update match status in database
  db.updateMatchStatus(matchId, 'void');

  // Clean up persisted state
  db.deleteMatchState(matchId);

  // Log the void
  logger.logMatchEnd(matchId, state?.players?.[0]?.tick || 0, null, reason);

  // Process refunds for all players via lobby wallet
  if (lobbyId) {
    await lobby.processLobbyRefund(lobbyId, 'server_crash');
  }

  // Reset lobby
  lobby.resetLobby(lobbyId);

  // Send alert for recovered match
  sendAlert(AlertType.MATCH_RECOVERED, {
    matchId,
    lobbyId,
    result: 'voided',
    reason,
    playerCount: state?.players?.length || 0,
  }).catch(err => console.error('Alert send failed:', err.message));

  console.log(`[RECOVERY] Match ${matchId} voided and players refunded (reason: ${reason})`);
}

/**
 * Attempt to recover interrupted matches on server startup
 * Returns array of recovery results for logging
 * @returns {Promise<Array<{matchId: string, result: string, reason?: string}>>}
 */
async function recoverInterruptedMatches() {
  const results = [];
  const interruptedMatches = db.getInterruptedMatches();

  if (interruptedMatches.length === 0) {
    console.log('[RECOVERY] No interrupted matches found');
    return results;
  }

  console.log(`[RECOVERY] Found ${interruptedMatches.length} interrupted match(es)`);

  for (const savedState of interruptedMatches) {
    const {
      match_id: matchId,
      version,
      updated_at: updatedAt,
      state,
      lobby_id: lobbyId,
      match_created_at: matchCreatedAt,
      match_running_at: matchRunningAt,
    } = savedState;

    // Use running_at if available, otherwise created_at (for payout time filtering)
    const matchStartTime = matchRunningAt || matchCreatedAt;

    console.log(`[RECOVERY] Processing match ${matchId} (lobby ${lobbyId}, tick ${savedState.tick}, started: ${matchStartTime})`);

    // Check version compatibility
    if (!isStateVersionCompatible(version)) {
      console.log(`[RECOVERY] Match ${matchId}: Incompatible state version ${version}`);
      await voidAndRefundFromRecovery(matchId, lobbyId, state, 'incompatible_state_version', matchStartTime);
      results.push({ matchId, result: 'voided', reason: 'incompatible_state_version' });
      continue;
    }

    // Check state age
    if (isStateTooOld(updatedAt)) {
      const ageMinutes = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000);
      console.log(`[RECOVERY] Match ${matchId}: State too old (${ageMinutes} minutes)`);
      await voidAndRefundFromRecovery(matchId, lobbyId, state, 'state_too_old', matchStartTime);
      results.push({ matchId, result: 'voided', reason: 'state_too_old' });
      continue;
    }

    // State is valid but we cannot resume (players have disconnected, no WebSockets)
    // For now, always void and refund on crash - reconnection not implemented yet
    console.log(`[RECOVERY] Match ${matchId}: Voiding (no reconnection support yet)`);
    await voidAndRefundFromRecovery(matchId, lobbyId, state, 'server_restart', matchStartTime);
    results.push({ matchId, result: 'voided', reason: 'server_restart' });
  }

  return results;
}

// ============================================
// Match Creation
// ============================================

/**
 * Start a new match from a ready lobby
 * @param {number} lobbyId - Lobby ID
 * @param {boolean} skipBalanceCheck - Skip wallet balance verification (admin/dev mode)
 * @returns {Object} Match object
 */
async function startMatch(lobbyId, skipBalanceCheck = false) {
  // Acquire lock to prevent concurrent match starts from same lobby
  await lobby.acquireLobbyLock(lobbyId);

  try {
    const lobbyData = lobby.getLobby(lobbyId);
    if (!lobbyData || lobbyData.status !== 'ready') {
      throw new Error('Lobby not ready');
    }

    const players = lobbyData.players.filter(p => !p.refunded_at);
    if (players.length !== 3) {
      throw new Error('Need exactly 3 players');
    }

    // Check lobby wallet balance before starting match (should have 3 USDC from 3 players)
    // Skip this check in dev/admin mode where payments are bypassed
    if (!skipBalanceCheck) {
      const lobbyBalance = await payments.getUsdcBalance(lobbyData.deposit_address);
      const expectedBalance = BigInt(payments.BUY_IN_AMOUNT) * BigInt(3); // 3 USDC
      if (BigInt(lobbyBalance.balance) < expectedBalance) {
        console.error(`Insufficient lobby balance: ${lobbyBalance.formatted} USDC (need ${Number(expectedBalance) / 1_000_000} USDC expected from 3 players)`);
        const err = new Error('INSUFFICIENT_LOBBY_BALANCE');
        err.balance = lobbyBalance.formatted;
        throw err;
      }
    } else {
      console.log('DEV MODE: Skipping lobby balance check');
    }

    // Generate cryptographically secure RNG seed
    const rngSeed = config.generateSecureRngSeed();

    // Create match in database
    const matchData = db.createMatch(lobbyId, rngSeed);

    // Calculate spawn positions and assign roles
    const spawnPositions = physics.calculateSpawnPositions(rngSeed);
    const roles = physics.shuffleRoles(rngSeed + 1); // Different seed for roles

    // Create match players
    const matchPlayers = [];
    for (let i = 0; i < 3; i++) {
      const player = players[i];
      const role = roles[i];
      const spawn = spawnPositions[i];

      db.addMatchPlayer(matchData.id, player.user_id, role, spawn.x, spawn.y);

      matchPlayers.push({
        id: player.user_id,
        walletAddress: player.wallet_address,
        username: player.username,
        role,
        x: spawn.x,
        y: spawn.y,
        targetX: spawn.x,  // Used by bots
        targetY: spawn.y,  // Used by bots
        dirX: 0,           // Used by human players (keyboard)
        dirY: 0,           // Used by human players (keyboard)
        alive: true,
        frozen: false,
        connected: true,
        lastInputSequence: 0,
        isBot: !!player.isBot,  // Track if this is a bot
      });
    }

    // Create active match state
    const match = {
      id: matchData.id,
      lobbyId,
      status: 'countdown',
      tick: 0,
      players: matchPlayers,
      connections: new Map(lobbyData.connections), // Copy connections from lobby
      countdownRemaining: config.COUNTDOWN_DURATION,
      gameLoopInterval: null,
      snapshotCounter: 0,
      devMode: skipBalanceCheck, // Dev mode skips payouts
    };

    activeMatches.set(matchData.id, match);
    lobby.setLobbyInProgress(lobbyId, matchData.id);

    // Log match start
    logger.logMatchStart(matchData.id, 0, matchPlayers);

    // Start countdown
    startCountdown(match);

    console.log(`Match ${matchData.id} started for lobby ${lobbyId}`);

    // Send activity alert
    sendAlert(AlertType.MATCH_STARTED, {
      lobbyId,
      matchId: matchData.id,
      players: matchPlayers.map(p => p.username).join(', '),
    }).catch(err => console.error('Alert send failed:', err.message));

    return match;
  } finally {
    lobby.releaseLobbyLock(lobbyId);
  }
}

// ============================================
// Countdown Phase
// ============================================

/**
 * Start the countdown phase
 */
function startCountdown(match) {
  // Send match starting notification
  const startMsg = protocol.createMatchStarting(match.id, config.COUNTDOWN_DURATION);
  broadcastToMatch(match, startMsg);

  // Send role assignments to each player AND set their matchId
  for (const player of match.players) {
    const ws = match.connections.get(player.id);
    if (ws && ws.readyState === 1) {
      // Set matchId on the connection so it can process inputs
      if (ws.setMatchId) {
        ws.setMatchId(match.id);
      }
      const roleMsg = protocol.createRoleAssignment(player.role, player.x, player.y);
      ws.send(roleMsg);
    }
  }

  // Initial snapshot (positions before game starts)
  const snapshot = protocol.createSnapshot(0, match.players);
  broadcastToMatch(match, snapshot);

  // Countdown timer - stored on match object so it can be cleared if match is voided
  match.countdownInterval = setInterval(() => {
    match.countdownRemaining--;

    if (match.countdownRemaining > 0) {
      const countdownMsg = protocol.createCountdown(match.countdownRemaining);
      broadcastToMatch(match, countdownMsg);
    } else {
      clearInterval(match.countdownInterval);
      match.countdownInterval = null;

      // Check for disconnected players at start of RUNNING
      for (const player of match.players) {
        if (!player.connected) {
          player.alive = false;
          logger.logDisconnect(match.id, 0, player.id, 'disconnected_at_start');
        }
      }

      // Transition to running
      match.status = 'running';
      db.updateMatchStatus(match.id, 'running');

      // Send GO countdown
      const goMsg = protocol.createCountdown(0);
      broadcastToMatch(match, goMsg);

      // Start game loop
      startGameLoop(match);
    }
  }, 1000);
}

// ============================================
// Game Loop (30 Hz)
// ============================================

// Maximum consecutive tick errors before voiding match
const MAX_CONSECUTIVE_TICK_ERRORS = 3;

/**
 * Classify tick errors to determine if they're recoverable
 * @param {Error} error - The error that occurred
 * @returns {'transient'|'critical'} - Error classification
 */
function classifyTickError(error) {
  const message = error.message || '';
  const name = error.name || '';

  // Check transient errors FIRST - these take priority
  // (e.g., a database error with "null" in it should be transient, not critical)
  const transientPatterns = [
    /database/i,
    /sqlite/i,
    /busy/i,
    /locked/i,
    /timeout/i,
    /econnreset/i,
    /econnrefused/i,
    /websocket/i,
    /network/i,
  ];

  for (const pattern of transientPatterns) {
    if (pattern.test(message) || pattern.test(name)) {
      return 'transient';
    }
  }

  // Critical errors that require immediate match void
  // These indicate corrupted state that won't recover on retry
  const criticalPatterns = [
    /match.*not.*found/i,
    /invalid.*match/i,
    /player.*corrupt/i,
    /undefined is not/i,
    /cannot read propert/i,
    /\bis null\b/i,           // "x is null" errors
    /\bof null\b/i,           // "property of null" errors
  ];

  for (const pattern of criticalPatterns) {
    if (pattern.test(message) || pattern.test(name)) {
      return 'critical';
    }
  }

  // Check error name for TypeError/ReferenceError (indicates code bug or corrupt state)
  if (name === 'TypeError' || name === 'ReferenceError') {
    return 'critical';
  }

  // Default to transient to give benefit of doubt
  return 'transient';
}

/**
 * Start the 30 Hz game loop with error boundary
 */
function startGameLoop(match) {
  const tickInterval = 1000 / physics.TICK_RATE; // ~33.3ms

  // Initialize error tracking for this match
  matchTickErrors.set(match.id, { count: 0, lastError: null, lastErrorTime: null });

  // Track last successful tick time for health monitoring
  match.lastTickTime = Date.now();

  // Save initial running state for crash recovery
  persistMatchState(match);

  match.gameLoopInterval = setInterval(() => {
    if (match.status !== 'running') {
      clearInterval(match.gameLoopInterval);
      matchTickErrors.delete(match.id);
      return;
    }

    try {
      processTick(match);

      // Reset error count on successful tick
      const errorState = matchTickErrors.get(match.id);
      if (errorState && errorState.count > 0) {
        errorState.count = 0;
        console.log(`[GAME_LOOP] Match ${match.id}: Recovered from tick errors`);
      }

      // Update last successful tick time
      match.lastTickTime = Date.now();

    } catch (error) {
      // Error boundary - log and decide whether to continue or void
      const errorState = matchTickErrors.get(match.id) || { count: 0 };
      errorState.count++;
      errorState.lastError = error.message;
      errorState.lastErrorTime = Date.now();
      matchTickErrors.set(match.id, errorState);

      const errorType = classifyTickError(error);

      console.error(`[GAME_LOOP_ERROR] Match ${match.id} tick ${match.tick}: ${error.message}`);
      console.error(`  Error type: ${errorType}, Consecutive errors: ${errorState.count}/${MAX_CONSECUTIVE_TICK_ERRORS}`);

      if (errorType === 'critical' || errorState.count >= MAX_CONSECUTIVE_TICK_ERRORS) {
        // Critical error or too many consecutive failures - void match
        console.error(`[GAME_LOOP] Match ${match.id}: Voiding match due to ${errorType === 'critical' ? 'critical error' : 'consecutive tick failures'}`);

        // Send alert for game loop failure
        sendAlert(AlertType.GAME_LOOP_ERROR, {
          matchId: match.id,
          tick: match.tick,
          error: error.message,
          consecutiveErrors: errorState.count,
          errorType,
          stalled: false,
        }).catch(err => console.error('Alert send failed:', err.message));

        // Void the match and refund players
        voidMatch(match.id, 'game_loop_error').catch(voidErr => {
          console.error(`[GAME_LOOP] Failed to void match ${match.id}:`, voidErr);
        });

        return; // Stop processing this tick
      }

      // Transient error with remaining retries - continue to next tick
      console.warn(`[GAME_LOOP] Match ${match.id}: Transient error, continuing (${MAX_CONSECUTIVE_TICK_ERRORS - errorState.count} retries left)`);
    }
  }, tickInterval);
}

/**
 * Process a single game tick
 * Order: grace period check → movement → collisions → win check → broadcast
 */
function processTick(match) {
  match.tick++;

  // Persist state every N ticks for crash recovery
  if (match.tick % PERSISTENCE_INTERVAL === 0) {
    persistMatchState(match);
  }

  // 1. Check grace period expirations (replaces immediate disconnect elimination)
  const shouldEnd = checkGracePeriodExpirations(match);
  if (shouldEnd) {
    const stillAlive = match.players.filter(p => p.alive);
    endMatch(match, stillAlive[0] || null, 'last_standing').catch(err => {
      console.error(`[GAME_LOOP] Failed to end match ${match.id}:`, err);
    });
    return;
  }

  // Recheck alive after grace period eliminations
  const stillAlive = match.players.filter(p => p.alive);

  // 2. Check win condition after disconnects
  if (stillAlive.length <= 1) {
    endMatch(match, stillAlive[0] || null, 'last_standing').catch(err => {
      console.error(`[GAME_LOOP] Failed to end match ${match.id}:`, err);
    });
    return;
  }

  // 3. Process movement for alive players
  // Store previous positions for swept collision detection
  for (const player of stillAlive) {
    player.prevX = player.x;
    player.prevY = player.y;
  }

  for (const player of stillAlive) {
    let newPos;
    if (player.isBot) {
      // Bots use target-based movement
      newPos = physics.moveTowardTarget(
        { x: player.x, y: player.y },
        { x: player.targetX, y: player.targetY },
        player.frozen
      );
    } else {
      // Human players use direction-based movement (keyboard)
      newPos = physics.moveInDirection(
        { x: player.x, y: player.y },
        player.dirX || 0,
        player.dirY || 0,
        player.frozen
      );
    }
    player.x = newPos.x;
    player.y = newPos.y;
  }

  // 4. Process collisions (in showdown mode, all collisions result in bounce)
  // Debug: Log player states EVERY tick when 2 remain (throttled to every 30 ticks = 1 second)
  if (DEBUG_MATCH && stillAlive.length === 2) {
    const p1 = stillAlive[0];
    const p2 = stillAlive[1];
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Log every second when 2 players, or every tick if within 60 pixels
    if (match.tick % 30 === 0 || dist < 60) {
      console.log(`[FINAL2] Tick ${match.tick}: ${p1.role}(${p1.id.slice(-4)}) pos=(${p1.x.toFixed(0)},${p1.y.toFixed(0)}) vs ${p2.role}(${p2.id.slice(-4)}) pos=(${p2.x.toFixed(0)},${p2.y.toFixed(0)}), dist=${dist.toFixed(1)}, overlap=${dist <= physics.PLAYER_RADIUS * 2}${match.showdown ? ' [SHOWDOWN]' : ''}`);
    }
  }

  const collisionResult = physics.processCollisions(match.players, !!match.showdown);

  // 4b. Process showdown heart captures (if in showdown mode and not frozen)
  if (match.showdown && !match.showdown.frozen) {
    // Log every tick when player is close to a heart (for debugging)
    for (const player of stillAlive) {
      for (const heart of match.showdown.hearts) {
        if (!heart.captured) {
          const dx = player.x - heart.x;
          const dy = player.y - heart.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const captureThreshold = physics.PLAYER_RADIUS + physics.HEART_RADIUS;
          if (dist < 80) {
            console.log(`[HEART] Tick ${match.tick}: Player at (${player.x.toFixed(0)},${player.y.toFixed(0)}) prev=(${player.prevX?.toFixed(0) ?? 'null'},${player.prevY?.toFixed(0) ?? 'null'}) dist=${dist.toFixed(1)} to heart ${heart.id} at (${heart.x.toFixed(0)},${heart.y.toFixed(0)}), threshold=${captureThreshold}`);
          }
        }
      }
    }

    const captures = physics.processHeartCaptures(match.players, match.showdown.hearts);

    // First pass: update all scores and broadcast captures
    for (const capture of captures) {
      if (!match.showdown.scores[capture.playerId]) {
        match.showdown.scores[capture.playerId] = 0;
      }
      match.showdown.scores[capture.playerId]++;

      const playerScore = match.showdown.scores[capture.playerId];

      // Broadcast heart capture
      const captureMsg = protocol.createHeartCaptured(capture.playerId, capture.heartId, playerScore);
      broadcastToMatch(match, captureMsg);

      console.log(`[SHOWDOWN] Player ${capture.playerId.slice(-4)} captured heart ${capture.heartId}, score: ${playerScore}/${SHOWDOWN_HEARTS_TO_WIN}`);
    }

    // Second pass: check for winners only if captures occurred (handles simultaneous captures fairly)
    if (captures.length > 0) {
      const winners = Object.entries(match.showdown.scores)
        .filter(([id, score]) => score >= SHOWDOWN_HEARTS_TO_WIN)
        .map(([id]) => match.players.find(p => p.id === id))
        .filter(p => p); // Filter out any undefined

      if (winners.length === 1) {
        // Single winner - normal case
        const winner = winners[0];
        if (DEBUG_MATCH) console.log(`[SHOWDOWN] Winner: ${winner.id.slice(-4)} with ${match.showdown.scores[winner.id]} hearts!`);

        const finalSnapshot = protocol.createSnapshot(match.tick, match.players);
        broadcastToMatch(match, finalSnapshot);

        endMatch(match, winner, 'showdown_winner').catch(err => {
          console.error(`[GAME_LOOP] Failed to end match ${match.id}:`, err);
        });
        return;
      } else if (winners.length > 1) {
        // Simultaneous win - random tiebreaker for fairness
        const winner = winners[Math.floor(Math.random() * winners.length)];
        console.log(`[SHOWDOWN] Simultaneous win tiebreaker! Players ${winners.map(w => w.id.slice(-4)).join(' and ')} both reached ${SHOWDOWN_HEARTS_TO_WIN} hearts. Random winner: ${winner.id.slice(-4)}`);

        const finalSnapshot = protocol.createSnapshot(match.tick, match.players);
        broadcastToMatch(match, finalSnapshot);

        endMatch(match, winner, 'showdown_winner_tiebreak').catch(err => {
          console.error(`[GAME_LOOP] Failed to end match ${match.id}:`, err);
        });
        return;
      }
    }
  }

  // Debug: Log collision result when 2 players remain
  if (DEBUG_MATCH && stillAlive.length === 2 && collisionResult.type !== 'none') {
    console.log(`[DEBUG] Collision result with 2 alive: type=${collisionResult.type}, eliminations=${JSON.stringify(collisionResult.eliminations)}`);
  }

  // Debug: Log when only 2 players remain and they're close
  if (DEBUG_MATCH && stillAlive.length === 2) {
    const p1 = stillAlive[0];
    const p2 = stillAlive[1];
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // Only log when they're getting close (within 100 pixels)
    if (distance < 100) {
      console.log(`[DEBUG] 2 players close - ${p1.role}(${p1.id.slice(-4)}) vs ${p2.role}(${p2.id.slice(-4)}), dist: ${distance.toFixed(1)}, collision: ${collisionResult.type}`);
    }
  }

  if (collisionResult.type === 'elimination') {
    for (const elim of collisionResult.eliminations) {
      db.eliminatePlayer(match.id, elim.loserId, elim.winnerId,
        match.players.find(p => p.id === elim.loserId).x,
        match.players.find(p => p.id === elim.loserId).y
      );

      logger.logElimination(match.id, match.tick, elim.winnerId, elim.loserId, match.players);

      const elimMsg = protocol.createElimination(match.tick, elim.loserId, elim.winnerId);
      broadcastToMatch(match, elimMsg);
    }

    // Check if we should trigger showdown mode (2 players remaining after elimination)
    const aliveAfterElim = match.players.filter(p => p.alive);
    if (aliveAfterElim.length === 2 && !match.showdown) {
      triggerShowdown(match);
      return; // Skip normal win check - showdown will determine winner
    }
  }

  // 5. Check win condition after collisions (only if not in showdown)
  const finalAlive = match.players.filter(p => p.alive);
  if (finalAlive.length <= 1 && !match.showdown) {
    if (DEBUG_MATCH) console.log(`[DEBUG] Match ending - winner: ${finalAlive[0]?.id || 'none'}, reason: last_standing`);
    endMatch(match, finalAlive[0] || null, 'last_standing').catch(err => {
      console.error(`[GAME_LOOP] Failed to end match ${match.id}:`, err);
    });
    return;
  }

  // 6. Broadcast snapshot at 30 Hz (tick-rate agnostic)
  // ticksPerSnapshot = TICK_RATE / 30 (e.g., 30Hz -> 1, 60Hz -> 2)
  const SNAPSHOT_RATE = 30;
  const ticksPerSnapshot = physics.TICK_RATE / SNAPSHOT_RATE;
  match.snapshotCounter++;
  if (match.snapshotCounter >= ticksPerSnapshot) {
    match.snapshotCounter -= ticksPerSnapshot; // Preserve fractional remainder
    const snapshot = protocol.createSnapshot(match.tick, match.players);
    broadcastToMatch(match, snapshot);
  }
}

// ============================================
// Match End
// ============================================

/**
 * End the match and process payouts
 * If payout fails, voids match and refunds all players
 */
async function endMatch(match, winner, reason) {
  if (match.status === 'finished' || match.status === 'void' || match.status === 'ending') {
    return; // Already ended or ending
  }

  // CRITICAL: Set status to 'ending' IMMEDIATELY to prevent health monitor from voiding
  // This must happen BEFORE clearing the game loop interval
  match.status = 'ending';

  clearInterval(match.gameLoopInterval);

  if (winner) {
    // Process winner payout from lobby wallet
    const winnerPlayer = match.players.find(p => p.id === winner.id);
    const lobbyData = lobby.getLobby(match.lobbyId);

    // DEV MODE: Skip actual payouts, just mark match as finished
    if (match.devMode) {
      console.log(`[DEV MODE] Skipping payout for match ${match.id}, winner: ${winnerPlayer.username}`);
      logger.logMatchEnd(match.id, match.tick, winner.id, reason);
      match.status = 'finished';
      db.setMatchWinner(match.id, winner.id, 0, 'dev_mode_no_payout');

      // Send match end message to clients (with fake payout info for UI)
      const endMsg = protocol.createMatchEnd(winner.id, {
        winner: 2.4,
        treasury: 0.6,
      });
      broadcastToMatch(match, endMsg);

      // Reset lobby for next game
      lobby.resetLobby(match.lobbyId);
      return;
    }

    // HIGH-1 FIX: Secondary balance check immediately before payout
    // This catches edge cases where funds could be swept between match start and end
    if (!lobbyData || !lobbyData.deposit_address) {
      console.error(`[PAYOUT] Lobby data not found for match ${match.id}, lobby ${match.lobbyId}`);
      await voidMatch(match.id, 'lobby_not_found', true);
      return;
    }
    const prePayoutBalance = await payments.getUsdcBalance(lobbyData.deposit_address);
    const requiredBalance = BigInt(payments.WINNER_PAYOUT); // 2.4 USDC for winner payout
    if (BigInt(prePayoutBalance.balance) < requiredBalance) {
      console.error(`[PAYOUT] Insufficient lobby balance at payout time: ${prePayoutBalance.formatted} USDC (need ${Number(requiredBalance) / 1_000_000} USDC)`);

      // Alert and void match - something drained the lobby wallet
      sendAlert(AlertType.INSUFFICIENT_BALANCE, {
        matchId: match.id,
        lobbyId: match.lobbyId,
        balance: prePayoutBalance.formatted,
        required: (Number(requiredBalance) / 1_000_000).toFixed(2),
        stage: 'pre_payout',
      }).catch(err => console.error('Alert send failed:', err.message));

      // Void match - voidMatch handles logging, refunds, and cleanup
      // Note: gameLoopInterval already cleared above, voidMatch will no-op on it
      await voidMatch(match.id, 'insufficient_balance_at_payout', true);
      return;
    }

    // Note: Refunds come from lobby wallet (where deposits are), not treasury
    // Treasury only receives swept fees after successful matches

    // HIGH-2 FIX: Check if payout was already made (prevents double-spend on crash recovery)
    const existingMatch = db.getMatch(match.id);
    if (existingMatch && existingMatch.payout_tx_hash) {
      console.log(`[PAYOUT] Payout already completed for match ${match.id}, tx: ${existingMatch.payout_tx_hash}`);
      match.status = 'finished';

      // Send match end message with existing payout info
      const endMsg = protocol.createMatchEnd(winner.id, {
        winner: 2.4,
        treasury: 0.6,
      });
      broadcastToMatch(match, endMsg);

      // Clean up persisted state (should already be deleted, but ensure consistency)
      db.deleteMatchState(match.id);

      // Cleanup without attempting another payout
      setTimeout(() => {
        activeMatches.delete(match.id);
        matchTickErrors.delete(match.id);
        lobby.resetLobby(match.lobbyId);
      }, 5000);
      return;
    }

    // Log the payout attempt before trying
    const attemptRecord = db.logPayoutAttempt({
      matchId: match.id,
      lobbyId: match.lobbyId,
      recipientAddress: winnerPlayer.walletAddress,
      amountUsdc: 2.4,
      attemptNumber: 1,
      status: 'pending',
      sourceWallet: 'lobby',
    });

    let payoutResult;
    try {
      payoutResult = await payments.sendWinnerPayout(
        lobbyData.deposit_private_key_encrypted,
        winnerPlayer.walletAddress,
        match.lobbyId
      );
    } catch (error) {
      console.error('Payout exception:', error);
      payoutResult = { success: false, error: error.message || 'Unknown payout error', errorType: 'unknown' };
    }

    // Update the attempt record with result
    if (attemptRecord) {
      db.updatePayoutAttempt(
        attemptRecord.id,
        payoutResult.success ? 'success' : 'failed',
        payoutResult.txHash || null,
        payoutResult.error || null,
        payoutResult.errorType || null
      );
    }

    if (payoutResult.success) {
      // Payout succeeded - mark match as finished with winner
      logger.logMatchEnd(match.id, match.tick, winner.id, reason);
      match.status = 'finished';
      db.setMatchWinner(match.id, winner.id, 2.4, payoutResult.txHash);

      // Record stats for all players (by wallet address)
      const buyInUsdc = config.BUY_IN_AMOUNT / 1_000_000; // Convert from raw to USDC
      for (const player of match.players) {
        const isWin = player.id === winner.id;
        const earnings = isWin ? 2.4 : 0;
        db.recordMatchResult(player.walletAddress, isWin, earnings, buyInUsdc);
      }

      // Send activity alert for successful match completion
      sendAlert(AlertType.MATCH_COMPLETED, {
        lobbyId: match.lobbyId,
        matchId: match.id,
        winner: winnerPlayer.username,
        payoutSuccess: true,
        txHash: payoutResult.txHash,
      }).catch(err => console.error('Alert send failed:', err.message));

      // Send match end message to clients
      const endMsg = protocol.createMatchEnd(winner.id, {
        winner: 2.4,
        treasury: 0.6,
      });
      broadcastToMatch(match, endMsg);

      console.log(`[PAYOUT] Success: Match ${match.id}, winner ${winnerPlayer.username}, tx: ${payoutResult.txHash}`);
    } else {
      // Payout failed - void match and refund all players
      console.error(`[PAYOUT] Failed: ${payoutResult.error}. Voiding match and refunding all players.`);

      logger.logMatchEnd(match.id, match.tick, winner.id, 'payout_failed');
      match.status = 'void';
      db.updateMatchStatus(match.id, 'void');

      // Alert on payout failure
      sendAlert(AlertType.PAYOUT_FAILED, {
        lobbyId: match.lobbyId,
        matchId: match.id,
        winnerAddress: winnerPlayer.walletAddress,
        error: payoutResult.error,
        action: 'Voiding match and refunding all players from lobby wallet',
      }).catch(err => console.error('Alert send failed:', err.message));

      // Process refunds for all players from lobby wallet
      const refundResult = await lobby.processLobbyRefund(match.lobbyId, 'payout_failed');

      // Log refund results
      console.log(`[PAYOUT] Refund result for match ${match.id}:`, refundResult);

      // Send match voided message to clients
      const voidMsg = protocol.createRefundProcessed(match.lobbyId, 'payout_failed',
        match.players.map(p => ({
          userId: p.id,
          username: p.username || protocol.truncateAddress(p.walletAddress),
          amount: 1,
          txHash: null, // Will be filled from refund result if available
        }))
      );
      broadcastToMatch(match, voidMsg);
    }
  } else {
    // No winner (void match due to other reasons like disconnect)
    logger.logMatchEnd(match.id, match.tick, null, reason);
    match.status = 'void';
    db.updateMatchStatus(match.id, 'void');

    // Process refunds
    await lobby.processLobbyRefund(match.lobbyId, reason);
  }

  // Clean up persisted state (match ended normally or voided)
  db.deleteMatchState(match.id);

  // Cleanup
  setTimeout(() => {
    activeMatches.delete(match.id);
    matchTickErrors.delete(match.id);
    lobby.resetLobby(match.lobbyId);
  }, 5000); // Keep match data for 5 seconds for final messages

  console.log(`Match ${match.id} ended. Status: ${match.status}, Winner: ${winner?.id || 'none'}, Reason: ${reason}`);
}

/**
 * Void a match (for server crash, mass disconnect)
 * @param {string} matchId - Match ID
 * @param {string} reason - Void reason
 * @param {boolean} force - If true, allows voiding a match in 'ending' state (used by endMatch internally)
 */
async function voidMatch(matchId, reason, force = false) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  // Don't void a match that's already finished or voided
  if (match.status === 'finished' || match.status === 'void') {
    console.log(`[VOID] Match ${matchId} already ${match.status}, skipping void with reason: ${reason}`);
    return;
  }

  // Don't void a match in 'ending' state unless forced (prevents health monitor race condition)
  if (match.status === 'ending' && !force) {
    console.log(`[VOID] Match ${matchId} is ending, skipping void with reason: ${reason}`);
    return;
  }

  // Clear both countdown and game loop intervals to prevent leaks
  if (match.countdownInterval) {
    clearInterval(match.countdownInterval);
    match.countdownInterval = null;
  }
  clearInterval(match.gameLoopInterval);
  match.status = 'void';
  db.updateMatchStatus(matchId, 'void');

  // Clean up persisted state
  db.deleteMatchState(matchId);

  logger.logMatchEnd(matchId, match.tick, null, reason);

  // Process refunds for all players
  await lobby.processLobbyRefund(match.lobbyId, reason);

  const refundMsg = protocol.createRefundProcessed(match.lobbyId, reason,
    match.players.map(p => ({
      userId: p.id,
      username: p.username || protocol.truncateAddress(p.walletAddress),
      amount: 1,
      txHash: null, // Will be filled when refund processes
    }))
  );
  broadcastToMatch(match, refundMsg);

  setTimeout(() => {
    activeMatches.delete(matchId);
    matchTickErrors.delete(matchId);
    lobby.resetLobby(match.lobbyId);
  }, 5000);

  console.log(`Match ${matchId} voided. Reason: ${reason}`);
}

// ============================================
// Input Handling
// ============================================

// Debug counter for input logging
let inputLogCount = 0;

/**
 * Process player input
 */
function processInput(matchId, userId, input) {
  const match = activeMatches.get(matchId);
  if (!match || match.status !== 'running') {
    if (DEBUG_MATCH && inputLogCount < 5) {
      console.log('[DEBUG] Input rejected - match status:', match ? match.status : 'no match');
      inputLogCount++;
    }
    return;
  }

  const player = match.players.find(p => p.id === userId);
  if (!player || !player.alive) {
    if (DEBUG_MATCH && inputLogCount < 5) {
      console.log('[DEBUG] Input rejected - player:', player ? 'dead' : 'not found');
      inputLogCount++;
    }
    return;
  }

  // Validate sequence number (prevent replay)
  if (input.sequence <= player.lastInputSequence) {
    return;
  }
  player.lastInputSequence = input.sequence;

  // Handle both input types:
  // - Human players send dirX/dirY (keyboard direction)
  // - Bots send targetX/targetY (position to move toward)
  if (input.targetX !== undefined && input.targetY !== undefined) {
    // Bot input: target position
    player.targetX = Math.max(0, Math.min(physics.ARENA_WIDTH, input.targetX));
    player.targetY = Math.max(0, Math.min(physics.ARENA_HEIGHT, input.targetY));
  } else {
    // Human input: direction
    player.dirX = input.dirX || 0;
    player.dirY = input.dirY || 0;
  }

  // Debug first few accepted inputs
  if (DEBUG_MATCH && inputLogCount < 10) {
    if (player.isBot) {
      console.log('[DEBUG] Bot input - seq:', input.sequence, 'target:', player.targetX?.toFixed(1), player.targetY?.toFixed(1));
    } else {
      console.log('[DEBUG] Input accepted - seq:', input.sequence, 'dir:', player.dirX, player.dirY, 'player pos:', player.x.toFixed(1), player.y.toFixed(1));
    }
    inputLogCount++;
  }
}

// ============================================
// Connection Management
// ============================================

/**
 * Handle player disconnect during match
 * Starts a grace period before auto-elimination
 */
function handleDisconnect(matchId, userId) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  const player = match.players.find(p => p.id === userId);
  if (!player || !player.alive) return;

  player.connected = false;
  player.disconnectedAt = Date.now();
  match.connections.delete(userId);

  console.log(`[RECONNECT] Player ${userId} disconnected from match ${matchId}, grace period: ${RECONNECT_GRACE_PERIOD}s`);

  // Notify other players of disconnect (with grace period info)
  const disconnectMsg = protocol.createPlayerDisconnect(userId, RECONNECT_GRACE_PERIOD);
  broadcastToMatch(match, disconnectMsg);

  // Log the disconnect event
  logger.logDisconnect(match.id, match.tick, userId, 'disconnected');

  // Check for mass disconnect
  const connectedCount = match.players.filter(p => p.connected && p.alive).length;
  const aliveCount = match.players.filter(p => p.alive).length;

  if (connectedCount === 0 && aliveCount > 1) {
    // All alive players disconnected simultaneously - start grace period for all
    // Don't void immediately, give them a chance to reconnect
    console.log(`[RECONNECT] All ${aliveCount} players disconnected, starting grace period`);
  }
}

/**
 * Handle player reconnection during match
 * Returns the match if reconnection successful, null otherwise
 * @param {string} matchId - Match ID
 * @param {string} userId - User ID
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} sessionToken - Current session token (will be rotated for security)
 */
function handleReconnect(matchId, userId, ws, sessionToken) {
  const match = activeMatches.get(matchId);
  if (!match) {
    console.log(`[RECONNECT] Match ${matchId} not found for reconnection`);
    return null;
  }

  const player = match.players.find(p => p.id === userId);
  if (!player) {
    console.log(`[RECONNECT] Player ${userId} not in match ${matchId}`);
    return null;
  }

  if (!player.alive) {
    console.log(`[RECONNECT] Player ${userId} already eliminated, cannot reconnect`);
    return null;
  }

  // Close any existing connection for this player (prevents duplicate connection attacks)
  const oldWs = match.connections.get(userId);
  if (oldWs && oldWs !== ws && oldWs.readyState === 1) {
    oldWs.close(1008, 'Duplicate reconnect');
  }

  // Reconnect the player
  player.connected = true;
  player.disconnectedAt = null;
  match.connections.set(userId, ws);

  // Set matchId on the connection
  if (ws.setMatchId) {
    ws.setMatchId(matchId);
  }

  console.log(`[RECONNECT] Player ${userId} reconnected to match ${matchId}`);

  // Rotate session token to prevent replay attacks (CRITICAL-2 fix)
  if (sessionToken) {
    const rotated = session.rotateToken(sessionToken);
    if (rotated) {
      // Send new token to client
      const tokenMsg = protocol.createTokenUpdate(rotated.token);
      ws.send(tokenMsg);
      console.log(`[RECONNECT] Token rotated for player ${userId}`);
    }
  }

  // Send reconnect state to the player (full game state)
  const reconnectMsg = protocol.createReconnectState(
    match.id,
    player.role,
    match.tick,
    match.players,
    null // No time limit for now
  );
  ws.send(reconnectMsg);

  // Notify other players of reconnection
  const reconnectNotify = protocol.createPlayerReconnect(userId);
  broadcastToMatch(match, reconnectNotify);

  return match;
}

/**
 * Check for players who exceeded grace period and eliminate them
 * Called from the game tick
 */
function checkGracePeriodExpirations(match) {
  const now = Date.now();
  const gracePeriodMs = RECONNECT_GRACE_PERIOD * 1000;

  for (const player of match.players) {
    if (!player.connected && player.alive && player.disconnectedAt) {
      const elapsed = now - player.disconnectedAt;

      if (elapsed >= gracePeriodMs) {
        // Grace period expired - eliminate player
        player.alive = false;
        player.disconnectedAt = null;

        console.log(`[RECONNECT] Player ${player.id} grace period expired, eliminated`);
        logger.logDisconnect(match.id, match.tick, player.id, 'grace_period_expired');

        // Broadcast elimination
        const eliminationMsg = protocol.createElimination(match.tick, player.id, null);
        broadcastToMatch(match, eliminationMsg);

        // Check if match should end or trigger showdown
        const aliveCount = match.players.filter(p => p.alive).length;
        if (aliveCount <= 1) {
          return true; // Signal that match should end
        }
        // Trigger showdown if exactly 2 players remain after disconnect elimination
        if (aliveCount === 2 && !match.showdown) {
          triggerShowdown(match);
        }
      }
    }
  }

  return false; // Match continues
}

/**
 * Get remaining grace time for a disconnected player
 */
function getGraceTimeRemaining(player) {
  if (!player.disconnectedAt || player.connected || !player.alive) {
    return 0;
  }
  const elapsed = Date.now() - player.disconnectedAt;
  const remaining = Math.max(0, (RECONNECT_GRACE_PERIOD * 1000) - elapsed);
  return Math.ceil(remaining / 1000);
}

/**
 * Clear grace period for a player (called immediately on reconnect message receipt)
 * This prevents race condition between reconnect and grace period expiry check
 * HIGH-2 FIX: Must be called BEFORE handleReconnect to prevent elimination during reconnection
 * @param {string} matchId - Match ID
 * @param {string} userId - User ID
 */
function clearGracePeriod(matchId, userId) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  const player = match.players.find(p => p.id === userId);
  if (player && player.alive) {
    player.disconnectedAt = null; // Clear immediately to stop grace period timer
  }
}

/**
 * Get active match for a player
 */
function getPlayerMatch(userId) {
  for (const [matchId, match] of activeMatches) {
    if (match.players.some(p => p.id === userId)) {
      return match;
    }
  }
  return null;
}

/**
 * Get match by ID
 */
function getMatch(matchId) {
  return activeMatches.get(matchId);
}

// ============================================
// Utilities
// ============================================

/**
 * Broadcast message to all players in a match
 */
function broadcastToMatch(match, message) {
  for (const [userId, ws] of match.connections) {
    if (ws && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

// ============================================
// Game Loop Health Monitoring
// ============================================

/**
 * Start monitoring all active game loops for staleness
 * Should be called once when the server starts
 */
function startHealthMonitor() {
  if (healthMonitorInterval) {
    console.warn('[HEALTH_MONITOR] Already running');
    return;
  }

  console.log('[HEALTH_MONITOR] Starting game loop health monitor');

  healthMonitorInterval = setInterval(() => {
    const now = Date.now();

    for (const [matchId, match] of activeMatches) {
      // Only monitor running matches (skip finished, void, or ending)
      if (match.status !== 'running') continue;

      // Check if game loop has stalled
      const timeSinceLastTick = now - (match.lastTickTime || now);

      if (timeSinceLastTick > MAX_TICK_STALENESS) {
        console.error(`[HEALTH_MONITOR] Match ${matchId}: Game loop stalled! Last tick was ${timeSinceLastTick}ms ago (tick ${match.tick})`);

        // Send alert for stalled game loop
        sendAlert(AlertType.GAME_LOOP_ERROR, {
          matchId,
          tick: match.tick,
          staleDuration: timeSinceLastTick,
          maxAllowed: MAX_TICK_STALENESS,
          stalled: true,
        }).catch(err => console.error('Alert send failed:', err.message));

        // Clear the potentially dead interval
        if (match.gameLoopInterval) {
          clearInterval(match.gameLoopInterval);
        }

        // Void the match
        voidMatch(matchId, 'game_loop_stalled').catch(err => {
          console.error(`[HEALTH_MONITOR] Failed to void stalled match ${matchId}:`, err);
        });
      }
    }
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop the health monitor
 * Should be called during graceful server shutdown
 */
function stopHealthMonitor() {
  if (healthMonitorInterval) {
    clearInterval(healthMonitorInterval);
    healthMonitorInterval = null;
    console.log('[HEALTH_MONITOR] Stopped game loop health monitor');
  }
}

// ============================================
// Showdown Mode
// ============================================

/**
 * Trigger showdown mode when 2 players remain
 * Spawns hearts and freezes players for dramatic effect
 * @param {Object} match - Match object
 */
function triggerShowdown(match) {
  console.log(`[SHOWDOWN] Triggering showdown for match ${match.id}`);

  // Spawn hearts (but don't reveal them yet)
  const hearts = physics.spawnHearts(3);

  // Initialize showdown state - frozen during "SHOWDOWN" text display
  match.showdown = {
    hearts: hearts,
    scores: {}, // playerId -> hearts captured
    frozen: true, // Frozen during showdown text
    freezeEndTime: Date.now() + SHOWDOWN_FREEZE_DURATION,
  };

  // Freeze all alive players during showdown text
  for (const player of match.players) {
    if (player.alive) {
      player.frozen = true;
    }
  }

  // Broadcast SHOWDOWN_START (freeze phase, "SHOWDOWN" text displays)
  const startMsg = protocol.createShowdownStart(SHOWDOWN_FREEZE_DURATION);
  broadcastToMatch(match, startMsg);

  console.log(`[SHOWDOWN] Freeze phase started (${SHOWDOWN_FREEZE_DURATION}ms)`);

  // After freeze duration, send SHOWDOWN_READY with hearts and unfreeze players
  setTimeout(() => {
    if (!match.showdown || match.status !== 'running') return;

    match.showdown.frozen = false;

    // Unfreeze players
    for (const player of match.players) {
      if (player.alive) {
        player.frozen = false;
      }
    }

    // Broadcast SHOWDOWN_READY - hearts appear and race begins!
    const readyMsg = protocol.createShowdownReady(hearts);
    broadcastToMatch(match, readyMsg);

    console.log(`[SHOWDOWN] Hearts spawned, race begins!`);
  }, SHOWDOWN_FREEZE_DURATION);
}

/**
 * Get health status of all active matches
 * Useful for debugging and the /api/health endpoint
 * @returns {Object} Health status object
 */
function getHealthStatus() {
  const now = Date.now();
  const matches = [];

  for (const [matchId, match] of activeMatches) {
    const timeSinceLastTick = match.lastTickTime ? now - match.lastTickTime : null;
    const errorState = matchTickErrors.get(matchId);

    matches.push({
      matchId,
      status: match.status,
      tick: match.tick,
      timeSinceLastTick,
      isHealthy: match.status !== 'running' || (timeSinceLastTick !== null && timeSinceLastTick < MAX_TICK_STALENESS),
      consecutiveErrors: errorState?.count || 0,
      lastError: errorState?.lastError || null,
      alivePlayers: match.players.filter(p => p.alive).length,
      connectedPlayers: match.players.filter(p => p.connected).length,
    });
  }

  return {
    monitorRunning: healthMonitorInterval !== null,
    activeMatchCount: activeMatches.size,
    matches,
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  startMatch,
  endMatch,
  voidMatch,
  processInput,
  handleDisconnect,
  handleReconnect,
  clearGracePeriod,
  getPlayerMatch,
  getMatch,
  broadcastToMatch,
  // Health monitoring
  startHealthMonitor,
  stopHealthMonitor,
  getHealthStatus,
  // Crash recovery
  recoverInterruptedMatches,
  // Reconnection config
  RECONNECT_GRACE_PERIOD,
};
