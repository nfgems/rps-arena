/**
 * Application Logger for RPS Arena
 * Uses Winston for structured logging with environment-controlled log levels
 */

const winston = require('winston');
const path = require('path');

// Log levels (from most to least severe)
// error: 0, warn: 1, info: 2, http: 3, debug: 4
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, category, ...meta }) => {
    const categoryTag = category ? `[${category}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${categoryTag} ${message}${metaStr}`;
  })
);

// Format for file output (JSON for easy parsing)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Create transports array
const transports = [
  // Console transport - always enabled
  new winston.transports.Console({
    format: consoleFormat,
  }),
];

// Add file transports in production
if (process.env.NODE_ENV === 'production') {
  const logsDir = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');

  // Error log - only errors
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    })
  );

  // Combined log - all levels up to configured level
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
    })
  );
}

// Create the main logger
const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports,
  // Don't exit on error
  exitOnError: false,
});

/**
 * Create a child logger with a specific category
 * @param {string} category - Category name (e.g., 'MATCH', 'AUTH', 'PAYMENT')
 * @returns {Object} Logger with category pre-set
 */
function createLogger(category) {
  return {
    error: (message, meta = {}) => logger.error(message, { category, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { category, ...meta }),
    info: (message, meta = {}) => logger.info(message, { category, ...meta }),
    http: (message, meta = {}) => logger.http(message, { category, ...meta }),
    debug: (message, meta = {}) => logger.debug(message, { category, ...meta }),
  };
}

// Pre-configured loggers for common categories
const loggers = {
  server: createLogger('SERVER'),
  match: createLogger('MATCH'),
  auth: createLogger('AUTH'),
  payment: createLogger('PAYMENT'),
  lobby: createLogger('LOBBY'),
  database: createLogger('DATABASE'),
  physics: createLogger('PHYSICS'),
  session: createLogger('SESSION'),
  alerts: createLogger('ALERTS'),
  bot: createLogger('BOT'),
};

module.exports = {
  // Main logger instance
  logger,
  // Factory for custom category loggers
  createLogger,
  // Pre-configured category loggers
  ...loggers,
};
