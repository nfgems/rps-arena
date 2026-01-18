/**
 * Discord webhook alerts for server monitoring
 *
 * Two channels:
 * - DISCORD_WEBHOOK_URL: Critical alerts (errors, failures, low balance)
 * - DISCORD_ACTIVITY_WEBHOOK_URL: Activity logs (match started, player joined, etc.)
 */

const ALERTS_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ACTIVITY_WEBHOOK = process.env.DISCORD_ACTIVITY_WEBHOOK_URL;

const AlertType = {
  // Critical alerts (go to alerts channel)
  SERVER_START: 'server_start',
  SERVER_SHUTDOWN: 'server_shutdown',
  PAYOUT_FAILED: 'payout_failed',
  REFUND_FAILED: 'refund_failed',
  LOBBY_STUCK: 'lobby_stuck',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  LOW_ETH_LOBBY: 'low_eth_lobby',
  LOW_ETH_TREASURY: 'low_eth_treasury',
  RPC_ERROR: 'rpc_error',
  DATABASE_ERROR: 'database_error',
  GAME_LOOP_ERROR: 'game_loop_error',
  MATCH_RECOVERED: 'match_recovered',

  // Activity notifications (go to activity channel)
  MATCH_STARTED: 'match_started',
  MATCH_COMPLETED: 'match_completed',
  PLAYER_JOINED: 'player_joined',
};

// Alert types that go to the activity channel instead of alerts
const ACTIVITY_TYPES = new Set([
  AlertType.MATCH_STARTED,
  AlertType.MATCH_COMPLETED,
  AlertType.PLAYER_JOINED,
]);

// Critical alert types that should be retried on failure
const CRITICAL_TYPES = new Set([
  AlertType.PAYOUT_FAILED,
  AlertType.REFUND_FAILED,
  AlertType.INSUFFICIENT_BALANCE,
  AlertType.DATABASE_ERROR,
  AlertType.GAME_LOOP_ERROR,
]);

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1 second, doubles each retry

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send alert to appropriate Discord webhook
 * @param {string} type - Alert type from AlertType enum
 * @param {object} data - Alert-specific data
 */
async function sendAlert(type, data = {}) {
  const isActivity = ACTIVITY_TYPES.has(type);
  const isCritical = CRITICAL_TYPES.has(type);
  const webhookUrl = isActivity ? ACTIVITY_WEBHOOK : ALERTS_WEBHOOK;

  if (!webhookUrl) {
    console.warn(`[Alerts] Discord ${isActivity ? 'activity' : 'alerts'} webhook URL not configured, skipping:`, type);
    return;
  }

  const embed = buildEmbed(type, data);
  const username = isActivity ? 'RPS Arena Activity' : 'RPS Arena Alerts';
  const payload = JSON.stringify({ username, embeds: [embed] });

  const maxAttempts = isCritical ? MAX_RETRIES : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      if (response.ok) {
        if (attempt > 1) {
          console.log(`[Alerts] Alert sent successfully on attempt ${attempt}:`, type);
        }
        return; // Success
      }

      // Rate limited - wait and retry
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10) * 1000;
        console.warn(`[Alerts] Rate limited, waiting ${retryAfter}ms before retry`);
        await sleep(retryAfter);
        continue;
      }

      lastError = `HTTP ${response.status}: ${await response.text()}`;
    } catch (error) {
      lastError = error.message;
    }

    // If not last attempt, wait with exponential backoff
    if (attempt < maxAttempts) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[Alerts] Attempt ${attempt}/${maxAttempts} failed for ${type}, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  // All attempts failed
  console.error(`[Alerts] Failed to send ${isCritical ? 'critical ' : ''}alert after ${maxAttempts} attempt(s):`, type, lastError);
}

/**
 * Build Discord embed based on alert type
 */
function buildEmbed(type, data) {
  const timestamp = new Date().toISOString();

  switch (type) {
    // ==================== CRITICAL ALERTS ====================

    case AlertType.SERVER_START:
      return {
        title: '🟢 Server Started',
        description: 'RPS Arena server has started. This could indicate a restart after a crash.',
        color: 0x00ff00,
        fields: [
          { name: 'Environment', value: process.env.NODE_ENV || 'development', inline: true },
          { name: 'Port', value: String(data.port || 'unknown'), inline: true },
        ],
        timestamp,
      };

    case AlertType.SERVER_SHUTDOWN:
      return {
        title: '🔴 Server Shutting Down',
        description: 'RPS Arena server is shutting down gracefully.',
        color: 0xff0000,
        fields: [
          { name: 'Reason', value: data.reason || 'Unknown', inline: true },
        ],
        timestamp,
      };

    case AlertType.PAYOUT_FAILED:
      return {
        title: '🚨 Payout Failed',
        description: 'Failed to send winner payout. Manual intervention required.',
        color: 0xff0000,
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Match ID', value: String(data.matchId || 'unknown'), inline: true },
          { name: 'Winner Address', value: data.winnerAddress || 'unknown', inline: false },
          { name: 'Amount', value: '2.4 USDC', inline: true },
          { name: 'Error', value: data.error || 'Unknown error', inline: false },
        ],
        timestamp,
      };

    case AlertType.REFUND_FAILED:
      return {
        title: '🚨 Refund Failed',
        description: 'Failed to send refund. Manual intervention required.',
        color: 0xff0000,
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Player Address', value: data.playerAddress || 'unknown', inline: false },
          { name: 'Amount', value: '1 USDC', inline: true },
          { name: 'Error', value: data.error || 'Unknown error', inline: false },
        ],
        timestamp,
      };

    case AlertType.LOBBY_STUCK:
      return {
        title: '⚠️ Lobby Stuck',
        description: 'A lobby has been active for too long without completing.',
        color: 0xffaa00,
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Status', value: data.status || 'unknown', inline: true },
          { name: 'Players', value: String(data.playerCount || 0), inline: true },
          { name: 'Duration', value: data.duration || 'unknown', inline: true },
          { name: 'Deposit Address', value: data.depositAddress || 'unknown', inline: false },
        ],
        timestamp,
      };

    case AlertType.INSUFFICIENT_BALANCE:
      return {
        title: '🚨 Insufficient Lobby Balance',
        description: 'Match voided due to insufficient funds in lobby wallet.',
        color: 0xff0000,
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Balance', value: data.balance || 'unknown', inline: true },
          { name: 'Required', value: '2.4 USDC', inline: true },
        ],
        timestamp,
      };

    case AlertType.LOW_ETH_LOBBY:
      return {
        title: '⚠️ Low ETH in Lobby Wallet',
        description: 'Lobby wallet ETH balance is low. Payouts/refunds may fail.',
        color: 0xffaa00,
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'ETH Balance', value: data.balance || 'unknown', inline: true },
          { name: 'Wallet Address', value: data.walletAddress || 'unknown', inline: false },
        ],
        timestamp,
      };

    case AlertType.LOW_ETH_TREASURY:
      return {
        title: '⚠️ Low ETH in Treasury',
        description: 'Treasury wallet ETH balance is low. Operations may fail.',
        color: 0xffaa00,
        fields: [
          { name: 'ETH Balance', value: data.balance || 'unknown', inline: true },
          { name: 'Wallet Address', value: data.walletAddress || 'unknown', inline: false },
        ],
        timestamp,
      };

    case AlertType.RPC_ERROR:
      return {
        title: '🚨 RPC Provider Error',
        description: 'Blockchain connection issue detected.',
        color: 0xff0000,
        fields: [
          { name: 'Operation', value: data.operation || 'unknown', inline: true },
          { name: 'Error', value: (data.error || 'Unknown error').slice(0, 1000), inline: false },
        ],
        timestamp,
      };

    case AlertType.DATABASE_ERROR:
      return {
        title: '🚨 Database Error',
        description: 'Database operation failed.',
        color: 0xff0000,
        fields: [
          { name: 'Operation', value: data.operation || 'unknown', inline: true },
          { name: 'Error', value: (data.error || 'Unknown error').slice(0, 1000), inline: false },
        ],
        timestamp,
      };

    case AlertType.GAME_LOOP_ERROR:
      return {
        title: '🚨 Game Loop Error',
        description: data.stalled ? 'Game loop stalled and was terminated.' : 'Game loop encountered critical errors.',
        color: 0xff0000,
        fields: [
          { name: 'Match ID', value: String(data.matchId || 'unknown'), inline: true },
          { name: 'Tick', value: String(data.tick || 'unknown'), inline: true },
          { name: 'Type', value: data.stalled ? 'Stalled' : (data.errorType || 'Tick failure'), inline: true },
          ...(data.staleDuration ? [{ name: 'Stale Duration', value: `${data.staleDuration}ms (max ${data.maxAllowed}ms)`, inline: true }] : []),
          ...(data.consecutiveErrors ? [{ name: 'Consecutive Errors', value: String(data.consecutiveErrors), inline: true }] : []),
          ...(data.error ? [{ name: 'Error', value: String(data.error).slice(0, 500), inline: false }] : []),
        ],
        timestamp,
      };

    case AlertType.MATCH_RECOVERED:
      return {
        title: '🔄 Match Recovered from Crash',
        description: 'Server restarted and processed interrupted match. Players refunded.',
        color: 0xffaa00, // Orange/warning
        fields: [
          { name: 'Match ID', value: String(data.matchId || 'unknown'), inline: true },
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Result', value: data.result || 'unknown', inline: true },
          { name: 'Reason', value: data.reason || 'N/A', inline: true },
          { name: 'Players Affected', value: String(data.playerCount || 0), inline: true },
        ],
        timestamp,
      };

    // ==================== ACTIVITY NOTIFICATIONS ====================

    case AlertType.MATCH_STARTED:
      return {
        title: '🎮 Match Started',
        description: 'A new match has begun.',
        color: 0x5865f2, // Discord blurple
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Match ID', value: String(data.matchId || 'unknown'), inline: true },
          { name: 'Players', value: data.players || 'unknown', inline: false },
        ],
        timestamp,
      };

    case AlertType.MATCH_COMPLETED:
      return {
        title: '🏆 Match Completed',
        description: 'A match has finished.',
        color: 0x57f287, // Green
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Match ID', value: String(data.matchId || 'unknown'), inline: true },
          { name: 'Winner', value: data.winner || 'unknown', inline: true },
          { name: 'Payout', value: data.payoutSuccess ? '✅ 2.4 USDC sent' : '❌ Failed', inline: true },
          { name: 'TX Hash', value: data.txHash || 'N/A', inline: false },
        ],
        timestamp,
      };

    case AlertType.PLAYER_JOINED:
      return {
        title: '👤 Player Joined Lobby',
        description: 'A player has joined and paid.',
        color: 0x5865f2, // Discord blurple
        fields: [
          { name: 'Lobby ID', value: String(data.lobbyId || 'unknown'), inline: true },
          { name: 'Players', value: `${data.playerCount || '?'}/3`, inline: true },
          { name: 'Username', value: data.username || 'unknown', inline: true },
          { name: 'Wallet', value: data.walletAddress || 'unknown', inline: false },
        ],
        timestamp,
      };

    default:
      return {
        title: '❓ Unknown Alert',
        description: `Alert type: ${type}`,
        color: 0x808080,
        fields: [
          { name: 'Data', value: JSON.stringify(data).slice(0, 1000), inline: false },
        ],
        timestamp,
      };
  }
}

module.exports = {
  AlertType,
  sendAlert,
};
