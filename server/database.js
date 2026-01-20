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
// NOTE: This queue is in-memory only and will be lost on server restart.
// This is acceptable because:
// 1. Only NON-CRITICAL operations are queued (see CRITICAL_OPERATIONS below)
// 2. Critical operations (user creation, matches, payouts) fail immediately
// 3. Queued items are typically logging/metrics that can be lost without impact
// 4. The queue processes every 5s, so data loss window is minimal
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
 * Sleep for a specified duration without blocking the CPU
 * Uses Atomics.wait() which properly sleeps without busy-waiting
 * @param {number} ms - Milliseconds to sleep
 */
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
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
        }).catch(err => console.error('Alert send failed:', err.message));
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
        }).catch(err => console.error('Alert send failed:', err.message));
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

// ============================================
// WAL Checkpointing & Backup
// ============================================

/**
 * Run a WAL checkpoint to merge WAL file into main database
 * This should be run periodically (e.g., hourly) to prevent WAL file growth
 *
 * @param {string} mode - 'PASSIVE' (default, non-blocking), 'FULL', or 'TRUNCATE'
 * @returns {{success: boolean, pagesWritten?: number, pagesRemaining?: number, error?: string}}
 */
function walCheckpoint(mode = 'PASSIVE') {
  try {
    const database = getDb();
    if (!database) {
      return { success: false, error: 'Database not connected' };
    }

    // Valid modes: PASSIVE, FULL, RESTART, TRUNCATE
    const validModes = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'];
    if (!validModes.includes(mode.toUpperCase())) {
      return { success: false, error: `Invalid mode: ${mode}` };
    }

    const result = database.pragma(`wal_checkpoint(${mode.toUpperCase()})`);
    // Result is array: [{ busy: 0|1, log: pages_in_wal, checkpointed: pages_written }]
    const checkpoint = result[0] || {};

    console.log(`[DB] WAL checkpoint (${mode}): ${checkpoint.checkpointed || 0} pages written, ${checkpoint.log - (checkpoint.checkpointed || 0)} remaining`);

    return {
      success: checkpoint.busy === 0,
      pagesWritten: checkpoint.checkpointed || 0,
      pagesRemaining: (checkpoint.log || 0) - (checkpoint.checkpointed || 0),
      busy: checkpoint.busy === 1,
    };
  } catch (error) {
    console.error(`[DB ERROR] WAL checkpoint failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Create a backup of the database using SQLite's backup API
 * This is safe to call while the database is in use (online backup)
 *
 * @param {string} backupPath - Path for the backup file
 * @returns {Promise<{success: boolean, path?: string, size?: number, error?: string}>}
 */
async function createBackup(backupPath) {
  try {
    const database = getDb();
    if (!database) {
      return { success: false, error: 'Database not connected' };
    }

    // Ensure backup directory exists
    const backupDir = path.dirname(backupPath);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Run checkpoint first to ensure WAL is merged
    walCheckpoint('PASSIVE');

    // Use better-sqlite3's backup method (async, safe during writes)
    await database.backup(backupPath);

    // Get file size for logging
    const stats = fs.statSync(backupPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log(`[DB] Backup created: ${backupPath} (${sizeMB} MB)`);

    return {
      success: true,
      path: backupPath,
      size: stats.size,
      sizeMB: parseFloat(sizeMB),
    };
  } catch (error) {
    console.error(`[DB ERROR] Backup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Verify backup integrity by opening it and running integrity_check
 * @param {string} backupPath - Path to the backup file
 * @returns {{valid: boolean, error?: string}}
 */
function verifyBackupIntegrity(backupPath) {
  let backupDb = null;
  try {
    if (!fs.existsSync(backupPath)) {
      return { valid: false, error: 'Backup file does not exist' };
    }

    // Open backup database in read-only mode
    const Database = require('better-sqlite3');
    backupDb = new Database(backupPath, { readonly: true });

    // Run SQLite integrity check
    const result = backupDb.pragma('integrity_check');

    // integrity_check returns [{integrity_check: 'ok'}] if valid
    const isValid = result.length === 1 && result[0].integrity_check === 'ok';

    if (!isValid) {
      const errors = result.map(r => r.integrity_check).join(', ');
      console.error(`[DB] Backup integrity check failed: ${errors}`);
      return { valid: false, error: `Integrity check failed: ${errors}` };
    }

    // Also verify we can read a basic table
    const tableCheck = backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get();
    if (!tableCheck) {
      return { valid: false, error: 'Backup contains no tables' };
    }

    console.log(`[DB] Backup integrity verified: ${backupPath}`);
    return { valid: true };
  } catch (error) {
    console.error(`[DB ERROR] Backup verification failed: ${error.message}`);
    return { valid: false, error: error.message };
  } finally {
    if (backupDb) {
      try {
        backupDb.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

/**
 * Create a timestamped backup in the backups directory
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
async function createTimestampedBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.resolve('./backups', `rps-arena-${timestamp}.db`);
  return createBackup(backupPath);
}

/**
 * Get list of existing backups
 * @returns {{backups: Array<{name: string, path: string, size: number, created: Date}>}}
 */
function listBackups() {
  const backupDir = path.resolve('./backups');

  if (!fs.existsSync(backupDir)) {
    return { backups: [] };
  }

  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const fullPath = path.join(backupDir, f);
      const stats = fs.statSync(fullPath);
      return {
        name: f,
        path: fullPath,
        size: stats.size,
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        created: stats.mtime,
      };
    })
    .sort((a, b) => b.created - a.created); // Newest first

  return { backups: files };
}

/**
 * Clean up old backups, keeping only the most recent N
 * @param {number} keepCount - Number of backups to keep (default 24 = 1 day of hourly backups)
 * @returns {{deleted: number, kept: number}}
 */
function cleanupOldBackups(keepCount = 24) {
  const { backups } = listBackups();

  if (backups.length <= keepCount) {
    return { deleted: 0, kept: backups.length };
  }

  const toDelete = backups.slice(keepCount);
  let deleted = 0;

  for (const backup of toDelete) {
    try {
      fs.unlinkSync(backup.path);
      deleted++;
      console.log(`[DB] Deleted old backup: ${backup.name}`);
    } catch (error) {
      console.error(`[DB ERROR] Failed to delete backup ${backup.name}: ${error.message}`);
    }
  }

  return { deleted, kept: keepCount };
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

/**
 * Update session token (for token rotation on sensitive operations)
 * Generates a new token and invalidates the old one
 * @param {string} sessionId - Session UUID
 * @param {string} newToken - New token to set
 * @returns {Object|null} Update result or null on error
 */
function updateSessionToken(sessionId, newToken) {
  return withDbErrorHandling('updateSessionToken', () => {
    const database = getDb();
    const stmt = database.prepare(`
      UPDATE sessions SET token = ? WHERE id = ?
    `);
    return stmt.run(newToken, sessionId);
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
  try {
    const database = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    const stmt = database.prepare(`
      INSERT INTO lobby_players (id, lobby_id, user_id, payment_tx_hash, payment_confirmed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, lobbyId, userId, paymentTxHash, now);

    return { id, lobby_id: lobbyId, user_id: userId, payment_tx_hash: paymentTxHash };
  } catch (error) {
    // Handle UNIQUE constraint violation on payment_tx_hash (race condition safe)
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message?.includes('UNIQUE constraint failed')) {
      console.error(`[addLobbyPlayer] Duplicate tx hash rejected by constraint: ${paymentTxHash}`);
      return { error: 'DUPLICATE_TX_HASH' };
    }
    console.error('[addLobbyPlayer] Database error:', error);
    return null;
  }
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
    return stmt.all(matchId).map(e => {
      try {
        return { ...e, data: JSON.parse(e.data) };
      } catch (parseErr) {
        console.error(`[DB] Failed to parse match event data for event ${e.id}:`, parseErr.message);
        return { ...e, data: null };
      }
    });
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
      SELECT ms.*, m.lobby_id, m.rng_seed, m.created_at as match_created_at, m.running_at as match_running_at
      FROM match_state ms
      JOIN matches m ON ms.match_id = m.id
      WHERE ms.status IN ('countdown', 'running')
      ORDER BY ms.updated_at ASC
    `);
    return stmt.all().map(row => {
      try {
        row.state = JSON.parse(row.state_json);
      } catch (parseErr) {
        console.error(`[DB] Failed to parse match state for match ${row.match_id}:`, parseErr.message);
        row.state = null;
      }
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

/**
 * Cleanup old payout records older than specified days
 * Only deletes successful payouts - failed payouts are kept for audit
 * @param {number} daysOld - Delete records older than this many days (default 90)
 * @returns {{deleted: number}|null} Number of deleted records or null on error
 */
function cleanupOldPayoutRecords(daysOld = 90) {
  return withDbErrorHandling('cleanupOldPayoutRecords', () => {
    const database = getDb();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    const cutoffISO = cutoffDate.toISOString();

    // Only delete successful payouts - keep failed ones for audit/debugging
    const stmt = database.prepare(`
      DELETE FROM payout_attempts
      WHERE status = 'success'
      AND created_at < ?
    `);
    const result = stmt.run(cutoffISO);

    if (result.changes > 0) {
      console.log(`[DB Cleanup] Deleted ${result.changes} payout records older than ${daysOld} days`);
    }

    return { deleted: result.changes };
  }, null);
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
    // Step 1: Clear non-refunded lobby players (preserve refunded records for audit)
    const clearStmt = database.prepare('DELETE FROM lobby_players WHERE lobby_id = ? AND refund_tx_hash IS NULL');
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

    // Step 2: Clear non-refunded lobby players (preserve refunded records for audit)
    const clearStmt = database.prepare('DELETE FROM lobby_players WHERE lobby_id = ? AND refund_tx_hash IS NULL');
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
// Player Stats Operations
// ============================================

/**
 * Get player stats by wallet address
 * @param {string} walletAddress - Ethereum wallet address
 * @returns {Object|null} Player stats or null if not found
 */
function getPlayerStats(walletAddress) {
  return withDbErrorHandling('getPlayerStats', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT * FROM player_stats WHERE wallet_address = ?
    `);
    return stmt.get(walletAddress.toLowerCase());
  }, null);
}

/**
 * Record a match result for a player (win or loss)
 * Creates stats record on first match, updates atomically after each match
 *
 * @param {string} walletAddress - Player's wallet address
 * @param {boolean} isWin - True if player won the match
 * @param {number} earningsUsdc - Amount earned (payout for winner, 0 for loser)
 * @param {number} spentUsdc - Amount spent to enter (buy-in amount)
 * @returns {Object|null} Updated stats or null on error
 */
function recordMatchResult(walletAddress, isWin, earningsUsdc = 0, spentUsdc = 0) {
  return withTransaction('recordMatchResult', (database) => {
    const now = new Date().toISOString();
    const normalizedAddress = walletAddress.toLowerCase();
    const isWinInt = isWin ? 1 : 0;

    // Check if player exists
    const checkStmt = database.prepare('SELECT wallet_address FROM player_stats WHERE wallet_address = ?');
    const exists = checkStmt.get(normalizedAddress);

    if (!exists) {
      // First match for this player - create record
      // For new players: streak is 1 on win, 0 on loss
      const insertStmt = database.prepare(`
        INSERT INTO player_stats (
          wallet_address, total_matches, wins, losses,
          total_earnings_usdc, total_spent_usdc,
          current_win_streak, best_win_streak,
          first_match_at, last_match_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        normalizedAddress,
        isWinInt,
        isWin ? 0 : 1,
        earningsUsdc,
        spentUsdc,
        isWinInt,  // current_win_streak: 1 for win, 0 for loss
        isWinInt,  // best_win_streak: 1 for win, 0 for loss
        now,
        now,
        now
      );
    } else {
      // Update existing record with atomic SQL-based streak calculation
      // This prevents race conditions by calculating in DB rather than JS
      const updateStmt = database.prepare(`
        UPDATE player_stats SET
          total_matches = total_matches + 1,
          wins = wins + ?,
          losses = losses + ?,
          total_earnings_usdc = total_earnings_usdc + ?,
          total_spent_usdc = total_spent_usdc + ?,
          current_win_streak = CASE WHEN ? = 1 THEN current_win_streak + 1 ELSE 0 END,
          best_win_streak = MAX(best_win_streak, CASE WHEN ? = 1 THEN current_win_streak + 1 ELSE 0 END),
          last_match_at = ?,
          updated_at = ?
        WHERE wallet_address = ?
      `);
      updateStmt.run(
        isWinInt,
        isWin ? 0 : 1,
        earningsUsdc,
        spentUsdc,
        isWinInt,  // for current_win_streak CASE
        isWinInt,  // for best_win_streak CASE
        now,
        now,
        normalizedAddress
      );
    }

    // Return updated stats
    const resultStmt = database.prepare('SELECT * FROM player_stats WHERE wallet_address = ?');
    return resultStmt.get(normalizedAddress);
  });
}

/**
 * Set or update a player's username
 * Requires player to have completed at least one match
 * Usernames are permanently reserved once claimed
 *
 * @param {string} walletAddress - Player's wallet address
 * @param {string} username - Desired username (must be unique and not reserved)
 * @returns {{success: boolean, error?: string}} Result
 */
function setPlayerUsername(walletAddress, username) {
  return withTransaction('setPlayerUsername', (database) => {
    const normalizedAddress = walletAddress.toLowerCase();
    const normalizedUsername = username.trim();

    // Validate username format
    if (!normalizedUsername || normalizedUsername.length < 3 || normalizedUsername.length > 20) {
      return { success: false, error: 'Username must be 3-20 characters' };
    }
    if (!/^[a-zA-Z0-9_]+$/.test(normalizedUsername)) {
      return { success: false, error: 'Username can only contain letters, numbers, and underscores' };
    }

    // Check if player exists and has played at least one match
    const checkStmt = database.prepare('SELECT wallet_address, total_matches, username FROM player_stats WHERE wallet_address = ?');
    const player = checkStmt.get(normalizedAddress);

    if (!player) {
      return { success: false, error: 'You must complete a match before setting a username' };
    }

    if (player.total_matches < 1) {
      return { success: false, error: 'You must complete at least one match before setting a username' };
    }

    // Check if username is reserved (permanently claimed)
    const reservedStmt = database.prepare('SELECT username FROM reserved_usernames WHERE LOWER(username) = LOWER(?)');
    const reserved = reservedStmt.get(normalizedUsername);

    if (reserved) {
      return { success: false, error: 'Username is not available' };
    }

    // Check if username is currently in use by another player
    const usernameStmt = database.prepare('SELECT wallet_address FROM player_stats WHERE LOWER(username) = LOWER(?) AND wallet_address != ?');
    const existing = usernameStmt.get(normalizedUsername, normalizedAddress);

    if (existing) {
      return { success: false, error: 'Username is already taken' };
    }

    // Reserve the new username permanently
    const reserveStmt = database.prepare('INSERT OR IGNORE INTO reserved_usernames (username, reserved_by) VALUES (?, ?)');
    reserveStmt.run(normalizedUsername, normalizedAddress);

    // Update player's username
    const updateStmt = database.prepare('UPDATE player_stats SET username = ?, updated_at = ? WHERE wallet_address = ?');
    updateStmt.run(normalizedUsername, new Date().toISOString(), normalizedAddress);

    return { success: true };
  }) || { success: false, error: 'Database error' };
}

/**
 * Set or update a player's profile photo
 * Requires player to have completed at least one match
 * Photo is stored as base64 data URL
 *
 * @param {string} walletAddress - Player's wallet address
 * @param {string} photoData - Base64 encoded image data (data:image/...)
 * @returns {{success: boolean, error?: string}} Result
 */
function setPlayerPhoto(walletAddress, photoData) {
  return withDbErrorHandling('setPlayerPhoto', () => {
    const database = getDb();
    const normalizedAddress = walletAddress.toLowerCase();

    // Check if player exists and has played at least one match
    const checkStmt = database.prepare('SELECT wallet_address, total_matches FROM player_stats WHERE wallet_address = ?');
    const player = checkStmt.get(normalizedAddress);

    if (!player) {
      return { success: false, error: 'You must complete a match before setting a profile photo' };
    }

    if (player.total_matches < 1) {
      return { success: false, error: 'You must complete at least one match before setting a profile photo' };
    }

    // Validate photo data
    if (!photoData || !photoData.startsWith('data:image/')) {
      return { success: false, error: 'Invalid image format' };
    }

    // Check size (limit to ~500KB base64 which is ~375KB actual)
    if (photoData.length > 500000) {
      return { success: false, error: 'Image too large (max 500KB)' };
    }

    // Update profile photo
    const updateStmt = database.prepare('UPDATE player_stats SET profile_photo = ?, updated_at = ? WHERE wallet_address = ?');
    updateStmt.run(photoData, new Date().toISOString(), normalizedAddress);

    return { success: true };
  }, { success: false, error: 'Database error' });
}

/**
 * Get top players by wins (leaderboard)
 * Supports time-based filtering (all-time, monthly, weekly)
 *
 * @param {number} limit - Max number of players to return
 * @param {string} timeFilter - 'all' (default), 'monthly', or 'weekly'
 * @returns {Array} Top players sorted by wins
 */
function getLeaderboard(limit = 100, timeFilter = 'all') {
  return withDbErrorHandling('getLeaderboard', () => {
    const database = getDb();

    // For all-time, use the denormalized player_stats table (faster)
    if (timeFilter === 'all') {
      const stmt = database.prepare(`
        SELECT * FROM player_stats
        WHERE total_matches > 0
        ORDER BY wins DESC, total_earnings_usdc DESC
        LIMIT ?
      `);
      return stmt.all(limit);
    }

    // For time-filtered leaderboards, calculate from matches table
    let startDate;
    const now = new Date();

    if (timeFilter === 'weekly') {
      // Start of current week (Monday)
      const dayOfWeek = now.getDay();
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      startDate = new Date(now);
      startDate.setDate(now.getDate() - daysFromMonday);
      startDate.setHours(0, 0, 0, 0);
    } else if (timeFilter === 'monthly') {
      // Start of current month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      // Invalid filter, fall back to all-time
      const stmt = database.prepare(`
        SELECT * FROM player_stats
        WHERE total_matches > 0
        ORDER BY wins DESC, total_earnings_usdc DESC
        LIMIT ?
      `);
      return stmt.all(limit);
    }

    const startDateStr = startDate.toISOString();

    // Calculate wins, losses, and earnings within the time period
    const stmt = database.prepare(`
      SELECT
        u.wallet_address,
        ps.username,
        ps.profile_photo,
        COUNT(*) as total_matches,
        SUM(CASE WHEN m.winner_id = u.id THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN m.winner_id != u.id AND m.status = 'finished' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN m.winner_id = u.id THEN COALESCE(m.payout_amount, 0) ELSE 0 END) as total_earnings_usdc,
        ps.best_win_streak
      FROM users u
      JOIN match_players mp ON mp.user_id = u.id
      JOIN matches m ON mp.match_id = m.id
      LEFT JOIN player_stats ps ON u.wallet_address = ps.wallet_address
      WHERE m.status = 'finished' AND m.ended_at >= ?
      GROUP BY u.wallet_address
      ORDER BY wins DESC, total_earnings_usdc DESC
      LIMIT ?
    `);

    return stmt.all(startDateStr, limit);
  }, []);
}

/**
 * Get match history for a player by wallet address
 * Returns recent matches with details about opponents, roles, and outcomes
 * HIGH-4: Added offset parameter for pagination support
 *
 * @param {string} walletAddress - Player's wallet address
 * @param {number} limit - Max number of matches to return (default 20)
 * @param {number} offset - Number of matches to skip (default 0)
 * @returns {Array} Array of match records with details
 */
function getPlayerMatchHistory(walletAddress, limit = 20, offset = 0) {
  return withDbErrorHandling('getPlayerMatchHistory', () => {
    const database = getDb();
    const normalizedAddress = walletAddress.toLowerCase();

    // First get user_id for this wallet
    const userStmt = database.prepare('SELECT id FROM users WHERE wallet_address = ?');
    const user = userStmt.get(normalizedAddress);

    if (!user) {
      return [];
    }

    // Get finished matches for this player with all details
    const matchesStmt = database.prepare(`
      SELECT
        m.id as match_id,
        m.lobby_id,
        m.status,
        m.winner_id,
        m.payout_amount,
        m.payout_tx_hash,
        m.ended_at,
        mp.role as player_role,
        mp.eliminated_at,
        mp.eliminated_by
      FROM matches m
      JOIN match_players mp ON m.id = mp.match_id
      WHERE mp.user_id = ? AND m.status IN ('finished', 'void')
      ORDER BY m.ended_at DESC
      LIMIT ? OFFSET ?
    `);
    const matches = matchesStmt.all(user.id, limit, offset);

    // For each match, get opponent details
    const opponentsStmt = database.prepare(`
      SELECT
        mp.user_id,
        mp.role,
        mp.eliminated_at,
        u.wallet_address,
        ps.username
      FROM match_players mp
      JOIN users u ON mp.user_id = u.id
      LEFT JOIN player_stats ps ON u.wallet_address = ps.wallet_address
      WHERE mp.match_id = ? AND mp.user_id != ?
    `);

    return matches.map(match => {
      const opponents = opponentsStmt.all(match.match_id, user.id);
      const isWin = match.winner_id === user.id;
      const isVoid = match.status === 'void';

      return {
        matchId: match.match_id,
        lobbyId: match.lobby_id,
        endedAt: match.ended_at,
        result: isVoid ? 'void' : (isWin ? 'win' : 'loss'),
        playerRole: match.player_role,
        payout: isWin ? match.payout_amount : 0,
        payoutTxHash: isWin ? match.payout_tx_hash : null,
        eliminatedAt: match.eliminated_at,
        opponents: opponents.map(opp => ({
          walletAddress: opp.wallet_address,
          username: opp.username,
          role: opp.role,
        })),
      };
    });
  }, []);
}

/**
 * Get total match count for a player (for pagination)
 * HIGH-4: New function to support pagination
 *
 * @param {string} walletAddress - Player's wallet address
 * @returns {number} Total number of finished/void matches
 */
function getPlayerMatchCount(walletAddress) {
  return withDbErrorHandling('getPlayerMatchCount', () => {
    const database = getDb();
    const normalizedAddress = walletAddress.toLowerCase();

    // First get user_id for this wallet
    const userStmt = database.prepare('SELECT id FROM users WHERE wallet_address = ?');
    const user = userStmt.get(normalizedAddress);

    if (!user) {
      return 0;
    }

    const countStmt = database.prepare(`
      SELECT COUNT(*) as count
      FROM matches m
      JOIN match_players mp ON m.id = mp.match_id
      WHERE mp.user_id = ? AND m.status IN ('finished', 'void')
    `);
    return countStmt.get(user.id).count;
  }, 0);
}

/**
 * Calculate and rebuild stats for a player from match history
 * Useful for fixing inconsistencies or migrating existing data
 *
 * @param {string} walletAddress - Player's wallet address
 * @returns {Object|null} Rebuilt stats or null on error
 */
function rebuildPlayerStats(walletAddress) {
  return withTransaction('rebuildPlayerStats', (database) => {
    const now = new Date().toISOString();
    const normalizedAddress = walletAddress.toLowerCase();

    // Get user_id for this wallet (needed to query match_players)
    const userStmt = database.prepare('SELECT id FROM users WHERE wallet_address = ?');
    const user = userStmt.get(normalizedAddress);

    if (!user) {
      return null; // No user record means no matches
    }

    // Get all finished matches for this user
    const matchesStmt = database.prepare(`
      SELECT
        m.id,
        m.winner_id,
        m.payout_amount,
        m.ended_at
      FROM matches m
      JOIN match_players mp ON m.id = mp.match_id
      WHERE mp.user_id = ? AND m.status = 'finished'
      ORDER BY m.ended_at ASC
    `);
    const matches = matchesStmt.all(user.id);

    if (matches.length === 0) {
      return null; // No finished matches
    }

    // Calculate stats from history
    let totalMatches = matches.length;
    let wins = 0;
    let losses = 0;
    let totalEarnings = 0;
    let totalSpent = 0;
    let currentStreak = 0;
    let bestStreak = 0;
    let firstMatchAt = null;
    let lastMatchAt = null;

    const buyIn = parseFloat(process.env.BUY_IN_AMOUNT) || 1.0;

    for (const match of matches) {
      const isWin = match.winner_id === user.id;
      totalSpent += buyIn;

      if (!firstMatchAt) firstMatchAt = match.ended_at;

      if (isWin) {
        wins++;
        totalEarnings += match.payout_amount || 0;
        currentStreak++;
        bestStreak = Math.max(bestStreak, currentStreak);
      } else {
        losses++;
        currentStreak = 0;
      }
      lastMatchAt = match.ended_at;
    }

    // Preserve existing username if any
    const existingStmt = database.prepare('SELECT username FROM player_stats WHERE wallet_address = ?');
    const existing = existingStmt.get(normalizedAddress);

    // Upsert the stats
    const upsertStmt = database.prepare(`
      INSERT INTO player_stats (
        wallet_address, username, total_matches, wins, losses,
        total_earnings_usdc, total_spent_usdc,
        current_win_streak, best_win_streak,
        first_match_at, last_match_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        total_matches = excluded.total_matches,
        wins = excluded.wins,
        losses = excluded.losses,
        total_earnings_usdc = excluded.total_earnings_usdc,
        total_spent_usdc = excluded.total_spent_usdc,
        current_win_streak = excluded.current_win_streak,
        best_win_streak = excluded.best_win_streak,
        first_match_at = excluded.first_match_at,
        last_match_at = excluded.last_match_at,
        updated_at = excluded.updated_at
    `);
    upsertStmt.run(
      normalizedAddress,
      existing?.username || null,
      totalMatches, wins, losses,
      totalEarnings, totalSpent,
      currentStreak, bestStreak,
      firstMatchAt, lastMatchAt, now
    );

    return {
      wallet_address: normalizedAddress,
      total_matches: totalMatches,
      wins,
      losses,
      total_earnings_usdc: totalEarnings,
      total_spent_usdc: totalSpent,
      current_win_streak: currentStreak,
      best_win_streak: bestStreak,
      first_match_at: firstMatchAt,
      last_match_at: lastMatchAt,
    };
  });
}

/**
 * Rebuild stats for all players (migration helper)
 * @returns {{processed: number, errors: number}} Count of processed players
 */
function rebuildAllPlayerStats() {
  return withDbErrorHandling('rebuildAllPlayerStats', () => {
    const database = getDb();

    // Get all wallet addresses that have played at least one finished match
    const walletsStmt = database.prepare(`
      SELECT DISTINCT u.wallet_address
      FROM users u
      JOIN match_players mp ON mp.user_id = u.id
      JOIN matches m ON mp.match_id = m.id
      WHERE m.status = 'finished'
    `);
    const wallets = walletsStmt.all();

    let processed = 0;
    let errors = 0;

    for (const { wallet_address } of wallets) {
      const result = rebuildPlayerStats(wallet_address);
      if (result) {
        processed++;
      } else {
        errors++;
      }
    }

    console.log(`[DB] Rebuilt stats for ${processed} players (${errors} errors)`);
    return { processed, errors };
  }, { processed: 0, errors: 0 });
}

// ============================================
// Paid Wallets (Airdrop List)
// ============================================

/**
 * Track a wallet address that has paid to play
 * Called when a player successfully joins a lobby with confirmed payment
 * Updates total_payments and last_payment_at if wallet already exists
 *
 * @param {string} walletAddress - Player's wallet address
 * @returns {Object|null} The paid wallet record
 */
function trackPaidWallet(walletAddress) {
  return withDbErrorHandling('trackPaidWallet', () => {
    const database = getDb();
    const normalizedAddress = walletAddress.toLowerCase();
    const now = new Date().toISOString();

    const stmt = database.prepare(`
      INSERT INTO paid_wallets (wallet_address, first_payment_at, total_payments, last_payment_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        total_payments = total_payments + 1,
        last_payment_at = excluded.last_payment_at
    `);
    stmt.run(normalizedAddress, now, now);

    // Return the record
    const getStmt = database.prepare('SELECT * FROM paid_wallets WHERE wallet_address = ?');
    return getStmt.get(normalizedAddress);
  }, null);
}

/**
 * Get all wallets that have ever paid to play (for airdrops)
 * Returns unique wallet addresses sorted by first payment date
 *
 * @returns {Array<{wallet_address: string, first_payment_at: string, total_payments: number, last_payment_at: string}>}
 */
function getAllPaidWallets() {
  return withDbErrorHandling('getAllPaidWallets', () => {
    const database = getDb();
    const stmt = database.prepare(`
      SELECT * FROM paid_wallets
      ORDER BY first_payment_at ASC
    `);
    return stmt.all();
  }, []);
}

/**
 * Get count of unique paid wallets
 * @returns {number} Total number of unique wallets that have paid
 */
function getPaidWalletCount() {
  return withDbErrorHandling('getPaidWalletCount', () => {
    const database = getDb();
    const stmt = database.prepare('SELECT COUNT(*) as count FROM paid_wallets');
    return stmt.get().count;
  }, 0);
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

  // WAL Checkpointing & Backup
  walCheckpoint,
  createBackup,
  createTimestampedBackup,
  verifyBackupIntegrity,
  listBackups,
  cleanupOldBackups,

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
  updateSessionToken,

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
  cleanupOldPayoutRecords,

  // Transactional Operations (atomic multi-step)
  withTransaction,
  createMatchWithPlayers,
  resetLobbyWithPlayers,
  endMatchWithLobbyReset,

  // Player Stats (wallet-address based)
  getPlayerStats,
  getPlayerMatchHistory,
  getPlayerMatchCount,
  recordMatchResult,
  setPlayerUsername,
  setPlayerPhoto,
  getLeaderboard,
  rebuildPlayerStats,
  rebuildAllPlayerStats,

  // Paid Wallets (Airdrop List)
  trackPaidWallet,
  getAllPaidWallets,
  getPaidWalletCount,
};
