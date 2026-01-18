/**
 * Payment processing for RPS Arena
 * Base blockchain USDC transactions
 */

const { ethers } = require('ethers');
const wallet = require('./wallet');
const { sendAlert, AlertType } = require('./alerts');

// USDC Contract ABI (minimal for transfers)
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// Constants
const USDC_DECIMALS = 6;
const BUY_IN_AMOUNT = 1_000_000; // 1 USDC
const WINNER_PAYOUT = 2_400_000; // 2.4 USDC
const TREASURY_CUT = 600_000; // 0.6 USDC

// Payment security constants
const MIN_CONFIRMATIONS = 3; // Minimum block confirmations required
const MAX_TX_AGE_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const AMOUNT_TOLERANCE_PERCENT = 0; // Exact match required for USDC (ERC-20 transfers have no gas-induced variations)

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 10000; // 10 seconds

// Low ETH balance threshold (for gas)
const LOW_ETH_THRESHOLD = ethers.parseEther('0.001'); // 0.001 ETH (~$3-4 at typical prices, enough for ~20+ txs on Base)

// RPC provider fallbacks (in order of preference)
const DEFAULT_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
];

let provider = null;
let usdcContract = null;
let currentRpcIndex = 0;

// ============================================
// Error Classification
// ============================================

/**
 * Transient errors that may succeed on retry
 */
const TRANSIENT_ERROR_PATTERNS = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'network error',
  'timeout',
  'rate limit',
  'too many requests',
  '429',
  '502',
  '503',
  '504',
  'SERVER_ERROR',
  'CONNECTION_ERROR',
  'could not detect network',
  'missing response',
  'request failed',
];

/**
 * Permanent errors that should not be retried
 */
const PERMANENT_ERROR_PATTERNS = [
  'insufficient funds',
  'nonce too low',
  'replacement fee too low',
  'gas required exceeds',
  'execution reverted',
  'invalid address',
  'invalid argument',
  'UNPREDICTABLE_GAS_LIMIT',
  'CALL_EXCEPTION',
];

/**
 * Classify an error as transient or permanent
 * @param {Error|string} error - The error to classify
 * @returns {'transient'|'permanent'|'unknown'} Error classification
 */
function classifyError(error) {
  const errorMessage = (error?.message || error || '').toLowerCase();
  const errorCode = error?.code || '';

  // Check for permanent errors first (more specific)
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (errorMessage.includes(pattern.toLowerCase()) || errorCode.includes(pattern)) {
      return 'permanent';
    }
  }

  // Check for transient errors
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (errorMessage.includes(pattern.toLowerCase()) || errorCode.includes(pattern)) {
      return 'transient';
    }
  }

  return 'unknown';
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic for transient errors
 * @param {Function} fn - Async function to execute
 * @param {string} operationName - Name of the operation for logging
 * @param {number} maxRetries - Maximum number of retries (default: MAX_RETRIES)
 * @returns {Promise<any>} Result of the function
 */
async function withRetry(fn, operationName, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const errorType = classifyError(error);

      console.error(`${operationName} attempt ${attempt}/${maxRetries} failed:`, error.message);

      // Don't retry permanent errors
      if (errorType === 'permanent') {
        console.error(`${operationName}: Permanent error, not retrying`);
        throw error;
      }

      // On transient errors, try switching RPC provider
      if (errorType === 'transient' && attempt < maxRetries) {
        const switched = switchToNextProvider();
        if (switched) {
          console.log(`${operationName}: Switched to fallback RPC provider`);
        }
      }

      // Exponential backoff with jitter for retries
      if (attempt < maxRetries) {
        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 500,
          MAX_RETRY_DELAY_MS
        );
        console.log(`${operationName}: Retrying in ${Math.round(delay)}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted - send alert
  sendAlert(AlertType.RPC_ERROR, {
    operation: operationName,
    error: lastError?.message || 'Unknown error after all retries',
  }).catch(err => console.error('Alert send failed:', err.message));

  throw lastError;
}

// ============================================
// Provider Management
// ============================================

/**
 * Get the list of RPC URLs to try
 * @returns {string[]} Array of RPC URLs
 */
function getRpcUrls() {
  const customRpc = process.env.BASE_RPC_URL;
  if (customRpc) {
    // Put custom RPC first, then fallbacks
    return [customRpc, ...DEFAULT_RPC_URLS.filter(url => url !== customRpc)];
  }
  return DEFAULT_RPC_URLS;
}

/**
 * Initialize the blockchain provider with error handling
 */
function initProvider() {
  if (provider) return provider;

  const rpcUrls = getRpcUrls();
  const rpcUrl = rpcUrls[currentRpcIndex];

  try {
    provider = new ethers.JsonRpcProvider(rpcUrl);
    console.log(`Initialized RPC provider: ${rpcUrl}`);
  } catch (error) {
    console.error(`Failed to initialize RPC provider ${rpcUrl}:`, error.message);
    // Try next provider
    if (switchToNextProvider()) {
      return initProvider();
    }
    throw new Error('All RPC providers failed to initialize');
  }

  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, provider);

  return provider;
}

/**
 * Switch to the next available RPC provider
 * @returns {boolean} True if switched successfully, false if no more providers
 */
function switchToNextProvider() {
  const rpcUrls = getRpcUrls();
  const nextIndex = currentRpcIndex + 1;

  if (nextIndex >= rpcUrls.length) {
    // Wrap around to first provider
    currentRpcIndex = 0;
    console.warn('All RPC providers attempted, cycling back to primary');
    return false;
  }

  currentRpcIndex = nextIndex;
  const newRpcUrl = rpcUrls[currentRpcIndex];

  console.log(`Switching to RPC provider ${currentRpcIndex + 1}/${rpcUrls.length}: ${newRpcUrl}`);

  try {
    provider = new ethers.JsonRpcProvider(newRpcUrl);
    const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, provider);
    return true;
  } catch (error) {
    console.error(`Failed to switch to RPC provider ${newRpcUrl}:`, error.message);
    // Recursively try next provider
    return switchToNextProvider();
  }
}

/**
 * Test the current RPC connection
 * @returns {Promise<{healthy: boolean, latency: number, error?: string}>}
 */
async function testRpcConnection() {
  const start = Date.now();
  try {
    const p = getProvider();
    const blockNumber = await p.getBlockNumber();
    const latency = Date.now() - start;
    return { healthy: true, latency, blockNumber };
  } catch (error) {
    return { healthy: false, latency: Date.now() - start, error: error.message };
  }
}

/**
 * Get USDC contract instance
 */
function getUsdcContract() {
  if (!usdcContract) initProvider();
  return usdcContract;
}

/**
 * Get provider instance
 */
function getProvider() {
  if (!provider) initProvider();
  return provider;
}

// ============================================
// Transaction Verification
// ============================================

/**
 * Verify a USDC payment transaction
 * @param {string} txHash - Transaction hash
 * @param {string} expectedRecipient - Expected recipient address
 * @param {string} expectedSender - Expected sender address
 * @param {number} expectedAmount - Expected amount in USDC units (with decimals)
 * @param {Object} options - Verification options
 * @param {boolean} options.checkConfirmations - Whether to check min confirmations (default: true)
 * @param {boolean} options.checkAge - Whether to check transaction age (default: true)
 * @returns {Object} { valid, error, tx }
 */
async function verifyPayment(txHash, expectedRecipient, expectedSender, expectedAmount = BUY_IN_AMOUNT, options = {}) {
  const { checkConfirmations = true, checkAge = true } = options;

  try {
    const provider = getProvider();
    const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    // Get transaction receipt
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return { valid: false, error: 'Transaction not found or not confirmed' };
    }

    // Check if transaction was successful
    if (receipt.status !== 1) {
      return { valid: false, error: 'Transaction failed' };
    }

    // Get block for confirmation count and timestamp
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;

    // Check minimum confirmations
    if (checkConfirmations && confirmations < MIN_CONFIRMATIONS) {
      return {
        valid: false,
        error: `Insufficient confirmations: ${confirmations}/${MIN_CONFIRMATIONS}`,
        confirmations,
        requiredConfirmations: MIN_CONFIRMATIONS
      };
    }

    // Check transaction age (reject payments older than MAX_TX_AGE_MS)
    if (checkAge) {
      const block = await provider.getBlock(receipt.blockNumber);
      if (block) {
        const txTimestamp = block.timestamp * 1000; // Convert to milliseconds
        const txAge = Date.now() - txTimestamp;
        if (txAge > MAX_TX_AGE_MS) {
          return {
            valid: false,
            error: `Transaction too old: ${Math.round(txAge / 60000)} minutes (max ${MAX_TX_AGE_MS / 60000} minutes)`
          };
        }
      }
    }

    // Parse logs to find USDC Transfer event
    const iface = new ethers.Interface(USDC_ABI);
    let transferFound = false;
    let actualSender = null;
    let actualRecipient = null;
    let actualAmount = null;

    for (const log of receipt.logs) {
      // Check if this log is from USDC contract
      if (log.address.toLowerCase() !== usdcAddress.toLowerCase()) continue;

      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === 'Transfer') {
          actualSender = parsed.args[0];
          actualRecipient = parsed.args[1];
          actualAmount = parsed.args[2];
          transferFound = true;
          break;
        }
      } catch {
        // Not a Transfer event, continue
      }
    }

    if (!transferFound) {
      return { valid: false, error: 'No USDC transfer found in transaction' };
    }

    // Verify sender
    if (actualSender.toLowerCase() !== expectedSender.toLowerCase()) {
      return { valid: false, error: 'Sender mismatch' };
    }

    // Verify recipient
    if (actualRecipient.toLowerCase() !== expectedRecipient.toLowerCase()) {
      return { valid: false, error: 'Recipient mismatch' };
    }

    // Verify amount (exact match required for USDC)
    const expectedBigInt = BigInt(expectedAmount);
    const actualBigInt = BigInt(actualAmount);

    if (actualBigInt !== expectedBigInt) {
      return { valid: false, error: `Amount mismatch: expected ${expectedAmount}, got ${actualAmount}` };
    }

    return {
      valid: true,
      tx: {
        hash: txHash,
        from: actualSender,
        to: actualRecipient,
        amount: actualAmount.toString(),
        blockNumber: receipt.blockNumber,
        confirmations,
      },
    };
  } catch (error) {
    console.error('Payment verification error:', error);
    return { valid: false, error: error.message };
  }
}

// ============================================
// Sending Transactions
// ============================================

/**
 * Send USDC from a wallet (internal, no retry)
 * @param {ethers.Wallet} senderWallet - Wallet to send from (with provider)
 * @param {string} recipientAddress - Recipient address
 * @param {number} amount - Amount in USDC units (with decimals)
 * @param {number} nonce - Explicit nonce to use for the transaction
 * @returns {Object} { success, txHash, error, errorType }
 */
async function sendUsdcInternal(senderWallet, recipientAddress, amount, nonce) {
  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, senderWallet);

  // Check balance first (this is a read operation, can fail transiently)
  const balance = await usdc.balanceOf(senderWallet.address);
  if (BigInt(balance) < BigInt(amount)) {
    return { success: false, error: 'Insufficient USDC balance', errorType: 'permanent' };
  }

  // Send transaction with explicit nonce and wait for 3 confirmations for better finality
  const tx = await usdc.transfer(recipientAddress, amount, { nonce });
  const receipt = await tx.wait(3);

  if (receipt.status !== 1) {
    return { success: false, error: 'Transaction failed on-chain', errorType: 'permanent' };
  }

  return { success: true, txHash: receipt.hash };
}

/**
 * Send USDC from a wallet with retry logic for transient errors
 * Uses explicit nonce management to prevent duplicate transactions on retry
 * @param {ethers.Wallet} senderWallet - Wallet to send from (with provider)
 * @param {string} recipientAddress - Recipient address
 * @param {number} amount - Amount in USDC units (with decimals)
 * @returns {Object} { success, txHash, error, errorType }
 */
async function sendUsdc(senderWallet, recipientAddress, amount) {
  try {
    // Get nonce once before retries to prevent duplicate transactions
    const nonce = await senderWallet.getNonce();

    return await withRetry(
      () => sendUsdcInternal(senderWallet, recipientAddress, amount, nonce),
      `sendUsdc(${recipientAddress.slice(0, 8)}...)`
    );
  } catch (error) {
    const errorType = classifyError(error);
    console.error('Send USDC error (after retries):', error.message, `[${errorType}]`);
    return { success: false, error: error.message, errorType };
  }
}

/**
 * Get treasury wallet from mnemonic
 * @returns {ethers.Wallet|null} Treasury wallet instance or null if not configured
 */
function getTreasuryWallet() {
  const mnemonic = process.env.TREASURY_MNEMONIC;
  if (!mnemonic) {
    return null;
  }

  try {
    const provider = getProvider();
    // Use fromPhrase with path directly - this derives to the specified path from root
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
    return wallet.connect(provider);
  } catch (error) {
    console.error('Error creating treasury wallet:', error.message);
    return null;
  }
}

/**
 * Get treasury address (derived from mnemonic)
 * @returns {string|null} Treasury address or null if not configured
 */
function getTreasuryAddress() {
  const treasuryWallet = getTreasuryWallet();
  return treasuryWallet ? treasuryWallet.address : null;
}

/**
 * Send winner payout from lobby wallet
 * @param {string} encryptedPrivateKey - Encrypted lobby wallet private key
 * @param {string} winnerAddress - Winner's wallet address
 * @returns {Object} { success, txHash, error }
 */
async function sendWinnerPayout(encryptedPrivateKey, winnerAddress, lobbyId = null) {
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return { success: false, error: 'Wallet encryption key not configured' };
  }

  const provider = getProvider();
  const lobbyWallet = wallet.getWalletFromEncrypted(encryptedPrivateKey, encryptionKey, provider);

  // Check for low ETH (non-blocking, just alerts)
  checkLowEth(lobbyWallet.address, 'lobby', lobbyId);

  return sendUsdc(lobbyWallet, winnerAddress, WINNER_PAYOUT);
}

/**
 * Send refund from lobby wallet
 * @param {string} encryptedPrivateKey - Encrypted lobby wallet private key
 * @param {string} recipientAddress - Player's wallet address
 * @returns {Object} { success, txHash, error }
 */
async function sendRefundFromLobby(encryptedPrivateKey, recipientAddress, lobbyId = null) {
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return { success: false, error: 'Wallet encryption key not configured' };
  }

  const provider = getProvider();
  const lobbyWallet = wallet.getWalletFromEncrypted(encryptedPrivateKey, encryptionKey, provider);

  // Check for low ETH (non-blocking, just alerts)
  checkLowEth(lobbyWallet.address, 'lobby', lobbyId);

  return sendUsdc(lobbyWallet, recipientAddress, BUY_IN_AMOUNT);
}

/**
 * Send refund from treasury (for post-match refunds)
 * @param {string} recipientAddress - Player's wallet address
 * @returns {Object} { success, txHash, error }
 */
async function sendRefundFromTreasury(recipientAddress) {
  const treasuryWallet = getTreasuryWallet();
  if (!treasuryWallet) {
    return { success: false, error: 'Treasury mnemonic not configured' };
  }

  // Check for low ETH (non-blocking, just alerts)
  checkLowEth(treasuryWallet.address, 'treasury');

  return sendUsdc(treasuryWallet, recipientAddress, BUY_IN_AMOUNT);
}

// ============================================
// Balance Checking
// ============================================

/**
 * Get USDC balance of an address
 * @param {string} address - Wallet address
 * @returns {Object} { balance, formatted }
 */
async function getUsdcBalance(address) {
  try {
    const usdc = getUsdcContract();
    const balance = await usdc.balanceOf(address);
    return {
      balance: balance.toString(),
      formatted: (Number(balance) / 10 ** USDC_DECIMALS).toFixed(2),
    };
  } catch (error) {
    console.error('Balance check error:', error);
    return { balance: '0', formatted: '0.00' };
  }
}

/**
 * Get treasury balance
 * @returns {Object} { balance, formatted }
 */
async function getTreasuryBalance() {
  const treasuryAddress = getTreasuryAddress();
  if (!treasuryAddress) {
    return { balance: '0', formatted: '0.00' };
  }
  return getUsdcBalance(treasuryAddress);
}

/**
 * Get ETH balance of an address (for gas)
 * @param {string} address - Wallet address
 * @returns {Object} { balance, formatted }
 */
async function getEthBalance(address) {
  try {
    const provider = getProvider();
    const balance = await provider.getBalance(address);
    return {
      balance: balance.toString(),
      formatted: ethers.formatEther(balance),
    };
  } catch (error) {
    console.error('ETH balance check error:', error);
    return { balance: '0', formatted: '0.00' };
  }
}

// Track which wallets we've already alerted about (to avoid spam)
// Map of alertKey -> timestamp for periodic cleanup and re-alerting
const lowEthAlerts = new Map();
const LOW_ETH_ALERT_EXPIRY_MS = 24 * 60 * 60 * 1000; // Re-alert after 24 hours

/**
 * Check if wallet has low ETH and send alert if needed
 * @param {string} walletAddress - Wallet address
 * @param {string} walletType - 'lobby' or 'treasury'
 * @param {number|null} lobbyId - Lobby ID (for lobby wallets)
 */
async function checkLowEth(walletAddress, walletType, lobbyId = null) {
  try {
    const provider = getProvider();
    const balance = await provider.getBalance(walletAddress);

    if (balance < LOW_ETH_THRESHOLD) {
      const alertKey = `${walletType}-${walletAddress}`;
      const lastAlertTime = lowEthAlerts.get(alertKey);
      const now = Date.now();

      // Alert if never alerted or last alert expired (allows re-alerting after 24h)
      if (!lastAlertTime || (now - lastAlertTime) > LOW_ETH_ALERT_EXPIRY_MS) {
        lowEthAlerts.set(alertKey, now);

        const formattedBalance = ethers.formatEther(balance);

        if (walletType === 'lobby') {
          sendAlert(AlertType.LOW_ETH_LOBBY, {
            lobbyId,
            balance: `${formattedBalance} ETH`,
            walletAddress,
          }).catch(err => console.error('Alert send failed:', err.message));
        } else {
          sendAlert(AlertType.LOW_ETH_TREASURY, {
            balance: `${formattedBalance} ETH`,
            walletAddress,
          }).catch(err => console.error('Alert send failed:', err.message));
        }

        console.warn(`[Payments] Low ETH warning for ${walletType} wallet ${walletAddress}: ${formattedBalance} ETH`);
      }
    } else {
      // Clear alert flag if balance is now sufficient
      const alertKey = `${walletType}-${walletAddress}`;
      lowEthAlerts.delete(alertKey);
    }
  } catch (error) {
    console.error('Low ETH check error:', error);
  }
}

/**
 * Clean up expired lowEthAlerts entries
 * Called periodically to prevent unbounded Map growth
 */
function cleanupLowEthAlerts() {
  const now = Date.now();
  for (const [key, timestamp] of lowEthAlerts) {
    if (now - timestamp > LOW_ETH_ALERT_EXPIRY_MS) {
      lowEthAlerts.delete(key);
    }
  }
}

// Clean up expired alerts every hour
setInterval(cleanupLowEthAlerts, 60 * 60 * 1000);

// ============================================
// Exports
// ============================================

module.exports = {
  // Constants
  USDC_DECIMALS,
  BUY_IN_AMOUNT,
  WINNER_PAYOUT,
  TREASURY_CUT,
  MIN_CONFIRMATIONS,
  MAX_TX_AGE_MS,
  AMOUNT_TOLERANCE_PERCENT,

  // Initialization
  initProvider,
  getProvider,
  getUsdcContract,

  // Verification
  verifyPayment,

  // Sending
  sendUsdc,
  sendWinnerPayout,
  sendRefundFromLobby,
  sendRefundFromTreasury,

  // Treasury
  getTreasuryWallet,
  getTreasuryAddress,

  // Balance
  getUsdcBalance,
  getTreasuryBalance,

  // Error handling utilities
  classifyError,
  testRpcConnection,
  withRetry,
};
