/**
 * Database connection and query utilities for RPS Arena
 * Uses better-sqlite3 for synchronous SQLite operations
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let db = null;

/**
 * Get or create database connection
 */
function getDb() {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/rps-arena.db';
  const fullPath = path.resolve(dbPath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(fullPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * Initialize database with schema
 */
function initializeDatabase() {
  const db = getDb();
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  console.log('Database schema initialized');
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
  const db = getDb();
  const id = uuid();
  const stmt = db.prepare(`
    INSERT INTO users (id, wallet_address, username)
    VALUES (?, ?, ?)
  `);
  stmt.run(id, walletAddress.toLowerCase(), username);
  return { id, wallet_address: walletAddress.toLowerCase(), username };
}

function getUserByWallet(walletAddress) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE wallet_address = ?');
  return stmt.get(walletAddress.toLowerCase());
}

function getUserById(id) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

function updateUsername(userId, username) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE users SET username = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  return stmt.run(username, userId);
}

// ============================================
// Session Operations
// ============================================

function createSession(userId) {
  const db = getDb();
  const id = uuid();
  const token = crypto.randomBytes(32).toString('hex');
  const expiryHours = parseInt(process.env.SESSION_EXPIRY_HOURS || '24');
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, user_id, token, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, userId, token, expiresAt);

  return { id, user_id: userId, token, expires_at: expiresAt };
}

function getSessionByToken(token) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT s.*, u.wallet_address, u.username
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `);
  return stmt.get(token);
}

function deleteSession(token) {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
  return stmt.run(token);
}

function cleanExpiredSessions() {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  return stmt.run();
}

// ============================================
// Lobby Operations
// ============================================

function initializeLobbies(lobbies) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO lobbies (id, status, deposit_address, deposit_private_key_encrypted)
    VALUES (?, 'empty', ?, ?)
  `);

  const insertMany = db.transaction((lobbies) => {
    for (const lobby of lobbies) {
      stmt.run(lobby.id, lobby.depositAddress, lobby.encryptedPrivateKey);
    }
  });

  insertMany(lobbies);
}

function getLobby(lobbyId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM lobbies WHERE id = ?');
  return stmt.get(lobbyId);
}

function getAllLobbies() {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM lobbies ORDER BY id');
  return stmt.all();
}

function updateLobbyStatus(lobbyId, status, matchId = null) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE lobbies SET status = ?, current_match_id = ?
    WHERE id = ?
  `);
  return stmt.run(status, matchId, lobbyId);
}

function setLobbyFirstJoin(lobbyId) {
  const db = getDb();
  const now = new Date().toISOString();
  const timeout = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  const stmt = db.prepare(`
    UPDATE lobbies SET first_join_at = ?, timeout_at = ?, status = 'waiting'
    WHERE id = ? AND first_join_at IS NULL
  `);
  return stmt.run(now, timeout, lobbyId);
}

function resetLobby(lobbyId) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE lobbies
    SET status = 'empty', first_join_at = NULL, timeout_at = NULL, current_match_id = NULL
    WHERE id = ?
  `);
  return stmt.run(lobbyId);
}

function getLobbyPlayerCount(lobbyId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM lobby_players
    WHERE lobby_id = ? AND refunded_at IS NULL
  `);
  return stmt.get(lobbyId).count;
}

// ============================================
// Lobby Player Operations
// ============================================

function addLobbyPlayer(lobbyId, userId, paymentTxHash) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO lobby_players (id, lobby_id, user_id, payment_tx_hash, payment_confirmed_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, lobbyId, userId, paymentTxHash, now);

  return { id, lobby_id: lobbyId, user_id: userId, payment_tx_hash: paymentTxHash };
}

function getLobbyPlayers(lobbyId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT lp.*, u.wallet_address, u.username
    FROM lobby_players lp
    JOIN users u ON lp.user_id = u.id
    WHERE lp.lobby_id = ? AND lp.refunded_at IS NULL
    ORDER BY lp.joined_at
  `);
  return stmt.all(lobbyId);
}

function getPlayerInLobby(userId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT lp.*, l.status as lobby_status
    FROM lobby_players lp
    JOIN lobbies l ON lp.lobby_id = l.id
    WHERE lp.user_id = ? AND lp.refunded_at IS NULL
  `);
  return stmt.get(userId);
}

function txHashExists(txHash) {
  const db = getDb();
  const stmt = db.prepare('SELECT 1 FROM lobby_players WHERE payment_tx_hash = ?');
  return !!stmt.get(txHash);
}

function markPlayerRefunded(lobbyPlayerId, reason, txHash) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE lobby_players
    SET refunded_at = ?, refund_reason = ?, refund_tx_hash = ?
    WHERE id = ?
  `);
  return stmt.run(now, reason, txHash, lobbyPlayerId);
}

function clearLobbyPlayers(lobbyId) {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM lobby_players WHERE lobby_id = ?');
  return stmt.run(lobbyId);
}

// ============================================
// Match Operations
// ============================================

function createMatch(lobbyId, rngSeed) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO matches (id, lobby_id, status, rng_seed, countdown_at)
    VALUES (?, ?, 'countdown', ?, ?)
  `);
  stmt.run(id, lobbyId, rngSeed, now);

  return { id, lobby_id: lobbyId, status: 'countdown', rng_seed: rngSeed };
}

function getMatch(matchId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM matches WHERE id = ?');
  return stmt.get(matchId);
}

function updateMatchStatus(matchId, status) {
  const db = getDb();
  const now = new Date().toISOString();

  let stmt;
  if (status === 'running') {
    stmt = db.prepare('UPDATE matches SET status = ?, running_at = ? WHERE id = ?');
  } else if (status === 'finished' || status === 'void') {
    stmt = db.prepare('UPDATE matches SET status = ?, ended_at = ? WHERE id = ?');
  } else {
    stmt = db.prepare('UPDATE matches SET status = ? WHERE id = ?');
    return stmt.run(status, matchId);
  }
  return stmt.run(status, now, matchId);
}

function setMatchWinner(matchId, winnerId, payoutAmount, payoutTxHash) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE matches
    SET status = 'finished', winner_id = ?, payout_amount = ?, payout_tx_hash = ?, ended_at = ?
    WHERE id = ?
  `);
  return stmt.run(winnerId, payoutAmount, payoutTxHash, now, matchId);
}

// ============================================
// Match Player Operations
// ============================================

function addMatchPlayer(matchId, userId, role, spawnX, spawnY) {
  const db = getDb();
  const id = uuid();

  const stmt = db.prepare(`
    INSERT INTO match_players (id, match_id, user_id, role, spawn_x, spawn_y)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, matchId, userId, role, spawnX, spawnY);

  return { id, match_id: matchId, user_id: userId, role, spawn_x: spawnX, spawn_y: spawnY };
}

function getMatchPlayers(matchId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT mp.*, u.wallet_address, u.username
    FROM match_players mp
    JOIN users u ON mp.user_id = u.id
    WHERE mp.match_id = ?
  `);
  return stmt.all(matchId);
}

function eliminatePlayer(matchId, userId, eliminatedBy, finalX, finalY) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE match_players
    SET eliminated_at = ?, eliminated_by = ?, final_x = ?, final_y = ?
    WHERE match_id = ? AND user_id = ?
  `);
  return stmt.run(now, eliminatedBy, finalX, finalY, matchId, userId);
}

// ============================================
// Match Event Operations
// ============================================

function logMatchEvent(matchId, tick, eventType, data) {
  const db = getDb();
  const id = uuid();

  const stmt = db.prepare(`
    INSERT INTO match_events (id, match_id, tick, event_type, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, matchId, tick, eventType, JSON.stringify(data));

  return { id, match_id: matchId, tick, event_type: eventType, data };
}

function getMatchEvents(matchId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM match_events WHERE match_id = ? ORDER BY tick, created_at
  `);
  return stmt.all(matchId).map(e => ({ ...e, data: JSON.parse(e.data) }));
}

// ============================================
// Exports
// ============================================

module.exports = {
  getDb,
  initializeDatabase,
  uuid,

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
