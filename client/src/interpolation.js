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
  const BLEND_SPEED = 0.15; // How fast to blend local player toward server position

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

        if (distance > 50) {
          // Large discrepancy, snap closer
          localPlayerPosition.x += dx * 0.3;
          localPlayerPosition.y += dy * 0.3;
        } else if (distance > 5) {
          // Small discrepancy, blend smoothly
          localPlayerPosition.x += dx * BLEND_SPEED;
          localPlayerPosition.y += dy * BLEND_SPEED;
        }
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

    // For other players, interpolate between snapshots
    if (!previousSnapshot || !currentSnapshot) {
      if (currentSnapshot) {
        const player = currentSnapshot.players.find(p => p.id === playerId);
        return player ? { x: player.x, y: player.y } : null;
      }
      return null;
    }

    const prev = previousSnapshot.players.find(p => p.id === playerId);
    const curr = currentSnapshot.players.find(p => p.id === playerId);

    if (!prev || !curr) {
      return curr ? { x: curr.x, y: curr.y } : null;
    }

    // Calculate interpolation factor
    const elapsed = performance.now() - snapshotTime;
    const t = Math.min(elapsed / SNAPSHOT_INTERVAL, 1);

    return {
      x: prev.x + (curr.x - prev.x) * t,
      y: prev.y + (curr.y - prev.y) * t,
    };
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
