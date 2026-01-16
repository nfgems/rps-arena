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
        console.log('[DEBUG] First real mouse movement detected');
        hasReceivedMouseMove = true;
      }
    }

    // Update last known mouse position
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    // If this is the very first mousemove event after enable, just record position, don't update target
    if (!hasReceivedMouseMove) {
      console.log('[DEBUG] Recording initial mouse position, not updating target yet');
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
    // Reset mouse tracking - player will stay at spawn until mouse actually moves
    hasReceivedMouseMove = false;
    lastMouseX = null;
    lastMouseY = null;

    enabled = true;

    console.log('[DEBUG] startSending called, initial target:', targetX, targetY);

    // Log first few inputs
    let inputCount = 0;

    // Send inputs at 60 Hz
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
