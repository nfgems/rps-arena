/**
 * Confetti effect for victory celebration
 * Canvas-based particle system
 */

const Confetti = (function () {
  let canvas = null;
  let ctx = null;
  let particles = [];
  let animationId = null;
  let stopTimeout = null;

  // Confetti colors - festive mix
  const COLORS = [
    '#FFA500', // Orange (Rock)
    '#1E90FF', // Blue (Paper)
    '#2ECC71', // Green (Scissors)
    '#FFD700', // Gold
    '#FF69B4', // Pink
    '#9B59B6', // Purple
    '#E94560', // Red accent
  ];

  // Particle configuration
  const PARTICLE_COUNT = 150;
  const GRAVITY = 0.15;
  const DRAG = 0.02;
  const TERMINAL_VELOCITY = 4;

  /**
   * Create a single confetti particle
   */
  function createParticle() {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height * -1, // Start above screen
      vx: (Math.random() - 0.5) * 8,
      vy: Math.random() * 3 + 2,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      width: Math.random() * 10 + 5,
      height: Math.random() * 6 + 3,
      color: color,
      opacity: 1,
      wobble: Math.random() * 10,
      wobbleSpeed: Math.random() * 0.1 + 0.05,
    };
  }

  /**
   * Initialize confetti system
   */
  function init() {
    canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;

    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  /**
   * Handle canvas resize
   */
  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  /**
   * Start the confetti animation
   * @param {number} duration - Duration in milliseconds (default: 3000)
   */
  function start(duration = 3000) {
    if (!canvas || !ctx) {
      init();
    }
    if (!canvas || !ctx) return;

    // Clear any existing animation
    stop();

    // Create initial particles
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(createParticle());
    }

    // Start animation loop
    animate();

    // Auto-stop after duration (let particles fall naturally)
    stopTimeout = setTimeout(() => {
      // Don't call stop() immediately - just stop adding particles
      // The animate loop will naturally end when particles fall off screen
    }, duration);
  }

  /**
   * Animation loop
   */
  function animate() {
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update and draw particles
    let activeParticles = 0;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];

      // Update physics
      p.vy += GRAVITY;
      p.vy = Math.min(p.vy, TERMINAL_VELOCITY);
      p.vx *= (1 - DRAG);

      // Wobble effect
      p.wobble += p.wobbleSpeed;
      p.x += p.vx + Math.sin(p.wobble) * 0.5;
      p.y += p.vy;

      // Rotation
      p.rotation += p.rotationSpeed;

      // Fade out when near bottom
      if (p.y > canvas.height * 0.8) {
        p.opacity -= 0.02;
      }

      // Remove dead particles
      if (p.opacity <= 0 || p.y > canvas.height + 50) {
        particles.splice(i, 1);
        continue;
      }

      activeParticles++;

      // Draw particle
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;

      // Draw rectangle confetti piece
      ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);

      ctx.restore();
    }

    // Continue animation if particles remain
    if (activeParticles > 0) {
      animationId = requestAnimationFrame(animate);
    } else {
      stop();
    }
  }

  /**
   * Stop the confetti animation
   */
  function stop() {
    if (stopTimeout) {
      clearTimeout(stopTimeout);
      stopTimeout = null;
    }
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    particles = [];
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /**
   * Cleanup
   */
  function destroy() {
    stop();
    window.removeEventListener('resize', resize);
    canvas = null;
    ctx = null;
  }

  // Public API
  return {
    init,
    start,
    stop,
    destroy,
  };
})();
