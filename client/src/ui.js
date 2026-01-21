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
  let currentLobbyId = null; // Set only after server confirms join via LOBBY_UPDATE
  let pendingLobbyId = null; // Lobby ID while payment modal is open (not yet confirmed)
  let myRole = null;
  let devMode = false;
  let spawnPosition = { x: 800, y: 450 }; // Default to center, updated by role assignment
  let cachedLobbies = []; // Cache lobby list for re-rendering when returning to lobby screen

  // Showdown mode state
  let showdownState = null; // { hearts: [], scores: {}, showText: bool, textProgress: number, freezeEndTime: number }

  // Preview phase state (3-second map preview before game starts)
  let inPreviewPhase = false;

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
    screens.tutorial = document.getElementById('tutorial-screen');

    paymentModal = document.getElementById('payment-modal');

    // Check for mobile
    if (isMobile()) {
      showScreen('mobileBlock');
      return;
    }

    // Set up event listeners
    setupEventListeners();

    // Clean up resources on page unload
    window.addEventListener('beforeunload', handlePageUnload);

    // Check dev mode
    checkDevMode();

    console.log('UI initialized');
  }

  /**
   * Clean up resources when page is unloading
   */
  function handlePageUnload() {
    stopGameLoop();
    if (typeof Renderer !== 'undefined' && Renderer.destroy) {
      Renderer.destroy();
    }
    if (typeof Input !== 'undefined' && Input.destroy) {
      Input.destroy();
    }
    if (typeof Interpolation !== 'undefined' && Interpolation.destroy) {
      Interpolation.destroy();
    }
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

    // Dev reset button (only shown in dev mode)
    document.getElementById('dev-reset-btn').addEventListener('click', handleDevReset);

    // Payment modal buttons
    document.getElementById('send-payment-btn').addEventListener('click', handleSendPayment);
    document.getElementById('cancel-join-btn').addEventListener('click', hidePaymentModal);
    document.getElementById('copy-address-btn').addEventListener('click', handleCopyAddress);

    // Event delegation for lobby list buttons (prevents listener accumulation on re-render)
    document.getElementById('lobby-list').addEventListener('click', handleLobbyListClick);

    // Tab navigation
    document.getElementById('nav-lobbies').addEventListener('click', () => showTab('lobbies'));
    document.getElementById('nav-how-to-play').addEventListener('click', () => showTab('how-to-play'));
    document.getElementById('nav-leaderboard').addEventListener('click', () => showTab('leaderboard'));
    document.getElementById('nav-profile').addEventListener('click', () => showTab('profile'));

    // How to Play modal (landing page)
    document.getElementById('how-to-play-btn').addEventListener('click', showHowToPlayModal);
    document.getElementById('close-how-to-play-btn').addEventListener('click', hideHowToPlayModal);
    document.getElementById('how-to-play-modal').addEventListener('click', (e) => {
      if (e.target.id === 'how-to-play-modal') hideHowToPlayModal();
    });

    // Profile actions
    document.getElementById('edit-username-btn').addEventListener('click', showUsernameModal);
    document.getElementById('save-username-btn').addEventListener('click', handleSaveUsername);
    document.getElementById('cancel-username-btn').addEventListener('click', hideUsernameModal);
    document.getElementById('change-photo-btn').addEventListener('click', () => document.getElementById('photo-input').click());
    document.getElementById('photo-input').addEventListener('change', handlePhotoUpload);

    // Leaderboard filters
    document.getElementById('filter-all').addEventListener('click', () => loadLeaderboard('all'));
    document.getElementById('filter-monthly').addEventListener('click', () => loadLeaderboard('monthly'));
    document.getElementById('filter-weekly').addEventListener('click', () => loadLeaderboard('weekly'));

    // Tutorial buttons
    document.getElementById('start-tutorial-btn').addEventListener('click', handleStartTutorial);
    document.getElementById('tutorial-exit-btn').addEventListener('click', handleExitTutorial);
    document.getElementById('tutorial-complete-btn').addEventListener('click', handleTutorialComplete);
    document.getElementById('tutorial-restart-btn').addEventListener('click', handleRestartTutorial);
    document.getElementById('how-to-play-tutorial-btn').addEventListener('click', handleStartTutorial);

    // Network event listeners
    Network.addEventListener('LOBBY_LIST', handleLobbyList);
    Network.addEventListener('LOBBY_UPDATE', handleLobbyUpdate);
    Network.addEventListener('LOBBY_COUNTDOWN', handleLobbyCountdown);
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
    Network.addEventListener('PLAYER_DISCONNECT', handlePlayerDisconnect);
    Network.addEventListener('PLAYER_RECONNECT', handlePlayerReconnect);
    Network.addEventListener('RECONNECT_STATE', handleReconnectState);
    Network.addEventListener('SHOWDOWN_START', handleShowdownStart);
    Network.addEventListener('SHOWDOWN_READY', handleShowdownReady);
    Network.addEventListener('HEART_CAPTURED', handleHeartCaptured);

    // Wallet change handlers - prevent account switching during active match
    window.addEventListener('wallet:accountChanged', handleWalletAccountChanged);
    window.addEventListener('wallet:disconnected', handleWalletDisconnected);
    window.addEventListener('wallet:wrongNetwork', handleWalletWrongNetwork);
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

    // Hide footer during fullscreen game modes (tutorial, game, countdown)
    const fullscreenModes = ['tutorial', 'game', 'countdown'];
    if (fullscreenModes.includes(screenName)) {
      document.body.classList.add('hide-footer');
    } else {
      document.body.classList.remove('hide-footer');
    }

    // Re-render lobby list when returning to lobby screen (updates join button states)
    if (screenName === 'lobby' && cachedLobbies.length > 0) {
      renderLobbyList(cachedLobbies);
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

      // Build SIWE message for authentication
      const domain = window.location.host;
      const origin = window.location.origin;
      const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const issuedAt = new Date().toISOString();
      const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

      const message = `${domain} wants you to sign in with your Ethereum account:
${address}

Sign in to RPS Arena

URI: ${origin}
Version: 1
Chain ID: 8453
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;

      const signature = await Wallet.signMessage(message);

      // Authenticate with server
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, signature, message }),
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error);
      }

      // Store session token
      sessionStorage.setItem('sessionToken', data.token);

      // Connect WebSocket
      await Network.connect(data.token);

      // Update UI
      document.getElementById('user-display').textContent = data.user.username || Wallet.truncateAddress(address);

      // Show lobby screen
      showScreen('lobby');

    } catch (error) {
      console.error('Connection failed:', error);
      // Don't show alert for user cancellation
      if (error.message !== 'User cancelled connection') {
        alert('Failed to connect: ' + error.message);
      }
    } finally {
      const btn = document.getElementById('connect-wallet-btn');
      btn.disabled = false;
      btn.textContent = 'Connect Wallet';
    }
  }

  function handleDisconnect() {
    Wallet.disconnect();
    Network.disconnect();
    sessionStorage.removeItem('sessionToken');
    showScreen('landing');
  }

  function handleRefund() {
    if (currentLobbyId) {
      Network.requestRefund(currentLobbyId);
    }
  }

  function handlePlayAgain() {
    Confetti.stop();
    showScreen('lobby');
  }

  // ============================================
  // Tutorial Handlers
  // ============================================

  function handleStartTutorial() {
    // Check if connected to server
    if (!Network.isConnected()) {
      alert('Please connect your wallet first to access the tutorial.');
      return;
    }

    // Start the tutorial
    if (typeof Tutorial !== 'undefined') {
      Tutorial.start();
    } else {
      console.error('Tutorial module not loaded');
    }
  }

  function handleExitTutorial() {
    if (typeof Tutorial !== 'undefined') {
      Tutorial.end();
    }
    showScreen('lobby');
  }

  function handleTutorialComplete() {
    if (typeof Tutorial !== 'undefined') {
      Tutorial.cleanup();
    }
    // Hide the complete overlay
    document.getElementById('tutorial-complete-overlay').classList.add('hidden');
    showScreen('lobby');
  }

  function handleRestartTutorial() {
    // End current tutorial and start a new one
    if (typeof Tutorial !== 'undefined') {
      Tutorial.end();
      // Small delay to let server clean up, then restart
      setTimeout(() => {
        Tutorial.start();
      }, 100);
    }
  }

  async function handleDevReset() {
    // Reset lobby and go back to lobby screen for quick re-testing
    Confetti.stop();
    try {
      await fetch('/api/dev/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: 1 }),
      });
      showScreen('lobby');
    } catch (err) {
      console.error('Dev reset failed:', err);
      showScreen('lobby');
    }
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

      // Send to server (use pendingLobbyId, not currentLobbyId)
      Network.joinLobby(pendingLobbyId, txHash);

      // Hide modal (server will confirm via LOBBY_UPDATE which sets currentLobbyId)
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
    cachedLobbies = data.lobbies;
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

  function handleLobbyCountdown(data) {
    const { lobbyId, secondsRemaining } = data;

    // Only update if we're in this lobby and on the waiting screen
    if (currentLobbyId !== lobbyId) return;

    // Update the lobby countdown display
    const countdownDisplay = document.getElementById('lobby-countdown');
    const timerDisplay = document.getElementById('timeout-display');

    if (countdownDisplay) {
      countdownDisplay.classList.remove('hidden');
      const countdownNumber = document.getElementById('lobby-countdown-number');
      if (countdownNumber) {
        countdownNumber.textContent = secondsRemaining;
      }
    }

    // Update the timer display text
    if (timerDisplay) {
      timerDisplay.textContent = `Match starting in ${secondsRemaining}...`;
    }
  }

  function handleMatchStarting(data) {
    // Hide lobby countdown when transitioning to match
    const lobbyCountdown = document.getElementById('lobby-countdown');
    if (lobbyCountdown) {
      lobbyCountdown.classList.add('hidden');
    }

    showScreen('countdown');

    // Reset preview phase state
    inPreviewPhase = false;

    // Set initial countdown from server data
    const countdownNumber = document.getElementById('countdown-number');
    countdownNumber.textContent = data.countdown || 10;

    // Initialize countdown canvas
    const canvas = document.getElementById('countdown-canvas');
    Renderer.init(canvas);
  }

  function handleRoleAssignment(data) {
    myRole = data.role;

    // Store spawn position for when game actually starts
    spawnPosition = { x: data.spawnX, y: data.spawnY };

    // Role relationships: who each role attacks and should avoid
    const roleRelations = {
      rock: { attacks: 'scissors', avoids: 'paper' },
      paper: { attacks: 'rock', avoids: 'scissors' },
      scissors: { attacks: 'paper', avoids: 'rock' },
    };

    const relations = roleRelations[data.role];

    // Draw role icons on tutorial canvases
    const yourIcon = document.getElementById('your-role-icon');
    const attackIcon = document.getElementById('attack-role-icon');
    const avoidIcon = document.getElementById('avoid-role-icon');

    Renderer.drawRoleIconOnCanvas(yourIcon, data.role);
    Renderer.drawRoleIconOnCanvas(attackIcon, relations.attacks);
    Renderer.drawRoleIconOnCanvas(avoidIcon, relations.avoids);

    // Set role names with color classes
    const yourName = document.getElementById('your-role-name');
    const attackName = document.getElementById('attack-role-name');
    const avoidName = document.getElementById('avoid-role-name');

    yourName.textContent = data.role.toUpperCase();
    yourName.className = `role-name ${data.role}`;

    attackName.textContent = relations.attacks.toUpperCase();
    attackName.className = `role-name ${relations.attacks}`;

    avoidName.textContent = relations.avoids.toUpperCase();
    avoidName.className = `role-name ${relations.avoids}`;

    // Animate the icons during countdown
    startTutorialAnimation(yourIcon, attackIcon, avoidIcon, data.role, relations);
  }

  // Animation for tutorial icons during countdown
  let tutorialAnimationId = null;

  function startTutorialAnimation(yourIcon, attackIcon, avoidIcon, role, relations) {
    // Cancel any existing animation
    if (tutorialAnimationId) {
      cancelAnimationFrame(tutorialAnimationId);
    }

    function animate() {
      Renderer.drawRoleIconOnCanvas(yourIcon, role);
      Renderer.drawRoleIconOnCanvas(attackIcon, relations.attacks);
      Renderer.drawRoleIconOnCanvas(avoidIcon, relations.avoids);
      tutorialAnimationId = requestAnimationFrame(animate);
    }

    animate();
  }

  function stopTutorialAnimation() {
    if (tutorialAnimationId) {
      cancelAnimationFrame(tutorialAnimationId);
      tutorialAnimationId = null;
    }
  }

  function handleCountdown(data) {
    const secondsRemaining = data.secondsRemaining;

    // Phase 1: Tutorial screen (10-4 seconds)
    // Phase 2: Map preview (3-1 seconds)
    // Phase 3: GO! (0 seconds)

    if (secondsRemaining > 3) {
      // Phase 1: Update tutorial countdown
      const countdownNumber = document.getElementById('countdown-number');
      countdownNumber.textContent = secondsRemaining;
    } else if (secondsRemaining > 0 && !inPreviewPhase) {
      // Transition to Phase 2: Map preview
      inPreviewPhase = true;
      stopTutorialAnimation();

      showScreen('game');

      // Initialize game canvas
      const gameCanvas = document.getElementById('game-canvas');
      Renderer.init(gameCanvas);
      Input.init(gameCanvas);

      // Set up interpolation but DON'T start sending input yet
      Input.setPosition(spawnPosition.x, spawnPosition.y);
      Interpolation.setLocalPlayer(Network.getUserId(), spawnPosition.x, spawnPosition.y);

      // Show the GET READY overlay
      const overlay = document.getElementById('get-ready-overlay');
      overlay.classList.remove('hidden');

      // Update preview countdown
      const previewCountdown = document.getElementById('preview-countdown');
      previewCountdown.textContent = secondsRemaining;

      // Enable player highlight during preview
      Renderer.setPreviewMode(true, Network.getUserId());

      // Start render loop (for preview - no input yet)
      startGameLoop();
    } else if (secondsRemaining > 0 && inPreviewPhase) {
      // Still in Phase 2: Update preview countdown
      const previewCountdown = document.getElementById('preview-countdown');
      previewCountdown.textContent = secondsRemaining;
    } else if (secondsRemaining === 0) {
      // Phase 3: GO! - Start the game
      const previewCountdown = document.getElementById('preview-countdown');
      previewCountdown.textContent = 'GO!';

      // Disable preview mode highlight
      Renderer.setPreviewMode(false, null);

      // Hide overlay after a brief moment
      setTimeout(() => {
        const overlay = document.getElementById('get-ready-overlay');
        overlay.classList.add('hidden');
        inPreviewPhase = false;
      }, 500);

      // NOW start sending input - game begins!
      Input.startSending();
    }
  }

  function handleSnapshot(data) {
    Interpolation.onSnapshot(data);
  }

  function handleElimination(data) {
    // Check if we were eliminated
    if (data.eliminatedId === Network.getUserId()) {
      Input.stopSending();
    }
  }

  function handleBounce(data) {
    // Bounce events received - could add visual effects here
  }

  function handleMatchEnd(data) {
    Input.stopSending();

    const myId = Network.getUserId();
    const isWinner = data.winnerId === myId;

    // Update result screen content (but don't show yet)
    const title = document.getElementById('result-title');
    title.textContent = isWinner ? 'VICTORY!' : 'DEFEATED';
    title.className = isWinner ? 'victory' : 'defeat';

    const payout = document.getElementById('result-payout');
    payout.textContent = isWinner ? '+2.4 USDC' : '';
    payout.className = isWinner ? 'payout' : 'payout none';

    // Show dev reset button only in dev mode
    const devResetBtn = document.getElementById('dev-reset-btn');
    if (devMode) {
      devResetBtn.classList.remove('hidden');
    } else {
      devResetBtn.classList.add('hidden');
    }

    // Delay showing result screen so player can see the final heart capture
    // Game loop keeps running briefly for visual feedback
    const showResultDelay = showdownState ? 500 : 0; // 500ms delay if in showdown mode

    setTimeout(() => {
      stopGameLoop();
      Input.destroy();
      Renderer.destroy();
      showScreen('result');

      // Reset state
      currentLobbyId = null;
      myRole = null;
      showdownState = null;
      Interpolation.reset();
    }, showResultDelay);
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

  function handlePlayerDisconnect(data) {
    // Another player disconnected - show visual indicator
    const playerId = data.playerId;
    const graceRemaining = data.graceRemaining;

    console.log(`Player ${playerId} disconnected, ${graceRemaining}s grace period`);

    // Update interpolation to mark player as disconnected (for visual indicator)
    Interpolation.markPlayerDisconnected(playerId, graceRemaining);
  }

  function handlePlayerReconnect(data) {
    // Another player reconnected
    const playerId = data.playerId;

    console.log(`Player ${playerId} reconnected`);

    // Update interpolation to mark player as connected
    Interpolation.markPlayerReconnected(playerId);
  }

  function handleReconnectState(data) {
    // We reconnected to an in-progress match - restore game state
    console.log('Reconnected to match:', data.matchId);

    myRole = data.role;

    // Update role display
    document.getElementById('role-display').textContent = myRole.toUpperCase();
    document.getElementById('role-display').style.color = roleColors[myRole] || '#ffffff';

    // Initialize game systems if not already running
    if (currentScreen !== 'game') {
      showScreen('game');
      Renderer.init(document.getElementById('game-canvas'));
      Input.init(document.getElementById('game-canvas'));
      Interpolation.init();
      Input.startSending();
      startGameLoop();
    }

    // Apply the reconnect snapshot
    Interpolation.onSnapshot({
      tick: data.tick,
      players: data.players,
    });

    // Mark disconnected players
    for (const player of data.players) {
      if (!player.connected && player.alive) {
        Interpolation.markPlayerDisconnected(player.id, 0);
      }
    }
  }

  function handleShowdownStart(data) {
    console.log('SHOWDOWN_START received - freeze phase', data);

    // Initialize showdown state with freeze (no hearts yet)
    const freezeDuration = data.freezeDuration || 3000;

    showdownState = {
      hearts: [], // Hearts come later with SHOWDOWN_READY
      scores: {},
      showText: true, // Show "SHOWDOWN" text
      textProgress: 0,
      freezeEndTime: Date.now() + freezeDuration,
    };

    // Animate the "SHOWDOWN" text appearing
    const startTime = Date.now();
    const textAnimDuration = 500; // 500ms for text to fully appear

    function animateShowdownText() {
      if (!showdownState || !showdownState.showText) return;

      const elapsed = Date.now() - startTime;
      showdownState.textProgress = Math.min(1, elapsed / textAnimDuration);

      if (elapsed < freezeDuration) {
        requestAnimationFrame(animateShowdownText);
      }
    }

    requestAnimationFrame(animateShowdownText);
  }

  function handleShowdownReady(data) {
    console.log('SHOWDOWN - hearts spawned, race begins!', data);

    // Update showdown state: hide text, add hearts
    if (showdownState) {
      showdownState.hearts = data.hearts.map(h => ({ ...h, captured: false }));
      showdownState.showText = false; // Hide "SHOWDOWN" text, show hearts
    } else {
      // If somehow we missed SHOWDOWN_START, initialize state now
      showdownState = {
        hearts: data.hearts.map(h => ({ ...h, captured: false })),
        scores: {},
        showText: false,
      };
    }
  }

  function handleHeartCaptured(data) {
    console.log('Heart captured:', data);

    if (!showdownState) return;

    // Mark heart as captured
    const heart = showdownState.hearts.find(h => h.id === data.heartId);
    if (heart) {
      heart.captured = true;
    }

    // Update player score
    showdownState.scores[data.playerId] = data.playerScore;

    // Trigger confetti immediately when someone wins (collects 2nd heart)
    if (data.playerScore >= 2) {
      Confetti.start(3000); // 3 second celebration
    }
  }

  function handleWalletAccountChanged(event) {
    const newAddress = event.detail;
    console.log('Wallet account changed to:', newAddress);

    // If in a match, this is a forfeit - just disconnect
    if (currentScreen === 'game') {
      alert('Wallet account changed during match. You have been disconnected.');
      Network.disconnect();
      showScreen('landing');
    } else {
      // Not in match - re-authenticate with new wallet
      Network.disconnect();
      showScreen('landing');
    }
  }

  function handleWalletDisconnected() {
    console.log('Wallet disconnected');

    // If in a match, this is a forfeit
    if (currentScreen === 'game') {
      alert('Wallet disconnected during match. You have been disconnected from the game.');
    }

    Network.disconnect();
    showScreen('landing');
  }

  function handleWalletWrongNetwork() {
    console.log('Wallet switched to wrong network');
    alert('Please switch back to Base network to continue playing.');
  }

  // ============================================
  // UI Rendering
  // ============================================

  function renderLobbyList(lobbies) {
    const container = document.getElementById('lobby-list');
    container.innerHTML = '';

    // Check if player is already in a lobby (prevents joining multiple lobbies)
    const alreadyInLobby = currentLobbyId !== null;

    for (const lobby of lobbies) {
      const item = document.createElement('div');
      item.className = 'lobby-item';

      const statusClass = lobby.status === 'waiting' ? 'waiting' :
        lobby.status === 'in_progress' ? 'in-progress' : '';

      const statusText = lobby.status === 'empty' ? `${lobby.playerCount}/3` :
        lobby.status === 'waiting' ? `${lobby.playerCount}/3 - Waiting` :
          lobby.status === 'in_progress' ? 'In Progress' : `${lobby.playerCount}/3`;

      // Disable join if: in progress, full, OR player is already in another lobby
      const joinDisabled = lobby.status === 'in_progress' || lobby.playerCount >= 3 || alreadyInLobby;
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

      // No individual event listeners needed - using event delegation on lobby-list container
      container.appendChild(item);
    }
  }

  /**
   * Handle clicks on lobby list buttons (event delegation)
   */
  function handleLobbyListClick(event) {
    const target = event.target;

    // Handle join button clicks
    if (target.classList.contains('join-btn') && !target.disabled) {
      const lobbyId = parseInt(target.dataset.lobbyId, 10);
      const depositAddress = target.dataset.depositAddress;

      if (devMode) {
        handleDevJoin(lobbyId);
      } else {
        showPaymentModal(lobbyId, depositAddress);
      }
      return;
    }

    // Handle add bots button clicks (dev mode only)
    if (target.classList.contains('add-bots-btn') && !target.disabled) {
      const lobbyId = parseInt(target.dataset.lobbyId, 10);
      handleAddBots(lobbyId);
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
    const lobbyCountdown = document.getElementById('lobby-countdown');

    // Hide lobby countdown by default (will be shown by handleLobbyCountdown)
    if (lobbyCountdown) {
      lobbyCountdown.classList.add('hidden');
    }

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
    pendingLobbyId = lobbyId; // Store pending lobby (not confirmed yet)
    document.getElementById('join-lobby-id').textContent = lobbyId;
    document.getElementById('deposit-address').textContent = depositAddress;
    document.getElementById('payment-status').classList.add('hidden');
    document.getElementById('send-payment-btn').disabled = false;
    paymentModal.classList.remove('hidden');
  }

  function hidePaymentModal() {
    paymentModal.classList.add('hidden');
    pendingLobbyId = null; // Clear pending lobby when modal closes
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

    const gameState = { effects: [], showdown: null, localPlayerId: null };

    // Client-side prediction constants (match server physics)
    const MAX_SPEED = 450; // pixels per second
    const TICK_RATE = 30;
    const MAX_DELTA_PER_TICK = MAX_SPEED / TICK_RATE;

    let lastFrameTime = performance.now();

    function loop() {
      const now = performance.now();
      const deltaTime = (now - lastFrameTime) / 1000; // Convert to seconds
      lastFrameTime = now;

      // Get current direction from keyboard input
      const direction = Input.getDirection();

      // Client-side prediction: move in the direction at server speed
      // Skip movement if frozen during showdown text display
      const isFrozen = showdownState && showdownState.showText;
      const currentPos = Interpolation.getPosition(Network.getUserId());

      if (currentPos && !isFrozen && (direction.dx !== 0 || direction.dy !== 0)) {
        // Normalize diagonal movement
        let moveX = direction.dx;
        let moveY = direction.dy;
        if (direction.dx !== 0 && direction.dy !== 0) {
          const diagonalFactor = 1 / Math.sqrt(2);
          moveX *= diagonalFactor;
          moveY *= diagonalFactor;
        }

        // Apply movement (scale by deltaTime for frame-rate independence)
        const newX = currentPos.x + moveX * MAX_SPEED * deltaTime;
        const newY = currentPos.y + moveY * MAX_SPEED * deltaTime;

        const clamped = clampToArena(newX, newY);
        Interpolation.updateLocalPosition(clamped.x, clamped.y);
      }

      // Update game state with showdown info
      gameState.showdown = showdownState;
      gameState.localPlayerId = Network.getUserId();

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
  // Tab Navigation
  // ============================================

  function showTab(tabName) {
    // Update nav tabs
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
    document.getElementById(`nav-${tabName}`).classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
    document.getElementById(`${tabName}-tab`).classList.remove('hidden');

    // Load data for tab
    if (tabName === 'leaderboard') {
      loadLeaderboard();
    } else if (tabName === 'profile') {
      loadProfile();
    }
  }

  // ============================================
  // Leaderboard
  // ============================================

  let currentLeaderboardPeriod = 'all';

  async function loadLeaderboard(period = currentLeaderboardPeriod) {
    currentLeaderboardPeriod = period;

    // Update active filter button
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`filter-${period}`).classList.add('active');

    const list = document.getElementById('leaderboard-list');
    list.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const response = await fetch(`/api/leaderboard?limit=50&period=${period}`);
      // MEDIUM-6: Check HTTP status before parsing JSON
      if (!response.ok) {
        throw new Error(`Failed to load leaderboard: ${response.status}`);
      }
      const data = await response.json();

      const periodLabel = period === 'all' ? '' : period === 'monthly' ? ' This Month' : ' This Week';

      if (data.leaderboard.length === 0) {
        list.innerHTML = `<p style="text-align: center; color: var(--text-secondary);">No matches${periodLabel.toLowerCase()} yet. Be the first!</p>`;
        return;
      }

      list.innerHTML = `
        <div class="leaderboard-item header">
          <span>Rank</span>
          <span>Player</span>
          <span>Wins</span>
          <span>Win Rate</span>
          <span>Earnings</span>
        </div>
      `;

      data.leaderboard.forEach(player => {
        const item = document.createElement('div');
        item.className = 'leaderboard-item';
        // MEDIUM-2: Use textContent for username to prevent XSS (defense-in-depth)
        item.innerHTML = `
          <span class="leaderboard-rank">#${player.rank}</span>
          <div class="leaderboard-player">
            <span class="leaderboard-username"></span>
            <span class="leaderboard-wallet">${truncateAddress(player.walletAddress)}</span>
          </div>
          <span class="leaderboard-wins">${player.wins}</span>
          <span class="leaderboard-winrate">${player.winRate}%</span>
          <span class="leaderboard-earnings">$${player.totalEarnings.toFixed(2)}</span>
        `;
        // Set username via textContent to prevent XSS
        item.querySelector('.leaderboard-username').textContent =
          player.username || truncateAddress(player.walletAddress);
        list.appendChild(item);
      });
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
      list.innerHTML = '<p style="text-align: center; color: var(--accent);">Failed to load leaderboard</p>';
    }
  }

  // ============================================
  // Profile
  // ============================================

  let currentPlayerStats = null;

  async function loadProfile() {
    const address = Wallet.getAddress();
    if (!address) return;

    // Set wallet display
    document.getElementById('profile-wallet').textContent = truncateAddress(address);

    try {
      const response = await fetch(`/api/player/${address}`);

      if (response.status === 404) {
        // Player hasn't played yet
        showNoMatchesState();
        return;
      }

      const data = await response.json();
      currentPlayerStats = data;

      // Update profile header
      document.getElementById('profile-username').textContent = data.username || truncateAddress(address);

      // Profile photo
      const photoEl = document.getElementById('profile-photo');
      if (data.profilePhoto) {
        photoEl.src = data.profilePhoto;
      } else {
        photoEl.src = generateDefaultAvatar(address);
      }

      // Show edit buttons if player has matches
      if (data.stats.totalMatches > 0) {
        document.getElementById('edit-username-btn').classList.remove('hidden');
        document.getElementById('change-photo-btn').classList.remove('hidden');
        document.getElementById('profile-no-matches').classList.add('hidden');
      } else {
        showNoMatchesState();
      }

      // Update stats
      document.getElementById('stat-matches').textContent = data.stats.totalMatches;
      document.getElementById('stat-wins').textContent = data.stats.wins;
      document.getElementById('stat-winrate').textContent = `${data.stats.winRate}%`;
      document.getElementById('stat-profit').textContent = `$${data.stats.netProfit >= 0 ? '+' : ''}${data.stats.netProfit.toFixed(2)}`;
      document.getElementById('stat-streak').textContent = data.stats.bestWinStreak;

      // Color profit based on value
      const profitEl = document.getElementById('stat-profit');
      profitEl.style.color = data.stats.netProfit >= 0 ? 'var(--success)' : 'var(--accent)';

      // Load match history
      loadMatchHistory(address);

    } catch (error) {
      console.error('Failed to load profile:', error);
    }
  }

  function showNoMatchesState() {
    document.getElementById('profile-no-matches').classList.remove('hidden');
    document.getElementById('edit-username-btn').classList.add('hidden');
    document.getElementById('change-photo-btn').classList.add('hidden');

    // Set default photo
    const address = Wallet.getAddress();
    document.getElementById('profile-photo').src = generateDefaultAvatar(address);

    // Zero stats
    document.getElementById('stat-matches').textContent = '0';
    document.getElementById('stat-wins').textContent = '0';
    document.getElementById('stat-winrate').textContent = '0%';
    document.getElementById('stat-profit').textContent = '$0.00';
    document.getElementById('stat-streak').textContent = '0';

    // Clear match history
    document.getElementById('match-history-list').innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No matches yet</p>';
  }

  async function loadMatchHistory(address) {
    const list = document.getElementById('match-history-list');

    try {
      const response = await fetch(`/api/player/${address}/history?limit=10`);
      // MEDIUM-6: Check HTTP status before parsing JSON
      if (!response.ok) {
        throw new Error(`Failed to load history: ${response.status}`);
      }
      const data = await response.json();

      if (!data.matches || data.matches.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No matches yet</p>';
        return;
      }

      list.innerHTML = '';
      data.matches.forEach(match => {
        const item = document.createElement('div');
        item.className = `match-item ${match.result}`;

        const date = new Date(match.endedAt);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const opponents = match.opponents.map(o => o.username || truncateAddress(o.walletAddress)).join(', ');

        item.innerHTML = `
          <div class="match-details">
            <span class="match-result">${match.result}</span>
            <span class="match-opponents">vs ${opponents}</span>
          </div>
          <div class="match-meta">
            ${match.result === 'win' ? `<span class="match-payout">+$${match.payout.toFixed(2)}</span>` : ''}
            <span class="match-date">${dateStr}</span>
          </div>
        `;
        list.appendChild(item);
      });
    } catch (error) {
      console.error('Failed to load match history:', error);
      list.innerHTML = '<p style="text-align: center; color: var(--accent);">Failed to load history</p>';
    }
  }

  function generateDefaultAvatar(address) {
    // Generate a simple colored avatar based on wallet address
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');

    // Use address to generate color
    const hash = address.slice(2, 8);
    const hue = parseInt(hash, 16) % 360;

    ctx.fillStyle = `hsl(${hue}, 60%, 50%)`;
    ctx.fillRect(0, 0, 100, 100);

    // Add initials or icon
    ctx.fillStyle = 'white';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(address.slice(2, 4).toUpperCase(), 50, 50);

    return canvas.toDataURL();
  }

  // ============================================
  // Username Modal
  // ============================================

  function showUsernameModal() {
    const modal = document.getElementById('username-modal');
    const input = document.getElementById('username-input');
    const error = document.getElementById('username-error');

    input.value = currentPlayerStats?.username || '';
    error.classList.add('hidden');
    modal.classList.remove('hidden');
    input.focus();
  }

  function hideUsernameModal() {
    document.getElementById('username-modal').classList.add('hidden');
  }

  // ============================================
  // How to Play Modal
  // ============================================

  function showHowToPlayModal() {
    document.getElementById('how-to-play-modal').classList.remove('hidden');
  }

  function hideHowToPlayModal() {
    document.getElementById('how-to-play-modal').classList.add('hidden');
  }

  async function handleSaveUsername() {
    const input = document.getElementById('username-input');
    const error = document.getElementById('username-error');
    const btn = document.getElementById('save-username-btn');

    const username = input.value.trim();

    if (!username) {
      error.textContent = 'Username is required';
      error.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    error.classList.add('hidden');

    try {
      const token = sessionStorage.getItem('sessionToken');
      const response = await fetch('/api/player/username', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ username }),
      });

      const data = await response.json();

      if (!response.ok) {
        error.textContent = data.error || 'Failed to save username';
        error.classList.remove('hidden');
        return;
      }

      // Success - update UI
      document.getElementById('profile-username').textContent = data.username;
      document.getElementById('user-display').textContent = data.username;
      hideUsernameModal();

    } catch (err) {
      error.textContent = 'Network error. Please try again.';
      error.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }

  // ============================================
  // Photo Upload
  // ============================================

  async function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    // Validate file size (500KB)
    if (file.size > 500000) {
      alert('Image must be smaller than 500KB');
      return;
    }

    try {
      // Resize and convert to base64
      const photoData = await resizeImage(file, 200, 200);

      const token = sessionStorage.getItem('sessionToken');
      const response = await fetch('/api/player/photo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ photo: photoData }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Failed to upload photo');
        return;
      }

      // Update photo display
      document.getElementById('profile-photo').src = photoData;

    } catch (err) {
      console.error('Photo upload failed:', err);
      alert('Failed to upload photo');
    }

    // Clear input for next upload
    event.target.value = '';
  }

  function resizeImage(file, maxWidth, maxHeight) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.src = e.target.result;
      };

      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Calculate new dimensions
        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };

      img.onerror = reject;
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ============================================
  // Utility
  // ============================================

  function truncateAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  // ============================================
  // Auto-reconnect on page load
  // ============================================

  async function tryAutoReconnect() {
    const token = sessionStorage.getItem('sessionToken');
    if (token) {
      // Also verify wallet is still connected before attempting reconnect
      if (typeof Wallet !== 'undefined' && !Wallet.isConnected()) {
        console.log('Auto-reconnect skipped: wallet not connected');
        sessionStorage.removeItem('sessionToken');
        return;
      }
      try {
        await Network.connect(token);
        showScreen('lobby');
      } catch (error) {
        console.log('Auto-reconnect failed, showing landing');
        sessionStorage.removeItem('sessionToken');
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
