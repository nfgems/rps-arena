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
  let hasReceivedMouseMove = false; // Track if mouse has moved since game started
  let lastMouseX = null; // Track last raw mouse position to detect actual movement
  let lastMouseY = null;

  // Constants
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const SEND_RATE = 60; // 60 Hz
  const MOUSE_MOVE_THRESHOLD = 5; // Minimum pixels mouse must move to register

  /**
   * Initialize input handling for a canvas element
   * @param {HTMLCanvasElement} canvasElement - Game canvas to track mouse on
   */
  function init(canvasElement) {
    canvas = canvasElement;

    // Mouse move handler - use document to catch all mouse movement
    // This fixes the issue where canvas doesn't receive events until focused
    document.addEventListener('mousemove', handleMouseMove);

    // Also listen on canvas for redundancy
    canvas.addEventListener('mousemove', handleMouseMove);

    // Mouse leave handler
    canvas.addEventListener('mouseleave', handleMouseLeave);

    // Mouse enter handler
    canvas.addEventListener('mouseenter', handleMouseEnter);
  }

  /**
   * Handle mouse movement events
   * @param {MouseEvent} event - Mouse event
   */
  function handleMouseMove(event) {
    if (!enabled) return;
    if (!canvas) return;

    // Get canvas-relative coordinates
    const rect = canvas.getBoundingClientRect();

    // Skip if canvas hasn't been laid out yet (would cause NaN/Infinity)
    if (rect.width === 0 || rect.height === 0) {
      console.warn('[Input] Canvas has zero dimensions - mouse input ignored until canvas is properly sized. This may indicate a layout issue.');
      return;
    }

    // Check if mouse has actually moved since last check
    // This prevents the initial mouse position from immediately overwriting spawn position
    if (lastMouseX !== null && lastMouseY !== null) {
      const mouseDeltaX = Math.abs(event.clientX - lastMouseX);
      const mouseDeltaY = Math.abs(event.clientY - lastMouseY);

      // Only register as actual movement if mouse moved more than threshold
      if (mouseDeltaX < MOUSE_MOVE_THRESHOLD && mouseDeltaY < MOUSE_MOVE_THRESHOLD) {
        // Mouse hasn't moved enough, don't update target
        return;
      }

      // Mouse has moved, mark that we've received real input
      if (!hasReceivedMouseMove) {
        hasReceivedMouseMove = true;
      }
    }

    // Update last known mouse position
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    // If this is the very first mousemove event after enable, just record position, don't update target
    if (!hasReceivedMouseMove) {
      return;
    }

    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Scale to logical arena coordinates
    const scaleX = ARENA_WIDTH / rect.width;
    const scaleY = ARENA_HEIGHT / rect.height;

    const newX = Math.max(0, Math.min(ARENA_WIDTH, canvasX * scaleX));
    const newY = Math.max(0, Math.min(ARENA_HEIGHT, canvasY * scaleY));

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
    // Reset mouse tracking - player will stay at spawn until mouse actually moves
    hasReceivedMouseMove = false;
    lastMouseX = null;
    lastMouseY = null;

    enabled = true;

    // Send inputs at 60 Hz
    sendInterval = setInterval(() => {
      Network.sendInput(targetX, targetY, false);
    }, 1000 / SEND_RATE);
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
  }

  /**
   * Get current target position
   * @returns {{x: number, y: number, frozen: boolean}} Target position and frozen state
   */
  function getTarget() {
    return { x: targetX, y: targetY, frozen: false };
  }

  /**
   * Set initial target position (for spawn position)
   * @param {number} x - X position
   * @param {number} y - Y position
   */
  function setPosition(x, y) {
    targetX = x;
    targetY = y;
  }

  /**
   * Check if input handling is enabled
   * @returns {boolean} True if enabled
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
