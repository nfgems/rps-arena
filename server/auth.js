/**
 * Wallet authentication for RPS Arena
 * Handles signature verification and user creation
 */

const { ethers } = require('ethers');
const { SiweMessage } = require('siwe');
const db = require('./database');
const session = require('./session');

/**
 * Verify a SIWE message and signature
 * @param {string} walletAddress - Claimed wallet address
 * @param {string} signature - Signature from wallet
 * @param {string} message - SIWE message string
 * @returns {Object} { valid: boolean, error?: string }
 */
async function verifySiweMessage(walletAddress, signature, message) {
  try {
    const siweMessage = new SiweMessage(message);

    // Verify the signature
    const fields = await siweMessage.verify({ signature });

    if (!fields.success) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Verify the address matches
    if (siweMessage.address.toLowerCase() !== walletAddress.toLowerCase()) {
      return { valid: false, error: 'Address mismatch' };
    }

    // Check expiration
    if (siweMessage.expirationTime && new Date(siweMessage.expirationTime) < new Date()) {
      return { valid: false, error: 'Message expired' };
    }

    return { valid: true };
  } catch (error) {
    console.error('SIWE verification failed:', error.message);
    return { valid: false, error: 'Signature verification failed' };
  }
}

/**
 * Authenticate a user via SIWE wallet signature
 * Creates user if not exists, returns session token
 *
 * @param {string} walletAddress - Ethereum address
 * @param {string} signature - Signed message
 * @param {string} message - SIWE message string
 * @returns {Promise<Object>} { success, token, user, error }
 */
async function authenticateWallet(walletAddress, signature, message) {
  // Validate inputs
  if (!walletAddress || !signature || !message) {
    return { success: false, error: 'Missing required parameters' };
  }

  // Validate wallet address format
  if (!ethers.isAddress(walletAddress)) {
    return { success: false, error: 'Invalid wallet address format' };
  }

  // Verify SIWE message and signature
  const verification = await verifySiweMessage(walletAddress, signature, message);
  if (!verification.valid) {
    return { success: false, error: verification.error };
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
  verifySiweMessage,
  authenticateWallet,
  validateAuth,
  logout,
};
