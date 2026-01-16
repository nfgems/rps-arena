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

  // Track if local position has been initialized from server
  let localPositionInitialized = false;

  // Callback when position is first initialized
  let onPositionInitializedCallback = null;

  /**
   * Set the local player ID for special handling
   */
  function setLocalPlayer(playerId, initialX, initialY) {
    localPlayerId = playerId;
    // If initial position provided, use it; otherwise reset to wait for server
    if (initialX !== undefined && initialY !== undefined) {
      localPlayerPosition.x = initialX;
      localPlayerPosition.y = initialY;
      localPositionInitialized = true;
    } else {
      localPositionInitialized = false; // Reset so we snap to server position on first snapshot
    }
  }

  /**
   * Set callback for when local position is first initialized from server
   */
  function onPositionInitialized(callback) {
    onPositionInitializedCallback = callback;
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
        // If not initialized, snap to server position immediately
        if (!localPositionInitialized) {
          localPlayerPosition.x = serverPlayer.x;
          localPlayerPosition.y = serverPlayer.y;
          localPositionInitialized = true;
          // Notify callback so input can be initialized with correct position
          if (onPositionInitializedCallback) {
            onPositionInitializedCallback(serverPlayer.x, serverPlayer.y);
          }
          return;
        }

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
    // For local player, use predicted position if initialized
    if (playerId === localPlayerId) {
      // If not initialized yet, try to get from current snapshot
      if (!localPositionInitialized && currentSnapshot) {
        const serverPlayer = currentSnapshot.players.find(p => p.id === localPlayerId);
        if (serverPlayer) {
          localPlayerPosition.x = serverPlayer.x;
          localPlayerPosition.y = serverPlayer.y;
          localPositionInitialized = true;
        }
      }
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

  // Debug counter
  let getPlayersCount = 0;

  /**
   * Get all players with interpolated positions
   */
  function getPlayers() {
    if (!currentSnapshot) return [];

    const result = currentSnapshot.players.map(player => {
      const pos = getPosition(player.id);
      const isLocal = player.id === localPlayerId;

      // Debug local player position
      if (isLocal && getPlayersCount < 10) {
        console.log('[DEBUG] getPlayers - local player pos:', pos ? pos.x.toFixed(1) + ',' + pos.y.toFixed(1) : 'null',
                    'snapshot pos:', player.x.toFixed(1) + ',' + player.y.toFixed(1),
                    'localPlayerPosition:', localPlayerPosition.x.toFixed(1) + ',' + localPlayerPosition.y.toFixed(1));
        getPlayersCount++;
      }

      return {
        id: player.id,
        role: player.role,
        alive: player.alive,
        x: pos ? pos.x : player.x,
        y: pos ? pos.y : player.y,
        isLocal: isLocal,
      };
    });

    return result;
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
    localPositionInitialized = false;
    onPositionInitializedCallback = null;
  }

  // Public API
  return {
    setLocalPlayer,
    onPositionInitialized,
    onSnapshot,
    updateLocalPosition,
    getPosition,
    getPlayers,
    getCurrentTick,
    reset,
  };
})();
