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
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});
