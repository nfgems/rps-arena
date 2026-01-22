/**
 * Deposit Monitor for RPS Arena
 * Monitors lobby deposit addresses for USDC transfers and automatically
 * adds players who sent valid deposits but whose client failed to notify the server.
 *
 * This handles cases like:
 * - Browser crash/close after sending USDC
 * - Network disconnection
 * - Client-side errors
 */

const { ethers } = require('ethers');
const payments = require('./payments');
const db = require('./database');
const lobby = require('./lobby');
const { sendAlert, AlertType } = require('./alerts');

// USDC Contract ABI (minimal for Transfer events)
const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// Monitor configuration
const MONITOR_INTERVAL_MS = 30 * 1000; // Check every 30 seconds
const LOOKBACK_BLOCKS = 10; // Max 10 blocks per query (free tier RPC limit)

let monitorInterval = null;
let isRunning = false;

// Track last processed block per lobby to avoid re-processing
const lastProcessedBlock = new Map();

/**
 * Start the deposit monitor
 */
function start() {
  if (monitorInterval) {
    console.log('[DepositMonitor] Already running');
    return;
  }

  console.log('[DepositMonitor] Starting deposit monitor');
  monitorInterval = setInterval(checkAllLobbies, MONITOR_INTERVAL_MS);

  // Run immediately on start
  checkAllLobbies();
}

/**
 * Stop the deposit monitor
 */
function stop() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[DepositMonitor] Stopped');
  }
}

/**
 * Check all lobbies for unprocessed deposits
 */
async function checkAllLobbies() {
  if (isRunning) {
    console.log('[DepositMonitor] Previous check still running, skipping');
    return;
  }

  isRunning = true;

  try {
    const lobbies = lobby.getLobbyList();

    for (const l of lobbies) {
      // Only check lobbies that can accept players (not full, not in progress)
      if (l.status === 'in_progress' || l.playerCount >= 3) {
        continue;
      }

      try {
        await checkLobbyDeposits(l.id, l.depositAddress);
      } catch (error) {
        console.error(`[DepositMonitor] Error checking lobby ${l.id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[DepositMonitor] Error in checkAllLobbies:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Check a specific lobby for unprocessed deposits
 * @param {number} lobbyId - Lobby ID
 * @param {string} depositAddress - Lobby deposit address
 */
async function checkLobbyDeposits(lobbyId, depositAddress) {
  const provider = payments.getProvider();
  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, provider);

  const currentBlock = await provider.getBlockNumber();
  const lastBlock = lastProcessedBlock.get(lobbyId) || (currentBlock - LOOKBACK_BLOCKS);
  // Note: block range is inclusive, so for 10 block max we need currentBlock - 9
  const fromBlock = Math.max(lastBlock + 1, currentBlock - (LOOKBACK_BLOCKS - 1));

  if (fromBlock > currentBlock) {
    return; // No new blocks to check
  }

  // Query Transfer events TO the lobby deposit address
  const filter = usdc.filters.Transfer(null, depositAddress);
  const events = await usdc.queryFilter(filter, fromBlock, currentBlock);

  // Update last processed block
  lastProcessedBlock.set(lobbyId, currentBlock);

  if (events.length === 0) {
    return;
  }

  console.log(`[DepositMonitor] Found ${events.length} transfers to lobby ${lobbyId} in blocks ${fromBlock}-${currentBlock}`);

  for (const event of events) {
    await processDeposit(lobbyId, depositAddress, event);
  }
}

/**
 * Process a single deposit event
 * @param {number} lobbyId - Lobby ID
 * @param {string} depositAddress - Lobby deposit address
 * @param {Object} event - Transfer event
 */
async function processDeposit(lobbyId, depositAddress, event) {
  const txHash = event.transactionHash;
  const senderAddress = event.args.from;
  const amount = event.args.value;

  // Check if this tx hash is already processed
  if (db.txHashExists(txHash)) {
    return; // Already processed
  }

  // Verify amount is exactly 1 USDC (buy-in amount)
  const expectedAmount = BigInt(payments.BUY_IN_AMOUNT);
  if (BigInt(amount) !== expectedAmount) {
    console.log(`[DepositMonitor] Ignoring deposit with wrong amount: ${amount} (expected ${expectedAmount})`);
    return;
  }

  // Get the user by wallet address
  const user = db.getUserByWallet(senderAddress);
  if (!user) {
    console.log(`[DepositMonitor] Deposit from unknown wallet ${senderAddress} - cannot auto-add`);

    // Alert about orphaned deposit
    sendAlert(AlertType.LOBBY_STUCK, {
      lobbyId,
      status: 'orphaned_deposit',
      depositAddress,
      senderAddress,
      txHash,
      message: 'USDC deposit received from unknown wallet - manual review required',
    }).catch(err => console.error('Alert send failed:', err.message));

    return;
  }

  // Verify the transaction has enough confirmations
  const provider = payments.getProvider();
  const currentBlock = await provider.getBlockNumber();
  const confirmations = currentBlock - event.blockNumber;

  if (confirmations < payments.MIN_CONFIRMATIONS) {
    console.log(`[DepositMonitor] Deposit ${txHash} has ${confirmations} confirmations, waiting for ${payments.MIN_CONFIRMATIONS}`);
    // Will be picked up on next check
    return;
  }

  // Try to add the player to the lobby
  console.log(`[DepositMonitor] Auto-adding user ${user.id} to lobby ${lobbyId} (tx: ${txHash})`);

  const result = await lobby.joinLobby(
    user.id,
    lobbyId,
    txHash,
    senderAddress,
    false // Don't skip payment verification
  );

  if (result.success) {
    console.log(`[DepositMonitor] Successfully auto-added user ${user.id} to lobby ${lobbyId}`);

    // Alert about auto-recovery
    sendAlert(AlertType.PLAYER_JOINED, {
      lobbyId,
      playerCount: result.lobby.players.filter(p => !p.refunded_at).length,
      username: user.username,
      walletAddress: senderAddress,
      autoRecovered: true,
    }).catch(err => console.error('Alert send failed:', err.message));
  } else {
    // Log the failure - could be legitimate (already in lobby, lobby full, etc.)
    console.log(`[DepositMonitor] Failed to auto-add user ${user.id} to lobby ${lobbyId}: ${result.error}`);

    // If it's a real problem (not just "already in lobby"), alert
    if (result.error !== 'ALREADY_IN_LOBBY' && result.error !== 'LOBBY_FULL' && result.error !== 'DUPLICATE_TX_HASH') {
      sendAlert(AlertType.LOBBY_STUCK, {
        lobbyId,
        status: 'auto_add_failed',
        error: result.error,
        userId: user.id,
        walletAddress: senderAddress,
        txHash,
        message: 'Failed to auto-add player after deposit detection',
      }).catch(err => console.error('Alert send failed:', err.message));
    }
  }
}

/**
 * Manually trigger a check for a specific lobby
 * Useful for recovery scenarios
 * @param {number} lobbyId - Lobby ID
 */
async function checkLobbyNow(lobbyId) {
  const l = lobby.getLobby(lobbyId);
  if (!l) {
    return { success: false, error: 'Lobby not found' };
  }

  try {
    // Reset last processed block to force full lookback
    lastProcessedBlock.delete(lobbyId);
    await checkLobbyDeposits(lobbyId, l.deposit_address);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  start,
  stop,
  checkLobbyNow,
};
