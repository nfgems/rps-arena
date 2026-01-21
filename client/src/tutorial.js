/**
 * Tutorial Module for RPS Arena Client
 * Runs entirely client-side for lag-free practice mode
 */

const Tutorial = (function () {
  // Tutorial state
  let active = false;
  let currentStep = null;
  let instruction = null;
  let players = [];
  let showdownState = null;
  let gameLoopId = null;
  let lastFrameTime = 0;

  // Canvas and context
  let canvas = null;
  let ctx = null;

  // Constants (match server)
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const PLAYER_RADIUS = 22;
  const HEART_RADIUS = 25;
  const MAX_SPEED = 450;
  const TICK_RATE = 30;

  // Colors
  const COLORS = {
    rock: '#FFA500',
    paper: '#1E90FF',
    scissors: '#2ECC71',
    background: '#FFFFFF',
    heart: '#FF1493',
  };

  // Direction state for keyboard input
  let keysPressed = {};

  // Tutorial progression
  const TUTORIAL_STEPS = {
    INTRO: 'intro',
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

  // Step instructions
  const STEP_INSTRUCTIONS = {
    [TUTORIAL_STEPS.INTRO]: {
      title: 'Welcome to RPS Arena!',
      text: 'You are ROCK (orange). Rock beats SCISSORS (green). But PAPER (blue) beats you!',
      subtext: 'Chase GREEN, avoid BLUE. Press any movement key (WASD or Arrow Keys) to begin.',
    },
    [TUTORIAL_STEPS.MOVEMENT]: {
      title: 'Movement Controls',
      text: 'Use WASD or Arrow Keys to move. All players move at the same speed.',
      subtext: 'Move around the arena to get comfortable. Reach any edge to continue.',
    },
    [TUTORIAL_STEPS.CHASE_TARGET]: {
      title: 'Chase Your Target',
      text: 'You are ROCK. You beat SCISSORS! The green player is your target.',
      subtext: 'Chase down the SCISSORS (green) player and collide with them!',
    },
    [TUTORIAL_STEPS.ELIMINATION]: {
      title: 'Elimination!',
      text: "You eliminated SCISSORS! When you collide with a player you beat, they're instantly out.",
      subtext: 'Now only 2 players remain... watch what happens next!',
    },
    [TUTORIAL_STEPS.BEING_HUNTED]: {
      title: "Now You're the Prey!",
      text: "Now let's see the other side. PAPER (blue) beats ROCK - they're hunting YOU!",
      subtext: 'Let them catch you to see what elimination feels like.',
    },
    [TUTORIAL_STEPS.BEING_ELIMINATED]: {
      title: 'You Were Eliminated!',
      text: 'This is what happens when someone who beats your role catches you.',
      subtext: "Now let's learn about SHOWDOWN mode...",
    },
    [TUTORIAL_STEPS.SHOWDOWN_INTRO]: {
      title: 'Showdown Mode!',
      text: 'When only 2 players remain, SHOWDOWN begins! Both players freeze for 3 seconds.',
      subtext: 'Get ready for the showdown...',
    },
    [TUTORIAL_STEPS.SHOWDOWN_FREEZE]: {
      title: 'SHOWDOWN',
      text: "You're frozen! In 3 seconds, hearts will appear. First to collect 2 wins!",
      subtext: 'In showdown, collisions only cause bounces - no eliminations possible.',
    },
    [TUTORIAL_STEPS.HEART_COLLECTION]: {
      title: 'Collect Hearts!',
      text: 'Race to collect 2 hearts! Move directly into a heart to grab it.',
      subtext: 'You need 2 hearts to win. The opponent is also collecting!',
    },
    [TUTORIAL_STEPS.COMPLETE]: {
      title: 'Tutorial Complete!',
      text: 'You now understand all the core mechanics of RPS Arena!',
      subtext: 'Join a real lobby to compete for USDC prizes!',
    },
  };

  // Local game state
  let tick = 0;
  let stepStartTick = 0;
  let waitingForInput = true;
  let player = null;
  let bots = [];
  let movementHistory = null;
  let heartsCollectedByPlayer = 0;
  let heartCollectionComplete = false;

  /**
   * Initialize the tutorial
   */
  function init() {
    // Setup keyboard listeners
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    console.log('Tutorial module initialized (local mode)');
  }

  /**
   * Start the tutorial
   */
  function start() {
    console.log('Tutorial.start() called (local mode)');

    // Initialize local state
    active = true;
    tick = 0;
    stepStartTick = 0;
    waitingForInput = true;
    currentStep = TUTORIAL_STEPS.INTRO;
    instruction = STEP_INSTRUCTIONS[TUTORIAL_STEPS.INTRO];
    heartsCollectedByPlayer = 0;
    heartCollectionComplete = false;
    showdownState = null;

    // Initialize player (always rock)
    player = {
      id: 'local_player',
      role: 'rock',
      x: 400,
      y: 450,
      alive: true,
      frozen: false,
      dirX: 0,
      dirY: 0,
      isLocal: true,
    };

    // Initialize bots
    bots = [
      {
        id: 'tutorial_bot_scissors',
        username: 'Scissors Bot',
        role: 'scissors',
        x: 1200,
        y: 450,
        alive: true,
        frozen: false,
        behavior: BOT_BEHAVIOR.IDLE,
        targetX: 1200,
        targetY: 450,
        isLocal: false,
      },
      {
        id: 'tutorial_bot_paper',
        username: 'Paper Bot',
        role: 'paper',
        x: 800,
        y: 200,
        alive: true,
        frozen: false,
        behavior: BOT_BEHAVIOR.IDLE,
        targetX: 800,
        targetY: 200,
        isLocal: false,
      },
    ];

    // Build players array for rendering
    players = [player, ...bots];

    // Movement tracking
    movementHistory = {
      startX: 400,
      startY: 450,
      maxDistFromStart: 0,
      reachedEdge: false,
    };

    // Show tutorial screen
    showTutorialScreen();

    // Start game loop
    startGameLoop();
  }

  /**
   * End the tutorial
   */
  function end() {
    if (!active) return;
    cleanup();
  }

  /**
   * Cleanup tutorial state
   */
  function cleanup() {
    active = false;
    currentStep = null;
    instruction = null;
    players = [];
    player = null;
    bots = [];
    showdownState = null;

    if (gameLoopId) {
      cancelAnimationFrame(gameLoopId);
      gameLoopId = null;
    }

    // Reset input state
    keysPressed = {};

    // Hide tutorial complete overlay if visible
    const completeOverlay = document.getElementById('tutorial-complete-overlay');
    if (completeOverlay) {
      completeOverlay.classList.add('hidden');
    }

    // Clear canvas
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Remove resize listener
    window.removeEventListener('resize', resizeCanvas);
  }

  // ============================================
  // Input Handling
  // ============================================

  function handleKeyDown(e) {
    if (!active) return;

    const key = e.key.toLowerCase();
    if (keysPressed[key]) return;

    keysPressed[key] = true;
    updateDirection();

    // Any movement input clears waiting state
    if (waitingForInput && (player.dirX !== 0 || player.dirY !== 0)) {
      waitingForInput = false;
    }
  }

  function handleKeyUp(e) {
    if (!active) return;

    const key = e.key.toLowerCase();
    keysPressed[key] = false;
    updateDirection();
  }

  function updateDirection() {
    if (!player || player.frozen) return;

    let dx = 0;
    let dy = 0;

    if (keysPressed['w'] || keysPressed['arrowup']) dy -= 1;
    if (keysPressed['s'] || keysPressed['arrowdown']) dy += 1;
    if (keysPressed['a'] || keysPressed['arrowleft']) dx -= 1;
    if (keysPressed['d'] || keysPressed['arrowright']) dx += 1;

    player.dirX = dx;
    player.dirY = dy;
  }

  // ============================================
  // Game Loop (runs locally)
  // ============================================

  function startGameLoop() {
    lastFrameTime = performance.now();
    let accumulator = 0;
    const tickInterval = 1000 / TICK_RATE;
    let animationFrame = 0;

    function loop() {
      if (!active) return;

      const now = performance.now();
      let deltaTime = now - lastFrameTime;
      lastFrameTime = now;

      // Cap delta time
      if (deltaTime > 100) deltaTime = tickInterval;

      accumulator += deltaTime;

      // Fixed timestep for game logic
      while (accumulator >= tickInterval) {
        processTick();
        accumulator -= tickInterval;
      }

      // Render at display refresh rate
      animationFrame++;
      render(animationFrame);
      gameLoopId = requestAnimationFrame(loop);
    }

    loop();
  }

  function processTick() {
    tick++;

    // Process player movement
    if (player.alive && !player.frozen && !waitingForInput) {
      moveEntity(player);

      // Track movement for step progression
      const dx = player.x - movementHistory.startX;
      const dy = player.y - movementHistory.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      movementHistory.maxDistFromStart = Math.max(movementHistory.maxDistFromStart, dist);

      if (
        player.x < 50 ||
        player.x > ARENA_WIDTH - 50 ||
        player.y < 50 ||
        player.y > ARENA_HEIGHT - 50
      ) {
        movementHistory.reachedEdge = true;
      }
    }

    // Process bot movement
    for (const bot of bots) {
      if (bot.alive && !bot.frozen) {
        processBotBehavior(bot);
      }
    }

    // Process step logic
    processStepLogic();

    // Process collisions
    processCollisions();

    // Process heart collection
    if (showdownState && !showdownState.frozen) {
      processHearts();
    }

    // Update players array for rendering
    players = [player, ...bots];
  }

  function moveEntity(entity) {
    if (entity.dirX === 0 && entity.dirY === 0) return;

    let moveX = entity.dirX;
    let moveY = entity.dirY;

    // Normalize diagonal
    if (entity.dirX !== 0 && entity.dirY !== 0) {
      const factor = 1 / Math.sqrt(2);
      moveX *= factor;
      moveY *= factor;
    }

    const speed = MAX_SPEED / TICK_RATE;
    entity.x += moveX * speed;
    entity.y += moveY * speed;

    // Clamp to arena
    entity.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, entity.x));
    entity.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, entity.y));
  }

  // ============================================
  // Bot AI
  // ============================================

  function processBotBehavior(bot) {
    switch (bot.behavior) {
      case BOT_BEHAVIOR.IDLE:
        break;

      case BOT_BEHAVIOR.WANDER_SLOW:
        if (tick % 90 === 0) {
          bot.targetX = 200 + Math.random() * (ARENA_WIDTH - 400);
          bot.targetY = 200 + Math.random() * (ARENA_HEIGHT - 400);
        }
        moveTowardTarget(bot, bot.targetX, bot.targetY, 0.2);
        break;

      case BOT_BEHAVIOR.FLEE_SLOW:
        fleeFromPlayer(bot, player, 0.4);
        break;

      case BOT_BEHAVIOR.FLEE_MEDIUM:
        const awayTgt = getAwayDirection(bot, player);
        bot.targetX = awayTgt.x;
        bot.targetY = awayTgt.y;
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
        const distToPlayer = getDistance(bot, player);
        if (distToPlayer > 100) {
          moveTowardTarget(bot, player.x, player.y, 0.3);
        }
        break;

      case BOT_BEHAVIOR.COLLECT_HEARTS:
        if (showdownState && showdownState.hearts) {
          const target = showdownState.hearts.find(h => !h.captured);
          if (target) {
            moveTowardTarget(bot, target.x, target.y, 0.3);
          }
        }
        break;

      case BOT_BEHAVIOR.WAIT:
        break;
    }
  }

  function fleeFromPlayer(bot, target, speedMultiplier) {
    const dx = bot.x - target.x;
    const dy = bot.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    // Stay still if player is far away
    const fleeRadius = 400;
    if (dist > fleeRadius) {
      return;
    }

    // Flee direction (away from player)
    let fleeX = dx / dist;
    let fleeY = dy / dist;

    // Check where fleeing would take us
    const edgeBuffer = 150;
    const futureX = bot.x + fleeX * 100;
    const futureY = bot.y + fleeY * 100;

    // If fleeing would hit an edge, redirect along the edge instead
    const wouldHitLeft = futureX < edgeBuffer;
    const wouldHitRight = futureX > ARENA_WIDTH - edgeBuffer;
    const wouldHitTop = futureY < edgeBuffer;
    const wouldHitBottom = futureY > ARENA_HEIGHT - edgeBuffer;

    if (wouldHitLeft || wouldHitRight) {
      // Redirect vertically - go toward whichever vertical direction has more room
      fleeX = 0;
      fleeY = bot.y < ARENA_HEIGHT / 2 ? 1 : -1;
    }
    if (wouldHitTop || wouldHitBottom) {
      // Redirect horizontally - go toward whichever horizontal direction has more room
      fleeY = 0;
      fleeX = bot.x < ARENA_WIDTH / 2 ? 1 : -1;
    }

    // Normalize
    const moveDist = Math.sqrt(fleeX * fleeX + fleeY * fleeY) || 1;
    fleeX /= moveDist;
    fleeY /= moveDist;

    // Apply movement
    const maxSpeed = (MAX_SPEED / TICK_RATE) * speedMultiplier;
    bot.x += fleeX * maxSpeed;
    bot.y += fleeY * maxSpeed;

    // Clamp to arena bounds
    bot.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, bot.x));
    bot.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, bot.y));
  }

  function getAwayDirection(from, target) {
    const dx = from.x - target.x;
    const dy = from.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    const minX = 200;
    const maxX = ARENA_WIDTH - 200;
    const minY = 150;
    const maxY = ARENA_HEIGHT - 150;

    let fleeX = from.x + (dx / dist) * 200;
    let fleeY = from.y + (dy / dist) * 200;

    return {
      x: Math.max(minX, Math.min(maxX, fleeX)),
      y: Math.max(minY, Math.min(maxY, fleeY)),
    };
  }

  function moveTowardTarget(bot, targetX, targetY, speedMultiplier) {
    const dx = targetX - bot.x;
    const dy = targetY - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 3) return;

    const maxSpeed = (MAX_SPEED / TICK_RATE) * speedMultiplier;
    const moveX = (dx / dist) * Math.min(maxSpeed, dist);
    const moveY = (dy / dist) * Math.min(maxSpeed, dist);

    bot.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, bot.x + moveX));
    bot.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, bot.y + moveY));
  }

  function getDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ============================================
  // Step Progression
  // ============================================

  function processStepLogic() {
    const ticksInStep = tick - stepStartTick;

    switch (currentStep) {
      case TUTORIAL_STEPS.INTRO:
        if (!waitingForInput) {
          advanceToStep(TUTORIAL_STEPS.MOVEMENT);
        }
        break;

      case TUTORIAL_STEPS.MOVEMENT:
        if (movementHistory.reachedEdge && movementHistory.maxDistFromStart > 200) {
          advanceToStep(TUTORIAL_STEPS.CHASE_TARGET);
        }
        break;

      case TUTORIAL_STEPS.CHASE_TARGET:
        if (ticksInStep === 1) {
          setupChaseTarget();
        }
        break;

      case TUTORIAL_STEPS.ELIMINATION:
        if (ticksInStep >= 60) {
          advanceToStep(TUTORIAL_STEPS.BEING_HUNTED);
        }
        break;

      case TUTORIAL_STEPS.BEING_HUNTED:
        if (ticksInStep === 1) {
          setupBeingHunted();
        }
        break;

      case TUTORIAL_STEPS.BEING_ELIMINATED:
        if (ticksInStep >= 60) {
          advanceToStep(TUTORIAL_STEPS.SHOWDOWN_INTRO);
        }
        break;

      case TUTORIAL_STEPS.SHOWDOWN_INTRO:
        if (ticksInStep === 1) {
          setupShowdownIntro();
        }
        if (ticksInStep >= 60) {
          advanceToStep(TUTORIAL_STEPS.SHOWDOWN_FREEZE);
        }
        break;

      case TUTORIAL_STEPS.SHOWDOWN_FREEZE:
        if (ticksInStep === 1) {
          setupShowdownFreeze();
        }
        if (ticksInStep >= 90) {
          advanceToStep(TUTORIAL_STEPS.HEART_COLLECTION);
        }
        break;

      case TUTORIAL_STEPS.HEART_COLLECTION:
        if (ticksInStep === 1) {
          setupHeartCollection();
        }
        const anyoneWon =
          heartsCollectedByPlayer >= 2 ||
          (showdownState &&
            showdownState.scores &&
            Object.values(showdownState.scores).some(score => score >= 2));

        if (anyoneWon && !heartCollectionComplete) {
          heartCollectionComplete = true;
          setTimeout(() => {
            if (active) {
              advanceToStep(TUTORIAL_STEPS.COMPLETE);
            }
          }, 1500);
        }
        break;

      case TUTORIAL_STEPS.COMPLETE:
        if (ticksInStep === 1) {
          showCompletionScreen();
        }
        break;
    }
  }

  function advanceToStep(newStep) {
    currentStep = newStep;
    stepStartTick = tick;
    waitingForInput = false;

    if ([TUTORIAL_STEPS.INTRO, TUTORIAL_STEPS.BEING_ELIMINATED].includes(newStep)) {
      waitingForInput = true;
    }

    instruction = STEP_INSTRUCTIONS[newStep];
    updateInstructionOverlay();
    console.log(`[TUTORIAL] Advanced to step: ${newStep}`);
  }

  // ============================================
  // Step Setup Functions
  // ============================================

  function setupChaseTarget() {
    const scissorsBot = bots.find(b => b.role === 'scissors');
    scissorsBot.alive = true;
    scissorsBot.x = ARENA_WIDTH - 200;
    scissorsBot.y = ARENA_HEIGHT / 2;
    scissorsBot.behavior = BOT_BEHAVIOR.FLEE_SLOW;

    const paperBot = bots.find(b => b.role === 'paper');
    if (paperBot) paperBot.alive = false;

    player.x = 200;
    player.y = ARENA_HEIGHT / 2;

    instruction = STEP_INSTRUCTIONS[TUTORIAL_STEPS.CHASE_TARGET];
    updateInstructionOverlay();
  }

  function setupBeingHunted() {
    showdownState = null;
    heartsCollectedByPlayer = 0;
    player.alive = true;
    player.frozen = false;
    player.x = ARENA_WIDTH - 200;
    player.y = ARENA_HEIGHT / 2;

    const paperBot = bots.find(b => b.role === 'paper');
    paperBot.alive = true;
    paperBot.frozen = false;
    paperBot.x = 200;
    paperBot.y = ARENA_HEIGHT / 2;
    paperBot.behavior = BOT_BEHAVIOR.CHASE_MEDIUM;

    const scissorsBot = bots.find(b => b.role === 'scissors');
    if (scissorsBot) scissorsBot.alive = false;

    instruction = STEP_INSTRUCTIONS[TUTORIAL_STEPS.BEING_HUNTED];
    updateInstructionOverlay();
  }

  function setupShowdownIntro() {
    player.alive = true;
    player.frozen = false;
    player.x = 300;
    player.y = ARENA_HEIGHT / 2;

    const paperBot = bots.find(b => b.role === 'paper');
    paperBot.alive = true;
    paperBot.frozen = false;
    paperBot.x = ARENA_WIDTH - 300;
    paperBot.y = ARENA_HEIGHT / 2;
    paperBot.behavior = BOT_BEHAVIOR.WAIT;

    const scissorsBot = bots.find(b => b.role === 'scissors');
    if (scissorsBot) scissorsBot.alive = false;

    instruction = STEP_INSTRUCTIONS[TUTORIAL_STEPS.SHOWDOWN_INTRO];
    updateInstructionOverlay();
  }

  function setupShowdownFreeze() {
    player.frozen = true;
    player.dirX = 0;
    player.dirY = 0;

    const paperBot = bots.find(b => b.role === 'paper');
    paperBot.frozen = true;

    showdownState = {
      frozen: true,
      hearts: [],
      scores: {},
      showText: true,
      textProgress: 0,
    };

    // Animate showdown text
    const startTime = Date.now();
    const animDuration = 500;

    function animateText() {
      if (!showdownState || !showdownState.showText) return;
      showdownState.textProgress = Math.min(1, (Date.now() - startTime) / animDuration);
      if (Date.now() - startTime < 3000) {
        requestAnimationFrame(animateText);
      }
    }
    requestAnimationFrame(animateText);

    instruction = STEP_INSTRUCTIONS[TUTORIAL_STEPS.SHOWDOWN_FREEZE];
    updateInstructionOverlay();
  }

  function setupHeartCollection() {
    player.frozen = false;

    const paperBot = bots.find(b => b.role === 'paper');
    paperBot.frozen = false;
    paperBot.behavior = BOT_BEHAVIOR.COLLECT_HEARTS;

    showdownState = {
      frozen: false,
      showText: false,
      hearts: [
        { id: 'heart_1', x: 400, y: 300, captured: false },
        { id: 'heart_2', x: 800, y: 600, captured: false },
        { id: 'heart_3', x: 1200, y: 300, captured: false },
      ],
      scores: {},
    };

    instruction = STEP_INSTRUCTIONS[TUTORIAL_STEPS.HEART_COLLECTION];
    updateInstructionOverlay();
  }

  // ============================================
  // Collisions
  // ============================================

  function processCollisions() {
    if (!player.alive) return;

    for (const bot of bots) {
      if (!bot.alive) continue;

      const dist = getDistance(player, bot);
      if (dist <= PLAYER_RADIUS * 2) {
        // In showdown, bounce instead of eliminate
        if (showdownState) {
          bounceApart(player, bot);
          continue;
        }

        const result = getRpsResult(player.role, bot.role);

        if (result === 'win') {
          bot.alive = false;
          showEliminationEffect(bot);

          if (currentStep === TUTORIAL_STEPS.CHASE_TARGET) {
            advanceToStep(TUTORIAL_STEPS.ELIMINATION);
          }
        } else if (result === 'lose') {
          player.alive = false;
          showEliminationEffect(player);

          if (currentStep === TUTORIAL_STEPS.BEING_HUNTED) {
            setTimeout(() => {
              if (active) {
                advanceToStep(TUTORIAL_STEPS.BEING_ELIMINATED);
              }
            }, 500);
          }
        }
      }
    }
  }

  function getRpsResult(role1, role2) {
    if (role1 === role2) return 'tie';
    const wins = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
    return wins[role1] === role2 ? 'win' : 'lose';
  }

  function bounceApart(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    const overlap = PLAYER_RADIUS * 2 - dist;
    if (overlap > 0) {
      const pushX = (dx / dist) * (overlap / 2 + 10);
      const pushY = (dy / dist) * (overlap / 2 + 10);

      a.x = clamp(a.x + pushX, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
      a.y = clamp(a.y + pushY, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
      b.x = clamp(b.x - pushX, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
      b.y = clamp(b.y - pushY, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
    }
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // ============================================
  // Hearts
  // ============================================

  function processHearts() {
    if (!showdownState || !showdownState.hearts) return;

    const entities = [player, ...bots.filter(b => b.alive)];

    for (const heart of showdownState.hearts) {
      if (heart.captured) continue;

      for (const entity of entities) {
        const dist = getDistance(entity, heart);
        if (dist <= PLAYER_RADIUS + HEART_RADIUS) {
          heart.captured = true;

          if (!showdownState.scores[entity.id]) {
            showdownState.scores[entity.id] = 0;
          }
          showdownState.scores[entity.id]++;

          if (entity.id === player.id) {
            heartsCollectedByPlayer++;
          }
          break;
        }
      }
    }
  }

  // ============================================
  // Rendering
  // ============================================

  function showTutorialScreen() {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));

    const tutorialScreen = document.getElementById('tutorial-screen');
    tutorialScreen.classList.remove('hidden');

    document.body.classList.add('hide-footer');

    canvas = document.getElementById('tutorial-canvas');
    ctx = canvas.getContext('2d');

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    updateInstructionOverlay();
  }

  function resizeCanvas() {
    if (!canvas) return;

    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const arenaAspect = ARENA_WIDTH / ARENA_HEIGHT;
    const containerAspect = containerWidth / containerHeight;

    let width, height;
    if (containerAspect > arenaAspect) {
      height = containerHeight;
      width = height * arenaAspect;
    } else {
      width = containerWidth;
      height = width / arenaAspect;
    }

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = ARENA_WIDTH;
    canvas.height = ARENA_HEIGHT;
  }

  function render(animationFrame) {
    if (!ctx) return;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Draw hearts
    if (showdownState && showdownState.hearts) {
      drawHearts(showdownState.hearts, animationFrame);
    }

    // Draw players
    for (const p of players) {
      if (p.alive) {
        drawPlayer(p, animationFrame);
      }
    }

    // Draw showdown text
    if (showdownState && showdownState.showText) {
      drawShowdownText(showdownState.textProgress, animationFrame);
    }

    // Draw showdown scores
    if (showdownState && showdownState.scores && Object.keys(showdownState.scores).length > 0) {
      drawShowdownScores();
    }
  }

  function drawPlayer(p, animationFrame) {
    const { x, y, role, isLocal } = p;
    const time = animationFrame / 60;

    ctx.save();
    ctx.translate(x, y);

    if (isLocal) {
      const pulseScale = 1 + Math.sin(time * 5) * 0.1;
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS * pulseScale + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.ellipse(3, 5, PLAYER_RADIUS, PLAYER_RADIUS * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLORS[role];
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = isLocal ? '#000000' : 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = isLocal ? 3 : 1;
    ctx.stroke();

    drawRoleIcon(role, time);

    if (isLocal) {
      ctx.fillStyle = '#e94560';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', 0, -PLAYER_RADIUS - 15);
    }

    ctx.restore();
  }

  function drawRoleIcon(role, time) {
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;

    switch (role) {
      case 'rock':
        drawRock(time);
        break;
      case 'paper':
        drawPaper(time);
        break;
      case 'scissors':
        drawScissors(time);
        break;
    }
  }

  function drawRock(time) {
    const wobble = Math.sin(time * 3) * 1;
    const scale = 1 + Math.sin(time * 2) * 0.05;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.arc(wobble, 0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.arc(wobble - 3, -2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPaper(time) {
    const bob = Math.sin(time * 4) * 2;
    const tilt = Math.sin(time * 2) * 0.1;

    ctx.save();
    ctx.rotate(tilt);
    ctx.translate(0, bob);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(-8, -10, 16, 20);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.lineWidth = 1;
    for (let i = -6; i <= 6; i += 4) {
      ctx.beginPath();
      ctx.moveTo(-5, i);
      ctx.lineTo(5, i);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawScissors(time) {
    const snip = Math.sin(time * 6) * 0.3;

    ctx.save();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    ctx.save();
    ctx.rotate(-0.3 - snip);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.rotate(0.3 + snip);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-4, 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(4, 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawHearts(hearts, animationFrame) {
    const time = animationFrame / 60;

    for (const heart of hearts) {
      if (heart.captured) continue;

      ctx.save();
      ctx.translate(heart.x, heart.y);

      const pulse = 1 + Math.sin(time * 4) * 0.1;
      ctx.scale(pulse, pulse);

      ctx.shadowColor = COLORS.heart;
      ctx.shadowBlur = 15;

      ctx.fillStyle = COLORS.heart;
      ctx.beginPath();

      const s = HEART_RADIUS * 0.6;
      ctx.moveTo(0, s * 0.3);
      ctx.bezierCurveTo(-s, -s * 0.5, -s, s * 0.3, 0, s);
      ctx.bezierCurveTo(s, s * 0.3, s, -s * 0.5, 0, s * 0.3);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.beginPath();
      ctx.ellipse(-s * 0.3, -s * 0.1, s * 0.15, s * 0.2, -0.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawShowdownText(progress, animationFrame) {
    ctx.save();

    ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * progress})`;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    const scale = 0.5 + progress * 0.5;
    ctx.translate(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
    ctx.scale(scale, scale);

    const shake = (1 - progress) * 10;
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 5;

    ctx.fillStyle = '#CC0000';
    ctx.font = 'bold 120px Impact, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SHOWDOWN', 0, -40);

    ctx.strokeStyle = '#880000';
    ctx.lineWidth = 3;
    ctx.strokeText('SHOWDOWN', 0, -40);

    const time = animationFrame / 60;
    const sparkle = 0.7 + 0.3 * Math.sin(time * 8);
    const hue = 330 + 20 * Math.sin(time * 3);

    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = 20 + 10 * Math.sin(time * 6);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.font = 'bold 30px "Comic Sans MS", "Marker Felt", cursive';
    ctx.textAlign = 'center';
    const subtitleY = 55;
    const text = 'Collect 2 hearts to win!';

    ctx.fillStyle = `hsl(${hue}, 100%, ${65 + 15 * sparkle}%)`;
    ctx.fillText(text, 0, subtitleY);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.strokeText(text, 0, subtitleY);

    const textWidth = ctx.measureText(text).width;
    const heartSize = 12;
    const heartY = subtitleY - 4;
    const heartPulse = 1 + 0.15 * Math.sin(time * 6);

    ctx.save();
    ctx.translate(-textWidth / 2 - 25, heartY);
    ctx.scale(heartPulse, heartPulse);
    drawMiniHeart(0, 0, heartSize, hue, sparkle);
    ctx.restore();

    ctx.save();
    ctx.translate(textWidth / 2 + 25, heartY);
    ctx.scale(heartPulse, heartPulse);
    drawMiniHeart(0, 0, heartSize, hue, sparkle);
    ctx.restore();

    drawSparkles(-textWidth / 2 - 40, textWidth / 2 + 40, subtitleY - 15, subtitleY + 15, time);

    ctx.restore();
  }

  function drawMiniHeart(x, y, size, hue, sparkle) {
    ctx.save();
    ctx.fillStyle = `hsl(${hue}, 100%, ${65 + 15 * sparkle}%)`;
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.3);
    ctx.bezierCurveTo(x, y, x - size, y, x - size, y + size * 0.3);
    ctx.bezierCurveTo(x - size, y + size * 0.6, x, y + size, x, y + size);
    ctx.bezierCurveTo(x, y + size, x + size, y + size * 0.6, x + size, y + size * 0.3);
    ctx.bezierCurveTo(x + size, y, x, y, x, y + size * 0.3);
    ctx.fill();
    ctx.restore();
  }

  function drawSparkles(minX, maxX, minY, maxY, time) {
    ctx.save();
    const sparkleCount = 6;
    for (let i = 0; i < sparkleCount; i++) {
      const phase = (time * 2 + i * 1.5) % 3;
      if (phase < 1) {
        const alpha = Math.sin(phase * Math.PI);
        const sparkleX = minX + ((maxX - minX) * (i + 0.5)) / sparkleCount;
        const sparkleY = minY + (maxY - minY) * (0.5 + 0.4 * Math.sin(i * 2.1));
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
        ctx.beginPath();
        ctx.arc(sparkleX, sparkleY, 2 + alpha * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawShowdownScores() {
    if (!showdownState || !showdownState.scores) return;

    ctx.save();

    const barHeight = 40;
    const barWidth = 200;
    const padding = 20;

    const alivePlayers = players.filter(p => p.alive);

    alivePlayers.forEach((p, index) => {
      const score = showdownState.scores[p.id] || 0;
      const x = index === 0 ? padding : ARENA_WIDTH - barWidth - padding;
      const y = padding;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(x, y, barWidth, barHeight);

      ctx.fillStyle = COLORS[p.role];
      ctx.fillRect(x, y, 5, barHeight);

      for (let i = 0; i < 2; i++) {
        const heartX = x + 30 + i * 50;
        const heartY = y + barHeight / 2;

        if (i < score) {
          ctx.fillStyle = COLORS.heart;
          ctx.shadowColor = COLORS.heart;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          const hs = 8;
          ctx.moveTo(heartX, heartY + hs * 0.3);
          ctx.bezierCurveTo(
            heartX - hs,
            heartY - hs * 0.5,
            heartX - hs,
            heartY + hs * 0.3,
            heartX,
            heartY + hs
          );
          ctx.bezierCurveTo(
            heartX + hs,
            heartY + hs * 0.3,
            heartX + hs,
            heartY - hs * 0.5,
            heartX,
            heartY + hs * 0.3
          );
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.strokeStyle = COLORS.heart;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.3;
          ctx.beginPath();
          ctx.arc(heartX, heartY, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = index === 0 ? 'left' : 'right';
      ctx.fillText(
        p.isLocal ? 'YOU' : p.role.toUpperCase(),
        index === 0 ? x + barWidth - 10 : x + barWidth - 5,
        y + barHeight / 2 + 5
      );
    });

    ctx.restore();
  }

  function updateInstructionOverlay() {
    if (!instruction) return;

    const titleEl = document.getElementById('tutorial-instruction-title');
    const textEl = document.getElementById('tutorial-instruction-text');
    const subtextEl = document.getElementById('tutorial-instruction-subtext');

    if (titleEl) titleEl.textContent = instruction.title || '';
    if (textEl) textEl.textContent = instruction.text || '';
    if (subtextEl) subtextEl.textContent = instruction.subtext || '';
  }

  function showEliminationEffect(entity) {
    if (!entity) return;
    console.log(`[TUTORIAL] ${entity.id} eliminated!`);
  }

  function showCompletionScreen() {
    const overlay = document.getElementById('tutorial-complete-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
    }
  }

  // Public API
  return {
    init,
    start,
    end,
    cleanup,
    isActive: () => active,
  };
})();

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  Tutorial.init();
});
