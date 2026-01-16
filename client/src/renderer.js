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
  };

  // Animation state
  let animationFrame = 0;

  /**
   * Initialize renderer
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
   * Draw a player token
   */
  function drawPlayer(player) {
    const { x, y, role, alive, isLocal } = player;

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

    // Draw main circle
    ctx.fillStyle = COLORS[role];
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Draw border (thicker for local player)
    ctx.strokeStyle = isLocal ? '#000000' : 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = isLocal ? 3 : 1;
    ctx.stroke();

    // Draw role icon
    drawRoleIcon(role, time);

    ctx.restore();
  }

  /**
   * Draw role-specific icon inside the player circle
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
   * Draw elimination effect
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
   * Draw bounce effect
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
   * Render a frame
   */
  function render(gameState) {
    clear();

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
  }

  /**
   * Draw countdown overlay
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
    destroy,
    ARENA_WIDTH,
    ARENA_HEIGHT,
    COLORS,
  };
})();
