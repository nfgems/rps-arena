/**
 * Input handling for RPS Arena
 * Mouse tracking and input sending
 */

const Input = (function () {
  // State
  let canvas = null;
  let targetX = 0;
  let targetY = 0;
  let frozen = false;
  let enabled = false;
  let sendInterval = null;

  // Constants
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const SEND_RATE = 30; // 30 Hz

  /**
   * Initialize input handling
   */
  function init(canvasElement) {
    canvas = canvasElement;

    // Mouse move handler
    canvas.addEventListener('mousemove', handleMouseMove);

    // Mouse leave handler
    canvas.addEventListener('mouseleave', handleMouseLeave);

    // Mouse enter handler
    canvas.addEventListener('mouseenter', handleMouseEnter);

    console.log('Input initialized');
  }

  /**
   * Handle mouse movement
   */
  function handleMouseMove(event) {
    if (!enabled) return;

    // Get canvas-relative coordinates
    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Scale to logical arena coordinates
    const scaleX = ARENA_WIDTH / rect.width;
    const scaleY = ARENA_HEIGHT / rect.height;

    targetX = Math.max(0, Math.min(ARENA_WIDTH, canvasX * scaleX));
    targetY = Math.max(0, Math.min(ARENA_HEIGHT, canvasY * scaleY));
    frozen = false;
  }

  /**
   * Handle mouse leaving canvas
   */
  function handleMouseLeave() {
    if (!enabled) return;
    frozen = true;
  }

  /**
   * Handle mouse entering canvas
   */
  function handleMouseEnter() {
    if (!enabled) return;
    frozen = false;
  }

  /**
   * Start sending inputs
   */
  function startSending() {
    enabled = true;

    // Send inputs at 30 Hz
    sendInterval = setInterval(() => {
      Network.sendInput(targetX, targetY, frozen);
    }, 1000 / SEND_RATE);

    console.log('Input sending started');
  }

  /**
   * Stop sending inputs
   */
  function stopSending() {
    enabled = false;

    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
    }

    console.log('Input sending stopped');
  }

  /**
   * Get current target position
   */
  function getTarget() {
    return { x: targetX, y: targetY, frozen };
  }

  /**
   * Set initial position
   */
  function setPosition(x, y) {
    targetX = x;
    targetY = y;
  }

  /**
   * Check if enabled
   */
  function isEnabled() {
    return enabled;
  }

  /**
   * Cleanup
   */
  function destroy() {
    stopSending();
    if (canvas) {
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('mouseenter', handleMouseEnter);
    }
    canvas = null;
  }

  // Public API
  return {
    init,
    startSending,
    stopSending,
    getTarget,
    setPosition,
    isEnabled,
    destroy,
  };
})();
