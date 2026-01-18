/**
 * Sentry Error Tracking Integration for RPS Arena
 *
 * Provides error tracking, performance monitoring, and crash reporting.
 * Only initializes if SENTRY_DSN is set in environment variables.
 */

let Sentry = null;
let initialized = false;

/**
 * Initialize Sentry if DSN is configured
 * Should be called at the very start of the application
 */
function init() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.log('[SENTRY] No SENTRY_DSN configured - error tracking disabled');
    return false;
  }

  try {
    Sentry = require('@sentry/node');

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.npm_package_version || '1.0.0',

      // Performance monitoring - sample rate (1.0 = 100%)
      // Production: 5% sampling for cost efficiency (M-2)
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.05 : 1.0,

      // Only send errors in production by default
      enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_ENABLED === 'true',

      // Scrub sensitive data
      beforeSend(event) {
        // Remove wallet mnemonics and keys from error reports
        if (event.extra) {
          delete event.extra.TREASURY_MNEMONIC;
          delete event.extra.LOBBY_WALLET_SEED;
          delete event.extra.WALLET_ENCRYPTION_KEY;
        }
        return event;
      },

      // Ignore common non-critical errors
      ignoreErrors: [
        // WebSocket close errors (normal disconnections)
        'WebSocket is not open',
        'WebSocket was closed before the connection was established',
        // Rate limit errors (expected)
        'Rate limit exceeded',
      ],

      // Additional context
      initialScope: {
        tags: {
          app: 'rps-arena',
          component: 'server',
        },
      },
    });

    initialized = true;
    console.log('[SENTRY] Error tracking initialized');
    return true;
  } catch (error) {
    console.error('[SENTRY] Failed to initialize:', error.message);
    return false;
  }
}

/**
 * Capture an exception and send to Sentry
 * @param {Error} error - The error to capture
 * @param {Object} context - Additional context
 */
function captureException(error, context = {}) {
  if (!initialized || !Sentry) {
    // Log locally if Sentry not available
    console.error('[ERROR]', error.message, context);
    return;
  }

  Sentry.withScope((scope) => {
    // Add context as extra data
    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });

    // Add tags for filtering
    if (context.category) {
      scope.setTag('category', context.category);
    }
    if (context.matchId) {
      scope.setTag('matchId', context.matchId);
    }
    if (context.lobbyId) {
      scope.setTag('lobbyId', context.lobbyId);
    }
    if (context.userId) {
      scope.setUser({ id: context.userId });
    }

    Sentry.captureException(error);
  });
}

/**
 * Capture a message (non-error event)
 * @param {string} message - The message
 * @param {'info'|'warning'|'error'} level - Severity level
 * @param {Object} context - Additional context
 */
function captureMessage(message, level = 'info', context = {}) {
  if (!initialized || !Sentry) {
    console.log(`[${level.toUpperCase()}]`, message, context);
    return;
  }

  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });

    Sentry.captureMessage(message, level);
  });
}

/**
 * Set user context for subsequent events
 * @param {Object} user - User info { id, walletAddress, username }
 */
function setUser(user) {
  if (!initialized || !Sentry) return;

  Sentry.setUser({
    id: user.id,
    username: user.username,
    // Don't send wallet address as it's PII
  });
}

/**
 * Clear user context
 */
function clearUser() {
  if (!initialized || !Sentry) return;
  Sentry.setUser(null);
}

/**
 * Add breadcrumb for debugging
 * @param {Object} breadcrumb - { category, message, level, data }
 */
function addBreadcrumb(breadcrumb) {
  if (!initialized || !Sentry) return;

  Sentry.addBreadcrumb({
    category: breadcrumb.category || 'default',
    message: breadcrumb.message,
    level: breadcrumb.level || 'info',
    data: breadcrumb.data,
  });
}

/**
 * Start a transaction for performance monitoring
 * @param {string} name - Transaction name
 * @param {string} op - Operation type
 * @returns {Object|null} Transaction object or null
 */
function startTransaction(name, op) {
  if (!initialized || !Sentry) return null;

  return Sentry.startSpan({
    name,
    op,
  });
}

/**
 * Flush all pending events (call before shutdown)
 * @param {number} timeout - Timeout in ms
 */
async function flush(timeout = 2000) {
  if (!initialized || !Sentry) return;

  try {
    await Sentry.flush(timeout);
    console.log('[SENTRY] Flushed pending events');
  } catch (error) {
    console.error('[SENTRY] Failed to flush:', error.message);
  }
}

/**
 * Express error handler middleware
 * Use as the last error handler in Express
 */
function expressErrorHandler() {
  if (!initialized || !Sentry) {
    // Return a basic error handler if Sentry not available
    return (err, req, res, next) => {
      console.error('[EXPRESS ERROR]', err);
      res.status(500).json({ error: 'Internal server error' });
    };
  }

  return Sentry.expressErrorHandler();
}

/**
 * Check if Sentry is initialized
 */
function isInitialized() {
  return initialized;
}

module.exports = {
  init,
  captureException,
  captureMessage,
  setUser,
  clearUser,
  addBreadcrumb,
  startTransaction,
  flush,
  expressErrorHandler,
  isInitialized,
};
