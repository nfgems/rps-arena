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

// MEDIUM-5 FIX: Track refund attempts per player to prevent infinite retries
// Map of lobbyPlayerId -> { attempts: number, lastAttempt: timestamp }
const refundAttempts = new Map();
const MAX_REFUND_ATTEMPTS = 5;
const REFUND_ATTEMPT_RESET_MS = 60 * 60 * 1000; // Reset attempts after 1 hour

// ============================================
// Initialization
// ============================================

/**
 * Initialize the 12 fixed lobbies
 * Called once on server startup
 */
async function initializeLobbies() {
  const lobbyCount = parseInt(process.env.LOBBY_COUNT || '12');
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
 * @returns {Array<{id: number, status: string, playerCount: number, timeRemaining: number|null, depositAddress: string}>}
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
 * Get a specific lobby by ID
 * @param {number} lobbyId - Lobby ID (1-12)
 * @returns {Object|undefined} Lobby data or undefined if not found
 */
function getLobby(lobbyId) {
  return activeLobbies.get(lobbyId);
}

/**
 * Get lobby a user is currently in
 * @param {string} userId - User's UUID
 * @returns {{lobby: Object, player: Object}|null} Lobby and player data, or null if not in a lobby
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
 * @param {number} lobbyId - Lobby ID (1-12)
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

    // Track wallet for airdrop list (only for real payments)
    if (!skipPayment) {
      db.trackPaidWallet(user.wallet_address);
    }

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
 * @param {number} lobbyId - Lobby ID
 * @param {string} userId - User's UUID
 * @param {WebSocket} ws - WebSocket connection
 */
function registerConnection(lobbyId, userId, ws) {
  const lobby = activeLobbies.get(lobbyId);
  if (lobby) {
    lobby.connections.set(userId, ws);
  }
}

/**
 * Remove a WebSocket connection from a lobby
 *
 * Players who have paid remain in the lobby even when disconnected - they can
 * reconnect and resume their spot. Players are only removed from the lobby when:
 * - They explicitly request a refund
 * - The lobby timeout expires and refunds are processed
 * - The match ends
 *
 * @param {number} lobbyId - Lobby ID
 * @param {string} userId - User's UUID
 */
function removeConnection(lobbyId, userId) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return;

  lobby.connections.delete(userId);
  console.log(`[DISCONNECT] Player ${userId} disconnected from lobby ${lobbyId} (status: ${lobby.status})`);

  // Player stays in lobby - they paid and can reconnect
  // Only refund/removal mechanisms should remove players from the lobby
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

    // HIGH-3 FIX: Check if refund is available (timeout passed and match not started/starting)
    // Block refunds when lobby is 'ready' (match about to start) OR 'in_progress' (match running)
    // This closes the race window between lobby becoming ready and match actually starting
    if (lobby.status === 'in_progress' || lobby.status === 'ready') {
      return { success: false, error: 'REFUND_NOT_AVAILABLE' };
    }

    if (!lobby.timeout_at || new Date(lobby.timeout_at).getTime() > Date.now()) {
      return { success: false, error: 'REFUND_NOT_AVAILABLE' };
    }

    // Process refunds for all players
    const refunds = [];
    const playersToRefund = lobby.players.filter(p => !p.refunded_at);

    for (const p of playersToRefund) {
      // MEDIUM-5 FIX: Check and track refund attempts
      const attemptKey = `${lobbyId}-${p.id}`;
      const attemptData = refundAttempts.get(attemptKey) || { attempts: 0, lastAttempt: 0 };

      // Reset attempts if enough time has passed
      if (Date.now() - attemptData.lastAttempt > REFUND_ATTEMPT_RESET_MS) {
        attemptData.attempts = 0;
      }

      // Check if max attempts exceeded
      if (attemptData.attempts >= MAX_REFUND_ATTEMPTS) {
        console.error(`[REFUND] Max attempts (${MAX_REFUND_ATTEMPTS}) exceeded for player ${p.user_id} in lobby ${lobbyId}`);

        sendAlert(AlertType.REFUND_FAILED, {
          lobbyId,
          playerAddress: p.wallet_address,
          error: `Max refund attempts (${MAX_REFUND_ATTEMPTS}) exceeded - MANUAL INTERVENTION REQUIRED`,
          attempts: attemptData.attempts,
          critical: true,
        }).catch(err => console.error('Alert send failed:', err.message));

        continue;
      }

      // Track this attempt
      attemptData.attempts++;
      attemptData.lastAttempt = Date.now();
      refundAttempts.set(attemptKey, attemptData);

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

        // Clear attempt tracking on success
        refundAttempts.delete(attemptKey);

        refunds.push({
          userId: p.user_id,
          username: p.username || protocol.truncateAddress(p.wallet_address),
          amount: 1,
          txHash: result.txHash,
        });
      } else {
        console.error(`Failed to refund player ${p.user_id} (attempt ${attemptData.attempts}/${MAX_REFUND_ATTEMPTS}):`, result.error);

        // Alert on refund failure
        sendAlert(AlertType.REFUND_FAILED, {
          lobbyId,
          playerAddress: p.wallet_address,
          error: result.error,
          attempts: attemptData.attempts,
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
 * Process refunds from lobby wallet (for server crash, void, timeouts, etc.)
 * Refunds come from the lobby wallet since that's where player deposits went.
 * @param {number} lobbyId - Lobby ID
 * @param {string} reason - Refund reason
 * @returns {Object} { success, refunds }
 */
async function processLobbyRefund(lobbyId, reason) {
  const lobby = activeLobbies.get(lobbyId);
  if (!lobby) return { success: false, refunds: [] };

  // Acquire lock to prevent double refunds
  await acquireLobbyLock(lobbyId);

  try {
    const refunds = [];
    const playersToRefund = lobby.players.filter(p => !p.refunded_at);

    for (const p of playersToRefund) {
      // MEDIUM-5 FIX: Check and track refund attempts
      const attemptKey = `${lobbyId}-${p.id}`;
      const attemptData = refundAttempts.get(attemptKey) || { attempts: 0, lastAttempt: 0 };

      // Reset attempts if enough time has passed
      if (Date.now() - attemptData.lastAttempt > REFUND_ATTEMPT_RESET_MS) {
        attemptData.attempts = 0;
      }

      // Check if max attempts exceeded
      if (attemptData.attempts >= MAX_REFUND_ATTEMPTS) {
        console.error(`[REFUND] Max attempts (${MAX_REFUND_ATTEMPTS}) exceeded for player ${p.user_id} in lobby ${lobbyId}`);

        // Send critical alert - manual intervention required
        sendAlert(AlertType.REFUND_FAILED, {
          lobbyId,
          playerAddress: p.wallet_address,
          error: `Max refund attempts (${MAX_REFUND_ATTEMPTS}) exceeded - MANUAL INTERVENTION REQUIRED`,
          attempts: attemptData.attempts,
          critical: true,
        }).catch(err => console.error('Alert send failed:', err.message));

        continue; // Skip this player, don't attempt refund
      }

      // Track this attempt
      attemptData.attempts++;
      attemptData.lastAttempt = Date.now();
      refundAttempts.set(attemptKey, attemptData);

      let result;
      try {
        // Use lobby wallet for refunds - the USDC is already there from deposits
        result = await payments.sendRefundFromLobby(
          lobby.deposit_private_key_encrypted,
          p.wallet_address,
          lobbyId
        );
      } catch (error) {
        console.error(`Lobby refund exception for player ${p.user_id}:`, error);
        result = { success: false, error: error.message || 'Unknown refund error' };
      }

      if (result.success) {
        db.markPlayerRefunded(p.id, reason, result.txHash);
        p.refunded_at = new Date().toISOString();
        p.refund_reason = reason;
        p.refund_tx_hash = result.txHash;

        // Clear attempt tracking on success
        refundAttempts.delete(attemptKey);

        refunds.push({
          userId: p.user_id,
          username: p.username || protocol.truncateAddress(p.wallet_address),
          amount: 1,
          txHash: result.txHash,
        });
      } else {
        console.error(`Failed to refund player ${p.user_id} (attempt ${attemptData.attempts}/${MAX_REFUND_ATTEMPTS}):`, result.error);

        // Alert on refund failure
        sendAlert(AlertType.REFUND_FAILED, {
          lobbyId,
          playerAddress: p.wallet_address,
          error: result.error,
          attempts: attemptData.attempts,
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
 * @param {number} lobbyId - Lobby ID
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
 * Closes all WebSocket connections and resets the lobby state
 * @param {number} lobbyId - Lobby ID
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
 * @param {number} lobbyId - Lobby ID
 * @param {string} matchId - Match UUID
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
 * @param {number} lobbyId - Lobby ID
 * @param {string} message - JSON message string to send
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
 * Notifies clients when timeout has been reached so refund button can be shown
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
 * Alerts admin for manual review via Discord webhook
 * Re-alerts every 24 hours if still stuck
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
  processLobbyRefund,
  resetLobby,
  forceResetLobby,
  setLobbyInProgress,
  broadcastToLobby,
  acquireLobbyLock,
  releaseLobbyLock,
};
