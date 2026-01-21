/**
 * Tutorial Module for RPS Arena
 * Provides a comprehensive free practice mode against scripted bots
 *
 * Tutorial Steps:
 * 1. INTRO - Welcome and explain what they'll learn
 * 2. ROLE_EXPLAIN - Explain their role and who beats who
 * 3. MOVEMENT - Learn WASD/Arrow keys movement
 * 4. CHASE_TARGET - Chase the role you beat
 * 5. ELIMINATION - Eliminate the target
 * 6. BEING_HUNTED - Experience being chased by your threat
 * 7. BEING_ELIMINATED - Get eliminated to see what it's like
 * 8. SHOWDOWN_INTRO - Explain showdown mode triggers
 * 9. SHOWDOWN_FREEZE - Experience the 3-second freeze
 * 10. HEART_COLLECTION - Collect hearts to win
 * 11. COMPLETE - Tutorial finished
 */

const physics = require('./physics');

// Tutorial state storage
const activeTutorials = new Map();

// Tutorial step definitions (in order)
const TUTORIAL_STEPS = {
  INTRO: 'intro',
  ROLE_EXPLAIN: 'role_explain',
  MOVEMENT: 'movement',
  CHASE_TARGET: 'chase_target',
  ELIMINATION: 'elimination',
  BEING_HUNTED: 'being_hunted',
  BEING_ELIMINATED: 'being_eliminated',
  SHOWDOWN_INTRO: 'showdown_intro',
  SHOWDOWN_FREEZE: 'showdown_freeze',
  HEART_COLLECTION: 'heart_collection',
  COMPLETE: 'complete',
};

// Bot behavior modes
const BOT_BEHAVIOR = {
  IDLE: 'idle',
  WANDER_SLOW: 'wander_slow',
  FLEE_SLOW: 'flee_slow',
  FLEE_MEDIUM: 'flee_medium',
  CHASE_SLOW: 'chase_slow',
  CHASE_MEDIUM: 'chase_medium',
  CHASE_FAST: 'chase_fast',
  COLLECT_HEARTS: 'collect_hearts',
  WAIT: 'wait',
  APPROACH_PLAYER: 'approach_player',
};

// Step instructions with detailed educational content
const STEP_INSTRUCTIONS = {
  [TUTORIAL_STEPS.INTRO]: {
    title: 'Welcome to RPS Arena!',
    text: 'This tutorial will teach you everything you need to know to compete.',
    subtext: 'Press any movement key (WASD or Arrow Keys) to begin.',
    highlight: null,
  },
  [TUTORIAL_STEPS.ROLE_EXPLAIN]: {
    title: 'Your Role: ROCK',
    text: 'You are ROCK (orange). Rock beats SCISSORS (green). But PAPER (blue) beats you!',
    subtext: 'Remember: Chase GREEN, avoid BLUE. Press any key to continue.',
    highlight: 'player',
  },
  [TUTORIAL_STEPS.MOVEMENT]: {
    title: 'Movement Controls',
    text: 'Use WASD or Arrow Keys to move. All players move at the same speed.',
    subtext: 'Move around the arena to get comfortable. Reach any edge to continue.',
    highlight: 'player',
  },
  [TUTORIAL_STEPS.CHASE_TARGET]: {
    title: 'Chase Your Target',
    text: 'You are ROCK. You beat SCISSORS! The green player is your target.',
    subtext: 'Chase down the SCISSORS (green) player and collide with them!',
    highlight: 'bot_target',
  },
  [TUTORIAL_STEPS.ELIMINATION]: {
    title: 'Elimination!',
    text: 'You eliminated SCISSORS! When you collide with a player you beat, they\'re instantly out.',
    subtext: 'Now only 2 players remain... watch what happens next!',
    highlight: null,
  },
  [TUTORIAL_STEPS.SHOWDOWN_INTRO]: {
    title: 'Showdown Mode!',
    text: 'When only 2 players remain, SHOWDOWN begins! Both players freeze for 3 seconds.',
    subtext: 'Get ready for the showdown...',
    highlight: null,
  },
  [TUTORIAL_STEPS.SHOWDOWN_FREEZE]: {
    title: 'SHOWDOWN',
    text: 'You\'re frozen! In 3 seconds, hearts will appear. First to collect 2 wins!',
    subtext: 'In showdown, collisions only cause bounces - no eliminations possible.',
    highlight: null,
  },
  [TUTORIAL_STEPS.HEART_COLLECTION]: {
    title: 'Collect Hearts!',
    text: 'Race to collect 2 hearts! Move directly into a heart to grab it.',
    subtext: 'You need 2 hearts to win. The opponent is also collecting!',
    highlight: 'hearts',
  },
  [TUTORIAL_STEPS.BEING_HUNTED]: {
    title: 'Now You\'re the Prey!',
    text: 'Now let\'s see the other side. PAPER (blue) beats ROCK - they\'re hunting YOU!',
    subtext: 'Let them catch you to see what elimination feels like.',
    highlight: 'bot_threat',
  },
  [TUTORIAL_STEPS.BEING_ELIMINATED]: {
    title: 'You Were Eliminated!',
    text: 'This is what happens when someone who beats your role catches you.',
    subtext: 'Now let\'s learn about SHOWDOWN mode...',
    highlight: null,
  },
  [TUTORIAL_STEPS.COMPLETE]: {
    title: 'Tutorial Complete!',
    text: 'You now understand all the core mechanics of RPS Arena!',
    subtext: 'Join a real lobby to compete for USDC prizes!',
    highlight: null,
  },
};

/**
 * Start a new tutorial session for a player
 */
function startTutorial(userId, ws) {
  if (activeTutorials.has(userId)) {
    endTutorial(userId);
  }

  const tutorialId = `tutorial_${userId}_${Date.now()}`;

  const tutorial = {
    id: tutorialId,
    userId: userId,
    ws: ws,
    currentStep: TUTORIAL_STEPS.INTRO,
    tick: 0,
    status: 'running',
    gameLoopInterval: null,
    stepStartTick: 0,
    waitingForInput: true,

    // Player state (always rock in tutorial)
    player: {
      id: userId,
      role: 'rock',
      x: 400,
      y: 450,
      alive: true,
      frozen: false,
      dirX: 0,
      dirY: 0,
      lastInputSequence: 0,
    },

    // Tutorial bots
    bots: [
      {
        id: 'tutorial_bot_scissors',
        username: 'Scissors Bot',
        role: 'scissors', // Player beats this
        x: 1200,
        y: 450,
        alive: true,
        frozen: false,
        behavior: BOT_BEHAVIOR.IDLE,
        targetX: 1200,
        targetY: 450,
      },
      {
        id: 'tutorial_bot_paper',
        username: 'Paper Bot',
        role: 'paper', // This beats player
        x: 800,
        y: 200,
        alive: true,
        frozen: false,
        behavior: BOT_BEHAVIOR.IDLE,
        targetX: 800,
        targetY: 200,
      },
    ],

    showdown: null,

    // Movement tracking
    movementHistory: {
      startX: 400,
      startY: 450,
      maxDistFromStart: 0,
      reachedEdge: false,
    },

    // Step-specific state
    heartsCollectedByPlayer: 0,
  };

  activeTutorials.set(userId, tutorial);

  sendTutorialStart(tutorial);
  startTutorialLoop(tutorial);

  console.log(`[TUTORIAL] Started for user ${userId}`);
  return tutorial;
}

/**
 * Send tutorial start message
 */
function sendTutorialStart(tutorial) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_START',
    tutorialId: tutorial.id,
    step: tutorial.currentStep,
    instruction: STEP_INSTRUCTIONS[tutorial.currentStep],
    player: {
      id: tutorial.player.id,
      role: tutorial.player.role,
      x: tutorial.player.x,
      y: tutorial.player.y,
    },
    bots: tutorial.bots.filter(b => b.alive).map(b => ({
      id: b.id,
      username: b.username,
      role: b.role,
      x: b.x,
      y: b.y,
      alive: b.alive,
    })),
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

/**
 * Start the tutorial game loop
 */
function startTutorialLoop(tutorial) {
  const tickInterval = 1000 / physics.TICK_RATE;

  tutorial.gameLoopInterval = setInterval(() => {
    if (tutorial.status !== 'running') {
      clearInterval(tutorial.gameLoopInterval);
      return;
    }

    try {
      processTutorialTick(tutorial);
    } catch (error) {
      console.error(`[TUTORIAL] Tick error:`, error);
    }
  }, tickInterval);
}

/**
 * Process a single tutorial tick
 */
function processTutorialTick(tutorial) {
  tutorial.tick++;

  // Process player movement if allowed
  if (tutorial.player.alive && !tutorial.player.frozen && !tutorial.waitingForInput) {
    const newPos = physics.moveInDirection(
      { x: tutorial.player.x, y: tutorial.player.y },
      tutorial.player.dirX,
      tutorial.player.dirY,
      false
    );
    tutorial.player.x = newPos.x;
    tutorial.player.y = newPos.y;

    // Track movement
    const dx = newPos.x - tutorial.movementHistory.startX;
    const dy = newPos.y - tutorial.movementHistory.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    tutorial.movementHistory.maxDistFromStart = Math.max(tutorial.movementHistory.maxDistFromStart, dist);

    if (newPos.x < 50 || newPos.x > physics.ARENA_WIDTH - 50 ||
        newPos.y < 50 || newPos.y > physics.ARENA_HEIGHT - 50) {
      tutorial.movementHistory.reachedEdge = true;
    }
  }

  // Process bot movement
  for (const bot of tutorial.bots) {
    if (bot.alive && !bot.frozen) {
      processBotBehavior(tutorial, bot);
    }
  }

  // Check step-specific logic
  processStepLogic(tutorial);

  // Process collisions
  processTutorialCollisions(tutorial);

  // Process showdown hearts
  if (tutorial.showdown && !tutorial.showdown.frozen) {
    processTutorialHearts(tutorial);
  }

  // Send snapshot
  if (tutorial.tick % 2 === 0) {
    sendTutorialSnapshot(tutorial);
  }
}

/**
 * Process bot movement based on behavior
 */
function processBotBehavior(tutorial, bot) {
  const player = tutorial.player;

  switch (bot.behavior) {
    case BOT_BEHAVIOR.IDLE:
      break;

    case BOT_BEHAVIOR.WANDER_SLOW:
      if (tutorial.tick % 90 === 0) {
        bot.targetX = 200 + Math.random() * (physics.ARENA_WIDTH - 400);
        bot.targetY = 200 + Math.random() * (physics.ARENA_HEIGHT - 400);
      }
      moveTowardTarget(bot, bot.targetX, bot.targetY, 0.2);
      break;

    case BOT_BEHAVIOR.FLEE_SLOW:
      // Flee but stay catchable - move perpendicular to player sometimes
      const awaySlow = getFleeTarget(bot, player, tutorial.tick);
      bot.targetX = awaySlow.x;
      bot.targetY = awaySlow.y;
      moveTowardTarget(bot, bot.targetX, bot.targetY, 0.35);
      break;

    case BOT_BEHAVIOR.FLEE_MEDIUM:
      const awayMed = getAwayDirection(bot, player);
      bot.targetX = awayMed.x;
      bot.targetY = awayMed.y;
      moveTowardTarget(bot, bot.targetX, bot.targetY, 0.6);
      break;

    case BOT_BEHAVIOR.CHASE_SLOW:
      moveTowardTarget(bot, player.x, player.y, 0.4);
      break;

    case BOT_BEHAVIOR.CHASE_MEDIUM:
      moveTowardTarget(bot, player.x, player.y, 0.6);
      break;

    case BOT_BEHAVIOR.CHASE_FAST:
      moveTowardTarget(bot, player.x, player.y, 0.85);
      break;

    case BOT_BEHAVIOR.APPROACH_PLAYER:
      // Move toward player slowly, stop when close
      const distToPlayer = getDistance(bot, player);
      if (distToPlayer > 100) {
        moveTowardTarget(bot, player.x, player.y, 0.3);
      }
      break;

    case BOT_BEHAVIOR.COLLECT_HEARTS:
      if (tutorial.showdown && tutorial.showdown.hearts) {
        const target = tutorial.showdown.hearts.find(h => !h.captured);
        if (target) {
          // Move slowly so player has a fair chance to learn
          moveTowardTarget(bot, target.x, target.y, 0.3);
        }
      }
      break;

    case BOT_BEHAVIOR.WAIT:
      break;
  }
}

/**
 * Get flee target for tutorial bot - stays in visible area and is catchable
 * Bot moves in an arc pattern to stay visible and give player a fair chase
 */
function getFleeTarget(bot, player, tick) {
  // Define a safe play area in the center of the arena
  const minX = 250;
  const maxX = physics.ARENA_WIDTH - 250;
  const minY = 200;
  const maxY = physics.ARENA_HEIGHT - 200;
  const centerX = physics.ARENA_WIDTH / 2;
  const centerY = physics.ARENA_HEIGHT / 2;

  const dx = bot.x - player.x;
  const dy = bot.y - player.y;
  const distToPlayer = Math.sqrt(dx * dx + dy * dy) || 1;

  // If player is far, just wander in the safe zone
  if (distToPlayer > 400) {
    // Move toward center slowly
    return { x: centerX, y: centerY };
  }

  // Calculate perpendicular direction for arc movement
  // This makes the bot circle around rather than flee in a straight line
  const perpX = -dy / distToPlayer;
  const perpY = dx / distToPlayer;

  // Mix fleeing away with perpendicular movement for an arc
  const fleeX = dx / distToPlayer;
  const fleeY = dy / distToPlayer;

  // Alternate direction based on tick to prevent getting stuck
  const arcDir = Math.sin(tick * 0.02) > 0 ? 1 : -1;

  // Blend: 60% flee direction + 40% perpendicular for smooth arc
  let targetX = bot.x + (fleeX * 0.6 + perpX * arcDir * 0.4) * 150;
  let targetY = bot.y + (fleeY * 0.6 + perpY * arcDir * 0.4) * 150;

  // If target would be outside safe zone, move toward center instead
  if (targetX < minX || targetX > maxX || targetY < minY || targetY > maxY) {
    targetX = bot.x * 0.7 + centerX * 0.3;
    targetY = bot.y * 0.7 + centerY * 0.3;
  }

  return {
    x: Math.max(minX, Math.min(maxX, targetX)),
    y: Math.max(minY, Math.min(maxY, targetY)),
  };
}

/**
 * Get direction away from a target (used for FLEE_MEDIUM)
 */
function getAwayDirection(from, target) {
  const dx = from.x - target.x;
  const dy = from.y - target.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  // Keep in visible area
  const minX = 200;
  const maxX = physics.ARENA_WIDTH - 200;
  const minY = 150;
  const maxY = physics.ARENA_HEIGHT - 150;

  let fleeX = from.x + (dx / dist) * 200;
  let fleeY = from.y + (dy / dist) * 200;

  // Clamp to safe area
  return {
    x: Math.max(minX, Math.min(maxX, fleeX)),
    y: Math.max(minY, Math.min(maxY, fleeY)),
  };
}

/**
 * Get distance between two entities
 */
function getDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Move bot toward target
 */
function moveTowardTarget(bot, targetX, targetY, speedMultiplier = 1.0) {
  const dx = targetX - bot.x;
  const dy = targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 3) return;

  const maxSpeed = (physics.MAX_SPEED / physics.TICK_RATE) * speedMultiplier;
  const moveX = (dx / dist) * Math.min(maxSpeed, dist);
  const moveY = (dy / dist) * Math.min(maxSpeed, dist);

  bot.x = Math.max(physics.PLAYER_RADIUS, Math.min(physics.ARENA_WIDTH - physics.PLAYER_RADIUS, bot.x + moveX));
  bot.y = Math.max(physics.PLAYER_RADIUS, Math.min(physics.ARENA_HEIGHT - physics.PLAYER_RADIUS, bot.y + moveY));
}

/**
 * Process step-specific logic
 */
function processStepLogic(tutorial) {
  const ticksInStep = tutorial.tick - tutorial.stepStartTick;

  switch (tutorial.currentStep) {
    case TUTORIAL_STEPS.INTRO:
      // Wait for any input
      if (!tutorial.waitingForInput) {
        advanceToStep(tutorial, TUTORIAL_STEPS.ROLE_EXPLAIN);
      }
      break;

    case TUTORIAL_STEPS.ROLE_EXPLAIN:
      // Wait for any input, auto-advance after 5 seconds
      if (!tutorial.waitingForInput || ticksInStep > 150) {
        advanceToStep(tutorial, TUTORIAL_STEPS.MOVEMENT);
      }
      break;

    case TUTORIAL_STEPS.MOVEMENT:
      // Wait until player reaches edge
      if (tutorial.movementHistory.reachedEdge && tutorial.movementHistory.maxDistFromStart > 200) {
        advanceToStep(tutorial, TUTORIAL_STEPS.CHASE_TARGET);
      }
      break;

    case TUTORIAL_STEPS.CHASE_TARGET:
      // Setup: Position scissors bot, make it flee slowly
      if (ticksInStep === 1) {
        setupChaseTarget(tutorial);
      }
      // Scissors bot eliminated triggers next step
      break;

    case TUTORIAL_STEPS.ELIMINATION:
      // Brief pause after elimination, then move to being hunted
      if (ticksInStep >= 60) { // 2 seconds
        advanceToStep(tutorial, TUTORIAL_STEPS.BEING_HUNTED);
      }
      break;

    case TUTORIAL_STEPS.BEING_HUNTED:
      if (ticksInStep === 1) {
        setupBeingHunted(tutorial);
      }
      // Player elimination triggers next step (handled in collision detection)
      break;

    case TUTORIAL_STEPS.BEING_ELIMINATED:
      // Brief pause after being eliminated, then move to showdown
      if (ticksInStep >= 60) { // 2 seconds
        advanceToStep(tutorial, TUTORIAL_STEPS.SHOWDOWN_INTRO);
      }
      break;

    case TUTORIAL_STEPS.SHOWDOWN_INTRO:
      if (ticksInStep === 1) {
        setupShowdownIntro(tutorial);
      }
      if (ticksInStep >= 60) {
        advanceToStep(tutorial, TUTORIAL_STEPS.SHOWDOWN_FREEZE);
      }
      break;

    case TUTORIAL_STEPS.SHOWDOWN_FREEZE:
      // Freeze both players for 3 seconds
      if (ticksInStep === 1) {
        setupShowdownFreeze(tutorial);
      }
      if (ticksInStep >= 90) { // 3 seconds
        advanceToStep(tutorial, TUTORIAL_STEPS.HEART_COLLECTION);
      }
      break;

    case TUTORIAL_STEPS.HEART_COLLECTION:
      if (ticksInStep === 1) {
        setupHeartCollection(tutorial);
      }
      // Check if anyone collected 2 hearts (player OR bot)
      const anyoneWon = tutorial.heartsCollectedByPlayer >= 2 ||
        (tutorial.showdown && tutorial.showdown.scores &&
          Object.values(tutorial.showdown.scores).some(score => score >= 2));

      if (anyoneWon && !tutorial.heartCollectionComplete) {
        tutorial.heartCollectionComplete = true; // Prevent multiple triggers
        setTimeout(() => {
          if (tutorial.status === 'running') {
            advanceToStep(tutorial, TUTORIAL_STEPS.COMPLETE);
          }
        }, 1500);
      }
      break;

    case TUTORIAL_STEPS.COMPLETE:
      if (ticksInStep === 1) {
        completeTutorial(tutorial);
      }
      break;
  }
}

/**
 * Setup functions for each step
 */
function setupChaseTarget(tutorial) {
  // Show scissors bot (player's target)
  const scissorsBot = tutorial.bots.find(b => b.role === 'scissors');
  scissorsBot.alive = true;
  scissorsBot.x = physics.ARENA_WIDTH - 200;
  scissorsBot.y = physics.ARENA_HEIGHT / 2;
  scissorsBot.behavior = BOT_BEHAVIOR.FLEE_SLOW;

  // Hide paper bot for now
  const paperBot = tutorial.bots.find(b => b.role === 'paper');
  if (paperBot) paperBot.alive = false;

  // Position player on left
  tutorial.player.x = 200;
  tutorial.player.y = physics.ARENA_HEIGHT / 2;

  updateInstruction(tutorial, STEP_INSTRUCTIONS[TUTORIAL_STEPS.CHASE_TARGET]);
}

function setupShowdownIntro(tutorial) {
  // Reset player state for showdown demonstration
  tutorial.player.alive = true;
  tutorial.player.frozen = false;
  tutorial.player.x = 300;
  tutorial.player.y = physics.ARENA_HEIGHT / 2;

  // Prepare bot for showdown
  const paperBot = tutorial.bots.find(b => b.role === 'paper');
  paperBot.alive = true;
  paperBot.frozen = false;
  paperBot.x = physics.ARENA_WIDTH - 300;
  paperBot.y = physics.ARENA_HEIGHT / 2;
  paperBot.behavior = BOT_BEHAVIOR.WAIT;

  // Hide scissors bot
  const scissorsBot = tutorial.bots.find(b => b.role === 'scissors');
  if (scissorsBot) scissorsBot.alive = false;

  updateInstruction(tutorial, STEP_INSTRUCTIONS[TUTORIAL_STEPS.SHOWDOWN_INTRO]);
}

function setupShowdownFreeze(tutorial) {
  // Freeze both players
  tutorial.player.frozen = true;
  const paperBot = tutorial.bots.find(b => b.role === 'paper');
  paperBot.frozen = true;

  // Send showdown start
  sendShowdownStart(tutorial);

  updateInstruction(tutorial, STEP_INSTRUCTIONS[TUTORIAL_STEPS.SHOWDOWN_FREEZE]);
}

function setupHeartCollection(tutorial) {
  // Unfreeze
  tutorial.player.frozen = false;
  const paperBot = tutorial.bots.find(b => b.role === 'paper');
  paperBot.frozen = false;
  paperBot.behavior = BOT_BEHAVIOR.COLLECT_HEARTS;

  // Create showdown with hearts
  tutorial.showdown = {
    frozen: false,
    hearts: [
      { id: 'heart_1', x: 400, y: 300, captured: false },
      { id: 'heart_2', x: 800, y: 600, captured: false },
      { id: 'heart_3', x: 1200, y: 300, captured: false },
    ],
    scores: {},
  };

  sendShowdownReady(tutorial);
  updateInstruction(tutorial, STEP_INSTRUCTIONS[TUTORIAL_STEPS.HEART_COLLECTION]);
}

function setupBeingHunted(tutorial) {
  // Reset everything
  tutorial.showdown = null;
  tutorial.heartsCollectedByPlayer = 0;
  tutorial.player.alive = true;
  tutorial.player.frozen = false;
  tutorial.player.x = physics.ARENA_WIDTH - 200;
  tutorial.player.y = physics.ARENA_HEIGHT / 2;

  // Paper bot chases player
  const paperBot = tutorial.bots.find(b => b.role === 'paper');
  paperBot.alive = true;
  paperBot.frozen = false;
  paperBot.x = 200;
  paperBot.y = physics.ARENA_HEIGHT / 2;
  paperBot.behavior = BOT_BEHAVIOR.CHASE_MEDIUM;

  // Hide scissors bot
  const scissorsBot = tutorial.bots.find(b => b.role === 'scissors');
  if (scissorsBot) scissorsBot.alive = false;

  updateInstruction(tutorial, STEP_INSTRUCTIONS[TUTORIAL_STEPS.BEING_HUNTED]);
}

/**
 * Advance to next tutorial step
 */
function advanceToStep(tutorial, newStep) {
  tutorial.currentStep = newStep;
  tutorial.stepStartTick = tutorial.tick;
  tutorial.waitingForInput = false;

  // Steps that wait for input
  if ([TUTORIAL_STEPS.INTRO, TUTORIAL_STEPS.ROLE_EXPLAIN, TUTORIAL_STEPS.BEING_ELIMINATED].includes(newStep)) {
    tutorial.waitingForInput = true;
  }

  const instruction = STEP_INSTRUCTIONS[newStep];
  if (instruction) {
    updateInstruction(tutorial, instruction);
  }

  sendStepChange(tutorial);
  console.log(`[TUTORIAL] ${tutorial.userId} advanced to step: ${newStep}`);
}

/**
 * Process collisions
 */
function processTutorialCollisions(tutorial) {
  const player = tutorial.player;
  if (!player.alive) return;

  for (const bot of tutorial.bots) {
    if (!bot.alive) continue;

    const dist = getDistance(player, bot);
    if (dist <= physics.PLAYER_RADIUS * 2) {
      // Collision!

      // In showdown, always bounce (no eliminations)
      if (tutorial.showdown) {
        bounceApart(player, bot);
        sendBounce(tutorial, player, bot);
        continue;
      }

      // Determine winner based on RPS rules
      const result = getRpsResult(player.role, bot.role);

      if (result === 'win') {
        // Player eliminates bot
        bot.alive = false;
        sendElimination(tutorial, bot.id, player.id);

        // Check if this was the chase target
        if (tutorial.currentStep === TUTORIAL_STEPS.CHASE_TARGET) {
          advanceToStep(tutorial, TUTORIAL_STEPS.ELIMINATION);
        }
      } else if (result === 'lose') {
        // Bot eliminates player
        player.alive = false;
        sendElimination(tutorial, player.id, bot.id);

        // Check if this was during being hunted
        if (tutorial.currentStep === TUTORIAL_STEPS.BEING_HUNTED) {
          setTimeout(() => {
            if (tutorial.status === 'running') {
              advanceToStep(tutorial, TUTORIAL_STEPS.BEING_ELIMINATED);
            }
          }, 500);
        }
      }
    }
  }
}

/**
 * Process heart captures
 */
function processTutorialHearts(tutorial) {
  if (!tutorial.showdown || !tutorial.showdown.hearts) return;

  const entities = [tutorial.player, ...tutorial.bots.filter(b => b.alive)];

  for (const heart of tutorial.showdown.hearts) {
    if (heart.captured) continue;

    for (const entity of entities) {
      const dist = getDistance(entity, heart);
      if (dist <= physics.PLAYER_RADIUS + physics.HEART_RADIUS) {
        heart.captured = true;

        if (!tutorial.showdown.scores[entity.id]) {
          tutorial.showdown.scores[entity.id] = 0;
        }
        tutorial.showdown.scores[entity.id]++;

        if (entity.id === tutorial.player.id) {
          tutorial.heartsCollectedByPlayer++;
        }

        sendHeartCaptured(tutorial, entity.id, heart.id, tutorial.showdown.scores[entity.id]);
        break;
      }
    }
  }
}

/**
 * RPS result
 */
function getRpsResult(role1, role2) {
  if (role1 === role2) return 'tie';
  const wins = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return wins[role1] === role2 ? 'win' : 'lose';
}

/**
 * Bounce entities apart
 */
function bounceApart(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  const overlap = physics.PLAYER_RADIUS * 2 - dist;
  if (overlap > 0) {
    const pushX = (dx / dist) * (overlap / 2 + 10);
    const pushY = (dy / dist) * (overlap / 2 + 10);

    a.x = clamp(a.x + pushX, physics.PLAYER_RADIUS, physics.ARENA_WIDTH - physics.PLAYER_RADIUS);
    a.y = clamp(a.y + pushY, physics.PLAYER_RADIUS, physics.ARENA_HEIGHT - physics.PLAYER_RADIUS);
    b.x = clamp(b.x - pushX, physics.PLAYER_RADIUS, physics.ARENA_WIDTH - physics.PLAYER_RADIUS);
    b.y = clamp(b.y - pushY, physics.PLAYER_RADIUS, physics.ARENA_HEIGHT - physics.PLAYER_RADIUS);
  }
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Complete tutorial
 */
function completeTutorial(tutorial) {
  tutorial.status = 'complete';
  clearInterval(tutorial.gameLoopInterval);

  sendTutorialComplete(tutorial);
  console.log(`[TUTORIAL] Completed for user ${tutorial.userId}`);

  setTimeout(() => {
    activeTutorials.delete(tutorial.userId);
  }, 5000);
}

/**
 * Update instruction
 */
function updateInstruction(tutorial, instruction) {
  tutorial.instruction = instruction;
}

// ============================================
// Message Sending
// ============================================

function sendTutorialSnapshot(tutorial) {
  const allPlayers = [
    {
      id: tutorial.player.id,
      role: tutorial.player.role,
      x: tutorial.player.x,
      y: tutorial.player.y,
      alive: tutorial.player.alive,
      frozen: tutorial.player.frozen,
    },
    ...tutorial.bots.filter(b => b.alive).map(b => ({
      id: b.id,
      role: b.role,
      x: b.x,
      y: b.y,
      alive: b.alive,
      frozen: b.frozen,
    })),
  ];

  const msg = JSON.stringify({
    type: 'TUTORIAL_SNAPSHOT',
    tick: tutorial.tick,
    step: tutorial.currentStep,
    players: allPlayers,
    instruction: tutorial.instruction,
    showdown: tutorial.showdown ? {
      hearts: tutorial.showdown.hearts,
      scores: tutorial.showdown.scores,
      frozen: tutorial.showdown.frozen,
    } : null,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendStepChange(tutorial) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_STEP',
    step: tutorial.currentStep,
    instruction: tutorial.instruction,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendElimination(tutorial, eliminatedId, winnerId) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_ELIMINATION',
    eliminatedId,
    winnerId,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendBounce(tutorial, a, b) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_BOUNCE',
    player1Id: a.id,
    player2Id: b.id,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendShowdownStart(tutorial) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_SHOWDOWN_START',
    freezeDuration: 3000,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendShowdownReady(tutorial) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_SHOWDOWN_READY',
    hearts: tutorial.showdown.hearts,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendHeartCaptured(tutorial, playerId, heartId, score) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_HEART_CAPTURED',
    playerId,
    heartId,
    playerScore: score,
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

function sendTutorialComplete(tutorial) {
  const msg = JSON.stringify({
    type: 'TUTORIAL_COMPLETE',
  });

  if (tutorial.ws && tutorial.ws.readyState === 1) {
    tutorial.ws.send(msg);
  }
}

// ============================================
// Input Handling
// ============================================

function processInput(userId, input) {
  const tutorial = activeTutorials.get(userId);
  if (!tutorial || tutorial.status !== 'running') return;

  if (input.sequence <= tutorial.player.lastInputSequence) return;
  tutorial.player.lastInputSequence = input.sequence;

  // Any input clears waiting state
  if (tutorial.waitingForInput && (input.dirX !== 0 || input.dirY !== 0)) {
    tutorial.waitingForInput = false;
  }

  tutorial.player.dirX = input.dirX || 0;
  tutorial.player.dirY = input.dirY || 0;
}

function endTutorial(userId) {
  const tutorial = activeTutorials.get(userId);
  if (!tutorial) return;

  tutorial.status = 'ended';
  if (tutorial.gameLoopInterval) {
    clearInterval(tutorial.gameLoopInterval);
  }

  activeTutorials.delete(userId);
  console.log(`[TUTORIAL] Ended for user ${userId}`);
}

function isInTutorial(userId) {
  return activeTutorials.has(userId);
}

function getTutorial(userId) {
  return activeTutorials.get(userId);
}

module.exports = {
  startTutorial,
  endTutorial,
  processInput,
  isInTutorial,
  getTutorial,
  TUTORIAL_STEPS,
};
