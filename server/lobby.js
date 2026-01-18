/**
 * Lobby management for RPS Arena
 * Handles lobby state, player joins, timeouts, and refunds
 */

const db = require('./database');
const wallet = require('./wallet');
const payments = require('./payments');
const protocol = require('./protocol');
const { sendAlert, AlertType } = require('./alerts');

// Active lobby data (in-memory for real-time updates)
const activeLobbies = new Map();

// Mutex locks for lobby operations (prevents race conditions)
const lobbyLocks = new Map();

// ============================================
// Initialization
// ============================================

/**
 * Initialize the 10 fixed lobbies
 * Called once on server startup
 */
async function initializeLobbies() {
  const lobbyCount = parseInt(process.env.LOBBY_COUNT || '10');
  const existingLobbies = db.getAllLobbies();

  if (existingLobbies.length === lobbyCount) {
    console.log(`Lobbies already initialized (${lobbyCount})`);
    // Load into memory
    for (const lobby of existingLobbies) {
      activeLobbies.set(lobby.id, {
        ...lobby,
        players: db.getLobbyPlayers(lobby.id),
        connections: new Map(), // userId -> WebSocket
      });
    }
    return;
  }

  // Generate lobby wallets from seed
  const mnemonic = process.env.LOBBY_WALLET_SEED;
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;

  if (!mnemonic || !encryptionKey) {
    console.warn('WARNING: LOBBY_WALLET_SEED or WALLET_ENCRYPTION_KEY not set');
    console.warn('Generating temporary wallets for development...');

    // For development, generate a temporary mnemonic
    const tempMnemonic = wallet.generateMnemonic();
    console.log('Development mnemonic (DO NOT USE IN PRODUCTION):', tempMnemonic);

    const lobbies = wallet.generateLobbyWallets(tempMnemonic, encryptionKey || 'dev-key', lobbyCount);
    db.initializeLobbies(lobbies);

    for (const lobby of lobbies) {
      activeLobbies.set(lobby.id, {
        id: lobby.id,
        status: 'empty',
        deposit_address: lobby.depositAddress,
        deposit_private_key_encrypted: lobby.encryptedPrivateKey,
        first_join_at: null,
        timeout_at: null,
        current_match_id: null,
        players: [],
        connections: new Map(),
      });
    }
  } else {
    const lobbies = wallet.generateLobbyWallets(mnemonic, encryptionKey, lobbyCount);
    db.initializeLobbies(lobbies);

    for (const lobby of lobbies) {
      activeLobbies.set(lobby.id, {
        id: lobby.id,
        status: 'empty',
        deposit_address: lobby.depositAddress,
        deposit_private_key_encrypted: lobby.encryptedPrivateKey,
        first_join_at: null,
        timeout_at: null,
        current_match_id: null,
        players: [],
        connections: new Map(),
      });
    }
  }

  console.log(`Initialized ${lobbyCount} lobbies`);
}

// ============================================
// Lobby Queries
// ============================================

/**
 * Get lobby list for client display
 */
function getLobbyList() {
  const lobbies = [];

  for (const [id, lobby] of activeLobbies) {
    const playerCount = lobby.players.filter(p => !p.refunded_at).length;
    const timeRemaining = lobby.timeout_at
      ? Math.max(0, new Date(lobby.timeout_at).getTime() - Date.now())
      : null;

    lobbies.push({
      id: lobby.id,
      status: lobby.status,
      playerCount,
      timeRemaining,
      depositAddress: lobby.deposit_address,
    });
  }

  return lobbies;
}

/**
 * Get a specific lobby
 */
function getLobby(lobbyId) {
  return activeLobbies.get(lobbyId);
}

/**
 * Get lobby a user is currently in
 */
function getPlayerLobby(userId) {
  for (const [id, lobby] of activeLobbies) {
    const player = lobby.players.find(p => p.user_id === userId && !p.refunded_at);
    if (player) {
      return { lobby, player };
    }
  }
  return null;
}

// ============================================
// Mutex Helpers
// ============================================

/**
 * Acquire a lock for a lobby (waits if already locked)
 * @param {number} lobbyId - Lobby ID
 * @returns {Promise<void>}
 */
async function acquireLobbyLock(lobbyId) {
  while (lobbyLocks.get(lobbyId)) {
    // Wait for lock to be released
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  lobbyLocks.set(lobbyId, true);
}

/**
 * Release a lock for a lobby
 * @param {number} lobbyId - Lobby ID
 */
function releaseLobbyLock(lobbyId) {
  lobbyLocks.delete(lobbyId);
}

// ============================================
// Join Flow
// ============================================

/**
 * Process a player joining a lobby
 * @param {string} userId - User's UUID
 * @param {number} lobbyId - Lobby ID (1-10)
 * @param {string} paymentTxHash - Transaction hash of USDC payment
 * @param {string} userWalletAddress - User's wallet address
 * @param {boolean} skipPayment - Whether to skip payment verification (admin port)
 * @returns {Object} { success, error, lobby }
 */
async function joinLobby(userId, lobbyId, paymentTxHash, userWalletAddress, skipPayment = false) {
  const lobby = activeLobbies.get(lobbyId);

  // Validation (before lock - quick checks)
  if (!lobby) {
    return { success: false, error: 'LOBBY_NOT_FOUND' };
  }

  // Acquire lock for this lobby to prevent race conditions
  await acquireLobbyLock(lobbyId);

  try {
    // Re-check conditions after acquiring lock
    if (lobby.status === 'in_progress') {
      return { success: false, error: 'LOBBY_FULL' };
    }

    const currentPlayerCount = lobby.players.filter(p => !p.refunded_at).length;
    if (currentPlayerCount >= 3) {
      return { success: false, error: 'LOBBY_FULL' };
    }

    // Check if user is already in a lobby
    const existingLobby = getPlayerLobby(userId);
    if (existingLobby) {
      return { success: false, error: 'ALREADY_IN_LOBBY' };
    }

    // Check for duplicate tx hash (skip check for admin port fake tx hashes)
    if (!skipPayment && db.txHashExists(paymentTxHash)) {
      return { success: false, error: 'PAYMENT_NOT_CONFIRMED' }; // Duplicate
    }

    // Check timeout
    if (lobby.timeout_at && new Date(lobby.timeout_at).getTime() < Date.now()) {
      return { success: false, error: 'LOBBY_TIMEOUT' };
    }

    // Verify payment on blockchain (skip on admin port)
    if (!skipPayment) {
      const verification = await payments.verifyPayment(
        paymentTxHash,
        lobby.deposit_address,
        userWalletAddress,
        payments.BUY_IN_AMOUNT
      );

      if (!verification.valid) {
        console.log('Payment verification failed:', verification.error);
        return { success: false, error: 'PAYMENT_NOT_CONFIRMED' };
      }
    } else {
      console.log('ADMIN PORT: Skipping payment verification');
    }

    // Final check - lobby hasn't filled (shouldn't happen with lock, but defensive)
    const recheckCount = lobby.players.filter(p => !p.refunded_at).length;
    if (recheckCount >= 3) {
      return { success: false, error: 'LOBBY_FULL' };
    }

    // Add player to database and memory
    const user = db.getUserById(userId);
    const lobbyPlayer = db.addLobbyPlayer(lobbyId, userId, paymentTxHash);

    // Handle duplicate tx hash (race condition safe via UNIQUE constraint)
    if (lobbyPlayer?.error === 'DUPLICATE_TX_HASH') {
      return { success: false, error: 'DUPLICATE_TX_HASH' };
    }
    if (!lobbyPlayer) {
      return { success: false, error: 'DATABASE_ERROR' };
    }

    lobby.players.push({
      ...lobbyPlayer,
      wallet_address: user.wallet_address,
      username: user.username,
    });

    // Update lobby state
    if (lobby.status === 'empty') {
      db.setLobbyFirstJoin(lobbyId);
      const updatedLobby = db.getLobby(lobbyId);
      lobby.status = 'waiting';
      lobby.first_join_at = updatedLobby.first_join_at;
      lobby.timeout_at = updatedLobby.timeout_at;
    }

    // Check if lobby is now full
    const newPlayerCount = lobby.players.filter(p => !p.refunded_at).length;
    if (newPlayerCount === 3) {
      lobby.status = 'ready';
      db.updateLobbyStatus(lobbyId, 'ready');
    }

    console.log(`Player ${userId} joined lobby ${lobbyId} (${newPlayerCount}/3)`);

    // Clear stuck lobby alert since there's activity
    stuckLobbyAlerts.delete(lobbyId);

    // Send activity alert (only for paid joins on production port)
    if (!skipPayment) {
      sendAlert(AlertType.PLAYER_JOINED, {
        lobbyId,
        playerCount: newPlayerCount,
        username: user.username,
        walletAddress: user.wallet_address,
      }).catch(err => console.error('Alert send failed:', err.message));
    }

    return { success: true, lobby };
  } finally {
    // Always release the lock
    releaseLobbyLock(lobbyId);
  }
}

/**
 * Register a WebSocket connection for a player in a lobby
 */
function registerConnection(lobbyId, userId, ws) {
  const lobby = activeLobbies.get(lobbyId);
  if (lobby) {
    lobby.connections.set(userId, ws);
  }
}

/**
 * Remove a WebSocket connection and clean up player if no active match
 *
 * When a player disconnects before a match starts (status: waiting/ready),
 * we remove them from the lobby to free up the slot. They can still request
 * a refund via the timeout mechanism or by reconnecting.
 */
function removeConnection(lobbyId, userId) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return;

  lobby.connections.delete(userId);

  // Only clean up player slot if lobby is not in an active match
  // During in_progress, player stays in match even if disconnected
  if (lobby.status === 'waiting' || lobby.status === 'ready') {
    const playerIndex = lobby.players.findIndex(p => p.user_id === userId && !p.refunded_at);
    if (playerIndex !== -1) {
      console.log(`[DISCONNECT] Player ${userId} left lobby ${lobbyId} (status: ${lobby.status})`);

      // Remove from in-memory lobby (DB record stays for refund eligibility)
      lobby.players.splice(playerIndex, 1);

      // Update lobby status based on remaining connected players
      const remainingPlayers = lobby.players.filter(p => !p.refunded_at).length;

      if (remainingPlayers === 0) {
        // Lobby is now empty - reset it
        lobby.status = 'empty';
        lobby.first_join_at = null;
        lobby.timeout_at = null;
        db.resetLobby(lobbyId);
        console.log(`[DISCONNECT] Lobby ${lobbyId} reset to empty`);
      } else if (lobby.status === 'ready' && remainingPlayers < 3) {
        // Was ready but now missing players
        lobby.status = 'waiting';
        db.updateLobbyStatus(lobbyId, 'waiting');
        console.log(`[DISCONNECT] Lobby ${lobbyId} reverted to waiting (${remainingPlayers}/3)`);
      }
    }
  }
}

// ============================================
// Refunds
// ============================================

/**
 * Process timeout refund for a lobby
 * @param {number} lobbyId - Lobby ID
 * @param {string} requestingUserId - User requesting the refund
 * @returns {Object} { success, error, refunds }
 */
async function processTimeoutRefund(lobbyId, requestingUserId) {
  const lobby = activeLobbies.get(lobbyId);

  if (!lobby) {
    return { success: false, error: 'LOBBY_NOT_FOUND' };
  }

  // Acquire lock to prevent double refunds
  await acquireLobbyLock(lobbyId);

  try {
    // Re-check conditions after acquiring lock
    // Verify user is in this lobby
    const player = lobby.players.find(p => p.user_id === requestingUserId && !p.refunded_at);
    if (!player) {
      return { success: false, error: 'NOT_IN_LOBBY' };
    }

    // Check if refund is available (timeout passed and match not started)
    if (lobby.status === 'in_progress') {
      return { success: false, error: 'REFUND_NOT_AVAILABLE' };
    }

    if (!lobby.timeout_at || new Date(lobby.timeout_at).getTime() > Date.now()) {
      return { success: false, error: 'REFUND_NOT_AVAILABLE' };
    }

    // Process refunds for all players
    const refunds = [];
    const playersToRefund = lobby.players.filter(p => !p.refunded_at);

    for (const p of playersToRefund) {
      let result;
      try {
        result = await payments.sendRefundFromLobby(
          lobby.deposit_private_key_encrypted,
          p.wallet_address,
          lobbyId
        );
      } catch (error) {
        console.error(`Refund exception for player ${p.user_id}:`, error);
        result = { success: false, error: error.message || 'Unknown refund error' };
      }

      if (result.success) {
        db.markPlayerRefunded(p.id, 'timeout', result.txHash);
        p.refunded_at = new Date().toISOString();
        p.refund_reason = 'timeout';
        p.refund_tx_hash = result.txHash;

        refunds.push({
          userId: p.user_id,
          username: p.username || protocol.truncateAddress(p.wallet_address),
          amount: 1,
          txHash: result.txHash,
        });
      } else {
        console.error(`Failed to refund player ${p.user_id}:`, result.error);

        // Alert on refund failure
        sendAlert(AlertType.REFUND_FAILED, {
          lobbyId,
          playerAddress: p.wallet_address,
          error: result.error,
        }).catch(err => console.error('Alert send failed:', err.message));
      }
    }

    // Reset lobby
    resetLobby(lobbyId);

    return { success: true, refunds };
  } finally {
    releaseLobbyLock(lobbyId);
  }
}

/**
 * Process refund from treasury (for server crash, mass disconnect)
 * @param {number} lobbyId - Lobby ID
 * @param {string} reason - Refund reason
 * @returns {Object} { success, refunds }
 */
async function processTreasuryRefund(lobbyId, reason) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return { success: false, refunds: [] };

  // Acquire lock to prevent double refunds
  await acquireLobbyLock(lobbyId);

  try {
    const refunds = [];
    const playersToRefund = lobby.players.filter(p => !p.refunded_at);

    for (const p of playersToRefund) {
      let result;
      try {
        result = await payments.sendRefundFromTreasury(p.wallet_address);
      } catch (error) {
        console.error(`Treasury refund exception for player ${p.user_id}:`, error);
        result = { success: false, error: error.message || 'Unknown refund error' };
      }

      if (result.success) {
        db.markPlayerRefunded(p.id, reason, result.txHash);
        p.refunded_at = new Date().toISOString();
        p.refund_reason = reason;
        p.refund_tx_hash = result.txHash;

        refunds.push({
          userId: p.user_id,
          username: p.username || protocol.truncateAddress(p.wallet_address),
          amount: 1,
          txHash: result.txHash,
        });
      } else {
        console.error(`Failed to refund player ${p.user_id}:`, result.error);

        // Alert on refund failure
        sendAlert(AlertType.REFUND_FAILED, {
          lobbyId,
          playerAddress: p.wallet_address,
          error: result.error,
        }).catch(err => console.error('Alert send failed:', err.message));
      }
    }

    resetLobby(lobbyId);

    return { success: true, refunds };
  } finally {
    releaseLobbyLock(lobbyId);
  }
}

// ============================================
// Lobby State Management
// ============================================

/**
 * Reset a lobby to empty state
 */
function resetLobby(lobbyId) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return;

  db.resetLobby(lobbyId);
  db.clearLobbyPlayers(lobbyId);

  lobby.status = 'empty';
  lobby.first_join_at = null;
  lobby.timeout_at = null;
  lobby.current_match_id = null;
  lobby.players = [];
  lobby.connections.clear();

  console.log(`Lobby ${lobbyId} reset to empty`);
}

/**
 * Force reset a lobby (dev mode only) - works even during in_progress
 */
function forceResetLobby(lobbyId) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) {
    console.log(`Lobby ${lobbyId} not found for force reset`);
    return;
  }

  // Close all WebSocket connections gracefully
  for (const [userId, ws] of lobby.connections) {
    if (ws && ws.readyState === 1) {
      ws.close(4000, 'Lobby reset by admin');
    }
  }

  db.resetLobby(lobbyId);
  db.clearLobbyPlayers(lobbyId);

  lobby.status = 'empty';
  lobby.first_join_at = null;
  lobby.timeout_at = null;
  lobby.current_match_id = null;
  lobby.players = [];
  lobby.connections.clear();

  console.log(`Lobby ${lobbyId} force reset (dev mode)`);
}

/**
 * Set lobby to in_progress when match starts
 */
function setLobbyInProgress(lobbyId, matchId) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return;

  db.updateLobbyStatus(lobbyId, 'in_progress', matchId);
  lobby.status = 'in_progress';
  lobby.current_match_id = matchId;
}

/**
 * Broadcast a message to all players in a lobby
 */
function broadcastToLobby(lobbyId, message) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return;

  for (const [userId, ws] of lobby.connections) {
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
    }
  }
}

// ============================================
// Timeout Checker
// ============================================

/**
 * Check for lobbies that have timed out
 * Run periodically to enable refund buttons
 */
function checkTimeouts() {
  const now = Date.now();

  for (const [id, lobby] of activeLobbies) {
    if (lobby.status === 'waiting' && lobby.timeout_at) {
      const timeoutTime = new Date(lobby.timeout_at).getTime();
      if (now >= timeoutTime) {
        // Notify clients that refund is available
        const timeRemaining = 0;
        const message = protocol.createLobbyUpdate(
          lobby.id,
          lobby.players.filter(p => !p.refunded_at),
          lobby.status,
          timeRemaining,
          lobby.deposit_address
        );
        broadcastToLobby(id, message);
      }
    }
  }
}

// Track which lobbies we've already alerted about (Map: lobbyId -> timestamp)
const stuckLobbyAlerts = new Map();
const STUCK_ALERT_RENOTIFY_MS = 24 * 60 * 60 * 1000; // Re-alert after 24 hours if still stuck

/**
 * Check for lobbies stuck in waiting or in_progress for too long (2+ hours)
 * Alerts admin for manual review
 */
function checkStuckLobbies() {
  const now = Date.now();
  const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

  for (const [id, lobby] of activeLobbies) {
    if (lobby.status === 'waiting' || lobby.status === 'in_progress') {
      if (!lobby.first_join_at) continue;

      const firstJoinTime = new Date(lobby.first_join_at).getTime();
      const duration = now - firstJoinTime;

      const lastAlertTime = stuckLobbyAlerts.get(id);
      const shouldAlert = duration >= STUCK_THRESHOLD_MS &&
        (!lastAlertTime || (now - lastAlertTime) >= STUCK_ALERT_RENOTIFY_MS);

      if (shouldAlert) {
        // Mark as alerted with timestamp
        stuckLobbyAlerts.set(id, now);

        const hours = Math.floor(duration / (60 * 60 * 1000));
        const minutes = Math.floor((duration % (60 * 60 * 1000)) / (60 * 1000));

        sendAlert(AlertType.LOBBY_STUCK, {
          lobbyId: id,
          status: lobby.status,
          playerCount: lobby.players.length,
          duration: `${hours}h ${minutes}m`,
          depositAddress: lobby.deposit_address,
        }).catch(err => console.error('Alert send failed:', err.message));
      }
    } else {
      // Clear alert tracking when lobby resets
      stuckLobbyAlerts.delete(id);
    }
  }
}

/**
 * Cleanup stale entries from stuckLobbyAlerts (lobbies no longer active)
 */
function cleanupStuckLobbyAlerts() {
  for (const lobbyId of stuckLobbyAlerts.keys()) {
    if (!activeLobbies.has(lobbyId)) {
      stuckLobbyAlerts.delete(lobbyId);
    }
  }
}

// Run timeout checker every 10 seconds
setInterval(checkTimeouts, 10000);

// Run stuck lobby checker every 5 minutes
setInterval(checkStuckLobbies, 5 * 60 * 1000);

// Cleanup stale stuck lobby alerts every hour
setInterval(cleanupStuckLobbyAlerts, 60 * 60 * 1000);

// ============================================
// Exports
// ============================================

module.exports = {
  initializeLobbies,
  getLobbyList,
  getLobby,
  getPlayerLobby,
  joinLobby,
  registerConnection,
  removeConnection,
  processTimeoutRefund,
  processTreasuryRefund,
  resetLobby,
  forceResetLobby,
  setLobbyInProgress,
  broadcastToLobby,
  acquireLobbyLock,
  releaseLobbyLock,
};
