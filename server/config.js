/**
 * Centralized Configuration for RPS Arena
 * All configurable values with environment variable overrides
 */

const crypto = require('crypto');

// ============================================
// Payment Configuration
// ============================================

// USDC amounts (in smallest unit, 6 decimals)
const BUY_IN_AMOUNT = parseInt(process.env.BUY_IN_AMOUNT, 10) || 1_000_000; // 1 USDC
const WINNER_PAYOUT = parseInt(process.env.WINNER_PAYOUT, 10) || 2_400_000; // 2.4 USDC
const TREASURY_CUT = parseInt(process.env.TREASURY_CUT, 10) || 600_000; // 0.6 USDC

// ============================================
// Rate Limiting Configuration
// ============================================

const RATE_LIMIT_INPUT_PER_SEC = parseInt(process.env.RATE_LIMIT_INPUT, 10) || 120; // INPUT messages/sec
const RATE_LIMIT_OTHER_PER_SEC = parseInt(process.env.RATE_LIMIT_OTHER, 10) || 10; // Other messages/sec
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 3;

// Rate limit cleanup
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// ============================================
// Game Configuration
// ============================================

const COUNTDOWN_DURATION = parseInt(process.env.COUNTDOWN_DURATION, 10) || 3; // seconds
const TICK_RATE = parseInt(process.env.TICK_RATE, 10) || 30; // Hz
const SNAPSHOT_RATE = 20; // Hz (fixed - clients expect this)

// ============================================
// RNG Configuration
// ============================================

/**
 * Generate a cryptographically secure random seed
 * Used for spawn positions and role assignment
 * @returns {number} A random 32-bit integer
 */
function generateSecureRngSeed() {
  // Use crypto.randomInt for a secure random integer
  // Range: 0 to 2^31 - 1 (safe positive integer range)
  return crypto.randomInt(0, 2147483647);
}

// ============================================
// Lobby Configuration
// ============================================

const LOBBY_TIMEOUT_MS = parseInt(process.env.LOBBY_TIMEOUT_MS, 10) || 30 * 60 * 1000; // 30 minutes

// ============================================
// Export Configuration
// ============================================

module.exports = {
  // Payment
  BUY_IN_AMOUNT,
  WINNER_PAYOUT,
  TREASURY_CUT,

  // Rate limits
  RATE_LIMIT_INPUT_PER_SEC,
  RATE_LIMIT_OTHER_PER_SEC,
  MAX_CONNECTIONS_PER_IP,
  RATE_LIMIT_CLEANUP_INTERVAL_MS,
  RATE_LIMIT_MAX_AGE_MS,

  // Game
  COUNTDOWN_DURATION,
  TICK_RATE,
  SNAPSHOT_RATE,

  // RNG
  generateSecureRngSeed,

  // Lobby
  LOBBY_TIMEOUT_MS,
};
