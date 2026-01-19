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
const BOUNCE_DISTANCE = 10;
const LARGE_BOUNCE_DISTANCE = 25;
const MAX_BOUNCE_ITERATIONS = 2;

// Debug flag (set DEBUG_PHYSICS=true in environment to enable verbose logging)
const DEBUG_PHYSICS = process.env.DEBUG_PHYSICS === 'true';

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
 * Check if two moving circles collided during a tick (swept collision)
 * This catches cases where players pass through each other between frames
 * @param {Object} p1Start - Player 1 start position {x, y}
 * @param {Object} p1End - Player 1 end position {x, y}
 * @param {Object} p2Start - Player 2 start position {x, y}
 * @param {Object} p2End - Player 2 end position {x, y}
 * @returns {boolean} True if circles collided at any point during movement
 */
function sweptCircleCollision(p1Start, p1End, p2Start, p2End) {
  const collisionDist = PLAYER_RADIUS * 2;

  // Relative motion: treat p1 as stationary and p2 as moving
  const relStartX = p2Start.x - p1Start.x;
  const relStartY = p2Start.y - p1Start.y;
  const relEndX = p2End.x - p1End.x;
  const relEndY = p2End.y - p1End.y;

  // Direction of relative motion
  const relDx = relEndX - relStartX;
  const relDy = relEndY - relStartY;

  // Quadratic coefficients for distance squared over time t in [0,1]
  // dist^2(t) = |relStart + t * relD|^2
  const a = relDx * relDx + relDy * relDy;
  const b = 2 * (relStartX * relDx + relStartY * relDy);
  const c = relStartX * relStartX + relStartY * relStartY - collisionDist * collisionDist;

  // Check if already overlapping at start
  if (c <= 0) return true;

  // Check if overlapping at end
  const endDistSq = relEndX * relEndX + relEndY * relEndY;
  if (endDistSq <= collisionDist * collisionDist) return true;

  // If no relative motion, no collision (already checked endpoints)
  if (a < 0.0001) return false;

  // Find minimum distance during motion using calculus
  // d/dt(dist^2) = 2at + b = 0 => t = -b/(2a)
  const tMin = -b / (2 * a);

  // Check if minimum is within [0, 1]
  if (tMin > 0 && tMin < 1) {
    const minDistSq = a * tMin * tMin + b * tMin + c;
    if (minDistSq <= 0) return true;
  }

  return false;
}

/**
 * Determine the loser in an RPS collision
 * @param {string} role1 - Role of player 1
 * @param {string} role2 - Role of player 2
 * @returns {number} 1 if player 1 loses, 2 if player 2 loses, 0 if same role or invalid
 */
function getRpsLoser(role1, role2) {
  // Guard against undefined/null roles
  if (!role1 || !role2) {
    console.error(`[ERROR] getRpsLoser called with invalid roles: role1=${role1}, role2=${role2}`);
    return 0;
  }
  if (BEATS[role1] === role2) return 2; // Player 1 wins, Player 2 loses
  if (BEATS[role2] === role1) return 1; // Player 2 wins, Player 1 loses
  return 0; // Same role
}

/**
 * Process collisions for all alive players
 * Uses swept collision detection to catch collisions that occur during movement
 * @param {Array} players - Array of player objects with {id, x, y, alive, role, prevX, prevY}
 * @param {boolean} showdownMode - If true, all collisions result in bounce (no eliminations)
 * @returns {Object} { type: 'none'|'elimination'|'bounce', eliminations, bouncedPlayers }
 */
function processCollisions(players, showdownMode = false) {
  const alive = players.filter(p => p.alive);
  const eliminations = [];
  const sameRolePairs = [];

  // Debug: Log when 2 players remain (only when close to reduce spam)
  if (DEBUG_PHYSICS && alive.length === 2) {
    const p1 = alive[0];
    const p2 = alive[1];
    const d = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
    if (d < 70) {
      console.log(`[COLLISION] 2 alive: ${p1.role}(${p1.id.slice(-4)}) at (${p1.x.toFixed(0)},${p1.y.toFixed(0)}) vs ${p2.role}(${p2.id.slice(-4)}) at (${p2.x.toFixed(0)},${p2.y.toFixed(0)}), dist=${d.toFixed(1)}`);
    }
  }

  // Check all pairs for overlaps
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const p1 = alive[i];
      const p2 = alive[j];

      const dist = getDistance(p1, p2);
      const overlapping = isOverlapping(p1, p2);

      // Also check swept collision (if previous positions are available)
      const p1Prev = { x: p1.prevX ?? p1.x, y: p1.prevY ?? p1.y };
      const p2Prev = { x: p2.prevX ?? p2.x, y: p2.prevY ?? p2.y };
      const sweptCollision = sweptCircleCollision(p1Prev, p1, p2Prev, p2);

      // Debug when players are close (within 100 pixels when only 2 alive)
      if (DEBUG_PHYSICS && dist < 100 && alive.length === 2) {
        console.log(`[DEBUG] Final 2 players: ${p1.role}(${p1.id.slice(-4)}) at (${p1.x.toFixed(1)},${p1.y.toFixed(1)}) prev=(${p1Prev.x.toFixed(1)},${p1Prev.y.toFixed(1)}) vs ${p2.role}(${p2.id.slice(-4)}) at (${p2.x.toFixed(1)},${p2.y.toFixed(1)}) prev=(${p2Prev.x.toFixed(1)},${p2Prev.y.toFixed(1)}), dist=${dist.toFixed(1)}, overlapping=${overlapping}, swept=${sweptCollision}, threshold=${PLAYER_RADIUS * 2}`);
      }

      // Use swept collision OR endpoint overlap
      if (overlapping || sweptCollision) {
        // In showdown mode, ALL collisions result in bounce (no eliminations)
        if (showdownMode) {
          if (DEBUG_PHYSICS) console.log(`[DEBUG] SHOWDOWN collision - bouncing ${p1.role} vs ${p2.role}`);
          sameRolePairs.push([p1, p2]);
        } else {
          const loser = getRpsLoser(p1.role, p2.role);
          if (DEBUG_PHYSICS) {
            console.log(`[DEBUG] COLLISION DETECTED (overlap=${overlapping}, swept=${sweptCollision}) at dist=${dist.toFixed(1)}: ${p1.role}(${p1.id.slice(-4)}) vs ${p2.role}(${p2.id.slice(-4)}), getRpsLoser=${loser}`);
          }
          if (loser === 1) {
            if (DEBUG_PHYSICS) console.log(`[DEBUG] -> ${p1.role} loses to ${p2.role}`);
            eliminations.push({ winner: p2, loser: p1 });
          } else if (loser === 2) {
            if (DEBUG_PHYSICS) console.log(`[DEBUG] -> ${p2.role} loses to ${p1.role}`);
            eliminations.push({ winner: p1, loser: p2 });
          } else {
            // Same role = bounce apart instead of overlapping
            if (DEBUG_PHYSICS) console.log(`[DEBUG] -> Same role collision (loser=0) - bouncing ${p1.role} vs ${p2.role}`);
            sameRolePairs.push([p1, p2]);
          }
        }
      }
    }
  }

  // Bounce apart same-role collisions
  const bouncedPlayers = [];
  for (const [p1, p2] of sameRolePairs) {
    // Only bounce if both are still alive (not eliminated this tick)
    if (p1.alive && p2.alive) {
      bounceApart([p1, p2]);
      bouncedPlayers.push(p1, p2);
    }
  }

  // No overlaps or no eliminations
  if (eliminations.length === 0) {
    return {
      type: bouncedPlayers.length > 0 ? 'bounce' : 'none',
      eliminations: [],
      bouncedPlayers: [...new Set(bouncedPlayers)], // Deduplicate
    };
  }

  // Process all eliminations (even multiple simultaneous ones)
  const processedEliminations = [];
  if (DEBUG_PHYSICS && eliminations.length > 0) {
    console.log(`[DEBUG] Processing ${eliminations.length} elimination(s)`);
  }
  for (const { winner, loser } of eliminations) {
    if (DEBUG_PHYSICS) {
      console.log(`[DEBUG] Elimination candidate: ${winner.role}(${winner.id.slice(-4)}) beats ${loser.role}(${loser.id.slice(-4)}), loser.alive=${loser.alive}`);
    }
    // Only eliminate if loser is still alive (not already eliminated this tick)
    if (loser.alive) {
      if (DEBUG_PHYSICS) console.log(`[DEBUG] ELIMINATING ${loser.role}(${loser.id.slice(-4)})!`);
      loser.alive = false;
      processedEliminations.push({
        winnerId: winner.id,
        loserId: loser.id,
        winnerRole: winner.role,
        loserRole: loser.role,
      });
    } else {
      if (DEBUG_PHYSICS) console.log(`[DEBUG] Skipping elimination - loser already dead`);
    }
  }

  return {
    type: processedEliminations.length > 0 ? 'elimination' : (bouncedPlayers.length > 0 ? 'bounce' : 'none'),
    eliminations: processedEliminations,
    bouncedPlayers: [...new Set(bouncedPlayers)], // Deduplicate
  };
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
 * Calculate random spawn positions for 3 players with minimum distance
 * @returns {Array} Array of {x, y} positions
 */
function calculateSpawnPositions() {
  const minDistance = 150; // Minimum distance between any two players
  const padding = PLAYER_RADIUS + 10; // Keep away from arena edges

  const positions = [];
  const maxAttempts = 100;

  for (let i = 0; i < 3; i++) {
    let attempts = 0;
    let validPosition = null;

    while (attempts < maxAttempts) {
      // Generate random position within padded arena bounds
      const x = padding + Math.random() * (ARENA_WIDTH - 2 * padding);
      const y = padding + Math.random() * (ARENA_HEIGHT - 2 * padding);

      // Check distance from all existing positions
      let isValid = true;
      for (const pos of positions) {
        const dx = x - pos.x;
        const dy = y - pos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < minDistance) {
          isValid = false;
          break;
        }
      }

      if (isValid) {
        validPosition = { x, y };
        break;
      }

      attempts++;
    }

    // Fallback: if no valid position found, use triangle formation
    if (!validPosition) {
      const centerX = ARENA_WIDTH / 2;
      const centerY = ARENA_HEIGHT / 2;
      const angle = (i * 2 * Math.PI) / 3 + Math.random() * Math.PI * 2;
      validPosition = {
        x: centerX + Math.cos(angle) * minDistance,
        y: centerY + Math.sin(angle) * minDistance,
      };
    }

    positions.push(validPosition);
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
// Showdown Mode - Heart Spawning & Capture
// ============================================

// Minimum distance between hearts to prevent overlap
const MIN_HEART_DISTANCE = 50;

// Heart capture radius (player must be within this distance to capture)
const HEART_RADIUS = 25;

/**
 * Generate random heart positions for showdown mode
 * Hearts spawn at random locations with minimum distance between them
 * @param {number} count - Number of hearts to spawn (default 3)
 * @returns {Array} Array of heart objects [{id, x, y, captured: false}, ...]
 */
function spawnHearts(count = 3) {
  const hearts = [];
  const padding = PLAYER_RADIUS + HEART_RADIUS + 10; // Keep away from arena edges
  const maxAttempts = 100;

  for (let i = 0; i < count; i++) {
    let attempts = 0;
    let validPosition = null;

    while (attempts < maxAttempts) {
      // Generate random position within padded arena bounds
      const x = padding + Math.random() * (ARENA_WIDTH - 2 * padding);
      const y = padding + Math.random() * (ARENA_HEIGHT - 2 * padding);

      // Check distance from all existing hearts
      let isValid = true;
      for (const heart of hearts) {
        const dx = x - heart.x;
        const dy = y - heart.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < MIN_HEART_DISTANCE) {
          isValid = false;
          break;
        }
      }

      if (isValid) {
        validPosition = { x, y };
        break;
      }

      attempts++;
    }

    // Fallback: if no valid position found after max attempts, use spaced grid
    if (!validPosition) {
      const gridX = (i + 1) * (ARENA_WIDTH / (count + 1));
      const gridY = ARENA_HEIGHT / 2 + (Math.random() - 0.5) * 200;
      validPosition = { x: gridX, y: gridY };
    }

    hearts.push({
      id: i,
      x: validPosition.x,
      y: validPosition.y,
      captured: false,
      capturedBy: null,
    });
  }

  return hearts;
}

/**
 * Check if a player is touching a heart (for capture)
 * Uses multiple checks: current position, target position, and swept collision
 * @param {Object} player - Player object with {x, y, prevX, prevY, targetX, targetY}
 * @param {Object} heart - Heart object with {x, y, captured}
 * @returns {boolean} True if player is touching or passed through the heart
 */
function isPlayerTouchingHeart(player, heart) {
  if (heart.captured) return false;

  const captureRadius = PLAYER_RADIUS + HEART_RADIUS;

  // Check current position
  const dx = player.x - heart.x;
  const dy = player.y - heart.y;
  const currentDist = Math.sqrt(dx * dx + dy * dy);

  if (currentDist <= captureRadius) {
    return true;
  }

  // Check if player's TARGET (mouse position) is on the heart
  // This makes capture feel instant when you click/hover on a heart
  if (player.targetX !== undefined && player.targetY !== undefined) {
    const targetDx = player.targetX - heart.x;
    const targetDy = player.targetY - heart.y;
    const targetDist = Math.sqrt(targetDx * targetDx + targetDy * targetDy);

    // If mouse is on the heart and player is close enough to reach it this tick
    if (targetDist <= captureRadius && currentDist <= captureRadius + MAX_DELTA_PER_TICK) {
      return true;
    }
  }

  // Swept collision: check if player passed through heart during movement
  // Heart is stationary, so we check if the line segment from prevPos to currentPos
  // comes within captureRadius of the heart center
  const prevX = player.prevX ?? player.x;
  const prevY = player.prevY ?? player.y;

  // Vector from prev to current position
  const moveX = player.x - prevX;
  const moveY = player.y - prevY;
  const moveLengthSq = moveX * moveX + moveY * moveY;

  // If player didn't move, only current position matters (already checked)
  if (moveLengthSq < 0.001) {
    return false;
  }

  // Vector from prev position to heart center
  const toHeartX = heart.x - prevX;
  const toHeartY = heart.y - prevY;

  // Project heart onto movement line: t = dot(toHeart, move) / |move|^2
  // t=0 is at prevPos, t=1 is at currentPos
  const t = Math.max(0, Math.min(1, (toHeartX * moveX + toHeartY * moveY) / moveLengthSq));

  // Closest point on movement line segment to heart
  const closestX = prevX + t * moveX;
  const closestY = prevY + t * moveY;

  // Distance from closest point to heart
  const closestDx = closestX - heart.x;
  const closestDy = closestY - heart.y;
  const closestDist = Math.sqrt(closestDx * closestDx + closestDy * closestDy);

  return closestDist <= captureRadius;
}

/**
 * Process heart captures for all alive players
 * Uses swept collision detection to catch fast-moving players
 * @param {Array} players - Array of player objects
 * @param {Array} hearts - Array of heart objects
 * @returns {Array} Array of capture events [{playerId, heartId}, ...]
 */
function processHeartCaptures(players, hearts) {
  const captures = [];
  const alive = players.filter(p => p.alive);

  for (const player of alive) {
    for (const heart of hearts) {
      if (!heart.captured && isPlayerTouchingHeart(player, heart)) {
        heart.captured = true;
        heart.capturedBy = player.id;
        captures.push({
          playerId: player.id,
          heartId: heart.id,
        });
      }
    }
  }

  return captures;
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
  sweptCircleCollision,

  // Bounce
  bounceApart,

  // Spawn
  calculateSpawnPositions,
  shuffleRoles,
  seededRandom,

  // Showdown mode
  spawnHearts,
  processHeartCaptures,
  HEART_RADIUS,
};
