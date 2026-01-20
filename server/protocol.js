/**
 * WebSocket Protocol for RPS Arena
 * Message serialization and parsing
 */

// ============================================
// Message Types
// ============================================

const ClientMessages = {
  HELLO: 'HELLO',
  JOIN_LOBBY: 'JOIN_LOBBY',
  REQUEST_REFUND: 'REQUEST_REFUND',
  PING: 'PING',
  INPUT: 'INPUT',
};

const ServerMessages = {
  WELCOME: 'WELCOME',
  LOBBY_LIST: 'LOBBY_LIST',
  LOBBY_UPDATE: 'LOBBY_UPDATE',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  MATCH_STARTING: 'MATCH_STARTING',
  ROLE_ASSIGNMENT: 'ROLE_ASSIGNMENT',
  COUNTDOWN: 'COUNTDOWN',
  SNAPSHOT: 'SNAPSHOT',
  ELIMINATION: 'ELIMINATION',
  BOUNCE: 'BOUNCE',
  MATCH_END: 'MATCH_END',
  PONG: 'PONG',
  ERROR: 'ERROR',
  PLAYER_DISCONNECT: 'PLAYER_DISCONNECT',
  PLAYER_RECONNECT: 'PLAYER_RECONNECT',
  RECONNECT_STATE: 'RECONNECT_STATE',
  TOKEN_UPDATE: 'TOKEN_UPDATE',
  SHOWDOWN_START: 'SHOWDOWN_START',
  SHOWDOWN_READY: 'SHOWDOWN_READY',
  HEART_CAPTURED: 'HEART_CAPTURED',
};

// ============================================
// Error Codes
// ============================================

const ErrorCodes = {
  INVALID_SESSION: { code: 1001, message: 'Session token invalid or expired' },
  SESSION_EXPIRED: { code: 1002, message: 'Session has expired, re-authenticate' },
  LOBBY_NOT_FOUND: { code: 2001, message: "Lobby ID doesn't exist" },
  LOBBY_FULL: { code: 2002, message: 'Lobby already has 3 players' },
  ALREADY_IN_LOBBY: { code: 2003, message: 'Player is already in a lobby' },
  LOBBY_TIMEOUT: { code: 2004, message: 'Lobby timeout expired, cannot join' },
  PAYMENT_NOT_CONFIRMED: { code: 2005, message: 'Payment transaction not found or not confirmed' },
  REFUND_NOT_AVAILABLE: { code: 2006, message: 'Refund only available after 1-hour timeout' },
  NOT_IN_LOBBY: { code: 2007, message: 'Player not in this lobby' },
  PAYMENT_FAILED: { code: 3001, message: 'Buy-in payment failed' },
  INSUFFICIENT_BALANCE: { code: 3002, message: 'Wallet has insufficient USDC' },
  MATCH_NOT_FOUND: { code: 4001, message: "Match ID doesn't exist" },
  NOT_IN_MATCH: { code: 4002, message: 'Player not part of this match' },
  RATE_LIMITED: { code: 5001, message: 'Too many requests, slow down' },
  INTERNAL_ERROR: { code: 9999, message: 'Server error, try again' },
};

// ============================================
// Validation Constants
// ============================================

// Arena bounds (must match physics.js)
const ARENA_WIDTH = parseInt(process.env.GAME_ARENA_WIDTH || '1600');
const ARENA_HEIGHT = parseInt(process.env.GAME_ARENA_HEIGHT || '900');
const LOBBY_COUNT = parseInt(process.env.LOBBY_COUNT || '12');

// Ethereum transaction hash regex: 0x followed by 64 hex characters
const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

// Admin/dev mode tx hash patterns (used on admin port only)
const ADMIN_TX_HASH_REGEX = /^0x(dev_|bot_tx_)[a-zA-Z0-9_]+$/;

// Valid client message types whitelist
const VALID_CLIENT_MESSAGE_TYPES = new Set(Object.values(ClientMessages));

// ============================================
// Validation Helpers
// ============================================

/**
 * Check if value is a finite number
 * @param {*} value - Value to check
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Check if value is a positive integer
 * @param {*} value - Value to check
 * @returns {boolean}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Check if value is a non-negative integer
 * @param {*} value - Value to check
 * @returns {boolean}
 */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate Ethereum transaction hash format
 * @param {*} txHash - Transaction hash to validate
 * @param {boolean} isAdmin - Whether this is from the admin port (allows dev/bot tx hashes)
 * @returns {boolean}
 */
function isValidTxHash(txHash, isAdmin = false) {
  if (typeof txHash !== 'string') return false;
  // Always accept real Ethereum tx hashes
  if (TX_HASH_REGEX.test(txHash)) return true;
  // Only accept admin/dev mode fake hashes on admin port
  return isAdmin && ADMIN_TX_HASH_REGEX.test(txHash);
}

/**
 * Validate lobby ID
 * @param {*} lobbyId - Lobby ID to validate
 * @returns {boolean}
 */
function isValidLobbyId(lobbyId) {
  return isPositiveInteger(lobbyId) && lobbyId >= 1 && lobbyId <= LOBBY_COUNT;
}

/**
 * Validate coordinate is within arena bounds
 * @param {*} value - Coordinate value
 * @param {number} max - Maximum value (ARENA_WIDTH or ARENA_HEIGHT)
 * @returns {boolean}
 */
function isValidCoordinate(value, max) {
  return isFiniteNumber(value) && value >= 0 && value <= max;
}

// ============================================
// Message Schema Validators
// ============================================

/**
 * Validate HELLO message
 * @param {Object} message - Message to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateHello(message) {
  if (typeof message.sessionToken !== 'string' || message.sessionToken.length === 0) {
    return { valid: false, error: 'Invalid or missing sessionToken' };
  }
  return { valid: true };
}

/**
 * Validate JOIN_LOBBY message
 * @param {Object} message - Message to validate
 * @param {Object} context - Validation context
 * @param {boolean} context.isAdmin - Whether this is from the admin port
 * @returns {{valid: boolean, error?: string}}
 */
function validateJoinLobby(message, context = {}) {
  if (!isValidLobbyId(message.lobbyId)) {
    return { valid: false, error: `Invalid lobbyId: must be integer 1-${LOBBY_COUNT}` };
  }
  if (!isValidTxHash(message.paymentTxHash, context.isAdmin)) {
    return { valid: false, error: 'Invalid paymentTxHash: must be 0x + 64 hex characters' };
  }
  return { valid: true };
}

/**
 * Validate REQUEST_REFUND message
 * @param {Object} message - Message to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateRequestRefund(message) {
  // REQUEST_REFUND doesn't require additional fields beyond type
  // The lobbyId is determined server-side from player state
  return { valid: true };
}

/**
 * Validate PING message
 * @param {Object} message - Message to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validatePing(message) {
  // clientTime is optional but if present should be a number
  if (message.clientTime !== undefined && !isFiniteNumber(message.clientTime)) {
    return { valid: false, error: 'Invalid clientTime: must be a number' };
  }
  return { valid: true };
}

/**
 * Validate INPUT message (direction-based movement)
 * @param {Object} message - Message to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateInput(message) {
  // dirX and dirY must be -1, 0, or 1
  if (typeof message.dirX !== 'number' || ![-1, 0, 1].includes(message.dirX)) {
    return { valid: false, error: 'Invalid dirX: must be -1, 0, or 1' };
  }
  if (typeof message.dirY !== 'number' || ![-1, 0, 1].includes(message.dirY)) {
    return { valid: false, error: 'Invalid dirY: must be -1, 0, or 1' };
  }
  if (!isNonNegativeInteger(message.sequence)) {
    return { valid: false, error: 'Invalid sequence: must be non-negative integer' };
  }
  return { valid: true };
}

// Message type to validator mapping
const MESSAGE_VALIDATORS = {
  [ClientMessages.HELLO]: validateHello,
  [ClientMessages.JOIN_LOBBY]: validateJoinLobby,
  [ClientMessages.REQUEST_REFUND]: validateRequestRefund,
  [ClientMessages.PING]: validatePing,
  [ClientMessages.INPUT]: validateInput,
};

// ============================================
// Message Parsing
// ============================================

/**
 * Parse and validate incoming WebSocket message
 * @param {string} data - Raw message string
 * @param {Object} context - Validation context (e.g., { isAdmin: true })
 * @returns {{message: Object|null, error?: string}} Parsed message or null with error
 */
function parseMessage(data, context = {}) {
  // Parse JSON
  let message;
  try {
    message = JSON.parse(data);
  } catch (error) {
    return { message: null, error: 'Invalid JSON' };
  }

  // Check message is an object
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { message: null, error: 'Message must be an object' };
  }

  // Check type field exists and is a string
  if (typeof message.type !== 'string') {
    return { message: null, error: 'Missing or invalid message type' };
  }

  // Validate against whitelist
  if (!VALID_CLIENT_MESSAGE_TYPES.has(message.type)) {
    return { message: null, error: `Unknown message type: ${message.type}` };
  }

  // Run schema validation for this message type
  const validator = MESSAGE_VALIDATORS[message.type];
  if (validator) {
    const validation = validator(message, context);
    if (!validation.valid) {
      return { message: null, error: validation.error };
    }
  }

  return { message };
}

// ============================================
// Message Creation (Server -> Client)
// ============================================

function createWelcome(userId, serverTime) {
  return JSON.stringify({
    type: ServerMessages.WELCOME,
    userId,
    serverTime,
  });
}

function createLobbyList(lobbies) {
  return JSON.stringify({
    type: ServerMessages.LOBBY_LIST,
    lobbies: lobbies.map(l => ({
      id: l.id,
      status: l.status,
      playerCount: l.playerCount,
      timeRemaining: l.timeRemaining,
      depositAddress: l.depositAddress,
    })),
  });
}

function createLobbyUpdate(lobbyId, players, status, timeRemaining, depositAddress) {
  return JSON.stringify({
    type: ServerMessages.LOBBY_UPDATE,
    lobbyId,
    players: players.map(p => ({
      id: p.id,
      username: p.username || truncateAddress(p.wallet_address),
    })),
    status,
    timeRemaining,
    depositAddress,
  });
}

function createRefundProcessed(lobbyId, reason, players) {
  return JSON.stringify({
    type: ServerMessages.REFUND_PROCESSED,
    lobbyId,
    reason,
    players: players.map(p => ({
      userId: p.userId,
      username: p.username,
      amount: p.amount,
      txHash: p.txHash,
    })),
  });
}

function createMatchStarting(matchId, countdown) {
  return JSON.stringify({
    type: ServerMessages.MATCH_STARTING,
    matchId,
    countdown,
  });
}

function createRoleAssignment(role, spawnX, spawnY) {
  return JSON.stringify({
    type: ServerMessages.ROLE_ASSIGNMENT,
    role,
    spawnX,
    spawnY,
  });
}

function createCountdown(secondsRemaining) {
  return JSON.stringify({
    type: ServerMessages.COUNTDOWN,
    secondsRemaining,
  });
}

function createSnapshot(tick, players) {
  return JSON.stringify({
    type: ServerMessages.SNAPSHOT,
    tick,
    players: players.map(p => ({
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      alive: p.alive,
      role: p.role,
    })),
  });
}

function createElimination(tick, eliminatedId, eliminatorId) {
  return JSON.stringify({
    type: ServerMessages.ELIMINATION,
    tick,
    eliminatedId,
    eliminatorId,
  });
}

function createBounce(tick, players) {
  return JSON.stringify({
    type: ServerMessages.BOUNCE,
    tick,
    players: players.map(p => ({
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
    })),
  });
}

function createMatchEnd(winnerId, payout) {
  return JSON.stringify({
    type: ServerMessages.MATCH_END,
    winnerId,
    payout: {
      winner: payout.winner,
      treasury: payout.treasury,
    },
  });
}

function createPong(serverTime, yourPing) {
  return JSON.stringify({
    type: ServerMessages.PONG,
    serverTime,
    yourPing,
  });
}

function createError(errorKey) {
  const error = ErrorCodes[errorKey] || ErrorCodes.INTERNAL_ERROR;
  return JSON.stringify({
    type: ServerMessages.ERROR,
    code: error.code,
    message: error.message,
  });
}

function createPlayerDisconnect(playerId, graceRemaining) {
  return JSON.stringify({
    type: ServerMessages.PLAYER_DISCONNECT,
    playerId,
    graceRemaining, // seconds until auto-elimination
  });
}

function createPlayerReconnect(playerId) {
  return JSON.stringify({
    type: ServerMessages.PLAYER_RECONNECT,
    playerId,
  });
}

function createReconnectState(matchId, role, tick, players, timeRemaining) {
  return JSON.stringify({
    type: ServerMessages.RECONNECT_STATE,
    matchId,
    role,
    tick,
    players: players.map(p => ({
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      alive: p.alive,
      role: p.role,
      connected: p.connected,
    })),
    timeRemaining,
  });
}

/**
 * Create token update message (sent after token rotation)
 * Client should update stored token immediately
 * @param {string} newToken - New session token
 * @returns {string} JSON message
 */
function createTokenUpdate(newToken) {
  return JSON.stringify({
    type: ServerMessages.TOKEN_UPDATE,
    token: newToken,
  });
}

/**
 * Create showdown start message
 * Sent when only 2 players remain - triggers showdown mode (freeze phase, no hearts yet)
 * @param {number} freezeDuration - How long players are frozen (ms)
 * @returns {string} JSON message
 */
function createShowdownStart(freezeDuration) {
  return JSON.stringify({
    type: ServerMessages.SHOWDOWN_START,
    freezeDuration,
  });
}

/**
 * Create showdown ready message
 * Sent when freeze ends - hearts appear and race begins
 * @param {Array} hearts - Array of heart positions [{id, x, y}, ...]
 * @returns {string} JSON message
 */
function createShowdownReady(hearts) {
  return JSON.stringify({
    type: ServerMessages.SHOWDOWN_READY,
    hearts: hearts.map(h => ({
      id: h.id,
      x: Math.round(h.x * 100) / 100,
      y: Math.round(h.y * 100) / 100,
    })),
  });
}

/**
 * Create heart captured message
 * Sent when a player captures a heart
 * @param {string} playerId - ID of player who captured the heart
 * @param {number} heartId - ID of the captured heart
 * @param {number} playerScore - Player's new score (hearts captured)
 * @returns {string} JSON message
 */
function createHeartCaptured(playerId, heartId, playerScore) {
  return JSON.stringify({
    type: ServerMessages.HEART_CAPTURED,
    playerId,
    heartId,
    playerScore,
  });
}

// ============================================
// Utilities
// ============================================

/**
 * Truncate wallet address for display
 * @param {string} address - Full wallet address
 * @returns {string} Truncated address (e.g., "0x7a2F...3b9C")
 */
function truncateAddress(address) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ============================================
// Exports
// ============================================

module.exports = {
  ClientMessages,
  ServerMessages,
  ErrorCodes,
  parseMessage,
  truncateAddress,

  // Validation helpers (exported for testing)
  isValidTxHash,
  isValidLobbyId,
  isValidCoordinate,
  ARENA_WIDTH,
  ARENA_HEIGHT,
  LOBBY_COUNT,

  // Message creators
  createWelcome,
  createLobbyList,
  createLobbyUpdate,
  createRefundProcessed,
  createMatchStarting,
  createRoleAssignment,
  createCountdown,
  createSnapshot,
  createElimination,
  createBounce,
  createMatchEnd,
  createPong,
  createError,
  createPlayerDisconnect,
  createPlayerReconnect,
  createReconnectState,
  createTokenUpdate,
  createShowdownStart,
  createShowdownReady,
  createHeartCaptured,
};
