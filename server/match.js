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
const { sendAlert, AlertType } = require('./alerts');

// Active matches (in-memory for real-time game state)
const activeMatches = new Map();

// Track consecutive tick errors per match for recovery decisions
const matchTickErrors = new Map();

// Health monitor interval reference
let healthMonitorInterval = null;

// How often to check game loop health (ms)
const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds

// Maximum time since last tick before considering game loop stalled (ms)
const MAX_TICK_STALENESS = 2000; // 2 seconds (60 ticks at 30Hz)

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
 * @param {string} matchId - Match UUID
 * @param {number} lobbyId - Lobby ID
 * @param {Object} state - Saved state with player info
 * @param {string} reason - Reason for voiding
 */
async function voidAndRefundFromRecovery(matchId, lobbyId, state, reason) {
  // Update match status in database
  db.updateMatchStatus(matchId, 'void');

  // Clean up persisted state
  db.deleteMatchState(matchId);

  // Log the void
  logger.logMatchEnd(matchId, state?.players?.[0]?.tick || 0, null, reason);

  // Process refunds for all players via treasury
  if (lobbyId) {
    await lobby.processTreasuryRefund(lobbyId, 'server_crash');
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
    const { match_id: matchId, version, updated_at: updatedAt, state, lobby_id: lobbyId } = savedState;

    console.log(`[RECOVERY] Processing match ${matchId} (lobby ${lobbyId}, tick ${savedState.tick})`);

    // Check version compatibility
    if (!isStateVersionCompatible(version)) {
      console.log(`[RECOVERY] Match ${matchId}: Incompatible state version ${version}`);
      await voidAndRefundFromRecovery(matchId, lobbyId, state, 'incompatible_state_version');
      results.push({ matchId, result: 'voided', reason: 'incompatible_state_version' });
      continue;
    }

    // Check state age
    if (isStateTooOld(updatedAt)) {
      const ageMinutes = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000);
      console.log(`[RECOVERY] Match ${matchId}: State too old (${ageMinutes} minutes)`);
      await voidAndRefundFromRecovery(matchId, lobbyId, state, 'state_too_old');
      results.push({ matchId, result: 'voided', reason: 'state_too_old' });
      continue;
    }

    // State is valid but we cannot resume (players have disconnected, no WebSockets)
    // For now, always void and refund on crash - reconnection not implemented yet
    console.log(`[RECOVERY] Match ${matchId}: Voiding (no reconnection support yet)`);
    await voidAndRefundFromRecovery(matchId, lobbyId, state, 'server_restart');
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
 * @returns {Object} Match object
 */
async function startMatch(lobbyId) {
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
    const lobbyBalance = await payments.getUsdcBalance(lobbyData.deposit_address);
    const expectedBalance = BigInt(payments.BUY_IN_AMOUNT) * BigInt(3); // 3 USDC
    if (BigInt(lobbyBalance.balance) < expectedBalance) {
      console.error(`Insufficient lobby balance: ${lobbyBalance.formatted} USDC (need ${Number(expectedBalance) / 1_000_000} USDC expected from 3 players)`);
      const err = new Error('INSUFFICIENT_LOBBY_BALANCE');
      err.balance = lobbyBalance.formatted;
      throw err;
    }

    // Generate RNG seed
    const rngSeed = Date.now();

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
        targetX: spawn.x,
        targetY: spawn.y,
        alive: true,
        frozen: false,
        connected: true,
        lastInputSequence: 0,
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
      countdownRemaining: 3,
      gameLoopInterval: null,
      snapshotCounter: 0,
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
  const startMsg = protocol.createMatchStarting(match.id, 3);
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
        sendAlert(AlertType.DATABASE_ERROR, {
          context: 'Game loop tick failure',
          matchId: match.id,
          tick: match.tick,
          error: error.message,
          consecutiveErrors: errorState.count,
          errorType,
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
 * Order: disconnects → inputs → movement → collisions → win check → broadcast
 */
function processTick(match) {
  match.tick++;

  // Persist state every N ticks for crash recovery
  if (match.tick % PERSISTENCE_INTERVAL === 0) {
    persistMatchState(match);
  }

  const alivePlayers = match.players.filter(p => p.alive);

  // 1. Process disconnects
  for (const player of alivePlayers) {
    if (!player.connected) {
      player.alive = false;
      logger.logDisconnect(match.id, match.tick, player.id, 'disconnected');

      // Send elimination for disconnect
      const elimMsg = protocol.createElimination(match.tick, player.id, null);
      broadcastToMatch(match, elimMsg);
    }
  }

  // Recheck alive after disconnects
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
    const newPos = physics.moveTowardTarget(
      { x: player.x, y: player.y },
      { x: player.targetX, y: player.targetY },
      player.frozen
    );
    player.x = newPos.x;
    player.y = newPos.y;
  }

  // 4. Process collisions
  // Debug: Log player states EVERY tick when 2 remain (throttled to every 30 ticks = 1 second)
  if (stillAlive.length === 2) {
    const p1 = stillAlive[0];
    const p2 = stillAlive[1];
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Log every second when 2 players, or every tick if within 60 pixels
    if (match.tick % 30 === 0 || dist < 60) {
      console.log(`[FINAL2] Tick ${match.tick}: ${p1.role}(${p1.id.slice(-4)}) pos=(${p1.x.toFixed(0)},${p1.y.toFixed(0)}) vs ${p2.role}(${p2.id.slice(-4)}) pos=(${p2.x.toFixed(0)},${p2.y.toFixed(0)}), dist=${dist.toFixed(1)}, overlap=${dist <= physics.PLAYER_RADIUS * 2}`);
    }
  }

  const collisionResult = physics.processCollisions(match.players);

  // Debug: Log collision result when 2 players remain
  if (stillAlive.length === 2 && collisionResult.type !== 'none') {
    console.log(`[DEBUG] Collision result with 2 alive: type=${collisionResult.type}, eliminations=${JSON.stringify(collisionResult.eliminations)}`);
  }

  // Debug: Log when only 2 players remain and they're close
  if (stillAlive.length === 2) {
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
  }

  // 5. Check win condition after collisions
  const finalAlive = match.players.filter(p => p.alive);
  if (finalAlive.length <= 1) {
    console.log(`[DEBUG] Match ending - winner: ${finalAlive[0]?.id || 'none'}, reason: last_standing`);
    endMatch(match, finalAlive[0] || null, 'last_standing').catch(err => {
      console.error(`[GAME_LOOP] Failed to end match ${match.id}:`, err);
    });
    return;
  }

  // 6. Broadcast snapshot (at 20 Hz = every ~1.5 ticks)
  match.snapshotCounter++;
  if (match.snapshotCounter >= 1.5) {
    match.snapshotCounter = 0;
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
  if (match.status === 'finished' || match.status === 'void') {
    return; // Already ended
  }

  clearInterval(match.gameLoopInterval);

  logger.logMatchEnd(match.id, match.tick, winner?.id || null, reason);

  if (winner) {
    // Process winner payout from lobby wallet
    const winnerPlayer = match.players.find(p => p.id === winner.id);
    const lobbyData = lobby.getLobby(match.lobbyId);

    // Check treasury balance before attempting payout
    // This ensures we have a fallback if payout fails and we need to refund
    let treasuryBalance = null;
    try {
      const treasuryInfo = await payments.getTreasuryBalance();
      treasuryBalance = treasuryInfo.formatted;
      const treasuryBalanceRaw = BigInt(treasuryInfo.balance);
      const refundAmount = BigInt(payments.BUY_IN_AMOUNT) * BigInt(3); // 3 USDC for 3 players

      if (treasuryBalanceRaw < refundAmount) {
        console.warn(`[PAYOUT] Treasury balance (${treasuryBalance} USDC) insufficient for potential refunds (need 3.0 USDC). Proceeding with caution.`);
        // Note: We don't alert here since we're proceeding anyway.
        // If payout fails, the PAYOUT_FAILED alert will fire and include context about refunds.
      }
    } catch (balanceError) {
      console.error('[PAYOUT] Failed to check treasury balance:', balanceError.message);
      // Continue anyway - we'll handle failure if payout fails
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
      treasuryBalanceBefore: treasuryBalance,
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
      match.status = 'finished';
      db.setMatchWinner(match.id, winner.id, 2.4, payoutResult.txHash);

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

      match.status = 'void';
      db.updateMatchStatus(match.id, 'void');

      // Alert on payout failure
      sendAlert(AlertType.PAYOUT_FAILED, {
        lobbyId: match.lobbyId,
        matchId: match.id,
        winnerAddress: winnerPlayer.walletAddress,
        error: payoutResult.error,
        action: 'Voiding match and refunding all players from treasury',
      }).catch(err => console.error('Alert send failed:', err.message));

      // Process refunds for all players from treasury
      const refundResult = await lobby.processTreasuryRefund(match.lobbyId, 'payout_failed');

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
    match.status = 'void';
    db.updateMatchStatus(match.id, 'void');

    // Process refunds
    await lobby.processTreasuryRefund(match.lobbyId, reason);
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
 */
async function voidMatch(matchId, reason) {
  const match = activeMatches.get(matchId);
  if (!match) return;

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
  await lobby.processTreasuryRefund(match.lobbyId, reason);

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
    if (inputLogCount < 5) {
      console.log('[DEBUG] Input rejected - match status:', match ? match.status : 'no match');
      inputLogCount++;
    }
    return;
  }

  const player = match.players.find(p => p.id === userId);
  if (!player || !player.alive) {
    if (inputLogCount < 5) {
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

  // Validate target position (within arena)
  const targetX = Math.max(0, Math.min(physics.ARENA_WIDTH, input.targetX));
  const targetY = Math.max(0, Math.min(physics.ARENA_HEIGHT, input.targetY));

  // Debug first few accepted inputs
  if (inputLogCount < 10) {
    console.log('[DEBUG] Input accepted - seq:', input.sequence, 'target:', targetX.toFixed(1), targetY.toFixed(1), 'player pos:', player.x.toFixed(1), player.y.toFixed(1));
    inputLogCount++;
  }

  player.targetX = targetX;
  player.targetY = targetY;
  player.frozen = input.frozen || false;
}

// ============================================
// Connection Management
// ============================================

/**
 * Handle player disconnect during match
 */
function handleDisconnect(matchId, userId) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  const player = match.players.find(p => p.id === userId);
  if (player) {
    player.connected = false;
    match.connections.delete(userId);
  }

  // Check for mass disconnect
  const connectedCount = match.players.filter(p => p.connected).length;
  const aliveCount = match.players.filter(p => p.alive).length;

  if (connectedCount === 0 && aliveCount > 1) {
    // All players disconnected simultaneously
    voidMatch(matchId, 'triple_disconnect').catch(err => {
      console.error(`[DISCONNECT] Failed to void match ${matchId}:`, err);
    });
  } else if (aliveCount === 2) {
    // Check if last 2 players disconnected
    const aliveAndConnected = match.players.filter(p => p.alive && p.connected);
    if (aliveAndConnected.length === 0) {
      voidMatch(matchId, 'double_disconnect').catch(err => {
        console.error(`[DISCONNECT] Failed to void match ${matchId}:`, err);
      });
    }
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
      // Only monitor running matches
      if (match.status !== 'running') continue;

      // Check if game loop has stalled
      const timeSinceLastTick = now - (match.lastTickTime || now);

      if (timeSinceLastTick > MAX_TICK_STALENESS) {
        console.error(`[HEALTH_MONITOR] Match ${matchId}: Game loop stalled! Last tick was ${timeSinceLastTick}ms ago (tick ${match.tick})`);

        // Send alert for stalled game loop
        sendAlert(AlertType.DATABASE_ERROR, {
          context: 'Game loop stalled',
          matchId,
          tick: match.tick,
          staleDuration: timeSinceLastTick,
          maxAllowed: MAX_TICK_STALENESS,
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
  getPlayerMatch,
  getMatch,
  broadcastToMatch,
  // Health monitoring
  startHealthMonitor,
  stopHealthMonitor,
  getHealthStatus,
  // Crash recovery
  recoverInterruptedMatches,
};
