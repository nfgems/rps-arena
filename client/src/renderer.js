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

  // Preview mode state (for 3-second map preview before game starts)
  let previewMode = false;
  let previewPlayerId = null;

  // Current ping value for display
  let currentPing = null;

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
   * @param {{x: number, y: number, role: string, alive: boolean, isLocal: boolean, id: string}} player - Player data
   */
  function drawPlayer(player) {
    const { x, y, role, alive, isLocal, id } = player;

    if (!alive) return;

    ctx.save();
    ctx.translate(x, y);

    // Animate based on frame
    animationFrame++;
    const time = animationFrame / 60;

    // Draw preview mode highlight for local player (pulsing ring)
    const isPreviewHighlight = previewMode && id === previewPlayerId;
    if (isPreviewHighlight) {
      const pulseScale = 1 + Math.sin(time * 5) * 0.15;
      const pulseAlpha = 0.6 + Math.sin(time * 5) * 0.3;
      ctx.save();
      ctx.globalAlpha = pulseAlpha;
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
    const baseColor = COLORS[role];
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

    // Draw "YOU" label above local player during preview
    if (isPreviewHighlight) {
      ctx.fillStyle = '#e94560';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', 0, -PLAYER_RADIUS - 15);
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
   * Draw a mini heart for the showdown subtitle
   * @param {number} x - Center X position
   * @param {number} y - Center Y position
   * @param {number} size - Size of the heart
   * @param {number} hue - Color hue (pink range)
   * @param {number} sparkle - Sparkle intensity (0-1)
   */
  function drawMiniHeart(x, y, size, hue, sparkle) {
    ctx.save();
    ctx.translate(x, y);

    // Glowing effect
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = 10 + 5 * sparkle;

    ctx.fillStyle = `hsl(${hue}, 100%, ${65 + 15 * sparkle}%)`;
    ctx.beginPath();

    // Heart shape using bezier curves
    const s = size * 0.6;
    ctx.moveTo(0, s * 0.3);
    ctx.bezierCurveTo(-s, -s * 0.5, -s, s * 0.3, 0, s);
    ctx.bezierCurveTo(s, s * 0.3, s, -s * 0.5, 0, s * 0.3);
    ctx.closePath();
    ctx.fill();

    // White highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.ellipse(-s * 0.3, -s * 0.1, s * 0.12, s * 0.15, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw sparkles around the showdown subtitle
   * @param {number} xMin - Left boundary
   * @param {number} xMax - Right boundary
   * @param {number} yMin - Top boundary
   * @param {number} yMax - Bottom boundary
   * @param {number} time - Animation time
   */
  function drawSparkles(xMin, xMax, yMin, yMax, time) {
    const sparkleCount = 8;
    ctx.save();

    for (let i = 0; i < sparkleCount; i++) {
      // Pseudo-random positions based on index and time
      const seed = i * 137.5;
      const xPos = xMin + ((seed + time * 50) % (xMax - xMin));
      const yPos = yMin + ((seed * 2.3 + time * 30) % (yMax - yMin));
      const alpha = 0.3 + 0.7 * Math.abs(Math.sin(time * 5 + i * 0.8));
      const size = 2 + Math.sin(time * 6 + i) * 1;

      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.shadowColor = '#FF69B4';
      ctx.shadowBlur = 5;

      // Draw a 4-point star sparkle
      ctx.beginPath();
      ctx.moveTo(xPos, yPos - size);
      ctx.lineTo(xPos + size * 0.3, yPos);
      ctx.lineTo(xPos, yPos + size);
      ctx.lineTo(xPos - size * 0.3, yPos);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(xPos - size, yPos);
      ctx.lineTo(xPos, yPos + size * 0.3);
      ctx.lineTo(xPos + size, yPos);
      ctx.lineTo(xPos, yPos - size * 0.3);
      ctx.closePath();
      ctx.fill();
    }

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
    ctx.fillText('SHOWDOWN', 0, -40);

    // Outline for that gritty effect
    ctx.strokeStyle = '#880000';
    ctx.lineWidth = 3;
    ctx.strokeText('SHOWDOWN', 0, -40);

    // Subtitle text - sparkling animated pink with hearts
    const time = animationFrame / 60;
    const sparkle = 0.7 + 0.3 * Math.sin(time * 8); // Pulsing intensity
    const hue = 330 + 20 * Math.sin(time * 3); // Shifting pink hue

    // Glowing neon effect - multiple shadow layers
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = 20 + 10 * Math.sin(time * 6);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.font = 'bold 30px "Comic Sans MS", "Marker Felt", cursive';
    ctx.textAlign = 'center';
    const subtitleY = 55;
    const text = 'Collect 2 hearts to win!';

    // Draw glowing text with animated color
    ctx.fillStyle = `hsl(${hue}, 100%, ${65 + 15 * sparkle}%)`;
    ctx.fillText(text, 0, subtitleY);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.strokeText(text, 0, subtitleY);

    // Draw mini hearts on each side
    const textWidth = ctx.measureText(text).width;
    const heartSize = 12;
    const heartY = subtitleY - 4;
    const heartPulse = 1 + 0.15 * Math.sin(time * 6);

    // Left heart
    ctx.save();
    ctx.translate(-textWidth / 2 - 25, heartY);
    ctx.scale(heartPulse, heartPulse);
    drawMiniHeart(0, 0, heartSize, hue, sparkle);
    ctx.restore();

    // Right heart
    ctx.save();
    ctx.translate(textWidth / 2 + 25, heartY);
    ctx.scale(heartPulse, heartPulse);
    drawMiniHeart(0, 0, heartSize, hue, sparkle);
    ctx.restore();

    // Sparkles around the text
    drawSparkles(-textWidth / 2 - 40, textWidth / 2 + 40, subtitleY - 15, subtitleY + 15, time);

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
      ctx.textAlign = 'right';
      ctx.fillText(
        isLocal ? 'YOU' : player.role.toUpperCase(),
        x + barWidth - 10,
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

    // Draw ping display
    drawPing();
  }

  /**
   * Draw ping display at bottom center of canvas
   */
  function drawPing() {
    if (currentPing === null) return;

    ctx.save();
    ctx.font = '11px Arial';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`Ping: ${currentPing}ms`, ARENA_WIDTH / 2, ARENA_HEIGHT - 8);
    ctx.restore();
  }

  /**
   * Update the current ping value
   * @param {number} ping - Ping in milliseconds
   */
  function setPing(ping) {
    currentPing = ping;
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
   * Draw a role icon on a standalone canvas (for tutorial display)
   * @param {HTMLCanvasElement} targetCanvas - Canvas to draw on
   * @param {string} role - Player role (rock, paper, scissors)
   */
  function drawRoleIconOnCanvas(targetCanvas, role) {
    const targetCtx = targetCanvas.getContext('2d');
    const size = targetCanvas.width;
    const radius = size * 0.4;

    // Clear canvas
    targetCtx.clearRect(0, 0, size, size);

    // Center the drawing
    targetCtx.save();
    targetCtx.translate(size / 2, size / 2);

    // Draw shadow
    targetCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    targetCtx.beginPath();
    targetCtx.ellipse(2, 4, radius, radius * 0.4, 0, 0, Math.PI * 2);
    targetCtx.fill();

    // Draw main circle
    targetCtx.fillStyle = COLORS[role];
    targetCtx.beginPath();
    targetCtx.arc(0, 0, radius, 0, Math.PI * 2);
    targetCtx.fill();

    // Draw border
    targetCtx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    targetCtx.lineWidth = 2;
    targetCtx.stroke();

    // Draw role icon (scaled for the smaller canvas)
    const scale = radius / PLAYER_RADIUS;
    targetCtx.scale(scale, scale);
    targetCtx.fillStyle = '#FFFFFF';
    targetCtx.strokeStyle = '#FFFFFF';
    targetCtx.lineWidth = 2;

    const time = Date.now() / 1000; // Use real time for animation
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

    targetCtx.restore();
  }

  /**
   * Set preview mode (for 3-second map preview before game starts)
   * @param {boolean} enabled - Whether preview mode is enabled
   * @param {string|null} playerId - The local player's ID to highlight
   */
  function setPreviewMode(enabled, playerId) {
    previewMode = enabled;
    previewPlayerId = playerId;
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
    drawRoleIconOnCanvas,
    setPreviewMode,
    setPing,
    destroy,
    ARENA_WIDTH,
    ARENA_HEIGHT,
    COLORS,
  };
})();
