/**
 * Tutorial Module for RPS Arena Client
 * Handles the free practice mode UI and game rendering
 */

const Tutorial = (function () {
  // Tutorial state
  let active = false;
  let currentStep = null;
  let instruction = null;
  let players = [];
  let showdownState = null;
  let gameLoopId = null;
  let inputLoopId = null;
  let inputSequence = 0;

  // Canvas and context
  let canvas = null;
  let ctx = null;

  // Constants (match server)
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const PLAYER_RADIUS = 22;
  const HEART_RADIUS = 25;

  // Colors
  const COLORS = {
    rock: '#FFA500',
    paper: '#1E90FF',
    scissors: '#2ECC71',
    background: '#FFFFFF',
    heart: '#FF1493',
  };

  // Direction state for keyboard input
  let direction = { dx: 0, dy: 0 };
  let keysPressed = {};

  // Client-side prediction state
  let predictedX = 0;
  let predictedY = 0;
  let lastFrameTime = 0;
  const MAX_SPEED = 450; // Must match server physics

  /**
   * Initialize the tutorial
   */
  function init() {
    // Setup keyboard listeners
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Setup network listeners for tutorial messages
    Network.addEventListener('TUTORIAL_START', handleTutorialStart);
    Network.addEventListener('TUTORIAL_SNAPSHOT', handleTutorialSnapshot);
    Network.addEventListener('TUTORIAL_STEP', handleTutorialStep);
    Network.addEventListener('TUTORIAL_ELIMINATION', handleTutorialElimination);
    Network.addEventListener('TUTORIAL_SHOWDOWN_START', handleShowdownStart);
    Network.addEventListener('TUTORIAL_SHOWDOWN_READY', handleShowdownReady);
    Network.addEventListener('TUTORIAL_HEART_CAPTURED', handleHeartCaptured);
    Network.addEventListener('TUTORIAL_COMPLETE', handleTutorialComplete);

    console.log('Tutorial module initialized');
  }

  /**
   * Start the tutorial
   */
  function start() {
    console.log('Tutorial.start() called');
    // Send start tutorial message
    Network.send({
      type: 'START_TUTORIAL',
    });
    console.log('START_TUTORIAL message sent');
  }

  /**
   * End the tutorial
   */
  function end() {
    if (!active) return;

    // Send end tutorial message
    Network.send({
      type: 'END_TUTORIAL',
    });

    cleanup();

    // Return to lobby screen - UI.showScreen will be called by the button handler
  }

  /**
   * Cleanup tutorial state
   */
  function cleanup() {
    active = false;
    currentStep = null;
    instruction = null;
    players = [];
    showdownState = null;

    if (gameLoopId) {
      cancelAnimationFrame(gameLoopId);
      gameLoopId = null;
    }

    if (inputLoopId) {
      clearInterval(inputLoopId);
      inputLoopId = null;
    }

    // Reset input state
    direction = { dx: 0, dy: 0 };
    keysPressed = {};
    inputSequence = 0;

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
  // Network Event Handlers
  // ============================================

  function handleTutorialStart(data) {
    console.log('Tutorial started:', data);

    active = true;
    currentStep = data.step;
    instruction = data.instruction;

    // Initialize player state
    players = [
      { ...data.player, isLocal: true },
      ...data.bots.map(b => ({
        ...b,
        isLocal: false,
        serverX: b.x,
        serverY: b.y,
        velX: 0,
        velY: 0,
        lastSnapshotTime: performance.now(),
      })),
    ];

    // Initialize prediction position
    predictedX = data.player.x;
    predictedY = data.player.y;
    lastFrameTime = performance.now();

    // Show tutorial screen
    showTutorialScreen();

    // Start game loop
    startGameLoop();

    // Start sending input
    startInputLoop();
  }

  function handleTutorialSnapshot(data) {
    if (!active) return;

    // Update player positions
    for (const serverPlayer of data.players) {
      const localPlayer = players.find(p => p.id === serverPlayer.id);
      if (localPlayer) {
        if (localPlayer.isLocal) {
          // For local player, use same reconciliation as main game
          // Only blend if there's significant drift - otherwise trust prediction
          const dx = serverPlayer.x - predictedX;
          const dy = serverPlayer.y - predictedY;
          const drift = Math.sqrt(dx * dx + dy * dy);

          if (drift > 100) {
            // Large drift - snap immediately (teleport, lag spike, etc.)
            predictedX = serverPlayer.x;
            predictedY = serverPlayer.y;
          } else if (drift > 5) {
            // Gradual blend - same as main game's Interpolation module
            predictedX += dx * 0.15;
            predictedY += dy * 0.15;
          }
          // If drift <= 5, prediction is accurate - keep it
        } else {
          // For bots, use extrapolation like main game does for other players
          // Calculate velocity from previous SERVER position (not extrapolated position)
          const prevServerX = localPlayer.serverX !== undefined ? localPlayer.serverX : serverPlayer.x;
          const prevServerY = localPlayer.serverY !== undefined ? localPlayer.serverY : serverPlayer.y;
          localPlayer.velX = serverPlayer.x - prevServerX;
          localPlayer.velY = serverPlayer.y - prevServerY;
          localPlayer.serverX = serverPlayer.x;
          localPlayer.serverY = serverPlayer.y;
          localPlayer.lastSnapshotTime = performance.now();
          // Position will be extrapolated in render loop
        }
        localPlayer.alive = serverPlayer.alive;
        localPlayer.role = serverPlayer.role;
      } else {
        // New player (shouldn't happen in tutorial)
        players.push({ ...serverPlayer, isLocal: false });
      }
    }

    // Update instruction
    if (data.instruction) {
      instruction = data.instruction;
      updateInstructionOverlay();
    }

    // Update showdown state
    if (data.showdown) {
      showdownState = data.showdown;
    }
  }

  function handleTutorialStep(data) {
    currentStep = data.step;
    instruction = data.instruction;
    updateInstructionOverlay();

    // Reset prediction on step change - server may have repositioned player
    // The next snapshot will give us the correct position
    const localPlayer = players.find(p => p.isLocal);
    if (localPlayer) {
      predictedX = localPlayer.x;
      predictedY = localPlayer.y;
    }
  }

  function handleTutorialElimination(data) {
    console.log('Tutorial elimination:', data);

    // Mark player as eliminated
    const eliminated = players.find(p => p.id === data.eliminatedId);
    if (eliminated) {
      eliminated.alive = false;
    }

    // Show elimination effect
    showEliminationEffect(eliminated);
  }

  function handleShowdownStart(data) {
    console.log('Tutorial showdown start');

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

      if (Date.now() - startTime < data.freezeDuration) {
        requestAnimationFrame(animateText);
      }
    }

    requestAnimationFrame(animateText);
  }

  function handleShowdownReady(data) {
    console.log('Tutorial showdown ready:', data);

    if (showdownState) {
      showdownState.frozen = false;
      showdownState.showText = false;
      showdownState.hearts = data.hearts.map(h => ({ ...h, captured: false }));
    }
  }

  function handleHeartCaptured(data) {
    console.log('Tutorial heart captured:', data);

    if (!showdownState) return;

    // Mark heart as captured
    const heart = showdownState.hearts.find(h => h.id === data.heartId);
    if (heart) {
      heart.captured = true;
    }

    // Update score
    showdownState.scores[data.playerId] = data.playerScore;
  }

  function handleTutorialComplete(data) {
    console.log('Tutorial complete!');

    // Show completion message
    showCompletionScreen();
  }

  // ============================================
  // Input Handling
  // ============================================

  function handleKeyDown(e) {
    if (!active) return;

    const key = e.key.toLowerCase();
    if (keysPressed[key]) return; // Already pressed

    keysPressed[key] = true;
    updateDirection();
  }

  function handleKeyUp(e) {
    if (!active) return;

    const key = e.key.toLowerCase();
    keysPressed[key] = false;
    updateDirection();
  }

  function updateDirection() {
    let dx = 0;
    let dy = 0;

    // WASD
    if (keysPressed['w'] || keysPressed['arrowup']) dy -= 1;
    if (keysPressed['s'] || keysPressed['arrowdown']) dy += 1;
    if (keysPressed['a'] || keysPressed['arrowleft']) dx -= 1;
    if (keysPressed['d'] || keysPressed['arrowright']) dx += 1;

    direction = { dx, dy };
  }

  function startInputLoop() {
    // Clear any existing input loop
    if (inputLoopId) {
      clearInterval(inputLoopId);
    }

    // Send input at 60Hz
    inputLoopId = setInterval(() => {
      if (!active) return;

      inputSequence++;
      Network.send({
        type: 'TUTORIAL_INPUT',
        dirX: direction.dx,
        dirY: direction.dy,
        sequence: inputSequence,
      });
    }, 1000 / 60);
  }

  // ============================================
  // Rendering
  // ============================================

  function showTutorialScreen() {
    // Hide other screens
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));

    // Show tutorial screen
    const tutorialScreen = document.getElementById('tutorial-screen');
    tutorialScreen.classList.remove('hidden');

    // Get canvas
    canvas = document.getElementById('tutorial-canvas');
    ctx = canvas.getContext('2d');

    // Resize canvas
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Update instruction overlay
    updateInstructionOverlay();
  }

  function resizeCanvas() {
    if (!canvas) return;

    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // Fit to container while maintaining aspect ratio
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

  function startGameLoop() {
    let animationFrame = 0;
    const SNAPSHOT_INTERVAL = 67; // 15 Hz = ~67ms (server sends every 2 ticks at 30Hz)

    function loop() {
      if (!active) return;

      const now = performance.now();
      let deltaTime = (now - lastFrameTime) / 1000; // seconds
      lastFrameTime = now;

      // Cap delta time to prevent huge jumps (e.g., on first frame or after tab switch)
      if (deltaTime > 0.1) deltaTime = 0.016; // Cap at ~60fps frame time

      // Client-side prediction for local player movement
      const localPlayer = players.find(p => p.isLocal);
      if (localPlayer && localPlayer.alive && (direction.dx !== 0 || direction.dy !== 0)) {
        // Normalize diagonal movement
        let moveX = direction.dx;
        let moveY = direction.dy;
        if (direction.dx !== 0 && direction.dy !== 0) {
          const diagonalFactor = 1 / Math.sqrt(2);
          moveX *= diagonalFactor;
          moveY *= diagonalFactor;
        }

        // Apply movement with frame-rate independence
        predictedX += moveX * MAX_SPEED * deltaTime;
        predictedY += moveY * MAX_SPEED * deltaTime;

        // Clamp to arena bounds
        predictedX = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, predictedX));
        predictedY = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, predictedY));
      }

      // Update local player position for rendering
      if (localPlayer) {
        localPlayer.x = predictedX;
        localPlayer.y = predictedY;
      }

      // Extrapolate bot positions for smooth movement between snapshots
      for (const player of players) {
        if (!player.isLocal && player.serverX !== undefined) {
          const elapsed = now - (player.lastSnapshotTime || now);
          const t = Math.min(elapsed / SNAPSHOT_INTERVAL, 1.5); // Cap extrapolation
          player.x = player.serverX + (player.velX || 0) * t;
          player.y = player.serverY + (player.velY || 0) * t;
        }
      }

      animationFrame++;
      render(animationFrame);
      gameLoopId = requestAnimationFrame(loop);
    }

    loop();
  }

  function render(animationFrame) {
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Draw showdown hearts
    if (showdownState && showdownState.hearts) {
      drawHearts(showdownState.hearts, animationFrame);
    }

    // Draw players
    for (const player of players) {
      if (player.alive) {
        drawPlayer(player, animationFrame);
      }
    }

    // Draw showdown text
    if (showdownState && showdownState.showText) {
      drawShowdownText(showdownState.textProgress);
    }

    // Draw showdown scores
    if (showdownState && showdownState.scores && Object.keys(showdownState.scores).length > 0) {
      drawShowdownScores();
    }
  }

  function drawPlayer(player, animationFrame) {
    const { x, y, role, isLocal } = player;
    const time = animationFrame / 60;

    ctx.save();
    ctx.translate(x, y);

    // Highlight local player
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

    // Draw shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.ellipse(3, 5, PLAYER_RADIUS, PLAYER_RADIUS * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw main circle
    ctx.fillStyle = COLORS[role];
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Draw border
    ctx.strokeStyle = isLocal ? '#000000' : 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = isLocal ? 3 : 1;
    ctx.stroke();

    // Draw role icon
    drawRoleIcon(role, time);

    // Draw "YOU" label for local player
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

    // Left blade
    ctx.save();
    ctx.rotate(-0.3 - snip);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.restore();

    // Right blade
    ctx.save();
    ctx.rotate(0.3 + snip);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.restore();

    // Handle circles
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

      // Pulse
      const pulse = 1 + Math.sin(time * 4) * 0.1;
      ctx.scale(pulse, pulse);

      // Glow
      ctx.shadowColor = COLORS.heart;
      ctx.shadowBlur = 15;

      ctx.fillStyle = COLORS.heart;
      ctx.beginPath();

      // Heart shape
      const s = HEART_RADIUS * 0.6;
      ctx.moveTo(0, s * 0.3);
      ctx.bezierCurveTo(-s, -s * 0.5, -s, s * 0.3, 0, s);
      ctx.bezierCurveTo(s, s * 0.3, s, -s * 0.5, 0, s * 0.3);
      ctx.closePath();
      ctx.fill();

      // Highlight
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.beginPath();
      ctx.ellipse(-s * 0.3, -s * 0.1, s * 0.15, s * 0.2, -0.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawShowdownText(progress) {
    ctx.save();

    // Overlay
    ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * progress})`;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Scale
    const scale = 0.5 + progress * 0.5;
    ctx.translate(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
    ctx.scale(scale, scale);

    // Shadow
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 5;

    // Text
    ctx.fillStyle = '#CC0000';
    ctx.font = 'bold 120px Impact, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SHOWDOWN', 0, -40);

    ctx.strokeStyle = '#880000';
    ctx.lineWidth = 3;
    ctx.strokeText('SHOWDOWN', 0, -40);

    // Subtitle
    ctx.shadowBlur = 10;
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = '#FF69B4';
    ctx.fillText('Collect 2 hearts to win!', 0, 55);

    ctx.restore();
  }

  function drawShowdownScores() {
    if (!showdownState || !showdownState.scores) return;

    ctx.save();

    const barHeight = 40;
    const barWidth = 200;
    const padding = 20;

    const alivePlayers = players.filter(p => p.alive);

    alivePlayers.forEach((player, index) => {
      const score = showdownState.scores[player.id] || 0;
      const x = index === 0 ? padding : ARENA_WIDTH - barWidth - padding;
      const y = padding;

      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(x, y, barWidth, barHeight);

      // Color indicator
      ctx.fillStyle = COLORS[player.role];
      ctx.fillRect(x, y, 5, barHeight);

      // Hearts
      for (let i = 0; i < 2; i++) {
        const heartX = x + 30 + i * 50;
        const heartY = y + barHeight / 2;

        if (i < score) {
          // Filled heart
          ctx.fillStyle = COLORS.heart;
          ctx.shadowColor = COLORS.heart;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          const hs = 8;
          ctx.moveTo(heartX, heartY + hs * 0.3);
          ctx.bezierCurveTo(heartX - hs, heartY - hs * 0.5, heartX - hs, heartY + hs * 0.3, heartX, heartY + hs);
          ctx.bezierCurveTo(heartX + hs, heartY + hs * 0.3, heartX + hs, heartY - hs * 0.5, heartX, heartY + hs * 0.3);
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          // Empty heart outline
          ctx.strokeStyle = COLORS.heart;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.3;
          ctx.beginPath();
          ctx.arc(heartX, heartY, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // Label
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = index === 0 ? 'left' : 'right';
      ctx.fillText(
        player.isLocal ? 'YOU' : player.role.toUpperCase(),
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

  function showEliminationEffect(player) {
    if (!player) return;
    // Could add visual/audio effect here
    console.log(`Player ${player.id} eliminated!`);
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

// Initialize on load - defer to ensure Network module is available
document.addEventListener('DOMContentLoaded', () => {
  // Small delay to ensure all modules are loaded
  setTimeout(() => {
    if (typeof Network !== 'undefined') {
      Tutorial.init();
    } else {
      console.warn('Tutorial: Network module not available');
    }
  }, 100);
});
