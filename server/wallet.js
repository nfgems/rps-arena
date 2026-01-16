/**
 * Wallet management for RPS Arena
 * HD wallet derivation and encryption
 */

const { ethers } = require('ethers');
const crypto = require('crypto');

// ============================================
// Encryption Utilities
// ============================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a private key for storage
 * @param {string} privateKey - Private key to encrypt
 * @param {string} encryptionKey - 32-byte encryption key
 * @returns {string} Encrypted data as hex string (iv:authTag:ciphertext)
 */
function encryptPrivateKey(privateKey, encryptionKey) {
  // Ensure key is 32 bytes
  const key = crypto.createHash('sha256').update(encryptionKey).digest();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a private key from storage
 * @param {string} encryptedData - Encrypted data from encryptPrivateKey
 * @param {string} encryptionKey - 32-byte encryption key
 * @returns {string} Decrypted private key
 */
function decryptPrivateKey(encryptedData, encryptionKey) {
  const key = crypto.createHash('sha256').update(encryptionKey).digest();
  const [ivHex, authTagHex, ciphertext] = encryptedData.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ============================================
// HD Wallet Derivation
// ============================================

/**
 * Derive a wallet from a mnemonic seed phrase
 * @param {string} mnemonic - 12 or 24 word seed phrase
 * @param {number} index - Account index (0, 1, 2, etc.)
 * @returns {Object} { address, privateKey }
 */
function deriveWallet(mnemonic, index) {
  // ethers v6: fromPhrase with derivation path
  const path = `m/44'/60'/0'/0/${index}`;
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

/**
 * Generate lobby wallets from seed
 * @param {string} mnemonic - Seed phrase
 * @param {string} encryptionKey - Key for encrypting private keys
 * @returns {Array} Array of { id, depositAddress, encryptedPrivateKey }
 */
function generateLobbyWallets(mnemonic, encryptionKey) {
  const lobbies = [];

  for (let i = 1; i <= 10; i++) {
    const wallet = deriveWallet(mnemonic, i);

    lobbies.push({
      id: i,
      depositAddress: wallet.address,
      encryptedPrivateKey: encryptPrivateKey(wallet.privateKey, encryptionKey),
    });
  }

  return lobbies;
}

/**
 * Create a wallet instance from encrypted private key
 * @param {string} encryptedPrivateKey - Encrypted key from database
 * @param {string} encryptionKey - Decryption key
 * @param {Object} provider - ethers provider (optional)
 * @returns {ethers.Wallet} Wallet instance
 */
function getWalletFromEncrypted(encryptedPrivateKey, encryptionKey, provider = null) {
  const privateKey = decryptPrivateKey(encryptedPrivateKey, encryptionKey);
  return new ethers.Wallet(privateKey, provider);
}

/**
 * Validate a mnemonic phrase
 * @param {string} mnemonic - Seed phrase to validate
 * @returns {boolean} True if valid
 */
function isValidMnemonic(mnemonic) {
  try {
    return ethers.Mnemonic.isValidMnemonic(mnemonic);
  } catch {
    return false;
  }
}

/**
 * Generate a new random mnemonic (for testing/setup)
 * @returns {string} 12-word mnemonic
 */
function generateMnemonic() {
  const wallet = ethers.Wallet.createRandom();
  return wallet.mnemonic.phrase;
}

module.exports = {
  encryptPrivateKey,
  decryptPrivateKey,
  deriveWallet,
  generateLobbyWallets,
  getWalletFromEncrypted,
  isValidMnemonic,
  generateMnemonic,
};
