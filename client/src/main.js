/**
 * Main entry point for RPS Arena client
 */

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('RPS Arena client starting...');

  // Check if ethers is available (from CDN or bundled)
  if (typeof ethers === 'undefined') {
    // Load ethers from CDN
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.11.0/ethers.umd.min.js';
    script.onload = initializeApp;
    script.onerror = () => {
      console.error('Failed to load ethers library');
      alert('Failed to load required libraries. Please refresh the page.');
    };
    document.head.appendChild(script);
  } else {
    initializeApp();
  }
});

/**
 * Initialize the application
 */
function initializeApp() {
  console.log('Initializing RPS Arena...');

  // Initialize UI
  UI.init();

  // Try auto-reconnect if we have a session
  UI.tryAutoReconnect();

  // Handle visibility change (pause/resume when tab is hidden)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.log('Tab hidden');
    } else {
      console.log('Tab visible');
    }
  });

  // Handle beforeunload
  window.addEventListener('beforeunload', (event) => {
    // Warn if in a match
    if (Input.isEnabled()) {
      event.preventDefault();
      event.returnValue = 'You are in a match! Leaving will eliminate you.';
    }
  });

  console.log('RPS Arena initialized');
}

/**
 * Global error handler
 */
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  showErrorToUser('An unexpected error occurred. Please refresh the page if the game becomes unresponsive.');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  showErrorToUser('A connection or processing error occurred. Please check your connection and try again.');
});

/**
 * Show user-friendly error notification
 */
function showErrorToUser(message) {
  // Avoid spamming errors - only show one at a time
  if (document.querySelector('.global-error-toast')) return;

  const toast = document.createElement('div');
  toast.className = 'global-error-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #dc3545;
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 10000;
    max-width: 400px;
    text-align: center;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.remove();
  }, 5000);
}
