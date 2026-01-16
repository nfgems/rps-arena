/**
 * Lobby management for RPS Arena
 * Handles lobby state, player joins, timeouts, and refunds
 */

const db = require('./database');
const wallet = require('./wallet');
const payments = require('./payments');
const protocol = require('./protocol');

// Active lobby data (in-memory for real-time updates)
const activeLobbies = new Map();

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
// Join Flow
// ============================================

/**
 * Process a player joining a lobby
 * @param {string} userId - User's UUID
 * @param {number} lobbyId - Lobby ID (1-10)
 * @param {string} paymentTxHash - Transaction hash of USDC payment
 * @param {string} userWalletAddress - User's wallet address
 * @returns {Object} { success, error, lobby }
 */
async function joinLobby(userId, lobbyId, paymentTxHash, userWalletAddress) {
  const lobby = activeLobbies.get(lobbyId);

  // Validation
  if (!lobby) {
    return { success: false, error: 'LOBBY_NOT_FOUND' };
  }

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

  // Check for duplicate tx hash
  if (db.txHashExists(paymentTxHash)) {
    return { success: false, error: 'PAYMENT_NOT_CONFIRMED' }; // Duplicate
  }

  // Check timeout
  if (lobby.timeout_at && new Date(lobby.timeout_at).getTime() < Date.now()) {
    return { success: false, error: 'LOBBY_TIMEOUT' };
  }

  // Verify payment on blockchain (skip in dev mode)
  const devMode = process.env.NODE_ENV !== 'production' && process.env.DEV_MODE === 'true';

  if (!devMode) {
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
    console.log('DEV_MODE: Skipping payment verification');
  }

  // Double-check lobby hasn't filled while we were verifying
  const recheckCount = lobby.players.filter(p => !p.refunded_at).length;
  if (recheckCount >= 3) {
    return { success: false, error: 'LOBBY_FULL' };
  }

  // Add player to database and memory
  const user = db.getUserById(userId);
  const lobbyPlayer = db.addLobbyPlayer(lobbyId, userId, paymentTxHash);

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

  return { success: true, lobby };
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
 * Remove a WebSocket connection
 */
function removeConnection(lobbyId, userId) {
  const lobby = activeLobbies.get(lobbyId);
  if (lobby) {
    lobby.connections.delete(userId);
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
    const result = await payments.sendRefundFromLobby(
      lobby.deposit_private_key_encrypted,
      p.wallet_address
    );

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
    }
  }

  // Reset lobby
  resetLobby(lobbyId);

  return { success: true, refunds };
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

  const refunds = [];
  const playersToRefund = lobby.players.filter(p => !p.refunded_at);

  for (const p of playersToRefund) {
    const result = await payments.sendRefundFromTreasury(p.wallet_address);

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
    }
  }

  resetLobby(lobbyId);

  return { success: true, refunds };
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
    if (ws.readyState === 1) {
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
    if (ws.readyState === 1) { // WebSocket.OPEN
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

// Run timeout checker every 10 seconds
setInterval(checkTimeouts, 10000);

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
};
