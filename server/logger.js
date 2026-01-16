/**
 * Match event logger for RPS Arena
 * Logs all match events for replay and audit
 */

const db = require('./database');

/**
 * Log a match start event
 */
function logMatchStart(matchId, tick, players) {
  db.logMatchEvent(matchId, tick, 'start', {
    players: players.map(p => ({
      id: p.id,
      role: p.role,
      spawnX: p.x,
      spawnY: p.y,
    })),
  });
}

/**
 * Log an elimination event
 */
function logElimination(matchId, tick, eliminatorId, eliminatedId, positions) {
  db.logMatchEvent(matchId, tick, 'elimination', {
    eliminatorId,
    eliminatedId,
    positions: positions.map(p => ({
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      alive: p.alive,
    })),
  });
}

/**
 * Log a bounce event (contested tick)
 */
function logBounce(matchId, tick, players) {
  db.logMatchEvent(matchId, tick, 'bounce', {
    players: players.map(p => ({
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
    })),
  });
}

/**
 * Log a disconnect event
 */
function logDisconnect(matchId, tick, userId, reason) {
  db.logMatchEvent(matchId, tick, 'disconnect', {
    userId,
    reason,
  });
}

/**
 * Log match end event
 */
function logMatchEnd(matchId, tick, winnerId, reason) {
  db.logMatchEvent(matchId, tick, 'end', {
    winnerId,
    reason,
  });
}

/**
 * Get all events for a match (for replay)
 */
function getMatchEvents(matchId) {
  return db.getMatchEvents(matchId);
}

module.exports = {
  logMatchStart,
  logElimination,
  logBounce,
  logDisconnect,
  logMatchEnd,
  getMatchEvents,
};
