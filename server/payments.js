/**
 * Payment processing for RPS Arena
 * Base blockchain USDC transactions
 */

const { ethers } = require('ethers');
const wallet = require('./wallet');

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

let provider = null;
let usdcContract = null;

/**
 * Initialize the blockchain provider
 */
function initProvider() {
  if (provider) return provider;

  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  provider = new ethers.JsonRpcProvider(rpcUrl);

  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, provider);

  return provider;
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
 * @returns {Object} { valid, error, tx }
 */
async function verifyPayment(txHash, expectedRecipient, expectedSender, expectedAmount = BUY_IN_AMOUNT) {
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

    // Verify amount
    if (BigInt(actualAmount) !== BigInt(expectedAmount)) {
      return { valid: false, error: `Amount mismatch: expected ${expectedAmount}, got ${actualAmount}` };
    }

    // Get block for confirmation count
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;

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
 * Send USDC from a wallet
 * @param {ethers.Wallet} senderWallet - Wallet to send from (with provider)
 * @param {string} recipientAddress - Recipient address
 * @param {number} amount - Amount in USDC units (with decimals)
 * @returns {Object} { success, txHash, error }
 */
async function sendUsdc(senderWallet, recipientAddress, amount) {
  try {
    const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const usdc = new ethers.Contract(usdcAddress, USDC_ABI, senderWallet);

    // Check balance
    const balance = await usdc.balanceOf(senderWallet.address);
    if (BigInt(balance) < BigInt(amount)) {
      return { success: false, error: 'Insufficient USDC balance' };
    }

    // Send transaction
    const tx = await usdc.transfer(recipientAddress, amount);
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      return { success: false, error: 'Transaction failed' };
    }

    return { success: true, txHash: receipt.hash };
  } catch (error) {
    console.error('Send USDC error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send winner payout from treasury
 * @param {string} winnerAddress - Winner's wallet address
 * @returns {Object} { success, txHash, error }
 */
async function sendWinnerPayout(winnerAddress) {
  const treasuryKey = process.env.MASTER_TREASURY_PRIVATE_KEY;
  if (!treasuryKey) {
    return { success: false, error: 'Treasury private key not configured' };
  }

  const provider = getProvider();
  const treasuryWallet = new ethers.Wallet(treasuryKey, provider);

  return sendUsdc(treasuryWallet, winnerAddress, WINNER_PAYOUT);
}

/**
 * Send refund from lobby wallet
 * @param {string} encryptedPrivateKey - Encrypted lobby wallet private key
 * @param {string} recipientAddress - Player's wallet address
 * @returns {Object} { success, txHash, error }
 */
async function sendRefundFromLobby(encryptedPrivateKey, recipientAddress) {
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return { success: false, error: 'Wallet encryption key not configured' };
  }

  const provider = getProvider();
  const lobbyWallet = wallet.getWalletFromEncrypted(encryptedPrivateKey, encryptionKey, provider);

  return sendUsdc(lobbyWallet, recipientAddress, BUY_IN_AMOUNT);
}

/**
 * Send refund from treasury (for post-match refunds)
 * @param {string} recipientAddress - Player's wallet address
 * @returns {Object} { success, txHash, error }
 */
async function sendRefundFromTreasury(recipientAddress) {
  const treasuryKey = process.env.MASTER_TREASURY_PRIVATE_KEY;
  if (!treasuryKey) {
    return { success: false, error: 'Treasury private key not configured' };
  }

  const provider = getProvider();
  const treasuryWallet = new ethers.Wallet(treasuryKey, provider);

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
  const treasuryAddress = process.env.MASTER_TREASURY_ADDRESS;
  if (!treasuryAddress) {
    return { balance: '0', formatted: '0.00' };
  }
  return getUsdcBalance(treasuryAddress);
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Constants
  USDC_DECIMALS,
  BUY_IN_AMOUNT,
  WINNER_PAYOUT,
  TREASURY_CUT,

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

  // Balance
  getUsdcBalance,
  getTreasuryBalance,
};
