/**
 * Input handling for RPS Arena
 * Keyboard-based movement (WASD/Arrow keys)
 */

const Input = (function () {
  // State
  let canvas = null;
  let enabled = false;
  let sendInterval = null;

  // Direction state (-1, 0, or 1 for each axis)
  let dirX = 0;
  let dirY = 0;

  // Track which keys are currently pressed
  const keysPressed = {
    up: false,
    down: false,
    left: false,
    right: false,
  };

  // Constants
  const SEND_RATE = 60; // 60 Hz

  /**
   * Initialize input handling
   * @param {HTMLCanvasElement} canvasElement - Game canvas (for focus)
   */
  function init(canvasElement) {
    canvas = canvasElement;

    // Make canvas focusable
    canvas.tabIndex = 1;

    // Keyboard handlers
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    // Focus canvas when clicked
    canvas.addEventListener('click', () => canvas.focus());
  }

  /**
   * Handle key down events
   * @param {KeyboardEvent} event
   */
  function handleKeyDown(event) {
    if (!enabled) return;

    const key = event.key.toLowerCase();

    // Prevent default for game keys to avoid scrolling
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      event.preventDefault();
    }

    // Update key state
    switch (key) {
      case 'w':
      case 'arrowup':
        keysPressed.up = true;
        break;
      case 's':
      case 'arrowdown':
        keysPressed.down = true;
        break;
      case 'a':
      case 'arrowleft':
        keysPressed.left = true;
        break;
      case 'd':
      case 'arrowright':
        keysPressed.right = true;
        break;
    }

    updateDirection();
  }

  /**
   * Handle key up events
   * @param {KeyboardEvent} event
   */
  function handleKeyUp(event) {
    const key = event.key.toLowerCase();

    // Update key state
    switch (key) {
      case 'w':
      case 'arrowup':
        keysPressed.up = false;
        break;
      case 's':
      case 'arrowdown':
        keysPressed.down = false;
        break;
      case 'a':
      case 'arrowleft':
        keysPressed.left = false;
        break;
      case 'd':
      case 'arrowright':
        keysPressed.right = false;
        break;
    }

    updateDirection();
  }

  /**
   * Update direction based on current key state
   */
  function updateDirection() {
    // Calculate direction from pressed keys
    dirX = 0;
    dirY = 0;

    if (keysPressed.left) dirX -= 1;
    if (keysPressed.right) dirX += 1;
    if (keysPressed.up) dirY -= 1;
    if (keysPressed.down) dirY += 1;
  }

  /**
   * Start sending inputs
   */
  function startSending() {
    // Reset direction state
    dirX = 0;
    dirY = 0;
    keysPressed.up = false;
    keysPressed.down = false;
    keysPressed.left = false;
    keysPressed.right = false;

    enabled = true;

    // Focus canvas for keyboard input
    if (canvas) {
      canvas.focus();
    }

    // Send inputs at 60 Hz
    sendInterval = setInterval(() => {
      Network.sendInput(dirX, dirY);
    }, 1000 / SEND_RATE);
  }

  /**
   * Stop sending inputs
   */
  function stopSending() {
    enabled = false;
    dirX = 0;
    dirY = 0;

    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
    }
  }

  /**
   * Get current direction
   * @returns {{dx: number, dy: number}} Direction vector
   */
  function getDirection() {
    return { dx: dirX, dy: dirY };
  }

  /**
   * Set initial target position (no longer used for keyboard movement)
   * Kept for API compatibility
   */
  function setPosition(x, y) {
    // No-op for keyboard movement
  }

  /**
   * Get current target (compatibility method)
   * @returns {{x: number, y: number, frozen: boolean}}
   */
  function getTarget() {
    // Return zeros - not used in keyboard mode
    return { x: 0, y: 0, frozen: false };
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
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    canvas = null;
  }

  // Public API
  return {
    init,
    startSending,
    stopSending,
    getDirection,
    getTarget,
    setPosition,
    isEnabled,
    destroy,
  };
})();
