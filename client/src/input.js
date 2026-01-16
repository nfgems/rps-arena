/**
 * Input handling for RPS Arena
 * Mouse tracking and input sending
 */

const Input = (function () {
  // State
  let canvas = null;
  let targetX = 0;
  let targetY = 0;
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

    console.log('[DEBUG] Input.init - before listeners, targetX:', targetX, 'targetY:', targetY, 'enabled:', enabled);

    // Mouse move handler - use document to catch all mouse movement
    // This fixes the issue where canvas doesn't receive events until focused
    document.addEventListener('mousemove', handleMouseMove);

    // Also listen on canvas for redundancy
    canvas.addEventListener('mousemove', handleMouseMove);

    // Mouse leave handler
    canvas.addEventListener('mouseleave', handleMouseLeave);

    // Mouse enter handler
    canvas.addEventListener('mouseenter', handleMouseEnter);

    console.log('[DEBUG] Input.init - after listeners, targetX:', targetX, 'targetY:', targetY);
    console.log('Input initialized');
  }

  /**
   * Handle mouse movement
   */
  function handleMouseMove(event) {
    if (!enabled) return;
    if (!canvas) return;

    // Get canvas-relative coordinates
    const rect = canvas.getBoundingClientRect();

    // Skip if canvas hasn't been laid out yet (would cause NaN/Infinity)
    if (rect.width === 0 || rect.height === 0) {
      console.log('[DEBUG] Canvas rect is zero:', rect);
      return;
    }

    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Scale to logical arena coordinates
    const scaleX = ARENA_WIDTH / rect.width;
    const scaleY = ARENA_HEIGHT / rect.height;

    const newX = Math.max(0, Math.min(ARENA_WIDTH, canvasX * scaleX));
    const newY = Math.max(0, Math.min(ARENA_HEIGHT, canvasY * scaleY));

    // Log first few mouse moves
    if (Math.abs(newX - targetX) > 50 || Math.abs(newY - targetY) > 50) {
      console.log('[DEBUG] Mouse move - new target:', newX, newY, 'rect:', rect.width, rect.height);
    }

    targetX = newX;
    targetY = newY;
  }

  /**
   * Handle mouse leaving canvas
   * NOTE: We no longer freeze on mouse leave - player continues moving toward last known target
   */
  function handleMouseLeave() {
    // Don't freeze - let player continue moving toward last target position
    // This prevents the "invisible barrier" feel when mouse briefly leaves canvas
  }

  /**
   * Handle mouse entering canvas
   */
  function handleMouseEnter() {
    // No longer needed since we don't freeze on leave
  }

  /**
   * Start sending inputs
   */
  function startSending() {
    enabled = true;

    console.log('[DEBUG] startSending called, initial target:', targetX, targetY);

    // Log first few inputs
    let inputCount = 0;

    // Send inputs at 30 Hz
    sendInterval = setInterval(() => {
      if (inputCount < 5) {
        console.log('[DEBUG] Sending input #' + inputCount + ':', targetX, targetY);
        inputCount++;
      }
      Network.sendInput(targetX, targetY, false);
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
    return { x: targetX, y: targetY, frozen: false };
  }

  /**
   * Set initial position
   */
  function setPosition(x, y) {
    console.log('[DEBUG] Input.setPosition called with:', x, y);
    targetX = x;
    targetY = y;
    console.log('[DEBUG] Input.setPosition result - targetX:', targetX, 'targetY:', targetY);
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
    document.removeEventListener('mousemove', handleMouseMove);
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
