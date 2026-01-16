/**
 * Wallet authentication for RPS Arena
 * Handles signature verification and user creation
 */

const { ethers } = require('ethers');
const db = require('./database');
const session = require('./session');

/**
 * Generate a sign-in message for wallet signature
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Message to sign
 */
function getSignInMessage(timestamp) {
  return `Sign in to RPS Arena: ${timestamp}`;
}

/**
 * Verify a wallet signature
 * @param {string} walletAddress - Claimed wallet address
 * @param {string} signature - Signature from wallet
 * @param {number} timestamp - Timestamp used in message
 * @returns {boolean} True if signature is valid
 */
function verifySignature(walletAddress, signature, timestamp) {
  try {
    const message = getSignInMessage(timestamp);
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === walletAddress.toLowerCase();
  } catch (error) {
    console.error('Signature verification failed:', error.message);
    return false;
  }
}

/**
 * Authenticate a user via wallet signature
 * Creates user if not exists, returns session token
 *
 * @param {string} walletAddress - Ethereum address
 * @param {string} signature - Signed message
 * @param {number} timestamp - Timestamp from signed message
 * @returns {Object} { success, token, user, error }
 */
function authenticateWallet(walletAddress, signature, timestamp) {
  // Validate inputs
  if (!walletAddress || !signature || !timestamp) {
    return { success: false, error: 'Missing required parameters' };
  }

  // Validate wallet address format
  if (!ethers.isAddress(walletAddress)) {
    return { success: false, error: 'Invalid wallet address format' };
  }

  // Check timestamp is recent (within 5 minutes)
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  if (Math.abs(now - timestamp) > fiveMinutes) {
    return { success: false, error: 'Timestamp expired' };
  }

  // Verify signature
  if (!verifySignature(walletAddress, signature, timestamp)) {
    return { success: false, error: 'Invalid signature' };
  }

  // Get or create user
  let user = db.getUserByWallet(walletAddress);
  if (!user) {
    user = db.createUser(walletAddress);
    console.log(`Created new user: ${user.id} (${walletAddress})`);
  }

  // Create session
  const sessionData = session.createSession(user.id);

  return {
    success: true,
    token: sessionData.token,
    user: {
      id: user.id,
      walletAddress: user.wallet_address,
      username: user.username,
    },
  };
}

/**
 * Validate an existing session token
 * @param {string} token - Session token
 * @returns {Object} { valid, user }
 */
function validateAuth(token) {
  const sessionData = session.validateSession(token);
  if (!sessionData) {
    return { valid: false, user: null };
  }

  return {
    valid: true,
    user: {
      id: sessionData.user_id,
      walletAddress: sessionData.wallet_address,
      username: sessionData.username,
    },
  };
}

/**
 * Logout - invalidate session
 * @param {string} token - Session token
 */
function logout(token) {
  session.invalidateSession(token);
}

module.exports = {
  getSignInMessage,
  verifySignature,
  authenticateWallet,
  validateAuth,
  logout,
};
