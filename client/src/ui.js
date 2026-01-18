/**
 * UI management for RPS Arena
 * Screen transitions and UI updates
 */

const UI = (function () {
  // Screen elements
  const screens = {
    mobileBlock: null,
    landing: null,
    lobby: null,
    waiting: null,
    countdown: null,
    game: null,
    result: null,
  };

  // Modal
  let paymentModal = null;

  // Current state
  let currentScreen = 'landing';
  let currentLobbyId = null;
  let myRole = null;
  let devMode = false;
  let spawnPosition = { x: 800, y: 450 }; // Default to center, updated by role assignment

  /**
   * Initialize UI
   */
  function init() {
    // Get screen elements
    screens.mobileBlock = document.getElementById('mobile-block');
    screens.landing = document.getElementById('landing-screen');
    screens.lobby = document.getElementById('lobby-screen');
    screens.waiting = document.getElementById('waiting-screen');
    screens.countdown = document.getElementById('countdown-screen');
    screens.game = document.getElementById('game-screen');
    screens.result = document.getElementById('result-screen');

    paymentModal = document.getElementById('payment-modal');

    // Check for mobile
    if (isMobile()) {
      showScreen('mobileBlock');
      return;
    }

    // Set up event listeners
    setupEventListeners();

    // Check dev mode
    checkDevMode();

    console.log('UI initialized');
  }

  /**
   * Check if server is in dev mode
   */
  async function checkDevMode() {
    try {
      const res = await fetch('/api/dev-mode');
      const data = await res.json();
      devMode = data.devMode;
      if (devMode) {
        console.log('DEV MODE ENABLED - Payment verification skipped');
      }
    } catch (e) {
      console.log('Could not check dev mode');
    }
  }

  /**
   * Check if device is mobile
   */
  function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  /**
   * Set up event listeners
   */
  function setupEventListeners() {
    // Connect wallet button
    document.getElementById('connect-wallet-btn').addEventListener('click', handleConnectWallet);

    // Disconnect button
    document.getElementById('disconnect-btn').addEventListener('click', handleDisconnect);

    // Refund button
    document.getElementById('refund-btn').addEventListener('click', handleRefund);

    // Play again button
    document.getElementById('play-again-btn').addEventListener('click', handlePlayAgain);

    // Payment modal buttons
    document.getElementById('send-payment-btn').addEventListener('click', handleSendPayment);
    document.getElementById('cancel-join-btn').addEventListener('click', hidePaymentModal);
    document.getElementById('copy-address-btn').addEventListener('click', handleCopyAddress);

    // Network event listeners
    Network.addEventListener('LOBBY_LIST', handleLobbyList);
    Network.addEventListener('LOBBY_UPDATE', handleLobbyUpdate);
    Network.addEventListener('MATCH_STARTING', handleMatchStarting);
    Network.addEventListener('ROLE_ASSIGNMENT', handleRoleAssignment);
    Network.addEventListener('COUNTDOWN', handleCountdown);
    Network.addEventListener('SNAPSHOT', handleSnapshot);
    Network.addEventListener('ELIMINATION', handleElimination);
    Network.addEventListener('BOUNCE', handleBounce);
    Network.addEventListener('MATCH_END', handleMatchEnd);
    Network.addEventListener('REFUND_PROCESSED', handleRefundProcessed);
    Network.addEventListener('ERROR', handleError);
    Network.addEventListener('pingUpdate', handlePingUpdate);
  }

  /**
   * Show a screen
   */
  function showScreen(screenName) {
    // Hide all screens
    for (const [name, element] of Object.entries(screens)) {
      if (element) {
        element.classList.add('hidden');
      }
    }

    // Show requested screen
    if (screens[screenName]) {
      screens[screenName].classList.remove('hidden');
      currentScreen = screenName;
    }
  }

  // ============================================
  // Event Handlers
  // ============================================

  async function handleConnectWallet() {
    try {
      const btn = document.getElementById('connect-wallet-btn');
      btn.disabled = true;
      btn.textContent = 'Connecting...';

      // Connect wallet
      const address = await Wallet.connect();

      // Sign message for authentication
      const timestamp = Date.now();
      const message = `Sign in to RPS Arena: ${timestamp}`;
      const signature = await Wallet.signMessage(message);

      // Authenticate with server
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, signature, timestamp }),
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error);
      }

      // Store session token
      localStorage.setItem('sessionToken', data.token);

      // Connect WebSocket
      await Network.connect(data.token);

      // Update UI
      document.getElementById('user-display').textContent = data.user.username || Wallet.truncateAddress(address);

      // Show lobby screen
      showScreen('lobby');

    } catch (error) {
      console.error('Connection failed:', error);
      alert('Failed to connect: ' + error.message);
    } finally {
      const btn = document.getElementById('connect-wallet-btn');
      btn.disabled = false;
      btn.textContent = 'Connect Wallet';
    }
  }

  function handleDisconnect() {
    Wallet.disconnect();
    Network.disconnect();
    localStorage.removeItem('sessionToken');
    showScreen('landing');
  }

  function handleRefund() {
    if (currentLobbyId) {
      Network.requestRefund(currentLobbyId);
    }
  }

  function handlePlayAgain() {
    showScreen('lobby');
  }

  async function handleSendPayment() {
    const btn = document.getElementById('send-payment-btn');
    const status = document.getElementById('payment-status');

    try {
      btn.disabled = true;
      status.classList.remove('hidden');
      status.querySelector('span').textContent = 'Sending transaction...';

      const depositAddress = document.getElementById('deposit-address').textContent;
      const txHash = await Wallet.sendUSDC(depositAddress, 1);

      status.querySelector('span').textContent = 'Waiting for confirmation...';

      // Send to server
      Network.joinLobby(currentLobbyId, txHash);

      // Hide modal (server will confirm via LOBBY_UPDATE)
      hidePaymentModal();

    } catch (error) {
      console.error('Payment failed:', error);
      status.querySelector('span').textContent = 'Payment failed: ' + error.message;
      btn.disabled = false;
    }
  }

  function handleCopyAddress() {
    const address = document.getElementById('deposit-address').textContent;
    navigator.clipboard.writeText(address);

    const btn = document.getElementById('copy-address-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 2000);
  }

  // ============================================
  // Network Event Handlers
  // ============================================

  function handleLobbyList(data) {
    renderLobbyList(data.lobbies);
  }

  function handleLobbyUpdate(data) {
    const { lobbyId, players, status, timeRemaining, depositAddress } = data;

    // Check if we're in this lobby
    const myId = Network.getUserId();
    const inLobby = players.some(p => p.id === myId);

    if (inLobby) {
      currentLobbyId = lobbyId;

      if (status === 'waiting' || status === 'ready') {
        showScreen('waiting');
        updateWaitingScreen(lobbyId, players, timeRemaining);
      }
    }
  }

  function handleMatchStarting(data) {
    showScreen('countdown');

    // Initialize countdown canvas
    const canvas = document.getElementById('countdown-canvas');
    Renderer.init(canvas);
  }

  function handleRoleAssignment(data) {
    myRole = data.role;

    // Store spawn position for when game actually starts
    spawnPosition = { x: data.spawnX, y: data.spawnY };
    console.log('[DEBUG] Role assignment - spawn position:', spawnPosition);

    // Show role
    const roleDisplay = document.getElementById('role-display');
    roleDisplay.textContent = `You are ${data.role.toUpperCase()}`;
    roleDisplay.className = `role-display ${data.role}`;
  }

  function handleCountdown(data) {
    const countdownNumber = document.getElementById('countdown-number');
    countdownNumber.textContent = data.secondsRemaining === 0 ? 'GO!' : data.secondsRemaining;

    if (data.secondsRemaining === 0) {
      // Transition to game
      setTimeout(() => {
        showScreen('game');

        // Initialize game canvas
        const gameCanvas = document.getElementById('game-canvas');
        Renderer.init(gameCanvas);
        Input.init(gameCanvas);

        // Set input target to spawn position IMMEDIATELY
        // This uses the position received from ROLE_ASSIGNMENT before snapshots arrive
        console.log('[DEBUG] Game start - setting input to spawn:', spawnPosition);
        Input.setPosition(spawnPosition.x, spawnPosition.y);

        // Set local player for interpolation WITH spawn position
        // This fixes the "invisible barrier" issue where player was stuck at (0,0) until first snapshot
        Interpolation.setLocalPlayer(Network.getUserId(), spawnPosition.x, spawnPosition.y);

        Input.startSending();
        console.log('[DEBUG] Input started, current target:', Input.getTarget());

        // Start render loop
        startGameLoop();
      }, 500);
    }
  }

  function handleSnapshot(data) {
    Interpolation.onSnapshot(data);
  }

  function handleElimination(data) {
    console.log('Elimination:', data);

    // Check if we were eliminated
    if (data.eliminatedId === Network.getUserId()) {
      Input.stopSending();
    }
  }

  function handleBounce(data) {
    console.log('Bounce:', data);
  }

  function handleMatchEnd(data) {
    Input.stopSending();
    stopGameLoop();
    Input.destroy();
    Renderer.destroy();

    const myId = Network.getUserId();
    const isWinner = data.winnerId === myId;

    // Update result screen
    const title = document.getElementById('result-title');
    title.textContent = isWinner ? 'VICTORY!' : 'DEFEATED';
    title.className = isWinner ? 'victory' : 'defeat';

    const payout = document.getElementById('result-payout');
    payout.textContent = isWinner ? '+2.4 USDC' : '';
    payout.className = isWinner ? 'payout' : 'payout none';

    showScreen('result');

    // Reset state
    currentLobbyId = null;
    myRole = null;
    Interpolation.reset();
  }

  function handleRefundProcessed(data) {
    alert(`Refund processed for ${data.reason}`);
    showScreen('lobby');
    currentLobbyId = null;
  }

  function handleError(data) {
    console.error('Server error:', data);
    alert(`Error: ${data.message}`);
  }

  function handlePingUpdate(ping) {
    document.getElementById('ping-value').textContent = ping;
    document.getElementById('game-ping-value').textContent = ping;
  }

  // ============================================
  // UI Rendering
  // ============================================

  function renderLobbyList(lobbies) {
    const container = document.getElementById('lobby-list');
    container.innerHTML = '';

    for (const lobby of lobbies) {
      const item = document.createElement('div');
      item.className = 'lobby-item';

      const statusClass = lobby.status === 'waiting' ? 'waiting' :
        lobby.status === 'in_progress' ? 'in-progress' : '';

      const statusText = lobby.status === 'empty' ? `${lobby.playerCount}/3` :
        lobby.status === 'waiting' ? `${lobby.playerCount}/3 - Waiting` :
          lobby.status === 'in_progress' ? 'In Progress' : `${lobby.playerCount}/3`;

      const joinDisabled = lobby.status === 'in_progress' || lobby.playerCount >= 3;
      const joinText = devMode ? 'Join (Free)' : 'Join (1 USDC)';

      item.innerHTML = `
        <div class="lobby-info">
          <span class="lobby-name">Lobby #${lobby.id}</span>
          <span class="lobby-status ${statusClass}">${statusText}</span>
        </div>
        <div class="lobby-actions">
          <button class="btn btn-primary join-btn"
                  ${joinDisabled ? 'disabled' : ''}
                  data-lobby-id="${lobby.id}"
                  data-deposit-address="${lobby.depositAddress}">
            ${joinText}
          </button>
          ${devMode ? `
            <button class="btn btn-secondary add-bots-btn"
                    ${lobby.status === 'in_progress' || lobby.playerCount >= 3 ? 'disabled' : ''}
                    data-lobby-id="${lobby.id}">
              +Bots
            </button>
          ` : ''}
        </div>
      `;

      const joinBtn = item.querySelector('.join-btn');
      if (devMode) {
        joinBtn.addEventListener('click', () => handleDevJoin(lobby.id));
      } else {
        joinBtn.addEventListener('click', () => showPaymentModal(lobby.id, lobby.depositAddress));
      }

      if (devMode) {
        const botsBtn = item.querySelector('.add-bots-btn');
        if (botsBtn) {
          botsBtn.addEventListener('click', () => handleAddBots(lobby.id));
        }
      }

      container.appendChild(item);
    }
  }

  /**
   * Handle dev mode join (no payment required)
   */
  function handleDevJoin(lobbyId) {
    const fakeTxHash = `0xdev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    Network.joinLobby(lobbyId, fakeTxHash);
  }

  /**
   * Handle adding bots to a lobby
   */
  async function handleAddBots(lobbyId) {
    try {
      const res = await fetch('/api/bot/fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId }),
      });
      const data = await res.json();
      if (data.success) {
        console.log(`Added ${data.botsAdded} bots to lobby ${lobbyId}`);
      } else {
        console.error('Failed to add bots:', data.error);
      }
    } catch (e) {
      console.error('Failed to add bots:', e);
    }
  }

  function updateWaitingScreen(lobbyId, players, timeRemaining) {
    document.getElementById('current-lobby-id').textContent = lobbyId;

    // Update player slots
    const slotsContainer = document.getElementById('player-slots');
    slotsContainer.innerHTML = '';

    const myId = Network.getUserId();

    for (let i = 0; i < 3; i++) {
      const player = players[i];
      const slot = document.createElement('div');

      if (player) {
        const isYou = player.id === myId;
        slot.className = `player-slot ${isYou ? 'you' : ''}`;
        slot.textContent = player.username + (isYou ? ' (You)' : '');
      } else {
        slot.className = 'player-slot empty';
        slot.textContent = 'Waiting...';
      }

      slotsContainer.appendChild(slot);
    }

    // Update timer
    const timerDisplay = document.getElementById('timeout-display');
    if (timeRemaining !== null && timeRemaining > 0) {
      const minutes = Math.floor(timeRemaining / 60000);
      const seconds = Math.floor((timeRemaining % 60000) / 1000);
      timerDisplay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')} until refund available`;
    } else if (timeRemaining === 0) {
      timerDisplay.textContent = 'Refund available';
      document.getElementById('refund-btn').classList.remove('hidden');
    } else {
      timerDisplay.textContent = `Waiting for players... ${players.length}/3`;
    }
  }

  function showPaymentModal(lobbyId, depositAddress) {
    currentLobbyId = lobbyId;
    document.getElementById('join-lobby-id').textContent = lobbyId;
    document.getElementById('deposit-address').textContent = depositAddress;
    document.getElementById('payment-status').classList.add('hidden');
    document.getElementById('send-payment-btn').disabled = false;
    paymentModal.classList.remove('hidden');
  }

  function hidePaymentModal() {
    paymentModal.classList.add('hidden');
  }

  // ============================================
  // Game Loop
  // ============================================

  let gameLoopId = null;

  // Arena constants for client-side prediction (must match server)
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const PLAYER_RADIUS = 22;

  /**
   * Clamp position to arena bounds (same as server)
   */
  function clampToArena(x, y) {
    return {
      x: Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, x)),
      y: Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, y)),
    };
  }

  function startGameLoop() {
    if (gameLoopId) return; // Prevent multiple game loops

    const gameState = { effects: [] };
    let loopCount = 0;

    function loop() {
      // Update local player position based on input
      const target = Input.getTarget();

      // Simple client-side prediction (move toward target)
      const currentPos = Interpolation.getPosition(Network.getUserId());

      // Debug first few loops
      if (loopCount < 5) {
        console.log('[DEBUG] Game loop #' + loopCount + ' - target:', target.x.toFixed(1), target.y.toFixed(1),
                    'currentPos:', currentPos ? currentPos.x.toFixed(1) + ',' + currentPos.y.toFixed(1) : 'null');
        loopCount++;
      }

      if (currentPos) {
        // For responsive feel, move directly toward mouse cursor
        // The server will enforce the actual speed limit and reconcile
        const clamped = clampToArena(target.x, target.y);
        Interpolation.updateLocalPosition(clamped.x, clamped.y);
      }

      // Render
      Renderer.render(gameState);

      gameLoopId = requestAnimationFrame(loop);
    }

    loop();
  }

  function stopGameLoop() {
    if (gameLoopId) {
      cancelAnimationFrame(gameLoopId);
      gameLoopId = null;
    }
  }

  // ============================================
  // Auto-reconnect on page load
  // ============================================

  async function tryAutoReconnect() {
    const token = localStorage.getItem('sessionToken');
    if (token) {
      try {
        await Network.connect(token);
        showScreen('lobby');
      } catch (error) {
        console.log('Auto-reconnect failed, showing landing');
        localStorage.removeItem('sessionToken');
      }
    }
  }

  // Public API
  return {
    init,
    showScreen,
    tryAutoReconnect,
  };
})();
