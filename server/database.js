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
// Graceful Degradation - Retry & Queue
// ============================================

// Retry configuration for BUSY errors
const BUSY_RETRY_ATTEMPTS = 3;
const BUSY_RETRY_DELAY_MS = 50; // Start with 50ms, doubles each retry

// Queue for non-critical operations that failed and should be retried later
const deferredOperations = [];
const MAX_DEFERRED_QUEUE_SIZE = 100;
const DEFERRED_PROCESS_INTERVAL_MS = 5000; // Process queue every 5 seconds
let deferredProcessorRunning = false;

/**
 * Operations that are critical and cannot be deferred
 * These will fail immediately if DB is unavailable
 */
const CRITICAL_OPERATIONS = new Set([
  'createUser',
  'createSession',
  'addLobbyPlayer',
  'createMatch',
  'addMatchPlayer',
  'setMatchWinner',
  'markPlayerRefunded',
]);

/**
 * Sleep for a specified duration (synchronous busy-wait for better-sqlite3)
 * @param {number} ms - Milliseconds to sleep
 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait - necessary for synchronous SQLite operations
  }
}

/**
 * Add an operation to the deferred queue
 * @param {string} operationName - Name of the operation
 * @param {Function} fn - Function to execute
 * @param {any} defaultValue - Default value on failure
 */
function queueDeferredOperation(operationName, fn, defaultValue) {
  if (deferredOperations.length >= MAX_DEFERRED_QUEUE_SIZE) {
    console.warn(`[DB] Deferred queue full, dropping operation: ${operationName}`);
    return;
  }

  deferredOperations.push({
    operationName,
    fn,
    defaultValue,
    queuedAt: Date.now(),
    attempts: 0,
  });

  console.log(`[DB] Queued deferred operation: ${operationName} (queue size: ${deferredOperations.length})`);

  // Start the processor if not running
  if (!deferredProcessorRunning) {
    startDeferredProcessor();
  }
}

/**
 * Process deferred operations queue
 */
function processDeferredQueue() {
  if (deferredOperations.length === 0) {
    return { processed: 0, failed: 0, remaining: 0 };
  }

  if (!dbHealthy) {
    console.log(`[DB] Skipping deferred queue processing - database unhealthy`);
    return { processed: 0, failed: 0, remaining: deferredOperations.length };
  }

  let processed = 0;
  let failed = 0;
  const maxToProcess = 10; // Process max 10 at a time to avoid blocking

  for (let i = 0; i < maxToProcess && deferredOperations.length > 0; i++) {
    const op = deferredOperations.shift();
    op.attempts++;

    try {
      op.fn();
      processed++;
      console.log(`[DB] Processed deferred operation: ${op.operationName}`);
    } catch (error) {
      const errorType = classifyDbError(error);

      if (errorType === DbErrorType.BUSY && op.attempts < 3) {
        // Re-queue for another attempt
        deferredOperations.push(op);
      } else {
        failed++;
        console.error(`[DB] Deferred operation failed permanently: ${op.operationName} - ${error.message}`);
      }
    }
  }

  return { processed, failed, remaining: deferredOperations.length };
}

/**
 * Start the deferred operations processor
 */
function startDeferredProcessor() {
  if (deferredProcessorRunning) return;

  deferredProcessorRunning = true;

  const processInterval = setInterval(() => {
    if (deferredOperations.length === 0) {
      clearInterval(processInterval);
      deferredProcessorRunning = false;
      return;
    }

    const result = processDeferredQueue();
    if (result.remaining === 0) {
      clearInterval(processInterval);
      deferredProcessorRunning = false;
    }
  }, DEFERRED_PROCESS_INTERVAL_MS);
}

/**
 * Get deferred queue status
 * @returns {{size: number, oldest: number|null}}
 */
function getDeferredQueueStatus() {
  return {
    size: deferredOperations.length,
    oldest: deferredOperations.length > 0
      ? Date.now() - deferredOperations[0].queuedAt
      : null,
  };
}

// ============================================
// Transaction Support
// ============================================

/**
 * Execute multiple operations atomically in a transaction
 * If any operation fails, all changes are rolled back
 *
 * @param {string} operationName - Name for logging
 * @param {Function} fn - Function that receives db and performs operations
 * @returns {any} Result of fn() or null on error
 *
 * @example
 * withTransaction('createMatchWithPlayers', (db) => {
 *   const match = db.prepare('INSERT...').run(...);
 *   db.prepare('INSERT...').run(...); // player 1
 *   db.prepare('INSERT...').run(...); // player 2
 *   return match;
 * });
 */
function withTransaction(operationName, fn) {
  const database = getDb();
  if (!database) {
    console.error(`[DB ERROR] ${operationName}: Database not available`);
    return null;
  }

  // Create the transaction wrapper
  const txn = database.transaction(() => {
    return fn(database);
  });

  // Execute with error handling and retry logic
  for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = txn();
      dbErrorAlerts.clear();
      return result;
    } catch (error) {
      const errorType = classifyDbError(error);

      // For BUSY errors, retry with exponential backoff
      if (errorType === DbErrorType.BUSY && attempt < BUSY_RETRY_ATTEMPTS) {
        const delay = BUSY_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[DB] ${operationName} transaction busy, retrying in ${delay}ms (attempt ${attempt}/${BUSY_RETRY_ATTEMPTS})`);
        sleepSync(delay);
        continue;
      }

      console.error(`[DB ERROR] ${operationName} transaction failed: ${error.message} [${errorType}]`);

      // Mark database as unhealthy for connection/corruption errors
      if (errorType === DbErrorType.CONNECTION || errorType === DbErrorType.CORRUPT) {
        dbHealthy = false;
      }

      // Send alert for serious errors
      if (errorType !== DbErrorType.CONSTRAINT && !dbErrorAlerts.has(errorType)) {
        dbErrorAlerts.add(errorType);
        sendAlert(AlertType.DATABASE_ERROR, {
          operation: `${operationName} (transaction)`,
          error: `${error.message} [${errorType}]`,
        });
      }

      return null;
    }
  }

  return null;
}

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
 * Wrap a database operation with error handling, retry logic, and graceful degradation
 * @param {string} operationName - Name for logging
 * @param {Function} fn - Function to execute
 * @param {any} defaultValue - Default value to return on error (null for queries, false for writes)
 * @returns {any} Result of fn() or defaultValue on error
 */
function withDbErrorHandling(operationName, fn, defaultValue = null) {
  const isCritical = CRITICAL_OPERATIONS.has(operationName);

  // Retry loop for BUSY errors
  for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = fn();
      // Clear error alert tracking on successful operation
      dbErrorAlerts.clear();
      return result;
    } catch (error) {
      const errorType = classifyDbError(error);

      // For BUSY errors, retry with exponential backoff
      if (errorType === DbErrorType.BUSY && attempt < BUSY_RETRY_ATTEMPTS) {
        const delay = BUSY_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[DB] ${operationName} busy, retrying in ${delay}ms (attempt ${attempt}/${BUSY_RETRY_ATTEMPTS})`);
        sleepSync(delay);
        continue;
      }

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

      // For non-critical operations with BUSY errors, queue for later
      if (!isCritical && errorType === DbErrorType.BUSY) {
        queueDeferredOperation(operationName, fn, defaultValue);
        console.log(`[DB] Non-critical operation ${operationName} deferred due to BUSY error`);
      }

      return defaultValue;
    }
  }

  return defaultValue;
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
// Match State Persistence (Crash Recovery)
// ============================================

/**
 * Save or update match state for crash recovery
 * Uses upsert to handle both new and existing state
 *
 * @param {string} matchId - Match UUID
 * @param {number} tick - Current tick number
 * @param {string} status - 'countdown' or 'running'
 * @param {Object} state - Player state object
 * @param {number} version - State schema version (default 1)
 * @returns {boolean} True if successful, false on error
 */
function saveMatchState(matchId, tick, status, state, version = 1) {
  return withDbErrorHandling('saveMatchState', () => {
    const database = getDb();
    const now = new Date().toISOString();
    const stateJson = JSON.stringify(state);

    const stmt = database.prepare(`
      INSERT INTO match_state (match_id, version, tick, status, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id) DO UPDATE SET
        tick = excluded.tick,
        status = excluded.status,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(matchId, version, tick, status, stateJson, now);
    return true;
  }, false);
}

/**
 * Get saved match state for recovery
 * @param {string} matchId - Match UUID
 * @returns {Object|null} Saved state with parsed JSON, or null if not found
 */
function getMatchState(matchId) {
  return withDbErrorHandling('getMatchState', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM match_state WHERE match_id = ?');
    const row = stmt.get(matchId);
    if (row) {
      row.state = JSON.parse(row.state_json);
      delete row.state_json;
    }
    return row;
  }, null);
}

/**
 * Get all interrupted matches for crash recovery on startup
 * Returns matches that were in 'countdown' or 'running' status
 *
 * @returns {Array} Array of match states with lobby info
 */
function getInterruptedMatches() {
  return withDbErrorHandling('getInterruptedMatches', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT ms.*, m.lobby_id, m.rng_seed
      FROM match_state ms
      JOIN matches m ON ms.match_id = m.id
      WHERE ms.status IN ('countdown', 'running')
      ORDER BY ms.updated_at ASC
    `);
    return stmt.all().map(row => {
      row.state = JSON.parse(row.state_json);
      delete row.state_json;
      return row;
    });
  }, []);
}

/**
 * Delete match state (call when match ends normally or is voided)
 * @param {string} matchId - Match UUID
 * @returns {Object|null} Result of deletion or null on error
 */
function deleteMatchState(matchId) {
  return withDbErrorHandling('deleteMatchState', () => {
    const database = getDb();
    const stmt = database.prepare('DELETE FROM match_state WHERE match_id = ?');
    return stmt.run(matchId);
  }, null);
}

// ============================================
// Payout Attempt Operations
// ============================================

/**
 * Log a payout attempt for audit trail
 * @param {Object} params - Payout attempt details
 * @param {string} params.matchId - Match ID
 * @param {number} params.lobbyId - Lobby ID
 * @param {string} params.recipientAddress - Wallet address receiving payout
 * @param {number} params.amountUsdc - Amount in USDC (e.g., 2.4)
 * @param {number} params.attemptNumber - Which attempt this is (1, 2, 3...)
 * @param {'pending'|'success'|'failed'} params.status - Attempt status
 * @param {string} params.sourceWallet - 'lobby' or 'treasury'
 * @param {string} [params.txHash] - Transaction hash if successful
 * @param {string} [params.errorMessage] - Error message if failed
 * @param {string} [params.errorType] - Error classification (transient/permanent)
 * @param {string} [params.treasuryBalanceBefore] - Treasury balance before attempt
 * @returns {Object|null} Created payout attempt record
 */
function logPayoutAttempt({
  matchId,
  lobbyId,
  recipientAddress,
  amountUsdc,
  attemptNumber,
  status,
  sourceWallet,
  txHash = null,
  errorMessage = null,
  errorType = null,
  treasuryBalanceBefore = null,
}) {
  return withDbErrorHandling('logPayoutAttempt', () => {
    const database = getDb();
    const id = uuid();

    const stmt = database.prepare(`
      INSERT INTO payout_attempts (
        id, match_id, lobby_id, recipient_address, amount_usdc,
        attempt_number, status, tx_hash, error_message, error_type,
        source_wallet, treasury_balance_before
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, matchId, lobbyId, recipientAddress, amountUsdc,
      attemptNumber, status, txHash, errorMessage, errorType,
      sourceWallet, treasuryBalanceBefore
    );

    return {
      id,
      match_id: matchId,
      lobby_id: lobbyId,
      recipient_address: recipientAddress,
      amount_usdc: amountUsdc,
      attempt_number: attemptNumber,
      status,
      source_wallet: sourceWallet,
      tx_hash: txHash,
      error_message: errorMessage,
    };
  }, null);
}

/**
 * Update a payout attempt status (e.g., pending -> success/failed)
 * @param {string} attemptId - Payout attempt ID
 * @param {'success'|'failed'} status - New status
 * @param {string} [txHash] - Transaction hash if successful
 * @param {string} [errorMessage] - Error message if failed
 * @param {string} [errorType] - Error classification
 */
function updatePayoutAttempt(attemptId, status, txHash = null, errorMessage = null, errorType = null) {
  return withDbErrorHandling('updatePayoutAttempt', () => {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE payout_attempts
      SET status = ?, tx_hash = ?, error_message = ?, error_type = ?
      WHERE id = ?
    `);
    return stmt.run(status, txHash, errorMessage, errorType, attemptId);
  }, null);
}

/**
 * Get all payout attempts for a match
 * @param {string} matchId - Match ID
 * @returns {Array} List of payout attempts
 */
function getPayoutAttempts(matchId) {
  return withDbErrorHandling('getPayoutAttempts', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT * FROM payout_attempts
      WHERE match_id = ?
      ORDER BY created_at
    `);
    return stmt.all(matchId);
  }, []);
}

/**
 * Get failed payout attempts that may need manual intervention
 * @returns {Array} List of failed payouts with match info
 */
function getFailedPayouts() {
  return withDbErrorHandling('getFailedPayouts', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT pa.*, m.status as match_status, m.winner_id
      FROM payout_attempts pa
      JOIN matches m ON pa.match_id = m.id
      WHERE pa.status = 'failed'
      ORDER BY pa.created_at DESC
    `);
    return stmt.all();
  }, []);
}

// ============================================
// Transactional Operations (Multi-Step)
// ============================================

/**
 * Create a match with all players atomically
 * If any step fails, the entire operation is rolled back
 *
 * @param {number} lobbyId - Lobby ID
 * @param {string} rngSeed - RNG seed for the match
 * @param {Array<{userId: string, role: string, spawnX: number, spawnY: number}>} players - Player data
 * @returns {{match: Object, players: Array}|null} Created match and players, or null on failure
 */
function createMatchWithPlayers(lobbyId, rngSeed, players) {
  return withTransaction('createMatchWithPlayers', (database) => {
    const matchId = uuid();
    const now = new Date().toISOString();

    // Step 1: Create the match
    const matchStmt = database.prepare(`
      INSERT INTO matches (id, lobby_id, status, rng_seed, countdown_at)
      VALUES (?, ?, 'countdown', ?, ?)
    `);
    matchStmt.run(matchId, lobbyId, rngSeed, now);

    // Step 2: Add all players
    const playerStmt = database.prepare(`
      INSERT INTO match_players (id, match_id, user_id, role, spawn_x, spawn_y)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const createdPlayers = [];
    for (const p of players) {
      const playerId = uuid();
      playerStmt.run(playerId, matchId, p.userId, p.role, p.spawnX, p.spawnY);
      createdPlayers.push({
        id: playerId,
        match_id: matchId,
        user_id: p.userId,
        role: p.role,
        spawn_x: p.spawnX,
        spawn_y: p.spawnY,
      });
    }

    // Step 3: Update lobby status
    const lobbyStmt = database.prepare(`
      UPDATE lobbies SET status = 'in_progress', current_match_id = ?
      WHERE id = ?
    `);
    lobbyStmt.run(matchId, lobbyId);

    return {
      match: { id: matchId, lobby_id: lobbyId, status: 'countdown', rng_seed: rngSeed },
      players: createdPlayers,
    };
  });
}

/**
 * Reset a lobby and clear all its players atomically
 * Used when a lobby times out or needs to be force-reset
 *
 * @param {number} lobbyId - Lobby ID
 * @returns {boolean} True if successful, false on failure
 */
function resetLobbyWithPlayers(lobbyId) {
  return withTransaction('resetLobbyWithPlayers', (database) => {
    // Step 1: Clear all lobby players (those not refunded)
    const clearStmt = database.prepare('DELETE FROM lobby_players WHERE lobby_id = ?');
    clearStmt.run(lobbyId);

    // Step 2: Reset lobby state
    const resetStmt = database.prepare(`
      UPDATE lobbies
      SET status = 'empty', first_join_at = NULL, timeout_at = NULL, current_match_id = NULL
      WHERE id = ?
    `);
    resetStmt.run(lobbyId);

    return true;
  }) ?? false;
}

/**
 * End a match and update all related records atomically
 * Sets winner, payout info, and updates lobby status
 *
 * @param {string} matchId - Match ID
 * @param {string|null} winnerId - Winner user ID (null for void matches)
 * @param {number|null} payoutAmount - Payout amount (null for void matches)
 * @param {string|null} payoutTxHash - Payout transaction hash
 * @param {number} lobbyId - Lobby ID to reset
 * @returns {boolean} True if successful, false on failure
 */
function endMatchWithLobbyReset(matchId, winnerId, payoutAmount, payoutTxHash, lobbyId) {
  return withTransaction('endMatchWithLobbyReset', (database) => {
    const now = new Date().toISOString();

    // Step 1: Update match with winner info
    if (winnerId) {
      const matchStmt = database.prepare(`
        UPDATE matches
        SET status = 'finished', winner_id = ?, payout_amount = ?, payout_tx_hash = ?, ended_at = ?
        WHERE id = ?
      `);
      matchStmt.run(winnerId, payoutAmount, payoutTxHash, now, matchId);
    } else {
      // Void match
      const matchStmt = database.prepare(`
        UPDATE matches SET status = 'void', ended_at = ? WHERE id = ?
      `);
      matchStmt.run(now, matchId);
    }

    // Step 2: Clear lobby players
    const clearStmt = database.prepare('DELETE FROM lobby_players WHERE lobby_id = ?');
    clearStmt.run(lobbyId);

    // Step 3: Reset lobby for next match
    const lobbyStmt = database.prepare(`
      UPDATE lobbies
      SET status = 'empty', first_join_at = NULL, timeout_at = NULL, current_match_id = NULL
      WHERE id = ?
    `);
    lobbyStmt.run(lobbyId);

    return true;
  }) ?? false;
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

  // Graceful degradation
  getDeferredQueueStatus,
  processDeferredQueue,

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

  // Match State Persistence (Crash Recovery)
  saveMatchState,
  getMatchState,
  getInterruptedMatches,
  deleteMatchState,

  // Payout Attempts
  logPayoutAttempt,
  updatePayoutAttempt,
  getPayoutAttempts,
  getFailedPayouts,

  // Transactional Operations (atomic multi-step)
  withTransaction,
  createMatchWithPlayers,
  resetLobbyWithPlayers,
  endMatchWithLobbyReset,
};
