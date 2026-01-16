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
// Message Parsing
// ============================================

/**
 * Parse incoming WebSocket message
 * @param {string} data - Raw message string
 * @returns {Object|null} Parsed message or null if invalid
 */
function parseMessage(data) {
  try {
    const message = JSON.parse(data);
    if (!message.type) {
      return null;
    }
    return message;
  } catch (error) {
    return null;
  }
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
};
