/**
 * Database connection and query utilities for RPS Arena
 * Uses better-sqlite3 for synchronous SQLite operations
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { sendAlert, AlertType } = require('./alerts');

let db = null;
let dbHealthy = true;
let lastHealthCheck = null;

// ============================================
// Error Handling Utilities
// ============================================

/**
 * Database error types for classification
 */
const DbErrorType = {
  CONNECTION: 'CONNECTION',
  CONSTRAINT: 'CONSTRAINT',
  BUSY: 'BUSY',
  CORRUPT: 'CORRUPT',
  READONLY: 'READONLY',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Classify a database error
 * @param {Error} error - The error to classify
 * @returns {string} Error type from DbErrorType
 */
function classifyDbError(error) {
  const msg = (error?.message || '').toLowerCase();
  const code = error?.code || '';

  if (msg.includes('database is locked') || msg.includes('busy') || code === 'SQLITE_BUSY') {
    return DbErrorType.BUSY;
  }
  if (msg.includes('constraint') || code === 'SQLITE_CONSTRAINT') {
    return DbErrorType.CONSTRAINT;
  }
  if (msg.includes('corrupt') || code === 'SQLITE_CORRUPT') {
    return DbErrorType.CORRUPT;
  }
  if (msg.includes('readonly') || msg.includes('read-only') || code === 'SQLITE_READONLY') {
    return DbErrorType.READONLY;
  }
  if (msg.includes('unable to open') || msg.includes('no such file') || msg.includes('cannot open')) {
    return DbErrorType.CONNECTION;
  }

  return DbErrorType.UNKNOWN;
}

// Track which error types we've already alerted about (to avoid spam)
const dbErrorAlerts = new Set();

/**
 * Wrap a database operation with error handling
 * @param {string} operationName - Name for logging
 * @param {Function} fn - Function to execute
 * @param {any} defaultValue - Default value to return on error (null for queries, false for writes)
 * @returns {any} Result of fn() or defaultValue on error
 */
function withDbErrorHandling(operationName, fn, defaultValue = null) {
  try {
    // Clear error alert tracking on successful operation
    dbErrorAlerts.clear();
    return fn();
  } catch (error) {
    const errorType = classifyDbError(error);
    console.error(`[DB ERROR] ${operationName}: ${error.message} [${errorType}]`);

    // Mark database as unhealthy for connection/corruption errors
    if (errorType === DbErrorType.CONNECTION || errorType === DbErrorType.CORRUPT) {
      dbHealthy = false;
    }

    // Send alert for serious errors (not constraint violations which are expected)
    if (errorType !== DbErrorType.CONSTRAINT && !dbErrorAlerts.has(errorType)) {
      dbErrorAlerts.add(errorType);
      sendAlert(AlertType.DATABASE_ERROR, {
        operation: operationName,
        error: `${error.message} [${errorType}]`,
      });
    }

    // For busy errors, the operation might succeed on retry
    // But since better-sqlite3 is synchronous, we don't retry here
    // The caller can implement retry logic if needed

    return defaultValue;
  }
}

/**
 * Get or create database connection
 * @returns {Database|null} Database instance or null if connection failed
 */
function getDb() {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/rps-arena.db';
  const fullPath = path.resolve(dbPath);

  try {
    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(fullPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    dbHealthy = true;
    lastHealthCheck = Date.now();

    console.log(`Database connected: ${fullPath}`);
    return db;
  } catch (error) {
    console.error(`[DB ERROR] Failed to connect to database: ${error.message}`);
    dbHealthy = false;
    return null;
  }
}

/**
 * Check if database is healthy and accessible
 * @returns {{healthy: boolean, error?: string, path: string}}
 */
function checkHealth() {
  const dbPath = process.env.DATABASE_PATH || './data/rps-arena.db';
  const fullPath = path.resolve(dbPath);

  try {
    const database = getDb();
    if (!database) {
      return { healthy: false, error: 'Database connection not established', path: fullPath };
    }

    // Run a simple query to verify database is working
    const result = database.prepare('SELECT 1 as test').get();
    if (result?.test !== 1) {
      dbHealthy = false;
      return { healthy: false, error: 'Health check query failed', path: fullPath };
    }

    // Check if WAL mode is active
    const walMode = database.pragma('journal_mode', { simple: true });

    dbHealthy = true;
    lastHealthCheck = Date.now();

    return {
      healthy: true,
      path: fullPath,
      journalMode: walMode,
      lastCheck: new Date(lastHealthCheck).toISOString(),
    };
  } catch (error) {
    dbHealthy = false;
    return { healthy: false, error: error.message, path: fullPath };
  }
}

/**
 * Get database health status
 * @returns {boolean}
 */
function isHealthy() {
  return dbHealthy;
}

/**
 * Close database connection gracefully
 */
function closeDb() {
  if (db) {
    try {
      db.close();
      console.log('Database connection closed');
    } catch (error) {
      console.error(`[DB ERROR] Error closing database: ${error.message}`);
    }
    db = null;
    dbHealthy = false;
  }
}

/**
 * Initialize database with schema
 * @returns {boolean} True if initialization succeeded
 */
function initializeDatabase() {
  return withDbErrorHandling('initializeDatabase', () => {
    const database = getDb();
    if (!database) {
      throw new Error('Database connection not available');
    }
    const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    database.exec(schema);
    console.log('Database schema initialized');
    return true;
  }, false);
}

/**
 * Generate a UUID v4
 */
function uuid() {
  return crypto.randomUUID();
}

// ============================================
// User Operations
// ============================================

function createUser(walletAddress, username = null) {
  return withDbErrorHandling('createUser', () => {
    const database = getDb();
    const id = uuid();
    const stmt = database.prepare(`
      INSERT INTO users (id, wallet_address, username)
      VALUES (?, ?, ?)
    `);
    stmt.run(id, walletAddress.toLowerCase(), username);
    return { id, wallet_address: walletAddress.toLowerCase(), username };
  }, null);
}

function getUserByWallet(walletAddress) {
  return withDbErrorHandling('getUserByWallet', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM users WHERE wallet_address = ?');
    return stmt.get(walletAddress.toLowerCase());
  }, null);
}

function getUserById(id) {
  return withDbErrorHandling('getUserById', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  }, null);
}

function updateUsername(userId, username) {
  return withDbErrorHandling('updateUsername', () => {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE users SET username = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    return stmt.run(username, userId);
  }, null);
}

// ============================================
// Session Operations
// ============================================

function createSession(userId) {
  return withDbErrorHandling('createSession', () => {
    const database = getDb();
    const id = uuid();
    const token = crypto.randomBytes(32).toString('hex');
    const expiryHours = parseInt(process.env.SESSION_EXPIRY_HOURS || '24');
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

    const stmt = database.prepare(`
      INSERT INTO sessions (id, user_id, token, expires_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, userId, token, expiresAt);

    return { id, user_id: userId, token, expires_at: expiresAt };
  }, null);
}

function getSessionByToken(token) {
  return withDbErrorHandling('getSessionByToken', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT s.*, u.wallet_address, u.username
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `);
    return stmt.get(token);
  }, null);
}

function deleteSession(token) {
  return withDbErrorHandling('deleteSession', () => {
    const database = getDb();
    const stmt = database.prepare('DELETE FROM sessions WHERE token = ?');
    return stmt.run(token);
  }, null);
}

function cleanExpiredSessions() {
  return withDbErrorHandling('cleanExpiredSessions', () => {
    const database = getDb();
    const stmt = database.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");
    return stmt.run();
  }, null);
}

// ============================================
// Lobby Operations
// ============================================

function initializeLobbies(lobbies) {
  return withDbErrorHandling('initializeLobbies', () => {
    const database = getDb();
    const stmt = database.prepare(`
      INSERT OR IGNORE INTO lobbies (id, status, deposit_address, deposit_private_key_encrypted)
      VALUES (?, 'empty', ?, ?)
    `);

    const insertMany = database.transaction((lobbyList) => {
      for (const lobby of lobbyList) {
        stmt.run(lobby.id, lobby.depositAddress, lobby.encryptedPrivateKey);
      }
    });

    insertMany(lobbies);
    return true;
  }, false);
}

function getLobby(lobbyId) {
  return withDbErrorHandling('getLobby', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM lobbies WHERE id = ?');
    return stmt.get(lobbyId);
  }, null);
}

function getAllLobbies() {
  return withDbErrorHandling('getAllLobbies', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM lobbies ORDER BY id');
    return stmt.all();
  }, []);
}

function updateLobbyStatus(lobbyId, status, matchId = null) {
  return withDbErrorHandling('updateLobbyStatus', () => {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE lobbies SET status = ?, current_match_id = ?
      WHERE id = ?
    `);
    return stmt.run(status, matchId, lobbyId);
  }, null);
}

function setLobbyFirstJoin(lobbyId) {
  return withDbErrorHandling('setLobbyFirstJoin', () => {
    const database = getDb();
    const now = new Date().toISOString();
    const timeout = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
    const stmt = database.prepare(`
      UPDATE lobbies SET first_join_at = ?, timeout_at = ?, status = 'waiting'
      WHERE id = ? AND first_join_at IS NULL
    `);
    return stmt.run(now, timeout, lobbyId);
  }, null);
}

function resetLobby(lobbyId) {
  return withDbErrorHandling('resetLobby', () => {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE lobbies
      SET status = 'empty', first_join_at = NULL, timeout_at = NULL, current_match_id = NULL
      WHERE id = ?
    `);
    return stmt.run(lobbyId);
  }, null);
}

function getLobbyPlayerCount(lobbyId) {
  return withDbErrorHandling('getLobbyPlayerCount', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT COUNT(*) as count FROM lobby_players
      WHERE lobby_id = ? AND refunded_at IS NULL
    `);
    return stmt.get(lobbyId).count;
  }, 0);
}

// ============================================
// Lobby Player Operations
// ============================================

function addLobbyPlayer(lobbyId, userId, paymentTxHash) {
  return withDbErrorHandling('addLobbyPlayer', () => {
    const database = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    const stmt = database.prepare(`
      INSERT INTO lobby_players (id, lobby_id, user_id, payment_tx_hash, payment_confirmed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, lobbyId, userId, paymentTxHash, now);

    return { id, lobby_id: lobbyId, user_id: userId, payment_tx_hash: paymentTxHash };
  }, null);
}

function getLobbyPlayers(lobbyId) {
  return withDbErrorHandling('getLobbyPlayers', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT lp.*, u.wallet_address, u.username
      FROM lobby_players lp
      JOIN users u ON lp.user_id = u.id
      WHERE lp.lobby_id = ? AND lp.refunded_at IS NULL
      ORDER BY lp.joined_at
    `);
    return stmt.all(lobbyId);
  }, []);
}

function getPlayerInLobby(userId) {
  return withDbErrorHandling('getPlayerInLobby', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT lp.*, l.status as lobby_status
      FROM lobby_players lp
      JOIN lobbies l ON lp.lobby_id = l.id
      WHERE lp.user_id = ? AND lp.refunded_at IS NULL
    `);
    return stmt.get(userId);
  }, null);
}

function txHashExists(txHash) {
  return withDbErrorHandling('txHashExists', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT 1 FROM lobby_players WHERE payment_tx_hash = ?');
    return !!stmt.get(txHash);
  }, false);
}

function markPlayerRefunded(lobbyPlayerId, reason, txHash) {
  return withDbErrorHandling('markPlayerRefunded', () => {
    const database = getDb();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
      UPDATE lobby_players
      SET refunded_at = ?, refund_reason = ?, refund_tx_hash = ?
      WHERE id = ?
    `);
    return stmt.run(now, reason, txHash, lobbyPlayerId);
  }, null);
}

function clearLobbyPlayers(lobbyId) {
  return withDbErrorHandling('clearLobbyPlayers', () => {
    const database = getDb();
    const stmt = database.prepare('DELETE FROM lobby_players WHERE lobby_id = ?');
    return stmt.run(lobbyId);
  }, null);
}

// ============================================
// Match Operations
// ============================================

function createMatch(lobbyId, rngSeed) {
  return withDbErrorHandling('createMatch', () => {
    const database = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    const stmt = database.prepare(`
      INSERT INTO matches (id, lobby_id, status, rng_seed, countdown_at)
      VALUES (?, ?, 'countdown', ?, ?)
    `);
    stmt.run(id, lobbyId, rngSeed, now);

    return { id, lobby_id: lobbyId, status: 'countdown', rng_seed: rngSeed };
  }, null);
}

function getMatch(matchId) {
  return withDbErrorHandling('getMatch', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM matches WHERE id = ?');
    return stmt.get(matchId);
  }, null);
}

function updateMatchStatus(matchId, status) {
  return withDbErrorHandling('updateMatchStatus', () => {
    const database = getDb();
    const now = new Date().toISOString();

    let stmt;
    if (status === 'running') {
      stmt = database.prepare('UPDATE matches SET status = ?, running_at = ? WHERE id = ?');
    } else if (status === 'finished' || status === 'void') {
      stmt = database.prepare('UPDATE matches SET status = ?, ended_at = ? WHERE id = ?');
    } else {
      stmt = database.prepare('UPDATE matches SET status = ? WHERE id = ?');
      return stmt.run(status, matchId);
    }
    return stmt.run(status, now, matchId);
  }, null);
}

function setMatchWinner(matchId, winnerId, payoutAmount, payoutTxHash) {
  return withDbErrorHandling('setMatchWinner', () => {
    const database = getDb();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
      UPDATE matches
      SET status = 'finished', winner_id = ?, payout_amount = ?, payout_tx_hash = ?, ended_at = ?
      WHERE id = ?
    `);
    return stmt.run(winnerId, payoutAmount, payoutTxHash, now, matchId);
  }, null);
}

// ============================================
// Match Player Operations
// ============================================

function addMatchPlayer(matchId, userId, role, spawnX, spawnY) {
  return withDbErrorHandling('addMatchPlayer', () => {
    const database = getDb();
    const id = uuid();

    const stmt = database.prepare(`
      INSERT INTO match_players (id, match_id, user_id, role, spawn_x, spawn_y)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, matchId, userId, role, spawnX, spawnY);

    return { id, match_id: matchId, user_id: userId, role, spawn_x: spawnX, spawn_y: spawnY };
  }, null);
}

function getMatchPlayers(matchId) {
  return withDbErrorHandling('getMatchPlayers', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT mp.*, u.wallet_address, u.username
      FROM match_players mp
      JOIN users u ON mp.user_id = u.id
      WHERE mp.match_id = ?
    `);
    return stmt.all(matchId);
  }, []);
}

function eliminatePlayer(matchId, userId, eliminatedBy, finalX, finalY) {
  return withDbErrorHandling('eliminatePlayer', () => {
    const database = getDb();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
      UPDATE match_players
      SET eliminated_at = ?, eliminated_by = ?, final_x = ?, final_y = ?
      WHERE match_id = ? AND user_id = ?
    `);
    return stmt.run(now, eliminatedBy, finalX, finalY, matchId, userId);
  }, null);
}

// ============================================
// Match Event Operations
// ============================================

function logMatchEvent(matchId, tick, eventType, data) {
  return withDbErrorHandling('logMatchEvent', () => {
    const database = getDb();
    const id = uuid();

    const stmt = database.prepare(`
      INSERT INTO match_events (id, match_id, tick, event_type, data)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, matchId, tick, eventType, JSON.stringify(data));

    return { id, match_id: matchId, tick, event_type: eventType, data };
  }, null);
}

function getMatchEvents(matchId) {
  return withDbErrorHandling('getMatchEvents', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT * FROM match_events WHERE match_id = ? ORDER BY tick, created_at
    `);
    return stmt.all(matchId).map(e => ({ ...e, data: JSON.parse(e.data) }));
  }, []);
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Connection & Health
  getDb,
  closeDb,
  checkHealth,
  isHealthy,
  initializeDatabase,
  uuid,

  // Error types (for callers that need to handle specific errors)
  DbErrorType,

  // Users
  createUser,
  getUserByWallet,
  getUserById,
  updateUsername,

  // Sessions
  createSession,
  getSessionByToken,
  deleteSession,
  cleanExpiredSessions,

  // Lobbies
  initializeLobbies,
  getLobby,
  getAllLobbies,
  updateLobbyStatus,
  setLobbyFirstJoin,
  resetLobby,
  getLobbyPlayerCount,

  // Lobby Players
  addLobbyPlayer,
  getLobbyPlayers,
  getPlayerInLobby,
  txHashExists,
  markPlayerRefunded,
  clearLobbyPlayers,

  // Matches
  createMatch,
  getMatch,
  updateMatchStatus,
  setMatchWinner,

  // Match Players
  addMatchPlayer,
  getMatchPlayers,
  eliminatePlayer,

  // Match Events
  logMatchEvent,
  getMatchEvents,
};
