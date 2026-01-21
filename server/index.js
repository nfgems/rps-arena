/**
 * RPS Arena - Main Server Entry Point
 * WebSocket game server with Express for static files
 *
 * Port 3000 (PUBLIC_PORT): Production game server - payments required
 * Port 3001 (ADMIN_PORT): Admin/testing server - free joins, bot management
 */

require('dotenv').config();

// Initialize Sentry first (before any other imports that might throw)
const sentry = require('./sentry');
sentry.init();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const db = require('./database');
const auth = require('./auth');
const protocol = require('./protocol');
const lobby = require('./lobby');
const match = require('./match');
const payments = require('./payments');
const bot = require('./bot');
const tutorial = require('./tutorial');
const { sendAlert, AlertType } = require('./alerts');
const config = require('./config');

// ============================================
// Server Setup - Dual Port Architecture
// ============================================

// Production server (port 3000) - payments required
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Admin server (port 3001) - free joins, bot management
const adminApp = express();
const adminServer = http.createServer(adminApp);
const adminWss = new WebSocket.Server({ server: adminServer });

const PUBLIC_PORT = process.env.PORT || 3000;
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;

// Track active lobby countdowns: lobbyId -> { interval, secondsRemaining, isAdminPort }
const lobbyCountdowns = new Map();

// Serve static files from client directory (both servers)
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json());

adminApp.use(express.static(path.join(__dirname, '..', 'client')));
adminApp.use(express.json());

// ============================================
// HTTP Routes - Shared (both servers)
// ============================================

function setupSharedRoutes(expressApp) {
  // Health check (includes database status and game loop health)
  expressApp.get('/api/health', (req, res) => {
    const dbHealth = db.checkHealth();
    const deferredQueue = db.getDeferredQueueStatus();
    const gameLoopHealth = match.getHealthStatus();

    // Overall status is degraded if DB or any game loop is unhealthy
    const gameLoopsHealthy = gameLoopHealth.matches.every(m => m.isHealthy);
    const status = dbHealth.healthy && gameLoopsHealthy ? 'ok' : 'degraded';

    res.json({
      status,
      timestamp: Date.now(),
      database: dbHealth,
      deferredQueue,
      gameLoop: gameLoopHealth,
    });
  });

  // Authentication endpoint
  expressApp.post('/api/auth', async (req, res) => {
    const { walletAddress, signature, message } = req.body;
    console.log('Auth request received:', { walletAddress, hasSignature: !!signature, hasMessage: !!message });

    const result = await auth.authenticateWallet(walletAddress, signature, message);

    if (result.success) {
      res.json({
        success: true,
        token: result.token,
        user: result.user,
      });
    } else {
      res.status(401).json({
        success: false,
        error: result.error,
      });
    }
  });

  // Logout endpoint
  expressApp.post('/api/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      auth.logout(token);
    }
    res.json({ success: true });
  });

  // Get lobbies (REST fallback)
  expressApp.get('/api/lobbies', (req, res) => {
    const lobbies = lobby.getLobbyList();
    res.json({ lobbies });
  });

  // Get player stats by wallet address
  expressApp.get('/api/player/:wallet', (req, res) => {
    const { wallet } = req.params;

    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const stats = db.getPlayerStats(wallet);

    if (!stats) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Calculate win rate
    const winRate = stats.total_matches > 0
      ? ((stats.wins / stats.total_matches) * 100).toFixed(1)
      : '0.0';

    // Calculate net profit/loss
    const netProfit = stats.total_earnings_usdc - stats.total_spent_usdc;

    res.json({
      walletAddress: stats.wallet_address,
      username: stats.username,
      profilePhoto: stats.profile_photo || null,
      stats: {
        totalMatches: stats.total_matches,
        wins: stats.wins,
        losses: stats.losses,
        winRate: parseFloat(winRate),
        totalEarnings: stats.total_earnings_usdc,
        totalSpent: stats.total_spent_usdc,
        netProfit: parseFloat(netProfit.toFixed(2)),
        currentWinStreak: stats.current_win_streak,
        bestWinStreak: stats.best_win_streak,
      },
      firstMatchAt: stats.first_match_at,
      lastMatchAt: stats.last_match_at,
    });
  });

  // Get player match history (HIGH-4: Added pagination with offset support)
  expressApp.get('/api/player/:wallet/history', (req, res) => {
    const { wallet } = req.params;
    // HIGH-4 + MEDIUM-7: Validate and clamp limit/offset
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const history = db.getPlayerMatchHistory(wallet, limit, offset);
    const total = db.getPlayerMatchCount(wallet);

    res.json({
      matches: history,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + history.length < total,
      },
    });
  });

  // Get leaderboard (supports time filters: all, monthly, weekly)
  expressApp.get('/api/leaderboard', (req, res) => {
    // MEDIUM-7: Clamp limit to prevent negative values
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 100), 100);
    const timeFilter = ['all', 'monthly', 'weekly'].includes(req.query.period)
      ? req.query.period
      : 'all';

    const players = db.getLeaderboard(limit, timeFilter);

    // Format response with win rates
    const leaderboard = players.map((player, index) => {
      const winRate = player.total_matches > 0
        ? ((player.wins / player.total_matches) * 100).toFixed(1)
        : '0.0';

      return {
        rank: index + 1,
        walletAddress: player.wallet_address,
        username: player.username,
        wins: player.wins,
        losses: player.losses,
        totalMatches: player.total_matches,
        winRate: parseFloat(winRate),
        totalEarnings: player.total_earnings_usdc,
        bestWinStreak: player.best_win_streak || 0,
      };
    });

    res.json({ leaderboard, period: timeFilter });
  });

  // Set player username (requires authentication and completed match)
  expressApp.post('/api/player/username', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const session = db.getSessionByToken(token);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const user = db.getUserById(session.user_id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = db.setPlayerUsername(user.wallet_address, username);
    if (result.success) {
      res.json({ success: true, username: username.trim() });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // Set player profile photo (requires authentication and completed match)
  expressApp.post('/api/player/photo', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const session = db.getSessionByToken(token);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const user = db.getUserById(session.user_id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { photo } = req.body;
    if (!photo) {
      return res.status(400).json({ error: 'Photo data is required' });
    }

    const result = db.setPlayerPhoto(user.wallet_address, photo);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  });
}

// Apply shared routes to both servers
setupSharedRoutes(app);
setupSharedRoutes(adminApp);

// ============================================
// HTTP Routes - Production Server (Port 3000)
// ============================================

// Production server returns devMode: false always
app.get('/api/dev-mode', (req, res) => {
  res.json({ devMode: false });
});

// ============================================
// HTTP Routes - Admin Server Only (Port 3001)
// ============================================

// Admin server returns devMode: true (enables free joins and bot UI)
adminApp.get('/api/dev-mode', (req, res) => {
  res.json({ devMode: true });
});

// Add a bot to a lobby
adminApp.post('/api/bot/add', async (req, res) => {
  const { lobbyId } = req.body;
  if (!lobbyId) {
    return res.status(400).json({ success: false, error: 'lobbyId required' });
  }

  const parsedLobbyId = parseInt(lobbyId);
  if (!protocol.isValidLobbyId(parsedLobbyId)) {
    return res.status(400).json({ success: false, error: 'Invalid lobbyId (must be 1-12)' });
  }

  const result = await bot.addBotToLobby(parsedLobbyId);

  if (result.success) {
    // Broadcast updated lobby list to both servers
    broadcastLobbyList();
    res.json({ success: true, bot: { userId: result.bot.userId, username: result.bot.username } });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Fill a lobby with bots
adminApp.post('/api/bot/fill', async (req, res) => {
  const { lobbyId } = req.body;
  if (!lobbyId) {
    return res.status(400).json({ success: false, error: 'lobbyId required' });
  }

  const parsedLobbyId = parseInt(lobbyId);
  if (!protocol.isValidLobbyId(parsedLobbyId)) {
    return res.status(400).json({ success: false, error: 'Invalid lobbyId (must be 1-12)' });
  }

  const result = await bot.fillLobbyWithBots(parsedLobbyId);

  if (result.success) {
    broadcastLobbyList();
    res.json({ success: true, botsAdded: result.botsAdded });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Get active bots
adminApp.get('/api/bot/list', (req, res) => {
  const bots = bot.getActiveBots();
  res.json({ success: true, bots });
});

// Reset lobby for testing
adminApp.post('/api/dev/reset', async (req, res) => {
  const { lobbyId } = req.body;
  const targetLobbyId = lobbyId ? parseInt(lobbyId) : 1;

  if (!protocol.isValidLobbyId(targetLobbyId)) {
    return res.status(400).json({ success: false, error: 'Invalid lobbyId (must be 1-12)' });
  }

  try {
    // Remove all bots
    bot.removeAllBots();

    // Reset the lobby
    lobby.forceResetLobby(targetLobbyId);

    // Broadcast updated lobby list
    broadcastLobbyList();

    res.json({ success: true, message: `Lobby ${targetLobbyId} reset` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove a bot
adminApp.post('/api/bot/remove', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }

  const result = bot.removeBot(userId);

  if (result.success) {
    broadcastLobbyList();
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// ============================================
// Admin Database Backup Routes (Port 3001 Only)
// ============================================

// Create a database backup
adminApp.post('/api/admin/backup', async (req, res) => {
  try {
    const result = await db.createTimestampedBackup();
    if (result.success) {
      res.json({
        success: true,
        backup: {
          path: result.path,
          sizeMB: result.sizeMB,
        },
      });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List existing backups
adminApp.get('/api/admin/backups', (req, res) => {
  const result = db.listBackups();
  res.json({
    success: true,
    count: result.backups.length,
    backups: result.backups.map(b => ({
      name: b.name,
      sizeMB: b.sizeMB,
      created: b.created,
    })),
  });
});

// Run WAL checkpoint
adminApp.post('/api/admin/checkpoint', (req, res) => {
  const mode = req.body.mode || 'PASSIVE';
  const result = db.walCheckpoint(mode);
  res.json(result);
});

// Cleanup old backups
adminApp.post('/api/admin/backup/cleanup', (req, res) => {
  const keepCount = parseInt(req.body.keepCount) || 24;
  const result = db.cleanupOldBackups(keepCount);
  res.json({ success: true, ...result });
});

// ============================================
// Rate Limiting
// ============================================

const rateLimits = new Map(); // IP -> { inputCount, otherCount, lastReset }
const connectionCounts = new Map(); // IP -> count

// Cleanup stale rate limit entries every hour to prevent memory leak
const { RATE_LIMIT_CLEANUP_INTERVAL_MS, RATE_LIMIT_MAX_AGE_MS } = config;

setInterval(() => {
  const now = Date.now();
  let rateLimitsRemoved = 0;
  let connectionCountsRemoved = 0;

  // Clean stale rate limit entries
  for (const [ip, limits] of rateLimits) {
    if (now - limits.lastReset > RATE_LIMIT_MAX_AGE_MS) {
      rateLimits.delete(ip);
      rateLimitsRemoved++;
    }
  }

  // Clean zero connection count entries
  for (const [ip, count] of connectionCounts) {
    if (count <= 0) {
      connectionCounts.delete(ip);
      connectionCountsRemoved++;
    }
  }

  if (rateLimitsRemoved > 0 || connectionCountsRemoved > 0) {
    console.log(`[CLEANUP] Removed ${rateLimitsRemoved} stale rate limits, ${connectionCountsRemoved} zero connection counts`);
  }

  // Also cleanup old payout records (90+ days old successful payouts)
  db.cleanupOldPayoutRecords(90);
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

function checkRateLimit(ip, messageType) {
  const now = Date.now();
  let limits = rateLimits.get(ip);

  if (!limits || now - limits.lastReset > 1000) {
    limits = { inputCount: 0, otherCount: 0, lastReset: now };
    rateLimits.set(ip, limits);
  }

  // INPUT and TUTORIAL_INPUT both use the higher input rate limit
  if (messageType === 'INPUT' || messageType === 'TUTORIAL_INPUT') {
    limits.inputCount++;
    return limits.inputCount <= config.RATE_LIMIT_INPUT_PER_SEC;
  } else {
    limits.otherCount++;
    return limits.otherCount <= config.RATE_LIMIT_OTHER_PER_SEC;
  }
}

function checkConnectionLimit(ip) {
  const count = connectionCounts.get(ip) || 0;
  return count < config.MAX_CONNECTIONS_PER_IP;
}

function incrementConnection(ip) {
  const count = connectionCounts.get(ip) || 0;
  connectionCounts.set(ip, count + 1);
}

function decrementConnection(ip) {
  const count = connectionCounts.get(ip) || 0;
  connectionCounts.set(ip, Math.max(0, count - 1));
}

// ============================================
// Lobby Countdown Management
// ============================================

/**
 * Start a countdown for a lobby that is ready (3 players)
 * Broadcasts countdown ticks to all lobby players, then starts the match
 * @param {number} lobbyId - The lobby ID
 * @param {boolean} isAdminPort - Whether this is the admin port
 */
function startLobbyCountdown(lobbyId, isAdminPort) {
  // Don't start if countdown already in progress
  if (lobbyCountdowns.has(lobbyId)) {
    return;
  }

  let secondsRemaining = config.LOBBY_COUNTDOWN_DURATION;

  // Send initial countdown
  const initialMsg = protocol.createLobbyCountdown(lobbyId, secondsRemaining);
  lobby.broadcastToLobby(lobbyId, initialMsg);

  const interval = setInterval(async () => {
    secondsRemaining--;

    // Update stored countdown state for reconnecting players
    const countdownData = lobbyCountdowns.get(lobbyId);
    if (countdownData) {
      countdownData.secondsRemaining = secondsRemaining;
    }

    if (secondsRemaining > 0) {
      // Broadcast countdown tick
      const countdownMsg = protocol.createLobbyCountdown(lobbyId, secondsRemaining);
      lobby.broadcastToLobby(lobbyId, countdownMsg);
    } else {
      // Countdown finished - start the match
      clearInterval(interval);
      lobbyCountdowns.delete(lobbyId);

      try {
        const newMatch = await match.startMatch(lobbyId, isAdminPort);
        // Update currentMatchId for all connected players in the lobby
        const lobbyData = lobby.getLobby(lobbyId);
        if (lobbyData && lobbyData.connections) {
          for (const [userId, ws] of lobbyData.connections) {
            if (ws.setMatchId) {
              ws.setMatchId(newMatch.id);
            }
          }
        }
      } catch (error) {
        console.error('Failed to start match:', error);
        // If lobby balance is insufficient, void the lobby and refund players
        if (error.message === 'INSUFFICIENT_LOBBY_BALANCE') {
          sendAlert(AlertType.INSUFFICIENT_BALANCE, {
            lobbyId,
            balance: error.balance || 'unknown',
          }).catch(alertErr => console.error('Alert send failed:', alertErr));
          await lobby.processLobbyRefund(lobbyId, 'insufficient_lobby_balance');
          broadcastLobbyList();
        } else {
          // Catch-all: Reset lobby status on any match start error to prevent stuck lobbies
          console.error(`[MATCH_START] Resetting lobby ${lobbyId} due to match start failure:`, error.message);
          sendAlert(AlertType.DATABASE_ERROR, {
            operation: 'match_start',
            lobbyId,
            error: error.message,
          }).catch(alertErr => console.error('Alert send failed:', alertErr));
          try {
            await lobby.processLobbyRefund(lobbyId, 'match_start_failed');
            broadcastLobbyList();
          } catch (refundErr) {
            console.error(`[MATCH_START] Failed to refund lobby ${lobbyId}:`, refundErr);
            // Last resort: force reset the lobby to prevent it being stuck
            lobby.forceResetLobby(lobbyId);
            broadcastLobbyList();
          }
        }
      }
    }
  }, 1000);

  lobbyCountdowns.set(lobbyId, { interval, secondsRemaining, isAdminPort });
}

/**
 * Cancel a lobby countdown (e.g., if a player disconnects)
 * @param {number} lobbyId - The lobby ID
 */
function cancelLobbyCountdown(lobbyId) {
  const countdown = lobbyCountdowns.get(lobbyId);
  if (countdown) {
    clearInterval(countdown.interval);
    lobbyCountdowns.delete(lobbyId);
    console.log(`[LOBBY] Countdown cancelled for lobby ${lobbyId}`);
  }
}

// ============================================
// WebSocket Handling - Shared Setup
// ============================================

/**
 * Setup WebSocket connection handler for a server
 * @param {WebSocket.Server} wsServer - The WebSocket server
 * @param {boolean} isAdminPort - Whether this is the admin port (free joins)
 */
function setupWebSocketHandler(wsServer, isAdminPort) {
  wsServer.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;

    // Check connection limit
    if (!checkConnectionLimit(ip)) {
      ws.close(4429, 'Too many connections');
      return;
    }
    incrementConnection(ip);

    // Connection state
    let userId = null;
    let authenticated = false;
    let currentLobbyId = null;
    let currentMatchId = null;
    let currentSessionToken = null; // Track for token rotation on reconnect
    let pingInterval = null;
    let lastPingTime = null;

    // Mark connection as admin port (for payment bypass)
    ws.isAdminPort = isAdminPort;

    // Expose a method to set matchId from outside (used when match starts)
    ws.setMatchId = (matchId) => {
      currentMatchId = matchId;
    };

    const portLabel = isAdminPort ? 'ADMIN' : 'PUBLIC';
    console.log(`WebSocket connected from ${ip} [${portLabel}]`);

    // Ping interval
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        lastPingTime = Date.now();
        // Client-initiated pings, server just responds
      }
    }, 5000);

    ws.on('message', async (data) => {
      // Limit message size to prevent DoS (16KB should be plenty for game messages)
      const MAX_MESSAGE_SIZE = 16 * 1024;
      if (data.length > MAX_MESSAGE_SIZE) {
        console.log(`[SECURITY] Oversized message from ${ip}: ${data.length} bytes`);
        ws.send(protocol.createError('MESSAGE_TOO_LARGE'));
        return;
      }

      const { message, error } = protocol.parseMessage(data.toString(), { isAdmin: isAdminPort });
      if (!message) {
        // Log validation errors for debugging (not shown to client for security)
        if (error) {
          console.log(`[VALIDATION] Invalid message from ${ip}: ${error}`);
        }
        return;
      }

      // Rate limiting
      if (!checkRateLimit(ip, message.type)) {
        ws.send(protocol.createError('RATE_LIMITED'));
        return;
      }

      try {
        await handleMessage(ws, message);
      } catch (error) {
        console.error('Message handling error:', error);
        ws.send(protocol.createError('INTERNAL_ERROR'));
      }
    });

    ws.on('close', () => {
      console.log(`WebSocket disconnected: ${userId || 'unauthenticated'} [${portLabel}]`);

      clearInterval(pingInterval);
      decrementConnection(ip);

      // Handle disconnect from lobby/match - wrapped in try-catch to prevent server crash
      try {
        if (currentMatchId) {
          match.handleDisconnect(currentMatchId, userId);
        }
        if (currentLobbyId) {
          lobby.removeConnection(currentLobbyId, userId);
        }
      } catch (error) {
        console.error(`Error handling disconnect for user ${userId}:`, error);
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      // Clear ping interval on error to prevent leaks (close handler may not fire in all cases)
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    });

    // ============================================
    // Message Handlers
    // ============================================

    async function handleMessage(ws, message) {
      switch (message.type) {
        case protocol.ClientMessages.HELLO:
          await handleHello(message);
          break;

        case protocol.ClientMessages.JOIN_LOBBY:
          await handleJoinLobby(message);
          break;

        case protocol.ClientMessages.REQUEST_REFUND:
          await handleRequestRefund(message);
          break;

        case protocol.ClientMessages.PING:
          handlePing(message);
          break;

        case protocol.ClientMessages.INPUT:
          handleInput(message);
          break;

        case protocol.ClientMessages.START_TUTORIAL:
          console.log('[DEBUG] Received START_TUTORIAL message');
          handleStartTutorial();
          break;

        case protocol.ClientMessages.TUTORIAL_INPUT:
          handleTutorialInput(message);
          break;

        case protocol.ClientMessages.END_TUTORIAL:
          handleEndTutorial();
          break;

        default:
          console.log('Unknown message type:', message.type);
      }
    }

    async function handleHello(message) {
      const { sessionToken } = message;

      const authResult = auth.validateAuth(sessionToken);
      if (!authResult.valid) {
        ws.send(protocol.createError('INVALID_SESSION'));
        ws.close(4001, 'Invalid session');
        return;
      }

      userId = authResult.user.id;
      authenticated = true;
      currentSessionToken = sessionToken; // Store for token rotation on reconnect

      // Send welcome
      ws.send(protocol.createWelcome(userId, Date.now()));

      // Send lobby list
      const lobbies = lobby.getLobbyList();
      ws.send(protocol.createLobbyList(lobbies));

      // Check if player is already in a lobby/match
      const playerLobby = lobby.getPlayerLobby(userId);
      if (playerLobby) {
        currentLobbyId = playerLobby.lobby.id;
        lobby.registerConnection(currentLobbyId, userId, ws);

        // Send lobby update
        const lobbyData = playerLobby.lobby;
        const timeRemaining = lobbyData.timeout_at
          ? Math.max(0, new Date(lobbyData.timeout_at).getTime() - Date.now())
          : null;

        ws.send(protocol.createLobbyUpdate(
          lobbyData.id,
          lobbyData.players.filter(p => !p.refunded_at),
          lobbyData.status,
          timeRemaining,
          lobbyData.deposit_address
        ));

        // If lobby countdown is in progress, send current countdown state
        const activeCountdown = lobbyCountdowns.get(lobbyData.id);
        if (activeCountdown) {
          ws.send(protocol.createLobbyCountdown(lobbyData.id, activeCountdown.secondsRemaining));
        }

        // Check if in active match - use reconnect handler
        if (lobbyData.current_match_id) {
          currentMatchId = lobbyData.current_match_id;

          // HIGH-2 FIX: Immediately clear grace period to prevent race with tick
          // This prevents elimination if reconnect arrives just as grace period expires
          match.clearGracePeriod(currentMatchId, userId);

          const reconnectedMatch = match.handleReconnect(currentMatchId, userId, ws, currentSessionToken);

          if (reconnectedMatch) {
            console.log(`[RECONNECT] User ${userId} reconnected to match ${currentMatchId}`);
          } else {
            // Match may have ended or player eliminated
            console.log(`[RECONNECT] User ${userId} could not reconnect to match ${currentMatchId}`);
            currentMatchId = null;
          }
        }
      }

      console.log(`User ${userId} authenticated [${portLabel}]`);
    }

    async function handleJoinLobby(message) {
      if (!authenticated) {
        ws.send(protocol.createError('INVALID_SESSION'));
        return;
      }

      const { lobbyId, paymentTxHash } = message;
      const user = db.getUserById(userId);

      // Pass isAdminPort to joinLobby for payment bypass decision
      const result = await lobby.joinLobby(userId, lobbyId, paymentTxHash, user.wallet_address, isAdminPort);

      if (!result.success) {
        ws.send(protocol.createError(result.error));
        return;
      }

      currentLobbyId = lobbyId;
      lobby.registerConnection(lobbyId, userId, ws);

      // Send lobby update to all players in lobby
      const lobbyData = result.lobby;
      const players = lobbyData.players.filter(p => !p.refunded_at);
      const timeRemaining = lobbyData.timeout_at
        ? Math.max(0, new Date(lobbyData.timeout_at).getTime() - Date.now())
        : null;

      const updateMsg = protocol.createLobbyUpdate(
        lobbyId,
        players,
        lobbyData.status,
        timeRemaining,
        lobbyData.deposit_address
      );

      lobby.broadcastToLobby(lobbyId, updateMsg);

      // Broadcast updated lobby list to all connected clients
      broadcastLobbyList();

      // Check if lobby is ready to start match - begin lobby countdown
      if (lobbyData.status === 'ready' && players.length === 3) {
        // Start 10-second lobby countdown before match begins
        startLobbyCountdown(lobbyId, isAdminPort);
      }
    }

    async function handleRequestRefund(message) {
      if (!authenticated || !currentLobbyId) {
        ws.send(protocol.createError('NOT_IN_LOBBY'));
        return;
      }

      const result = await lobby.processTimeoutRefund(currentLobbyId, userId);

      if (!result.success) {
        ws.send(protocol.createError(result.error));
        return;
      }

      // Broadcast refund to all players
      const refundMsg = protocol.createRefundProcessed(currentLobbyId, 'timeout', result.refunds);
      lobby.broadcastToLobby(currentLobbyId, refundMsg);

      currentLobbyId = null;

      // Broadcast updated lobby list
      broadcastLobbyList();
    }

    function handlePing(message) {
      const { clientTime } = message;
      const serverTime = Date.now();
      const ping = lastPingTime ? serverTime - lastPingTime : 0;

      ws.send(protocol.createPong(serverTime, ping));
    }

    function handleInput(message) {
      if (!authenticated || !currentMatchId) return;

      match.processInput(currentMatchId, userId, {
        dirX: message.dirX,
        dirY: message.dirY,
        sequence: message.sequence,
      });
    }

    function handleStartTutorial() {
      console.log('[DEBUG] handleStartTutorial called, authenticated:', authenticated, 'userId:', userId);
      if (!authenticated) {
        console.log('[DEBUG] Not authenticated, rejecting');
        ws.send(protocol.createError('INVALID_SESSION'));
        return;
      }

      // Don't allow tutorial if in a lobby or match
      if (currentLobbyId || currentMatchId) {
        console.log('[DEBUG] Already in lobby/match, rejecting');
        ws.send(protocol.createError('ALREADY_IN_GAME'));
        return;
      }

      // Start the tutorial
      console.log('[DEBUG] Starting tutorial for user:', userId);
      tutorial.startTutorial(userId, ws);
      console.log(`[TUTORIAL] Started for user ${userId}`);
    }

    function handleTutorialInput(message) {
      if (!authenticated) return;

      // Check if user is in tutorial
      if (!tutorial.isInTutorial(userId)) return;

      tutorial.processInput(userId, {
        dirX: message.dirX,
        dirY: message.dirY,
        sequence: message.sequence,
      });
    }

    function handleEndTutorial() {
      if (!authenticated) return;

      if (tutorial.isInTutorial(userId)) {
        tutorial.endTutorial(userId);
        console.log(`[TUTORIAL] Ended by user ${userId}`);
      }
    }
  });
}

// Setup WebSocket handlers for both servers
setupWebSocketHandler(wss, false);      // Port 3000 - production (payments required)
setupWebSocketHandler(adminWss, true);  // Port 3001 - admin (free joins)

// ============================================
// Utility Functions
// ============================================

function broadcastLobbyList() {
  const lobbies = lobby.getLobbyList();
  const message = protocol.createLobbyList(lobbies);

  // Broadcast to both production and admin WebSocket servers
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });

  adminWss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ============================================
// Initialization
// ============================================

async function initialize() {
  console.log('Initializing RPS Arena server...');

  // B-1: Ensure backup directory exists at startup
  const fs = require('fs');
  const backupDir = './backups';
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`[BACKUP] Created backup directory: ${backupDir}`);
  }

  // Check database health before proceeding
  const dbHealth = db.checkHealth();
  if (!dbHealth.healthy) {
    console.error(`[FATAL] Database health check failed: ${dbHealth.error}`);
    console.error(`Database path: ${dbHealth.path}`);
    process.exit(1);
  }
  console.log(`Database health check passed: ${dbHealth.path} (journal: ${dbHealth.journalMode})`);

  // Initialize database schema
  const schemaInit = db.initializeDatabase();
  if (!schemaInit) {
    console.error('[FATAL] Failed to initialize database schema');
    process.exit(1);
  }

  // Recover interrupted matches from previous server crash
  console.log('Checking for interrupted matches...');
  const recoveryResults = await match.recoverInterruptedMatches();
  if (recoveryResults.length > 0) {
    console.log(`[RECOVERY] Processed ${recoveryResults.length} interrupted match(es)`);
    for (const r of recoveryResults) {
      console.log(`  - Match ${r.matchId}: ${r.result} (${r.reason || 'ok'})`);
    }
  }

  // Initialize lobbies (after recovery to ensure lobbies are reset)
  await lobby.initializeLobbies();

  // Resume countdowns for any lobbies that are in 'ready' status after server restart
  // This handles the case where the server crashed during a lobby countdown
  const readyLobbies = lobby.getLobbyList().filter(l => l.status === 'ready' && l.playerCount === 3);
  for (const readyLobby of readyLobbies) {
    console.log(`[STARTUP] Resuming countdown for ready lobby ${readyLobby.id}`);
    startLobbyCountdown(readyLobby.id, false); // Use non-admin port for resumed countdowns
  }

  // Initialize payment provider
  payments.initProvider();

  // Test RPC connectivity on startup (R-1: Critical startup check)
  const rpcHealth = await payments.testRpcConnection();
  if (!rpcHealth.healthy) {
    console.error(`[WARNING] RPC provider unreachable: ${rpcHealth.error}`);
    console.error('[WARNING] Payment operations may fail until RPC is available');
    // Send alert but don't exit - fallback RPCs may work for actual transactions
    sendAlert(AlertType.RPC_ERROR, {
      operation: 'startup_health_check',
      error: rpcHealth.error,
    }).catch(err => console.error('Alert send failed:', err.message));
  } else {
    console.log(`[RPC] Health check passed - Block: ${rpcHealth.blockNumber}, Latency: ${rpcHealth.latency}ms`);
  }

  // Start game loop health monitor
  match.startHealthMonitor();

  // R-3: Start periodic RPC health monitor
  payments.startRpcHealthMonitor();

  // Start automated backup scheduler (hourly)
  const backupIntervalHours = parseInt(process.env.BACKUP_INTERVAL_HOURS, 10);
  const BACKUP_INTERVAL_MS = (backupIntervalHours > 0 ? backupIntervalHours : 1) * 60 * 60 * 1000; // Default 1 hour, minimum 1 hour
  const BACKUP_KEEP_COUNT = Math.max(1, parseInt(process.env.BACKUP_KEEP_COUNT, 10) || 24); // Default 24, minimum 1

  setInterval(async () => {
    console.log('[BACKUP] Running scheduled backup...');
    try {
      // Run checkpoint first
      db.walCheckpoint('PASSIVE');

      // Create backup
      const result = await db.createTimestampedBackup();
      if (result.success) {
        console.log(`[BACKUP] Backup created: ${result.sizeMB} MB`);

        // B-2: Verify backup integrity
        const integrity = db.verifyBackupIntegrity(result.path);
        if (integrity.valid) {
          console.log('[BACKUP] Integrity check passed');
        } else {
          console.error(`[BACKUP] Integrity check FAILED: ${integrity.error}`);
          // Alert on backup integrity failure
          sendAlert(AlertType.DATABASE_ERROR, {
            operation: 'backup_integrity_check',
            error: integrity.error,
            backupPath: result.path,
          }).catch(err => console.error('Alert send failed:', err.message));
        }

        // Cleanup old backups
        const cleanup = db.cleanupOldBackups(BACKUP_KEEP_COUNT);
        if (cleanup.deleted > 0) {
          console.log(`[BACKUP] Cleaned up ${cleanup.deleted} old backup(s)`);
        }
      } else {
        console.error(`[BACKUP] Backup failed: ${result.error}`);
      }
    } catch (error) {
      console.error(`[BACKUP] Scheduled backup error: ${error.message}`);
    }
  }, BACKUP_INTERVAL_MS);

  console.log(`Automated backups: every ${BACKUP_INTERVAL_MS / (60 * 60 * 1000)} hour(s), keeping ${BACKUP_KEEP_COUNT} backups`);

  // Start production server (port 3000)
  server.listen(PUBLIC_PORT, () => {
    console.log(`Production server running on port ${PUBLIC_PORT} (payments required)`);
  });

  // Start admin server (port 3001) - SECURITY: Bind to localhost only
  // This prevents the admin port from being accessible from the network
  // Admin port allows payment bypass, so it must NEVER be exposed to the internet
  const ADMIN_BIND_ADDRESS = process.env.ADMIN_BIND_ADDRESS || '127.0.0.1';
  adminServer.listen(ADMIN_PORT, ADMIN_BIND_ADDRESS, () => {
    console.log(`Admin server running on ${ADMIN_BIND_ADDRESS}:${ADMIN_PORT} (free joins, bot management)`);
    if (ADMIN_BIND_ADDRESS !== '127.0.0.1' && ADMIN_BIND_ADDRESS !== 'localhost') {
      console.warn(`[SECURITY WARNING] Admin port bound to ${ADMIN_BIND_ADDRESS} - ensure firewall blocks external access!`);
    }
  });

  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // D-3: Log comprehensive startup health summary
  console.log('');
  console.log('='.repeat(50));
  console.log('RPS Arena Server Started Successfully');
  console.log('='.repeat(50));
  console.log(`  Environment:    ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Public Port:    ${PUBLIC_PORT}`);
  console.log(`  Admin Port:     ${ADMIN_PORT}`);
  console.log(`  Database:       ${dbHealth.path}`);
  console.log(`  RPC Status:     ${rpcHealth.healthy ? 'Connected' : 'DEGRADED'}`);
  console.log(`  Sentry:         ${sentry.isInitialized() ? 'Enabled' : 'Disabled'}`);
  console.log('='.repeat(50));
  console.log('');

  // Send startup alert (helps detect crashes/restarts)
  sendAlert(AlertType.SERVER_START, { port: PUBLIC_PORT })
    .catch(err => console.error('Alert send failed:', err.message));
}

// Handle graceful shutdown
async function gracefulShutdown(reason) {
  console.log('\nShutting down...');
  await sendAlert(AlertType.SERVER_SHUTDOWN, { reason });

  // Stop health monitors
  match.stopHealthMonitor();
  payments.stopRpcHealthMonitor();

  // Close all WebSocket connections on both servers
  wss.clients.forEach((client) => {
    client.close(1001, 'Server shutting down');
  });

  adminWss.clients.forEach((client) => {
    client.close(1001, 'Server shutting down');
  });

  // Flush Sentry before closing
  await sentry.flush(2000);

  server.close(() => {
    console.log('Production server closed');
  });

  adminServer.close(() => {
    console.log('Admin server closed');

    // Close database connection gracefully
    db.closeDb();

    process.exit(0);
  });
}

// Capture unhandled errors with Sentry
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  sentry.captureException(error, { category: 'uncaughtException' });
  // Give Sentry time to send, then exit
  sentry.flush(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    category: 'unhandledRejection',
  });
});

process.on('SIGINT', () => gracefulShutdown('SIGINT (manual stop)'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM (container stop)'));

// Start the server
initialize().catch((error) => {
  console.error('Failed to initialize server:', error);
  sentry.captureException(error, { category: 'initialization' });
  sentry.flush(2000).finally(() => process.exit(1));
});
