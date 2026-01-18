/**
 * Session management for RPS Arena
 * Handles token generation and validation
 */

const crypto = require('crypto');
const db = require('./database');

/**
 * Generate a secure random session token
 * @returns {string} 64-character hex token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new session for a user
 * @param {string} userId - User's UUID
 * @returns {Object} Session object with token
 */
function createSession(userId) {
  return db.createSession(userId);
}

/**
 * Validate a session token
 * @param {string} token - Session token to validate
 * @returns {Object|null} Session with user info if valid, null otherwise
 */
function validateSession(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) {
    return null;
  }
  return db.getSessionByToken(token);
}

/**
 * Invalidate a session (logout)
 * @param {string} token - Session token to invalidate
 */
function invalidateSession(token) {
  db.deleteSession(token);
}

/**
 * Rotate session token (invalidates old token, issues new one)
 * Use this on sensitive operations like reconnection to prevent replay attacks
 * @param {string} oldToken - Current session token
 * @returns {{token: string, userId: string}|null} New token and user ID, or null if invalid
 */
function rotateToken(oldToken) {
  const session = db.getSessionByToken(oldToken);
  if (!session) return null;

  const newToken = generateToken();
  const result = db.updateSessionToken(session.id, newToken);

  if (!result || result.changes === 0) {
    return null;
  }

  return {
    token: newToken,
    userId: session.user_id,
    walletAddress: session.wallet_address,
  };
}

/**
 * Clean up expired sessions (run periodically)
 */
function cleanupExpiredSessions() {
  const result = db.cleanExpiredSessions();
  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} expired sessions`);
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

module.exports = {
  generateToken,
  createSession,
  validateSession,
  invalidateSession,
  cleanupExpiredSessions,
  rotateToken,
};
