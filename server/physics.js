/**
 * Physics engine for RPS Arena
 * Movement, collision detection, and bounce mechanics
 */

// Game constants (can be overridden via environment)
const ARENA_WIDTH = parseInt(process.env.GAME_ARENA_WIDTH || '1600');
const ARENA_HEIGHT = parseInt(process.env.GAME_ARENA_HEIGHT || '900');
const MAX_SPEED = parseInt(process.env.GAME_MAX_SPEED || '450');
const PLAYER_RADIUS = parseInt(process.env.GAME_PLAYER_RADIUS || '22');
const TICK_RATE = parseInt(process.env.GAME_TICK_RATE || '30');

// Derived constants
const MAX_DELTA_PER_TICK = MAX_SPEED / TICK_RATE;
const BOUNCE_DISTANCE = 30;
const LARGE_BOUNCE_DISTANCE = 100;
const MAX_BOUNCE_ITERATIONS = 3;

// RPS win table: winner[attacker] = victim
const BEATS = {
  rock: 'scissors',
  scissors: 'paper',
  paper: 'rock',
};

// ============================================
// Movement
// ============================================

/**
 * Calculate new position moving toward target
 * @param {Object} current - Current position {x, y}
 * @param {Object} target - Target position {x, y}
 * @param {boolean} frozen - Whether player is frozen
 * @returns {Object} New position {x, y}
 */
function moveTowardTarget(current, target, frozen = false) {
  if (frozen) {
    return { x: current.x, y: current.y };
  }

  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance <= MAX_DELTA_PER_TICK) {
    // Can reach target this tick
    return clampToArena(target.x, target.y);
  }

  // Move at max speed toward target
  const ratio = MAX_DELTA_PER_TICK / distance;
  const newX = current.x + dx * ratio;
  const newY = current.y + dy * ratio;

  return clampToArena(newX, newY);
}

/**
 * Clamp position to arena bounds
 */
function clampToArena(x, y) {
  return {
    x: Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, x)),
    y: Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, y)),
  };
}

// ============================================
// Collision Detection
// ============================================

/**
 * Check if two players are overlapping
 * @param {Object} p1 - Player 1 with {x, y}
 * @param {Object} p2 - Player 2 with {x, y}
 * @returns {boolean} True if overlapping
 */
function isOverlapping(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance <= (PLAYER_RADIUS * 2);
}

/**
 * Get distance between two players
 */
function getDistance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Determine the loser in an RPS collision
 * @param {string} role1 - Role of player 1
 * @param {string} role2 - Role of player 2
 * @returns {number} 1 if player 1 loses, 2 if player 2 loses, 0 if same role
 */
function getRpsLoser(role1, role2) {
  if (BEATS[role1] === role2) return 2; // Player 1 wins, Player 2 loses
  if (BEATS[role2] === role1) return 1; // Player 2 wins, Player 1 loses
  return 0; // Same role (shouldn't happen in this game)
}

/**
 * Process collisions for all alive players
 * @param {Array} players - Array of player objects with {id, x, y, alive, role}
 * @returns {Object} { type: 'none'|'elimination'|'bounce', eliminations, bouncedPlayers }
 */
function processCollisions(players) {
  const alive = players.filter(p => p.alive);
  const eliminations = [];
  const overlappingPairs = [];

  // Check all pairs for overlaps
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const p1 = alive[i];
      const p2 = alive[j];

      if (isOverlapping(p1, p2)) {
        overlappingPairs.push([p1, p2]);

        const loser = getRpsLoser(p1.role, p2.role);
        if (loser === 1) {
          eliminations.push({ winner: p2, loser: p1 });
        } else if (loser === 2) {
          eliminations.push({ winner: p1, loser: p2 });
        }
      }
    }
  }

  // No overlaps
  if (overlappingPairs.length === 0) {
    return { type: 'none', eliminations: [], bouncedPlayers: [] };
  }

  // Contested tick: 2+ eliminations would occur
  if (eliminations.length >= 2) {
    // Get all players involved in overlaps
    const involvedPlayers = new Set();
    for (const [p1, p2] of overlappingPairs) {
      involvedPlayers.add(p1);
      involvedPlayers.add(p2);
    }

    const bouncedPlayers = bounceApart(Array.from(involvedPlayers));
    return { type: 'bounce', eliminations: [], bouncedPlayers };
  }

  // Single elimination
  if (eliminations.length === 1) {
    const { winner, loser } = eliminations[0];
    loser.alive = false;
    return {
      type: 'elimination',
      eliminations: [{
        winnerId: winner.id,
        loserId: loser.id,
        winnerRole: winner.role,
        loserRole: loser.role,
      }],
      bouncedPlayers: [],
    };
  }

  // Overlapping but no eliminations (same role - shouldn't happen)
  return { type: 'none', eliminations: [], bouncedPlayers: [] };
}

// ============================================
// Bounce Mechanics
// ============================================

/**
 * Bounce overlapping players apart
 * @param {Array} players - Players to bounce
 * @returns {Array} Players with updated positions
 */
function bounceApart(players) {
  let iterations = 0;
  let bounceDistance = BOUNCE_DISTANCE;

  while (iterations < MAX_BOUNCE_ITERATIONS) {
    // Calculate center of mass
    const com = {
      x: players.reduce((sum, p) => sum + p.x, 0) / players.length,
      y: players.reduce((sum, p) => sum + p.y, 0) / players.length,
    };

    // Push each player away from COM
    for (const player of players) {
      const dx = player.x - com.x;
      const dy = player.y - com.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > 0) {
        const pushX = (dx / distance) * bounceDistance;
        const pushY = (dy / distance) * bounceDistance;
        const newPos = clampToArena(player.x + pushX, player.y + pushY);
        player.x = newPos.x;
        player.y = newPos.y;
      } else {
        // Players at exact same position, push in random direction
        const angle = Math.random() * Math.PI * 2;
        const newPos = clampToArena(
          player.x + Math.cos(angle) * bounceDistance,
          player.y + Math.sin(angle) * bounceDistance
        );
        player.x = newPos.x;
        player.y = newPos.y;
      }
    }

    // Check if still overlapping
    let stillOverlapping = false;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        if (isOverlapping(players[i], players[j])) {
          stillOverlapping = true;
          break;
        }
      }
      if (stillOverlapping) break;
    }

    if (!stillOverlapping) {
      break;
    }

    iterations++;

    // Escalation: increase bounce distance
    if (iterations === MAX_BOUNCE_ITERATIONS) {
      bounceDistance = LARGE_BOUNCE_DISTANCE;
      // One more attempt with larger distance
      continue;
    }
  }

  return players;
}

// ============================================
// Spawn Positions
// ============================================

/**
 * Calculate equidistant spawn positions for 3 players
 * @param {number} seed - Random seed for rotation offset
 * @returns {Array} Array of {x, y} positions
 */
function calculateSpawnPositions(seed) {
  const centerX = ARENA_WIDTH / 2;
  const centerY = ARENA_HEIGHT / 2;
  const spawnRadius = 300;

  // Use seed for deterministic random rotation
  const rng = seededRandom(seed);
  const rotationOffset = rng() * Math.PI * 2;

  const positions = [];
  const baseAngles = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]; // 0°, 120°, 240°

  for (const baseAngle of baseAngles) {
    const angle = baseAngle + rotationOffset;
    positions.push({
      x: centerX + Math.cos(angle) * spawnRadius,
      y: centerY + Math.sin(angle) * spawnRadius,
    });
  }

  return positions;
}

/**
 * Shuffle roles for random assignment
 * @param {number} seed - Random seed
 * @returns {Array} Shuffled roles ['rock', 'paper', 'scissors']
 */
function shuffleRoles(seed) {
  const rng = seededRandom(seed);
  const roles = ['rock', 'paper', 'scissors'];

  // Fisher-Yates shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

/**
 * Simple seeded random number generator
 * @param {number} seed - Integer seed
 * @returns {Function} Random function returning 0-1
 */
function seededRandom(seed) {
  let state = seed;
  return function () {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Constants
  ARENA_WIDTH,
  ARENA_HEIGHT,
  MAX_SPEED,
  PLAYER_RADIUS,
  TICK_RATE,
  MAX_DELTA_PER_TICK,
  BEATS,

  // Movement
  moveTowardTarget,
  clampToArena,

  // Collision
  isOverlapping,
  getDistance,
  getRpsLoser,
  processCollisions,

  // Bounce
  bounceApart,

  // Spawn
  calculateSpawnPositions,
  shuffleRoles,
  seededRandom,
};
