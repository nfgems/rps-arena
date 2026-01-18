/**
 * Network communication for RPS Arena
 * WebSocket connection and message handling
 */

const Network = (function () {
  // State
  let ws = null;
  let sessionToken = null;
  let userId = null;
  let connected = false;
  let reconnectAttempts = 0;
  let maxReconnectAttempts = 5;
  let pingInterval = null;
  let lastPing = 0;
  let currentPing = 0;

  // Message handlers
  const handlers = new Map();

  // Connection timeout constant
  const CONNECTION_TIMEOUT_MS = 10000; // 10 seconds

  /**
   * Connect to WebSocket server
   * @param {string} token - Session token for authentication
   * @returns {Promise<{userId: string, serverTime: number}>} User ID and server time on success
   */
  function connect(token) {
    return new Promise((resolve, reject) => {
      sessionToken = token;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;

      ws = new WebSocket(wsUrl);

      // Connection timeout - reject if not connected within 10s
      const connectionTimeout = setTimeout(() => {
        if (ws && ws.readyState !== WebSocket.OPEN) {
          console.error('WebSocket connection timeout after 10s');
          ws.close();
          reject(new Error('Connection timeout - server did not respond within 10 seconds'));
        }
      }, CONNECTION_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        console.log('WebSocket connected');
        connected = true;
        reconnectAttempts = 0;

        // Send HELLO message
        send({
          type: 'HELLO',
          sessionToken: sessionToken,
        });

        // Start ping interval
        startPing();
      };

      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          console.error('Failed to parse server message:', error);
          return;
        }
        handleMessage(message);

        // Resolve on WELCOME
        if (message.type === 'WELCOME') {
          userId = message.userId;
          resolve({ userId, serverTime: message.serverTime });
        }

        // Reject on ERROR during connection
        if (message.type === 'ERROR' && !userId) {
          reject(new Error(message.message));
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        connected = false;
        stopPing();

        if (event.code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
          // Attempt reconnection with exponential backoff + jitter (MEDIUM-3)
          reconnectAttempts++;
          const baseDelay = 1000;
          const maxDelay = 30000;
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at 30s)
          const backoff = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), maxDelay);
          // Add jitter (50-100% of backoff) to prevent thundering herd
          const jitter = backoff * (0.5 + Math.random() * 0.5);
          console.log(`Reconnecting in ${Math.round(jitter)}ms... attempt ${reconnectAttempts}`);
          setTimeout(() => {
            connect(sessionToken).catch((err) => {
              console.error('Reconnection failed:', err);
              // Reset userId on reconnection failure to prevent stale auth state
              userId = null;
            });
          }, jitter);
        } else if (reconnectAttempts >= maxReconnectAttempts) {
          // All reconnection attempts exhausted - reset state
          console.log('Max reconnection attempts reached, resetting state');
          userId = null;
          sessionToken = null;
        }

        emit('disconnected', { code: event.code, reason: event.reason });
      };

      ws.onerror = (error) => {
        clearTimeout(connectionTimeout);
        console.error('WebSocket error:', error);
        reject(error);
      };
    });
  }

  /**
   * Disconnect from server
   */
  function disconnect() {
    if (ws) {
      ws.close(1000, 'User disconnected');
      ws = null;
    }
    connected = false;
    sessionToken = null;
    userId = null;
    stopPing();
  }

  /**
   * Send a message to the server
   * @param {Object} message - Message object with type and data
   */
  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Handle incoming message from server
   * @param {{type: string}} message - Server message with type property
   */
  function handleMessage(message) {
    const type = message.type;
    const handler = handlers.get(type);

    if (handler) {
      handler(message);
    }

    // Emit event for any listeners
    emit(type, message);
  }

  /**
   * Register a message handler for a specific message type
   * @param {string} type - Message type to handle
   * @param {Function} handler - Handler function receiving the message
   */
  function on(type, handler) {
    handlers.set(type, handler);
  }

  /**
   * Remove a message handler for a specific message type
   * @param {string} type - Message type to remove handler for
   */
  function off(type) {
    handlers.delete(type);
  }

  /**
   * Event emitter for UI updates
   */
  const eventListeners = new Map();

  /**
   * Emit an event to all registered listeners
   * @param {string} event - Event name
   * @param {any} data - Event data
   */
  function emit(event, data) {
    const listeners = eventListeners.get(event) || [];
    listeners.forEach(listener => listener(data));
  }

  /**
   * Add an event listener
   * @param {string} event - Event name
   * @param {Function} listener - Listener function
   */
  function addEventListener(event, listener) {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, []);
    }
    eventListeners.get(event).push(listener);
  }

  /**
   * Remove an event listener
   * @param {string} event - Event name
   * @param {Function} listener - Listener function to remove
   */
  function removeEventListener(event, listener) {
    const listeners = eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Ping management
   */
  function startPing() {
    pingInterval = setInterval(() => {
      if (connected) {
        lastPing = Date.now();
        send({ type: 'PING', clientTime: lastPing });
      }
    }, 2000);
  }

  function stopPing() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  // Handle PONG messages
  on('PONG', (message) => {
    currentPing = Date.now() - lastPing;
    emit('pingUpdate', currentPing);
  });

  // Handle TOKEN_UPDATE messages (token rotation for security - CRITICAL-2)
  on('TOKEN_UPDATE', (message) => {
    if (message.token) {
      sessionToken = message.token;
      // Persist new token to sessionStorage
      try {
        sessionStorage.setItem('sessionToken', message.token);
      } catch (e) {
        console.warn('Failed to persist rotated token:', e);
      }
      console.log('Session token rotated');
    }
  });

  /**
   * Send request to join a lobby
   * @param {number} lobbyId - Lobby ID to join
   * @param {string} paymentTxHash - Payment transaction hash
   */
  function joinLobby(lobbyId, paymentTxHash) {
    send({
      type: 'JOIN_LOBBY',
      lobbyId,
      paymentTxHash,
    });
  }

  /**
   * Request a refund for a lobby that timed out
   * @param {number} lobbyId - Lobby ID to request refund from
   */
  function requestRefund(lobbyId) {
    send({
      type: 'REQUEST_REFUND',
      lobbyId,
    });
  }

  let inputSequence = 0;

  /**
   * Send player input to server
   * @param {number} targetX - Target X position
   * @param {number} targetY - Target Y position
   * @param {boolean} [frozen=false] - Whether player is frozen (not moving)
   */
  function sendInput(targetX, targetY, frozen = false) {
    inputSequence++;
    send({
      type: 'INPUT',
      targetX,
      targetY,
      sequence: inputSequence,
      frozen,
    });
  }

  /**
   * Check if connected to server
   * @returns {boolean} True if connected
   */
  function isConnected() {
    return connected;
  }

  /**
   * Get the current user's ID
   * @returns {string|null} User ID or null if not authenticated
   */
  function getUserId() {
    return userId;
  }

  /**
   * Get current ping latency in milliseconds
   * @returns {number} Ping in ms
   */
  function getPing() {
    return currentPing;
  }

  // Public API
  return {
    connect,
    disconnect,
    send,
    on,
    off,
    addEventListener,
    removeEventListener,
    joinLobby,
    requestRefund,
    sendInput,
    isConnected,
    getUserId,
    getPing,
  };
})();
