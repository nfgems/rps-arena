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

  /**
   * Connect to WebSocket server
   */
  function connect(token) {
    return new Promise((resolve, reject) => {
      sessionToken = token;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
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
          // Attempt reconnection
          reconnectAttempts++;
          setTimeout(() => {
            console.log(`Reconnecting... attempt ${reconnectAttempts}`);
            connect(sessionToken).catch((err) => {
              console.error('Reconnection failed:', err);
              // Reset userId on reconnection failure to prevent stale auth state
              userId = null;
            });
          }, 1000 * reconnectAttempts);
        } else if (reconnectAttempts >= maxReconnectAttempts) {
          // All reconnection attempts exhausted - reset state
          console.log('Max reconnection attempts reached, resetting state');
          userId = null;
          sessionToken = null;
        }

        emit('disconnected', { code: event.code, reason: event.reason });
      };

      ws.onerror = (error) => {
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
   */
  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Handle incoming message
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
   * Register a message handler
   */
  function on(type, handler) {
    handlers.set(type, handler);
  }

  /**
   * Remove a message handler
   */
  function off(type) {
    handlers.delete(type);
  }

  /**
   * Event emitter for UI updates
   */
  const eventListeners = new Map();

  function emit(event, data) {
    const listeners = eventListeners.get(event) || [];
    listeners.forEach(listener => listener(data));
  }

  function addEventListener(event, listener) {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, []);
    }
    eventListeners.get(event).push(listener);
  }

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

  /**
   * Game-specific sends
   */
  function joinLobby(lobbyId, paymentTxHash) {
    send({
      type: 'JOIN_LOBBY',
      lobbyId,
      paymentTxHash,
    });
  }

  function requestRefund(lobbyId) {
    send({
      type: 'REQUEST_REFUND',
      lobbyId,
    });
  }

  let inputSequence = 0;

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
   * Getters
   */
  function isConnected() {
    return connected;
  }

  function getUserId() {
    return userId;
  }

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
