/**
 * RPS Arena - Main Server Entry Point
 * WebSocket game server with Express for static files
 */

require('dotenv').config();

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

// ============================================
// Server Setup
// ============================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from client directory
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json());

// ============================================
// HTTP Routes
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Authentication endpoint
app.post('/api/auth', (req, res) => {
  const { walletAddress, signature, timestamp } = req.body;

  const result = auth.authenticateWallet(walletAddress, signature, timestamp);

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
app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    auth.logout(token);
  }
  res.json({ success: true });
});

// Get lobbies (REST fallback)
app.get('/api/lobbies', (req, res) => {
  const lobbies = lobby.getLobbyList();
  res.json({ lobbies });
});

// ============================================
// Dev Mode Status
// ============================================

app.get('/api/dev-mode', (req, res) => {
  const devMode = process.env.NODE_ENV !== 'production' && process.env.DEV_MODE === 'true';
  res.json({ devMode });
});

// ============================================
// Bot Management (Dev Mode Only)
// ============================================

// Add a bot to a lobby
app.post('/api/bot/add', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Bots disabled in production' });
  }

  const { lobbyId } = req.body;
  if (!lobbyId) {
    return res.status(400).json({ success: false, error: 'lobbyId required' });
  }

  const result = await bot.addBotToLobby(parseInt(lobbyId));

  if (result.success) {
    // Broadcast updated lobby list
    broadcastLobbyList();
    res.json({ success: true, bot: { userId: result.bot.userId, username: result.bot.username } });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Fill a lobby with bots
app.post('/api/bot/fill', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Bots disabled in production' });
  }

  const { lobbyId } = req.body;
  if (!lobbyId) {
    return res.status(400).json({ success: false, error: 'lobbyId required' });
  }

  const result = await bot.fillLobbyWithBots(parseInt(lobbyId));

  if (result.success) {
    broadcastLobbyList();
    res.json({ success: true, botsAdded: result.botsAdded });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Get active bots
app.get('/api/bot/list', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Bots disabled in production' });
  }

  const bots = bot.getActiveBots();
  res.json({ success: true, bots });
});

// Reset lobby for testing (Dev Mode Only)
app.post('/api/dev/reset', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Reset disabled in production' });
  }

  const { lobbyId } = req.body;
  const targetLobbyId = lobbyId || 1;

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
app.post('/api/bot/remove', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Bots disabled in production' });
  }

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
// Rate Limiting
// ============================================

const rateLimits = new Map(); // IP -> { inputCount, otherCount, lastReset }
const connectionCounts = new Map(); // IP -> count

function checkRateLimit(ip, messageType) {
  const now = Date.now();
  let limits = rateLimits.get(ip);

  if (!limits || now - limits.lastReset > 1000) {
    limits = { inputCount: 0, otherCount: 0, lastReset: now };
    rateLimits.set(ip, limits);
  }

  if (messageType === 'INPUT') {
    limits.inputCount++;
    return limits.inputCount <= 60; // 60 INPUT/sec
  } else {
    limits.otherCount++;
    return limits.otherCount <= 10; // 10 other/sec
  }
}

function checkConnectionLimit(ip) {
  const count = connectionCounts.get(ip) || 0;
  return count < 3; // Max 3 connections per IP
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
// WebSocket Handling
// ============================================

wss.on('connection', (ws, req) => {
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
  let pingInterval = null;
  let lastPingTime = null;

  console.log(`WebSocket connected from ${ip}`);

  // Ping interval
  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      lastPingTime = Date.now();
      // Client-initiated pings, server just responds
    }
  }, 5000);

  ws.on('message', async (data) => {
    const message = protocol.parseMessage(data.toString());
    if (!message) return;

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
    console.log(`WebSocket disconnected: ${userId || 'unauthenticated'}`);

    clearInterval(pingInterval);
    decrementConnection(ip);

    // Handle disconnect from lobby/match
    if (currentMatchId) {
      match.handleDisconnect(currentMatchId, userId);
    }
    if (currentLobbyId) {
      lobby.removeConnection(currentLobbyId, userId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
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

      // Check if in active match
      if (lobbyData.current_match_id) {
        currentMatchId = lobbyData.current_match_id;
        const activeMatch = match.getMatch(currentMatchId);
        if (activeMatch) {
          activeMatch.connections.set(userId, ws);
          const player = activeMatch.players.find(p => p.id === userId);
          if (player) {
            player.connected = true;
          }
        }
      }
    }

    console.log(`User ${userId} authenticated`);
  }

  async function handleJoinLobby(message) {
    if (!authenticated) {
      ws.send(protocol.createError('INVALID_SESSION'));
      return;
    }

    const { lobbyId, paymentTxHash } = message;
    const user = db.getUserById(userId);

    const result = await lobby.joinLobby(userId, lobbyId, paymentTxHash, user.wallet_address);

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

    // Check if lobby is ready to start match
    if (lobbyData.status === 'ready' && players.length === 3) {
      setTimeout(() => {
        try {
          const newMatch = match.startMatch(lobbyId);
          currentMatchId = newMatch.id;
        } catch (error) {
          console.error('Failed to start match:', error);
        }
      }, 100); // Small delay to ensure all clients received lobby update
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
      targetX: message.targetX,
      targetY: message.targetY,
      sequence: message.sequence,
      frozen: message.frozen,
    });
  }
});

// ============================================
// Utility Functions
// ============================================

function broadcastLobbyList() {
  const lobbies = lobby.getLobbyList();
  const message = protocol.createLobbyList(lobbies);

  wss.clients.forEach((client) => {
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

  // Initialize database
  db.initializeDatabase();

  // Initialize lobbies
  await lobby.initializeLobbies();

  // Initialize payment provider
  payments.initProvider();

  // Start server
  server.listen(PORT, () => {
    console.log(`RPS Arena server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');

  // Close all WebSocket connections
  wss.clients.forEach((client) => {
    client.close(1001, 'Server shutting down');
  });

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start the server
initialize().catch((error) => {
  console.error('Failed to initialize server:', error);
  process.exit(1);
});
