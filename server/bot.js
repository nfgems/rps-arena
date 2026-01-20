/**
 * Bot players for RPS Arena testing
 * Creates fake players that join lobbies and play automatically
 */

const db = require('./database');
const lobby = require('./lobby');
const match = require('./match');
const physics = require('./physics');
const protocol = require('./protocol');

// Track active bots
const activeBots = new Map(); // odId -> botState

// Bot counter for unique names
let botCounter = 0;

/**
 * Create a bot user in the database
 */
function createBotUser() {
  botCounter++;
  const botAddress = `0xbot${String(botCounter).padStart(40, '0')}`;
  const botName = `Bot-${botCounter}`;

  // Check if bot user already exists
  let user = db.getUserByWallet(botAddress);
  if (!user) {
    user = db.createUser(botAddress, botName);
  }

  // Create a session for the bot
  const session = db.createSession(user.id);

  return {
    userId: user.id,
    walletAddress: botAddress,
    username: botName,
    sessionToken: session.token,
  };
}

/**
 * Add a bot to a specific lobby
 * @param {number} lobbyId - Lobby to join (1-12)
 * @returns {Object} Bot info or error
 */
async function addBotToLobby(lobbyId) {
  const lobbyData = lobby.getLobby(lobbyId);

  if (!lobbyData) {
    return { success: false, error: 'LOBBY_NOT_FOUND' };
  }

  if (lobbyData.status === 'in_progress') {
    return { success: false, error: 'LOBBY_IN_PROGRESS' };
  }

  const currentPlayerCount = lobbyData.players.filter(p => !p.refunded_at).length;
  if (currentPlayerCount >= 3) {
    return { success: false, error: 'LOBBY_FULL' };
  }

  // Create bot user
  const bot = createBotUser();

  // Join lobby directly (bypass payment verification)
  const fakeTxHash = `0xbot_tx_${Date.now()}_${bot.userId}`;
  const user = db.getUserById(bot.userId);
  const lobbyPlayer = db.addLobbyPlayer(lobbyId, bot.userId, fakeTxHash);

  // Add to in-memory lobby state
  lobbyData.players.push({
    ...lobbyPlayer,
    wallet_address: user.wallet_address,
    username: user.username,
    isBot: true,  // Mark as bot for movement logic
  });

  // Update lobby status if needed
  if (lobbyData.status === 'empty') {
    db.setLobbyFirstJoin(lobbyId);
    const updatedLobby = db.getLobby(lobbyId);
    lobbyData.status = 'waiting';
    lobbyData.first_join_at = updatedLobby.first_join_at;
    lobbyData.timeout_at = updatedLobby.timeout_at;
  }

  // Check if lobby is now full
  const newPlayerCount = lobbyData.players.filter(p => !p.refunded_at).length;
  if (newPlayerCount === 3) {
    lobbyData.status = 'ready';
    db.updateLobbyStatus(lobbyId, 'ready');
  }

  // Create bot state
  const botState = {
    ...bot,
    lobbyId,
    matchId: null,
    role: null,
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    inputSequence: 0,
    aiInterval: null,
  };

  activeBots.set(bot.userId, botState);

  // Create a fake WebSocket-like object for the bot
  const fakeWs = createFakeWebSocket(botState);
  lobby.registerConnection(lobbyId, bot.userId, fakeWs);

  // Broadcast lobby update
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

  console.log(`Bot ${bot.username} joined lobby ${lobbyId} (${newPlayerCount}/3)`);

  // If lobby is ready, start the match
  if (lobbyData.status === 'ready' && newPlayerCount === 3) {
    setTimeout(async () => {
      try {
        const newMatch = await match.startMatch(lobbyId, true); // skipBalanceCheck for bots
        // Register bots in the match
        for (const [userId, bot] of activeBots) {
          if (bot.lobbyId === lobbyId) {
            bot.matchId = newMatch.id;
            const fakeWs = createFakeWebSocket(bot);
            newMatch.connections.set(userId, fakeWs);
          }
        }
      } catch (error) {
        console.error('Failed to start match:', error);
      }
    }, 100);
  }

  return { success: true, bot: botState };
}

/**
 * Create a fake WebSocket object for bot communication
 */
function createFakeWebSocket(botState) {
  return {
    readyState: 1, // WebSocket.OPEN
    send: (message) => {
      // Process incoming messages to the bot
      handleBotMessage(botState, message);
    },
    close: () => {
      // Bot disconnected
      stopBotAI(botState.userId);
    },
  };
}

/**
 * Handle messages sent to the bot
 */
function handleBotMessage(botState, messageStr) {
  try {
    const message = JSON.parse(messageStr);

    switch (message.type) {
      case 'ROLE_ASSIGNMENT':
        botState.role = message.role;
        botState.x = message.spawnX;
        botState.y = message.spawnY;
        botState.targetX = message.spawnX;
        botState.targetY = message.spawnY;
        console.log(`Bot ${botState.username} assigned role: ${message.role}`);
        break;

      case 'COUNTDOWN':
        if (message.secondsRemaining === 0) {
          // Game started, begin AI
          startBotAI(botState);
        }
        break;

      case 'SNAPSHOT':
        // Update bot's knowledge of other players
        updateBotState(botState, message);
        break;

      case 'ELIMINATION':
        if (message.eliminatedId === botState.userId) {
          console.log(`Bot ${botState.username} was eliminated`);
          stopBotAI(botState.userId);
        }
        break;

      case 'MATCH_END':
        console.log(`Match ended. Winner: ${message.winnerId}`);
        stopBotAI(botState.userId);
        cleanupBot(botState.userId);
        break;
    }
  } catch (e) {
    // Ignore parse errors
  }
}

/**
 * Start the bot AI loop
 */
function startBotAI(botState) {
  if (botState.aiInterval) {
    clearInterval(botState.aiInterval);
  }

  console.log(`Bot ${botState.username} AI started`);

  // Give human player time to react - bot waits 2 seconds before moving
  botState.startDelay = 60; // 60 ticks at 100ms = 6 seconds of slow movement
  botState.tickCount = 0;

  // Bot makes decisions every 100ms
  botState.aiInterval = setInterval(() => {
    if (!botState.matchId) return;

    const activeMatch = match.getMatch(botState.matchId);
    if (!activeMatch || activeMatch.status !== 'running') {
      stopBotAI(botState.userId);
      return;
    }

    // Find bot's player state in match
    const botPlayer = activeMatch.players.find(p => p.id === botState.userId);
    if (!botPlayer || !botPlayer.alive) {
      stopBotAI(botState.userId);
      return;
    }

    botState.tickCount++;

    // Simple AI: find the player we can beat and chase them
    const target = findBestTarget(botState, activeMatch);

    if (target) {
      // During start delay, move slower by targeting a point between bot and target
      if (botState.tickCount < botState.startDelay) {
        // Move at 30% speed during warmup
        const slowFactor = 0.3;
        botState.targetX = botPlayer.x + (target.x - botPlayer.x) * slowFactor;
        botState.targetY = botPlayer.y + (target.y - botPlayer.y) * slowFactor;
      } else {
        // Full speed after warmup
        botState.targetX = target.x;
        botState.targetY = target.y;
      }
    } else {
      // Random movement if no good target
      botState.targetX = Math.random() * physics.ARENA_WIDTH;
      botState.targetY = Math.random() * physics.ARENA_HEIGHT;
    }

    // Send input to match
    botState.inputSequence++;
    match.processInput(botState.matchId, botState.userId, {
      targetX: botState.targetX,
      targetY: botState.targetY,
      sequence: botState.inputSequence,
      frozen: false,
    });

  }, 100);
}

/**
 * Find the best target for the bot to chase
 * Rock chases Scissors, Scissors chases Paper, Paper chases Rock
 */
function findBestTarget(botState, activeMatch) {
  const victimRole = getVictimRole(botState.role);
  const predatorRole = getPredatorRole(botState.role);

  const alivePlayers = activeMatch.players.filter(p => p.alive && p.id !== botState.userId);

  // Find victim (player we can eliminate)
  const victim = alivePlayers.find(p => p.role === victimRole);

  // Find predator (player who can eliminate us)
  const predator = alivePlayers.find(p => p.role === predatorRole);

  const botPlayer = activeMatch.players.find(p => p.id === botState.userId);

  if (victim && predator) {
    // Calculate distances
    const distToVictim = distance(botPlayer, victim);
    const distToPredator = distance(botPlayer, predator);

    // If predator is close, run away
    if (distToPredator < 150) {
      // Run away from predator
      const awayX = botPlayer.x + (botPlayer.x - predator.x);
      const awayY = botPlayer.y + (botPlayer.y - predator.y);
      return {
        x: Math.max(50, Math.min(physics.ARENA_WIDTH - 50, awayX)),
        y: Math.max(50, Math.min(physics.ARENA_HEIGHT - 50, awayY)),
      };
    }

    // Otherwise chase victim
    return { x: victim.x, y: victim.y };
  } else if (victim) {
    // No predator, chase victim
    return { x: victim.x, y: victim.y };
  } else if (predator) {
    // No victim, run from predator
    const awayX = botPlayer.x + (botPlayer.x - predator.x);
    const awayY = botPlayer.y + (botPlayer.y - predator.y);
    return {
      x: Math.max(50, Math.min(physics.ARENA_WIDTH - 50, awayX)),
      y: Math.max(50, Math.min(physics.ARENA_HEIGHT - 50, awayY)),
    };
  }

  return null;
}

/**
 * Get the role that this role beats
 */
function getVictimRole(role) {
  switch (role) {
    case 'rock': return 'scissors';
    case 'scissors': return 'paper';
    case 'paper': return 'rock';
    default: return null;
  }
}

/**
 * Get the role that beats this role
 */
function getPredatorRole(role) {
  switch (role) {
    case 'rock': return 'paper';
    case 'scissors': return 'rock';
    case 'paper': return 'scissors';
    default: return null;
  }
}

/**
 * Calculate distance between two points
 */
function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Update bot state from snapshot
 */
function updateBotState(botState, snapshot) {
  const botData = snapshot.players.find(p => p.id === botState.userId);
  if (botData) {
    botState.x = botData.x;
    botState.y = botData.y;
  }
}

/**
 * Stop bot AI
 */
function stopBotAI(userId) {
  const bot = activeBots.get(userId);
  if (bot && bot.aiInterval) {
    clearInterval(bot.aiInterval);
    bot.aiInterval = null;
  }
}

/**
 * Clean up bot after match ends
 */
function cleanupBot(userId) {
  const bot = activeBots.get(userId);
  if (bot) {
    stopBotAI(userId);
    activeBots.delete(userId);
    console.log(`Bot ${bot.username} cleaned up`);
  }
}

/**
 * Remove a bot from its current lobby
 */
function removeBot(userId) {
  const bot = activeBots.get(userId);
  if (!bot) {
    return { success: false, error: 'BOT_NOT_FOUND' };
  }

  stopBotAI(userId);

  // Remove from lobby
  if (bot.lobbyId) {
    lobby.removeConnection(bot.lobbyId, userId);
  }

  activeBots.delete(userId);
  console.log(`Bot ${bot.username} removed`);

  return { success: true };
}

/**
 * Get list of active bots
 */
function getActiveBots() {
  return Array.from(activeBots.values()).map(bot => ({
    userId: bot.userId,
    username: bot.username,
    lobbyId: bot.lobbyId,
    matchId: bot.matchId,
    role: bot.role,
  }));
}

/**
 * Remove all bots (dev mode reset)
 */
function removeAllBots() {
  for (const [userId] of activeBots) {
    removeBot(userId);
  }
  console.log('All bots removed');
}

/**
 * Fill a lobby with bots (adds bots until 3 players)
 */
async function fillLobbyWithBots(lobbyId) {
  const lobbyData = lobby.getLobby(lobbyId);
  if (!lobbyData) {
    return { success: false, error: 'LOBBY_NOT_FOUND' };
  }

  const currentCount = lobbyData.players.filter(p => !p.refunded_at).length;
  const botsNeeded = 3 - currentCount;

  const addedBots = [];
  for (let i = 0; i < botsNeeded; i++) {
    const result = await addBotToLobby(lobbyId);
    if (result.success) {
      addedBots.push(result.bot);
    }
  }

  return { success: true, botsAdded: addedBots.length };
}

module.exports = {
  addBotToLobby,
  removeBot,
  removeAllBots,
  getActiveBots,
  fillLobbyWithBots,
  cleanupBot,
};
