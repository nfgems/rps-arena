/**
 * Renderer for RPS Arena
 * Canvas-based game rendering
 */

const Renderer = (function () {
  // Canvas and context
  let canvas = null;
  let ctx = null;

  // Constants
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const PLAYER_RADIUS = 22;

  // Colors
  const COLORS = {
    rock: '#FFA500',
    paper: '#1E90FF',
    scissors: '#2ECC71',
    background: '#FFFFFF',
    text: '#333333',
    heart: '#FF1493', // Hot pink for showdown hearts
  };

  // Heart radius for rendering (should match server HEART_RADIUS)
  const HEART_RADIUS = 25;

  // Animation state
  let animationFrame = 0;

  /**
   * Initialize renderer with a canvas element
   * @param {HTMLCanvasElement} canvasElement - Canvas element to render to
   */
  function init(canvasElement) {
    canvas = canvasElement;
    ctx = canvas.getContext('2d');

    // Set canvas size
    resize();

    // Handle window resize
    window.addEventListener('resize', resize);

    console.log('Renderer initialized');
  }

  /**
   * Handle canvas resize
   */
  function resize() {
    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // Calculate scale to fit arena while maintaining aspect ratio
    const arenaAspect = ARENA_WIDTH / ARENA_HEIGHT;
    const containerAspect = containerWidth / containerHeight;

    let width, height;
    if (containerAspect > arenaAspect) {
      // Container is wider, fit to height
      height = containerHeight;
      width = height * arenaAspect;
    } else {
      // Container is taller, fit to width
      width = containerWidth;
      height = width / arenaAspect;
    }

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Set actual canvas resolution
    canvas.width = ARENA_WIDTH;
    canvas.height = ARENA_HEIGHT;
  }

  /**
   * Clear the canvas
   */
  function clear() {
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  }

  /**
   * Draw a player token on the canvas
   * @param {{x: number, y: number, role: string, alive: boolean, isLocal: boolean, disconnected: boolean}} player - Player data
   */
  function drawPlayer(player) {
    const { x, y, role, alive, isLocal, disconnected } = player;

    if (!alive) return;

    ctx.save();
    ctx.translate(x, y);

    // Animate based on frame
    animationFrame++;
    const time = animationFrame / 60;

    // Draw shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.ellipse(3, 5, PLAYER_RADIUS, PLAYER_RADIUS * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw main circle (faded if disconnected)
    const baseColor = COLORS[role];
    if (disconnected) {
      // Pulse opacity for disconnected players
      const alpha = 0.4 + Math.sin(time * 4) * 0.2;
      ctx.globalAlpha = alpha;
    }
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Draw border (thicker for local player)
    ctx.strokeStyle = isLocal ? '#000000' : 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = isLocal ? 3 : 1;
    ctx.stroke();

    // Draw role icon
    drawRoleIcon(role, time);

    // Draw disconnect indicator
    if (disconnected) {
      ctx.globalAlpha = 1;
      // Draw WiFi-off icon or "DC" text above player
      ctx.fillStyle = '#ff4444';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DC', 0, -PLAYER_RADIUS - 8);
    }

    ctx.restore();
  }

  /**
   * Draw role-specific icon inside the player circle
   * @param {string} role - Player role (rock, paper, scissors)
   * @param {number} time - Animation time for effects
   */
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

  /**
   * Draw rock icon (wobbling circle)
   * @param {number} time - Animation time
   */
  function drawRock(time) {
    const wobble = Math.sin(time * 3) * 1;
    const scale = 1 + Math.sin(time * 2) * 0.05;

    ctx.save();
    ctx.scale(scale, scale);

    ctx.beginPath();
    ctx.arc(wobble, 0, 10, 0, Math.PI * 2);
    ctx.fill();

    // Add some texture
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.arc(wobble - 3, -2, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw paper icon (fluttering rectangle)
   * @param {number} time - Animation time
   */
  function drawPaper(time) {
    const bob = Math.sin(time * 4) * 2;
    const tilt = Math.sin(time * 2) * 0.1;

    ctx.save();
    ctx.rotate(tilt);
    ctx.translate(0, bob);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(-8, -10, 16, 20);

    // Draw lines on paper
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

  /**
   * Draw scissors icon (snipping animation)
   * @param {number} time - Animation time
   */
  function drawScissors(time) {
    const snip = Math.sin(time * 6) * 0.3;

    ctx.save();

    // Draw two blades
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

  /**
   * Draw elimination effect (expanding red circle)
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} progress - Animation progress (0-1)
   */
  function drawElimination(x, y, progress) {
    const alpha = 1 - progress;
    const radius = PLAYER_RADIUS * (1 + progress * 2);

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw bounce effect (expanding gold circle)
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} progress - Animation progress (0-1)
   */
  function drawBounce(x, y, progress) {
    const alpha = 1 - progress;
    const radius = PLAYER_RADIUS * (1 + progress);

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw a heart shape at the specified position
   * @param {number} x - Center X position
   * @param {number} y - Center Y position
   * @param {number} size - Size of the heart
   * @param {number} time - Animation time for pulse effect
   */
  function drawHeart(x, y, size, time) {
    ctx.save();
    ctx.translate(x, y);

    // Pulse animation
    const pulse = 1 + Math.sin(time * 4) * 0.1;
    ctx.scale(pulse, pulse);

    // Glow effect
    ctx.shadowColor = COLORS.heart;
    ctx.shadowBlur = 15;

    ctx.fillStyle = COLORS.heart;
    ctx.beginPath();

    // Heart shape using bezier curves
    const s = size * 0.6; // Scale factor
    ctx.moveTo(0, s * 0.3);
    ctx.bezierCurveTo(-s, -s * 0.5, -s, s * 0.3, 0, s);
    ctx.bezierCurveTo(s, s * 0.3, s, -s * 0.5, 0, s * 0.3);
    ctx.closePath();
    ctx.fill();

    // White highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.ellipse(-s * 0.3, -s * 0.1, s * 0.15, s * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw all showdown hearts
   * @param {Array} hearts - Array of heart objects [{id, x, y, captured}, ...]
   */
  function drawHearts(hearts) {
    if (!hearts) return;

    const time = animationFrame / 60;

    for (const heart of hearts) {
      if (!heart.captured) {
        drawHeart(heart.x, heart.y, HEART_RADIUS, time);
      }
    }
  }

  /**
   * Draw the "SHOWDOWN" text with Mortal Kombat style
   * @param {number} progress - Animation progress (0-1, 0 = just started, 1 = fully visible)
   */
  function drawShowdownText(progress) {
    ctx.save();

    // Semi-transparent overlay
    ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * progress})`;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Scale in effect
    const scale = 0.5 + progress * 0.5;
    ctx.translate(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
    ctx.scale(scale, scale);

    // Shake effect (decreases as progress increases)
    const shake = (1 - progress) * 10;
    ctx.translate(
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake
    );

    // Text shadow for depth
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 5;

    // Main text - blood red like "FINISH HIM"
    ctx.fillStyle = '#CC0000';
    ctx.font = 'bold 120px Impact, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SHOWDOWN', 0, 0);

    // Outline for that gritty effect
    ctx.strokeStyle = '#880000';
    ctx.lineWidth = 3;
    ctx.strokeText('SHOWDOWN', 0, 0);

    ctx.restore();
  }

  /**
   * Draw showdown score display
   * @param {Object} scores - Player scores {playerId: score, ...}
   * @param {Array} players - Array of player objects
   * @param {string} localPlayerId - Local player's ID
   */
  function drawShowdownScores(scores, players, localPlayerId) {
    if (!scores || !players) return;

    ctx.save();

    const alivePlayers = players.filter(p => p.alive);
    const barHeight = 40;
    const barWidth = 200;
    const padding = 20;

    // Draw score bars for each player
    alivePlayers.forEach((player, index) => {
      const isLocal = player.id === localPlayerId;
      const score = scores[player.id] || 0;
      const x = index === 0 ? padding : ARENA_WIDTH - barWidth - padding;
      const y = padding;

      // Background bar
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(x, y, barWidth, barHeight);

      // Player color indicator
      ctx.fillStyle = COLORS[player.role] || '#FFFFFF';
      ctx.fillRect(x, y, 5, barHeight);

      // Hearts collected indicator
      for (let i = 0; i < 2; i++) {
        const heartX = x + 30 + i * 50;
        const heartY = y + barHeight / 2;

        if (i < score) {
          // Filled heart (smaller version for UI)
          ctx.save();
          ctx.translate(heartX, heartY);
          ctx.fillStyle = COLORS.heart;
          ctx.shadowColor = COLORS.heart;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          const hs = 8; // heart size for UI
          ctx.moveTo(0, hs * 0.3);
          ctx.bezierCurveTo(-hs, -hs * 0.5, -hs, hs * 0.3, 0, hs);
          ctx.bezierCurveTo(hs, hs * 0.3, hs, -hs * 0.5, 0, hs * 0.3);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          // Empty heart outline
          ctx.save();
          ctx.strokeStyle = COLORS.heart;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.3;
          ctx.beginPath();
          ctx.arc(heartX, heartY, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Player label
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = index === 0 ? 'left' : 'right';
      ctx.fillText(
        isLocal ? 'YOU' : player.role.toUpperCase(),
        index === 0 ? x + barWidth - 10 : x + barWidth - 5,
        y + barHeight / 2 + 5
      );
    });

    ctx.restore();
  }

  /**
   * Render a frame with all players and effects
   * @param {{effects: Array, showdown: Object}} gameState - Game state with visual effects and showdown state
   */
  function render(gameState) {
    clear();

    // Draw showdown hearts (if in showdown mode)
    if (gameState.showdown && gameState.showdown.hearts) {
      drawHearts(gameState.showdown.hearts);
    }

    // Draw all players
    const players = Interpolation.getPlayers();
    for (const player of players) {
      drawPlayer(player);
    }

    // Draw effects
    if (gameState.effects) {
      for (const effect of gameState.effects) {
        if (effect.type === 'elimination') {
          drawElimination(effect.x, effect.y, effect.progress);
        } else if (effect.type === 'bounce') {
          drawBounce(effect.x, effect.y, effect.progress);
        }
      }
    }

    // Draw showdown UI elements (text, scores)
    if (gameState.showdown) {
      // Draw "SHOWDOWN" text if in freeze phase
      if (gameState.showdown.showText) {
        const progress = Math.min(1, gameState.showdown.textProgress || 1);
        drawShowdownText(progress);
      }

      // Draw score display
      if (gameState.showdown.scores) {
        drawShowdownScores(
          gameState.showdown.scores,
          players,
          gameState.localPlayerId
        );
      }
    }
  }

  /**
   * Draw countdown overlay with number and player role
   * @param {number} number - Countdown number (3, 2, 1, 0 for GO!)
   * @param {string} role - Player's assigned role
   */
  function drawCountdown(number, role) {
    clear();

    // Draw players at spawn positions
    const players = Interpolation.getPlayers();
    for (const player of players) {
      drawPlayer(player);
    }

    // Draw overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Draw countdown number
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 200px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(number === 0 ? 'GO!' : number.toString(), ARENA_WIDTH / 2, ARENA_HEIGHT / 2 - 50);

    // Draw role
    if (role) {
      ctx.fillStyle = COLORS[role];
      ctx.font = 'bold 48px Arial';
      ctx.fillText(`You are ${role.toUpperCase()}`, ARENA_WIDTH / 2, ARENA_HEIGHT / 2 + 100);
    }
  }

  /**
   * Cleanup
   */
  function destroy() {
    window.removeEventListener('resize', resize);
    canvas = null;
    ctx = null;
  }

  // Public API
  return {
    init,
    resize,
    clear,
    render,
    drawCountdown,
    drawHearts,
    drawShowdownText,
    drawShowdownScores,
    destroy,
    ARENA_WIDTH,
    ARENA_HEIGHT,
    COLORS,
  };
})();
