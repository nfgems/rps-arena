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

// ============================================
// Match Creation
// ============================================

/**
 * Start a new match from a ready lobby
 * @param {number} lobbyId - Lobby ID
 * @returns {Object} Match object
 */
async function startMatch(lobbyId) {
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
  if (BigInt(lobbyBalance.balance) < BigInt(payments.WINNER_PAYOUT)) {
    console.error(`Insufficient lobby balance: ${lobbyBalance.formatted} USDC (need ${payments.WINNER_PAYOUT / 1_000_000} USDC for payout)`);
    throw new Error('INSUFFICIENT_LOBBY_BALANCE');
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
  });

  return match;
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

  // Countdown timer
  const countdownInterval = setInterval(() => {
    match.countdownRemaining--;

    if (match.countdownRemaining > 0) {
      const countdownMsg = protocol.createCountdown(match.countdownRemaining);
      broadcastToMatch(match, countdownMsg);
    } else {
      clearInterval(countdownInterval);

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

/**
 * Start the 30 Hz game loop
 */
function startGameLoop(match) {
  const tickInterval = 1000 / physics.TICK_RATE; // ~33.3ms

  match.gameLoopInterval = setInterval(() => {
    if (match.status !== 'running') {
      clearInterval(match.gameLoopInterval);
      return;
    }

    processTick(match);
  }, tickInterval);
}

/**
 * Process a single game tick
 * Order: disconnects → inputs → movement → collisions → win check → broadcast
 */
function processTick(match) {
  match.tick++;

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
    endMatch(match, stillAlive[0] || null, 'last_standing');
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
    endMatch(match, finalAlive[0] || null, 'last_standing');
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
 */
async function endMatch(match, winner, reason) {
  if (match.status === 'finished' || match.status === 'void') {
    return; // Already ended
  }

  clearInterval(match.gameLoopInterval);
  match.status = 'finished';

  logger.logMatchEnd(match.id, match.tick, winner?.id || null, reason);

  if (winner) {
    // Process winner payout from lobby wallet
    const winnerPlayer = match.players.find(p => p.id === winner.id);
    const lobbyData = lobby.getLobby(match.lobbyId);

    let payoutResult;
    try {
      payoutResult = await payments.sendWinnerPayout(
        lobbyData.deposit_private_key_encrypted,
        winnerPlayer.walletAddress,
        match.lobbyId
      );
    } catch (error) {
      console.error('Payout exception:', error);
      payoutResult = { success: false, error: error.message || 'Unknown payout error' };
    }

    if (payoutResult.success) {
      db.setMatchWinner(match.id, winner.id, 2.4, payoutResult.txHash);
    } else {
      console.error('Payout failed:', payoutResult.error);
      db.setMatchWinner(match.id, winner.id, 2.4, null);

      // Alert on payout failure - requires manual intervention
      sendAlert(AlertType.PAYOUT_FAILED, {
        lobbyId: match.lobbyId,
        matchId: match.id,
        winnerAddress: winnerPlayer.walletAddress,
        error: payoutResult.error,
      });
    }

    // Send activity alert for match completion
    sendAlert(AlertType.MATCH_COMPLETED, {
      lobbyId: match.lobbyId,
      matchId: match.id,
      winner: winnerPlayer.username,
      payoutSuccess: payoutResult.success,
      txHash: payoutResult.txHash || null,
    });

    // Send match end message
    const endMsg = protocol.createMatchEnd(winner.id, {
      winner: 2.4,
      treasury: 0.6,
    });
    broadcastToMatch(match, endMsg);
  } else {
    // No winner (void match)
    db.updateMatchStatus(match.id, 'void');
    match.status = 'void';

    // Process refunds
    await lobby.processTreasuryRefund(match.lobbyId, reason);
  }

  // Cleanup
  setTimeout(() => {
    activeMatches.delete(match.id);
    lobby.resetLobby(match.lobbyId);
  }, 5000); // Keep match data for 5 seconds for final messages

  console.log(`Match ${match.id} ended. Winner: ${winner?.id || 'none'}, Reason: ${reason}`);
}

/**
 * Void a match (for server crash, mass disconnect)
 */
async function voidMatch(matchId, reason) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  clearInterval(match.gameLoopInterval);
  match.status = 'void';
  db.updateMatchStatus(matchId, 'void');

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
    voidMatch(matchId, 'triple_disconnect');
  } else if (aliveCount === 2) {
    // Check if last 2 players disconnected
    const aliveAndConnected = match.players.filter(p => p.alive && p.connected);
    if (aliveAndConnected.length === 0) {
      voidMatch(matchId, 'double_disconnect');
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
};
