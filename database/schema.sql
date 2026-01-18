-- RPS Arena Database Schema
-- SQLite version

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Lobbies table (exactly 10 lobbies, created at server startup)
CREATE TABLE IF NOT EXISTS lobbies (
  id INTEGER PRIMARY KEY CHECK (id >= 1 AND id <= 10),
  status TEXT DEFAULT 'empty' CHECK (status IN ('empty', 'waiting', 'ready', 'in_progress')),
  deposit_address TEXT NOT NULL,
  deposit_private_key_encrypted TEXT NOT NULL,
  first_join_at TEXT,
  timeout_at TEXT,
  swept_at TEXT,
  current_match_id TEXT REFERENCES matches(id)
);

-- Lobby players (join table)
CREATE TABLE IF NOT EXISTS lobby_players (
  id TEXT PRIMARY KEY,
  lobby_id INTEGER REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  payment_tx_hash TEXT NOT NULL,
  payment_confirmed_at TEXT NOT NULL,
  refund_tx_hash TEXT,
  refund_reason TEXT CHECK (refund_reason IN ('timeout', 'server_crash', 'triple_disconnect', 'double_disconnect', 'payout_failed')),
  refunded_at TEXT,
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(lobby_id, user_id),
  UNIQUE(payment_tx_hash)
);

-- Matches table
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  lobby_id INTEGER REFERENCES lobbies(id),
  status TEXT DEFAULT 'countdown' CHECK (status IN ('countdown', 'running', 'finished', 'void')),
  winner_id TEXT REFERENCES users(id),
  rng_seed INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  countdown_at TEXT,
  running_at TEXT,
  ended_at TEXT,
  payout_amount REAL,
  payout_tx_hash TEXT
);

-- Match players (join table with game-specific data)
CREATE TABLE IF NOT EXISTS match_players (
  id TEXT PRIMARY KEY,
  match_id TEXT REFERENCES matches(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('rock', 'paper', 'scissors')),
  spawn_x REAL NOT NULL,
  spawn_y REAL NOT NULL,
  eliminated_at TEXT,
  eliminated_by TEXT REFERENCES users(id),
  final_x REAL,
  final_y REAL,
  UNIQUE(match_id, user_id),
  UNIQUE(match_id, role)
);

-- Match events (for replay/audit)
CREATE TABLE IF NOT EXISTS match_events (
  id TEXT PRIMARY KEY,
  match_id TEXT REFERENCES matches(id) ON DELETE CASCADE,
  tick INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('elimination', 'bounce', 'disconnect', 'start', 'end')),
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Payout attempts (for audit trail and failure tracking)
CREATE TABLE IF NOT EXISTS payout_attempts (
  id TEXT PRIMARY KEY,
  match_id TEXT REFERENCES matches(id) ON DELETE CASCADE,
  lobby_id INTEGER REFERENCES lobbies(id),
  recipient_address TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  tx_hash TEXT,
  error_message TEXT,
  error_type TEXT,
  source_wallet TEXT NOT NULL CHECK (source_wallet IN ('lobby', 'treasury')),
  treasury_balance_before TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_lobbies_status ON lobbies(status);
CREATE INDEX IF NOT EXISTS idx_lobby_players_lobby ON lobby_players(lobby_id);
CREATE INDEX IF NOT EXISTS idx_lobby_players_user ON lobby_players(user_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_lobby ON matches(lobby_id);
CREATE INDEX IF NOT EXISTS idx_match_events_match ON match_events(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_payout_attempts_match ON payout_attempts(match_id);
CREATE INDEX IF NOT EXISTS idx_payout_attempts_status ON payout_attempts(status);

-- Match state persistence (for crash recovery)
CREATE TABLE IF NOT EXISTS match_state (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  tick INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('countdown', 'running')),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_state_status ON match_state(status);
