/**
 * Interpolation for RPS Arena
 * Smooth player movement between server snapshots
 */

const Interpolation = (function () {
  // State
  let previousSnapshot = null;
  let currentSnapshot = null;
  let snapshotTime = 0;
  let localPlayerId = null;
  let localPlayerPosition = { x: 0, y: 0 };

  // Constants
  const SNAPSHOT_INTERVAL = 50; // 20 Hz = 50ms between snapshots
  const BLEND_SPEED = 0.15; // How fast to blend local player toward server position (reduced for smoother feel)

  /**
   * Set the local player ID for special handling
   */
  function setLocalPlayer(playerId) {
    localPlayerId = playerId;
  }

  /**
   * Process incoming snapshot
   */
  function onSnapshot(snapshot) {
    previousSnapshot = currentSnapshot;
    currentSnapshot = snapshot;
    snapshotTime = performance.now();

    // Update local player position (for server reconciliation)
    if (localPlayerId && currentSnapshot) {
      const serverPlayer = currentSnapshot.players.find(p => p.id === localPlayerId);
      if (serverPlayer) {
        // Blend toward server position if significantly different
        const dx = serverPlayer.x - localPlayerPosition.x;
        const dy = serverPlayer.y - localPlayerPosition.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 150) {
          // Very large discrepancy (teleport/spawn), snap immediately
          localPlayerPosition.x = serverPlayer.x;
          localPlayerPosition.y = serverPlayer.y;
        } else if (distance > 80) {
          // Large discrepancy, blend moderately
          localPlayerPosition.x += dx * 0.3;
          localPlayerPosition.y += dy * 0.3;
        } else if (distance > 40) {
          // Medium discrepancy, blend slowly
          localPlayerPosition.x += dx * BLEND_SPEED;
          localPlayerPosition.y += dy * BLEND_SPEED;
        }
        // Small discrepancies (< 40px) are ignored - trust client prediction
      }
    }
  }

  /**
   * Update local player position (client-side prediction)
   */
  function updateLocalPosition(x, y) {
    localPlayerPosition.x = x;
    localPlayerPosition.y = y;
  }

  /**
   * Get interpolated position for a player
   */
  function getPosition(playerId) {
    // For local player, use predicted position
    if (playerId === localPlayerId) {
      return { ...localPlayerPosition };
    }

    // For other players, extrapolate from current snapshot
    if (!currentSnapshot) {
      return null;
    }

    const curr = currentSnapshot.players.find(p => p.id === playerId);
    if (!curr) {
      return null;
    }

    // If we have a previous snapshot, extrapolate based on velocity
    if (previousSnapshot) {
      const prev = previousSnapshot.players.find(p => p.id === playerId);
      if (prev) {
        // Calculate velocity from last two snapshots
        const vx = curr.x - prev.x;
        const vy = curr.y - prev.y;

        // Extrapolate forward based on time since snapshot
        const elapsed = performance.now() - snapshotTime;
        const t = elapsed / SNAPSHOT_INTERVAL;

        // Extrapolate but cap at reasonable amount (1.5 snapshots worth)
        const cappedT = Math.min(t, 1.5);

        return {
          x: curr.x + vx * cappedT,
          y: curr.y + vy * cappedT,
        };
      }
    }

    return { x: curr.x, y: curr.y };
  }

  /**
   * Get all players with interpolated positions
   */
  function getPlayers() {
    if (!currentSnapshot) return [];

    return currentSnapshot.players.map(player => {
      const pos = getPosition(player.id);
      return {
        id: player.id,
        role: player.role,
        alive: player.alive,
        x: pos ? pos.x : player.x,
        y: pos ? pos.y : player.y,
        isLocal: player.id === localPlayerId,
      };
    });
  }

  /**
   * Get current snapshot tick
   */
  function getCurrentTick() {
    return currentSnapshot ? currentSnapshot.tick : 0;
  }

  /**
   * Reset state
   */
  function reset() {
    previousSnapshot = null;
    currentSnapshot = null;
    snapshotTime = 0;
    localPlayerPosition = { x: 0, y: 0 };
  }

  // Public API
  return {
    setLocalPlayer,
    onSnapshot,
    updateLocalPosition,
    getPosition,
    getPlayers,
    getCurrentTick,
    reset,
  };
})();
