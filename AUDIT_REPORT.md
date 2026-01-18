# RPS-ARENA Code Audit Report

> **Audit Date**: 2026-01-17 (Second Independent Verification)
> **Auditor**: Claude (AI Code Review)
> **Scope**: Full codebase review for bugs, race conditions, memory leaks, and security issues
> **Status**: Pre-Phase 3 audit (double-verified with production checklist cross-reference)

---

## Executive Summary

This audit was conducted before beginning Phase 3 (Code Cleanup) of the production checklist. The goal was to identify bugs and issues that could affect gameplay or cause fund loss.

An independent secondary audit was performed on 2026-01-17 to verify findings and identify additional issues.

### Findings by Severity

| Severity | Original | Verified/Fixed | New Issues | Reclassified | Total Active |
|----------|----------|----------------|------------|--------------|--------------|
| CRITICAL | 9 | 2 fixed (C5, C8) | 6 (C12-C17) | +2 from lower | 15 |
| HIGH | 17 | 0 | 2 (H18-H19) | -1 to CRITICAL (H7) | 18 |
| MEDIUM | 16 | 0 | 0 | -1 to CRITICAL (M7) | 15 |
| LOW | 7 | 0 | 0 | 0 | 7 |

**Total Active Issues: 55**

### Key New Findings (Second Audit)

| ID | Issue | Severity | File |
|----|-------|----------|------|
| NC1 | JSON.parse without try-catch crashes client | CRITICAL | client/src/network.js:49 |
| NC2 | Multiple game loops can run simultaneously | CRITICAL | client/src/ui.js:541-580 |
| NC3 | Renderer/Input.destroy() never called | CRITICAL | client/src/ui.js:337-359 |
| NC4 | BigInt precision loss on USDC amounts | CRITICAL | client/src/wallet.js:140 |
| NC5 | No message size limit before JSON.parse | CRITICAL | server/index.js:297 |
| NC6 | sleepSync blocks event loop | CRITICAL | server/database.js:48-52 |
| NH1 | stuckLobbyAlerts Set unbounded | HIGH | server/lobby.js:509 |
| NH2 | matchTickErrors Map can leak | HIGH | server/match.js |

### Production Checklist Verification

| Checklist Item | Status | Issue |
|----------------|--------|-------|
| Phase 1.1: tx.wait() with MIN_CONFIRMATIONS | **PARTIAL** | Uses tx.wait() but doesn't pass confirmation count |
| Phase 1.4: Alert delivery | **PARTIAL** | No retry mechanism for failed alerts |
| Phase 2.2: sleepSync in database.js | **BROKEN** | Blocks event loop with CPU-intensive busy-wait |

---

## Issues Already Covered by Production Checklist

These issues were found in the audit but are **already planned** in later phases:

| Issue | Checklist Location | Phase |
|-------|-------------------|-------|
| Debug console.log statements | Phase 3.1 | Code Cleanup |
| Hardcoded payout amounts | Phase 3.2 | Code Cleanup |
| Hardcoded rate limits | Phase 3.2 | Code Cleanup |
| `Date.now()` RNG seed | Phase 3.2 | Code Cleanup |
| Circular dependencies match.js/lobby.js | Phase 3.3 | Code Cleanup |
| Reconnection improvements | Phase 4.4 | User Features |
| Error tracking (Sentry) | Phase 5.4 | Infrastructure |
| RPC health check on startup | Phase 5.5 | Infrastructure |
| Security testing (payment bypass) | Phase 6.3 | Testing |
| Edge case: all players disconnect | Phase 6.4 | Testing |
| Edge case: RPC down during payout | Phase 6.4 | Testing |

**Conclusion**: These do NOT need separate fixes - they'll be addressed in their respective phases.

---

## NEW Issues Requiring Fixes (Not in Checklist)

### CRITICAL - Must Fix Before Production

#### C1. Missing `await` on Async Functions - Race Conditions
**Files**: `server/match.js:518, 591, 865, 870`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: Game loop continues while cleanup/payouts happen in background, causing state corruption.

```javascript
// CURRENT (broken)
endMatch(match, stillAlive[0] || null, 'last_standing');

// SHOULD BE
await endMatch(match, stillAlive[0] || null, 'last_standing');
```

**Note**: The game loop is in `setInterval` which can't be async. Need to restructure to handle this properly (set flag, clear interval, then await).

---

#### C2. Race Condition in Player Join Flow - 4+ Players Can Join
**File**: `server/lobby.js:151-246`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: Between player count check (line 163) and payment verification (line 186-196), multiple players can pass both checks simultaneously.

**Fix**: Add mutex/lock or use database transaction with SELECT FOR UPDATE pattern.

---

#### C3. Race Condition in Refund Flow - Double Refunds Possible
**File**: `server/lobby.js:278-396`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: Two concurrent refund requests can both see players as unrefunded, process both, and refund players twice.

**Fix**: Add mutex or check `refunded_at` immediately before each refund in a transaction.

---

#### C4. Memory Leak - Rate Limit Maps Never Cleaned
**File**: `server/index.js:214-233`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: `rateLimits` and `connectionCounts` Maps grow unbounded. Will cause OOM after days/weeks of operation.

**Fix**: Add periodic cleanup (e.g., every hour, remove entries older than 1 hour).

---

#### ~~C5. Client: Wrong Transaction Hash Property~~ ✅ VERIFIED FIXED
**File**: `client/src/wallet.js:150-152`
**Status**: ✅ NOT A BUG - Code is correct
**Verification**: In ethers.js v6, `await tx.wait()` returns a `TransactionReceipt` where `.hash` is the correct property to get the transaction hash. The current code `return receipt.hash;` is correct.

---

#### C6. Concurrent Match Start from Same Lobby
**File**: `server/index.js:469-487`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: Two players joining quickly can both trigger `startMatch()` before status changes to `in_progress`.

**Fix**: Check-and-set lobby status atomically, or add mutex.

---

#### C7. Countdown Timer Not Stored - Leaks on Match Void
**File**: `server/match.js:317-345`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: If match is voided during countdown, `countdownInterval` is never cleared.

**Fix**: Store interval on match object: `match.countdownInterval = setInterval(...)` and clear in `voidMatch()`.

---

#### ~~C8. Player Not Marked `alive=false` After Elimination~~ ✅ VERIFIED FIXED
**File**: `server/physics.js:251`
**Status**: ✅ ALREADY FIXED - Code is correct
**Verification**: The `processCollisions()` function in `physics.js` correctly sets `loser.alive = false;` at line 251 before adding to eliminations array. This issue does not exist in current code.

---

#### C9. Client Event Listener Leaks - Join Buttons
**File**: `client/src/ui.js:381-436`
**Status**: ⚠️ CONFIRMED - Still present
**Impact**: Join buttons add new listeners on every re-render. After several lobby refreshes, clicking fires 10+ times.

**Fix**: Use event delegation on parent container, or remove old listeners before adding new ones.

---

#### C10. Missing SIGTERM Handler (NEW)
**File**: `server/index.js:619-647`
**Status**: 🆕 NEW ISSUE
**Impact**: Docker/Kubernetes sends SIGTERM for graceful shutdown. Missing handler causes unclean shutdowns, potential data loss.

```javascript
// CURRENT - only handles SIGINT
process.on('SIGINT', async () => { ... });

// SHOULD ALSO HAVE
process.on('SIGTERM', async () => { ... });
```

**Fix**: Add SIGTERM handler with same logic as SIGINT handler.

---

#### C11. Disconnect Handler Has No Try-Catch (Elevated from H3)
**File**: `server/index.js:321-334`
**Status**: 🆕 ELEVATED TO CRITICAL
**Impact**: Error in `match.handleDisconnect()` or `lobby.removeConnection()` crashes the WebSocket close handler, potentially leaving server in inconsistent state.

```javascript
// CURRENT (no error handling)
ws.on('close', () => {
  if (currentMatchId) {
    match.handleDisconnect(currentMatchId, userId);
  }
  if (currentLobbyId) {
    lobby.removeConnection(currentLobbyId, userId);
  }
});

// SHOULD BE
ws.on('close', () => {
  try {
    if (currentMatchId) {
      match.handleDisconnect(currentMatchId, userId);
    }
    if (currentLobbyId) {
      lobby.removeConnection(currentLobbyId, userId);
    }
  } catch (error) {
    console.error('Error in disconnect handler:', error);
  }
});
```

---

#### C12. Client JSON.parse Without Try-Catch - Crashes WebSocket (NEW - 2nd Audit)
**File**: `client/src/network.js:49`
**Status**: 🆕 NEW CRITICAL - Elevated from H7
**Impact**: A single malformed message from server crashes the entire client WebSocket handler. No recovery possible.

```javascript
// CURRENT (crashes on malformed JSON)
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);  // NO TRY-CATCH
  ...
};

// SHOULD BE
socket.onmessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    ...
  } catch (error) {
    console.error('Failed to parse server message:', error);
    return; // Don't crash, just skip malformed message
  }
};
```

**Why CRITICAL**: Client crash = lost game = lost funds for user.

---

#### C13. Multiple Game Loops Can Run Simultaneously (NEW - 2nd Audit)
**File**: `client/src/ui.js:541-580`
**Status**: 🆕 NEW CRITICAL
**Impact**: `startGameLoop()` has no guard against being called multiple times. Each call creates a new `requestAnimationFrame` chain, leading to multiple parallel game loops.

```javascript
// CURRENT (no guard)
function startGameLoop() {
  function loop(timestamp) {
    ...
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// SHOULD BE
let gameLoopRunning = false;
let gameLoopId = null;

function startGameLoop() {
  if (gameLoopRunning) return;
  gameLoopRunning = true;

  function loop(timestamp) {
    ...
    gameLoopId = requestAnimationFrame(loop);
  }
  gameLoopId = requestAnimationFrame(loop);
}

function stopGameLoop() {
  if (gameLoopId) cancelAnimationFrame(gameLoopId);
  gameLoopRunning = false;
}
```

**Why CRITICAL**: Multiple loops = exponential CPU usage, input processing chaos, rendering glitches.

---

#### C14. Renderer.destroy() and Input.destroy() Never Called (NEW - 2nd Audit)
**File**: `client/src/ui.js:337-359`
**Status**: 🆕 NEW CRITICAL
**Impact**: After match ends, `handleMatchEnd()` never calls cleanup methods. Input event listeners and renderer resources accumulate across matches.

```javascript
// CURRENT handleMatchEnd (no cleanup)
function handleMatchEnd(data) {
  showScreen('match-result');
  // ... display results ...
  // NO CLEANUP CALLS
}

// SHOULD INCLUDE
function handleMatchEnd(data) {
  // Clean up game resources
  if (typeof Input !== 'undefined' && Input.destroy) Input.destroy();
  if (typeof Renderer !== 'undefined' && Renderer.destroy) Renderer.destroy();
  stopGameLoop(); // If implemented per C13

  showScreen('match-result');
  // ... display results ...
}
```

**Why CRITICAL**: Memory leak + event listener buildup = degraded performance after multiple matches, eventual browser crash.

---

#### C15. BigInt Precision Loss on USDC Amounts (NEW - 2nd Audit)
**File**: `client/src/wallet.js:140`
**Status**: 🆕 NEW CRITICAL - Elevated from M7
**Impact**: JavaScript floating-point arithmetic before BigInt conversion causes precision loss on USDC amounts.

```javascript
// CURRENT (precision loss)
const amountInUnits = BigInt(amount * 10 ** USDC_DECIMALS);
// For amount = 1.000001, this may become 1000000.9999999999 → 1000000n (lost 1 unit)

// SHOULD BE (string-based conversion)
function toUSDCUnits(amount) {
  const [whole, decimal = ''] = amount.toString().split('.');
  const paddedDecimal = decimal.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  return BigInt(whole + paddedDecimal);
}
const amountInUnits = toUSDCUnits(amount);
```

**Why CRITICAL**: Financial precision loss = potential fund loss or disputes.

---

#### C16. No Message Size Limit Before JSON.parse (NEW - 2nd Audit)
**File**: `server/index.js:297-318`
**Status**: 🆕 NEW CRITICAL
**Impact**: Server accepts arbitrarily large WebSocket messages. Attacker can send multi-GB JSON payload to exhaust server memory.

```javascript
// CURRENT (no size check)
ws.on('message', async (rawMessage) => {
  const message = JSON.parse(rawMessage); // Parses any size
  ...
});

// SHOULD BE
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB is generous for game messages

ws.on('message', async (rawMessage) => {
  if (rawMessage.length > MAX_MESSAGE_SIZE) {
    console.warn(`Message too large from ${userId}: ${rawMessage.length} bytes`);
    return;
  }
  const message = JSON.parse(rawMessage);
  ...
});
```

**Why CRITICAL**: DoS vector that can crash server with OOM.

---

#### C17. sleepSync Blocks Event Loop (NEW - 2nd Audit)
**File**: `server/database.js:48-52`
**Status**: 🆕 NEW CRITICAL
**Impact**: `sleepSync()` uses a busy-wait loop that blocks the entire Node.js event loop during database retries.

```javascript
// CURRENT (blocks event loop)
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait - BLOCKS EVERYTHING
  }
}

// SHOULD BE (for async context)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Or if truly need sync (rare), use:
const { execSync } = require('child_process');
function sleepSync(ms) {
  execSync(`sleep ${ms / 1000}`); // Unix only
}
```

**Why CRITICAL**: During database contention, all WebSocket messages, HTTP requests, and game ticks are blocked. Causes massive lag spikes and potential timeout cascades.

---

### HIGH - Should Fix Before Production

#### H1. Unhandled Match Start Errors Leave Lobby Stuck
**File**: `server/index.js:470-486`
**Status**: ⚠️ CONFIRMED
**Impact**: Non-INSUFFICIENT_BALANCE errors leave lobby in 'ready' state forever.

**Fix**: Add catch-all that resets lobby status on any error.

---

#### H2. Null Check Missing in Lobby Broadcast
**File**: `server/lobby.js:471-474`
**Status**: ⚠️ CONFIRMED
**Impact**: `ws.readyState` accessed without null check - can crash if ws is null.

**Fix**: Add `if (ws && ws.readyState === 1)`.

---

#### H3. ~~Disconnect Handler Has No Try-Catch~~ → Elevated to C11

---

#### H4. Disconnected Players Not Cleaned from Lobby
**File**: `server/lobby.js:251-266`
**Status**: ⚠️ CONFIRMED
**Impact**: `lobby.players` array grows unbounded with disconnected players who weren't refunded.

**Fix**: Clean up player records on disconnect if they have no active match.

---

#### H5. Fire-and-Forget Alert Calls
**Files**: Multiple locations
**Status**: ⚠️ CONFIRMED
**Impact**: `sendAlert()` calls without await lose errors silently.

**Fix**: Either await or add `.catch()` handler that logs failures.

---

#### H6. Balance Check Variable Unused
**File**: `server/match.js:210-211`
**Status**: ⚠️ CONFIRMED
**Impact**: `expectedBalance` is calculated but never used in the comparison.

```javascript
const expectedBalance = BigInt(payments.BUY_IN_AMOUNT) * BigInt(3); // UNUSED
if (BigInt(lobbyBalance.balance) < BigInt(payments.WINNER_PAYOUT)) { // Uses different value
```

**Fix**: Decide which check is correct and use it consistently. The current check (2.4 USDC) is sufficient but expectedBalance (3 USDC) would be more conservative.

---

#### ~~H7. Client JSON.parse Without Try-Catch~~ → Elevated to C12
**Note**: This issue has been elevated to CRITICAL (C12) in the second audit due to potential client crashes causing fund loss.

---

#### H8. Client Reconnection State Not Reset
**File**: `client/src/network.js:69-76`
**Status**: ⚠️ CONFIRMED
**Impact**: `userId` stays stale after failed reconnection, causing auth issues.

**Fix**: Reset `userId = null` on connection failure.

---

#### H9. Database JSON Parse Without Try-Catch
**File**: `server/database.js:842, 916`
**Status**: ⚠️ CONFIRMED
**Impact**: Corrupted JSON in database crashes functions.

**Fix**: Wrap JSON.parse in try-catch, return null or empty object on failure.

---

#### H10. Deferred Queue Lost on Server Restart
**File**: `server/database.js:61-65`
**Status**: ⚠️ CONFIRMED
**Impact**: In-memory deferred operation queue is lost if server crashes.

**Fix**: Either persist queue to database or accept this limitation (document it).

---

#### H11. Alert Delivery Failures Not Retried
**File**: `server/alerts.js:44-72`
**Status**: ⚠️ CONFIRMED
**Impact**: Critical alerts can be lost during Discord downtime.

**Fix**: Add retry logic or queue failed alerts to file.

---

#### H12. Payout Only Waits for 1 Confirmation
**File**: `server/payments.js:438-439`
**Status**: ⚠️ CONFIRMED
**Impact**: Blockchain reorgs could reverse payouts that were marked successful.

```javascript
// CURRENT
const receipt = await tx.wait();

// SHOULD BE
const receipt = await tx.wait(3); // Match MIN_CONFIRMATIONS
```

---

#### H13. No Nonce Management in Payout Retries
**File**: `server/payments.js:132-177`
**Status**: ⚠️ CONFIRMED
**Impact**: `withRetry()` can send duplicate transactions, causing failures or double-spending.

**Fix**: Track nonce explicitly or use provider's nonce management with proper error handling.

---

#### H14. `lowEthAlerts` Set Never Bounded (NEW)
**File**: `server/payments.js:612`
**Status**: 🆕 NEW ISSUE
**Impact**: Similar to rate limit maps, this Set grows unbounded over time.

**Fix**: Add periodic cleanup or use a Map with timestamps.

---

#### H15. Session Token Stored in localStorage (NEW)
**File**: `client/src/ui.js:166`
**Status**: 🆕 NEW ISSUE
**Impact**: XSS vulnerability could steal session tokens.

**Fix**: Consider using httpOnly cookies instead, or accept risk for single-page app.

---

#### H16. No Maximum WebSocket Message Size Check (NEW)
**File**: `server/index.js:297-318`
**Status**: 🆕 NEW ISSUE
**Impact**: Client could send very large JSON messages to DoS server memory.

**Fix**: Add explicit message size limit check before JSON.parse.

---

#### H17. `stuckLobbyAlerts` Set Not Cleared on Restart (NEW)
**File**: `server/lobby.js:509`
**Status**: 🆕 NEW ISSUE
**Impact**: After server restart, previously stuck lobbies will re-trigger alerts.

**Fix**: Not a bug per se, but document that duplicate alerts may occur after restart.

---

#### H18. `stuckLobbyAlerts` Set Unbounded (NEW - 2nd Audit)
**File**: `server/lobby.js:509`
**Status**: 🆕 NEW ISSUE
**Impact**: Like `lowEthAlerts` (H14), this Set grows unbounded as lobbies are created.

**Fix**: Add periodic cleanup or max size limit.

---

#### H19. `matchTickErrors` Map Can Leak (NEW - 2nd Audit)
**File**: `server/match.js`
**Status**: 🆕 NEW ISSUE
**Impact**: The `matchTickErrors` Map tracks errors per match but entries may not be cleaned up if matches end abnormally.

**Fix**: Ensure cleanup in all match end paths (normal, void, timeout).

---

### MEDIUM - Fix When Possible

#### M1. resetLobbyWithPlayers Deletes Refunded Players
**File**: `server/database.js:1123-1139`
**Status**: ⚠️ CONFIRMED
**Impact**: Audit trail lost for refunded players.

**Fix**: Change to `DELETE FROM lobby_players WHERE lobby_id = ? AND refunded_at IS NULL`.

---

#### M2. txHashExists Race Condition
**File**: `server/database.js:686-689`
**Status**: ⚠️ CONFIRMED
**Impact**: Two requests can both pass check, then both insert (caught by UNIQUE but not graceful).

**Fix**: Rely on UNIQUE constraint and handle the error gracefully.

---

#### M3. Client Wallet Event Listeners Accumulate
**File**: `client/src/wallet.js:61-62`
**Status**: ⚠️ CONFIRMED
**Impact**: Multiple reconnects add duplicate listeners.

**Fix**: Remove listeners before adding, or check if already added.

---

#### M4. Client Game Loop Not Cleaned on Page Unload
**File**: `client/src/ui.js:524-580`
**Status**: ⚠️ CONFIRMED
**Impact**: `requestAnimationFrame` may continue after navigation.

**Fix**: Add `beforeunload` handler to cancel animation frame.

---

#### M5. Client Missing destroy() Calls After Match End
**File**: `client/src/ui.js:337-359`
**Status**: ⚠️ CONFIRMED
**Impact**: Input listeners and renderer persist between matches.

**Fix**: Call `Input.destroy()` and `Renderer.destroy()` in `handleMatchEnd()`.

---

#### M6. Snapshot Counter Logic Error
**File**: `server/match.js:596-601`
**Status**: ⚠️ CONFIRMED
**Impact**: Snapshots sent every 2 ticks (15 Hz) instead of every 1.5 ticks (20 Hz) as intended.

**Fix**: Use fractional increment: `match.snapshotCounter += 1; if (snapshotCounter >= 2)` or use modulo.

---

#### ~~M7. Client BigInt Precision Loss~~ → Elevated to C15
**Note**: This issue has been elevated to CRITICAL (C15) in the second audit due to potential financial precision loss causing fund disputes.

---

#### M8. Amount Tolerance on Fixed USDC Transfers
**File**: `server/payments.js:27, 388-396`
**Status**: ⚠️ CONFIRMED
**Impact**: 1% tolerance allows underpaying by 0.01 USDC per transaction.

**Fix**: Reduce tolerance to 0% or 0.1% for USDC (no gas variability on token transfers).

---

#### M9. Database treasury_balance_before Wrong Type
**File**: `database/schema.sql:103`
**Status**: ⚠️ CONFIRMED
**Impact**: TEXT allows non-numeric values.

**Fix**: Change to REAL in schema (requires migration).

---

#### M10. Game Loop Error Uses Wrong Alert Type
**File**: `server/match.js:464, 939`
**Status**: ⚠️ CONFIRMED
**Impact**: Game loop errors sent as DATABASE_ERROR, polluting that alert category.

**Fix**: Add GAME_LOOP_ERROR alert type.

---

#### M11. Health Monitor Stall Detection Delay
**File**: `server/match.js:924-958`
**Status**: ⚠️ CONFIRMED
**Impact**: 5-second check interval with 2-second threshold means up to 7 seconds before detection.

**Fix**: Reduce HEALTH_CHECK_INTERVAL to 1-2 seconds.

---

#### M12. Physics Debug Logs Still Active (NEW)
**File**: `server/physics.js:174-260`
**Status**: 🆕 NEW ISSUE
**Impact**: Heavy console.log output in production affecting performance.

**Fix**: Remove or gate behind DEBUG flag. (Note: Phase 3.1 should include these specific files)

---

#### M13. `sleepSync` Uses CPU-Intensive Busy Wait (NEW)
**File**: `server/database.js:48-52`
**Status**: 🆕 NEW ISSUE
**Impact**: Blocks event loop during database retries.

**Fix**: Acceptable for synchronous SQLite but document the trade-off.

---

#### M14. No Input Validation on Bot Endpoints (NEW)
**File**: `server/index.js:132-164`
**Status**: 🆕 NEW ISSUE
**Impact**: `/api/bot/add` and `/api/bot/fill` don't validate `lobbyId` is a number.

**Fix**: Add `isValidLobbyId()` check from protocol.js.

---

#### M15. `refund_reason` Schema Constraint Incomplete (NEW)
**File**: `database/schema.sql:42`
**Status**: 🆕 NEW ISSUE
**Impact**: Schema allows `timeout`, `server_crash`, `triple_disconnect`, `double_disconnect`, `payout_failed` but code may use `insufficient_lobby_balance` or `game_loop_error`.

**Fix**: Add missing values to CHECK constraint or use a more flexible approach.

---

#### M16. Client Auto-Reconnect No Wallet State Check (NEW)
**File**: `client/src/ui.js:586-597`
**Status**: 🆕 NEW ISSUE
**Impact**: Auto-reconnect only checks session token, not if wallet is still connected.

**Fix**: Also verify `Wallet.isConnected()` before attempting reconnection.

---

### LOW - Nice to Have

#### L1. WebSocket Connection No Timeout
**File**: `client/src/network.js:24-86`
**Status**: ⚠️ CONFIRMED
**Impact**: Connection attempt hangs forever if server unresponsive.

**Fix**: Add connection timeout (e.g., 10 seconds).

---

#### L2. Global Error Handlers Only Log
**File**: `client/src/main.js:61-67`
**Status**: ⚠️ CONFIRMED
**Impact**: User unaware of errors; no recovery mechanism.

**Fix**: Show user-friendly error message.

---

#### L3. Input Handler Silent on Zero Canvas
**File**: `client/src/input.js:59-61`
**Status**: ⚠️ CONFIRMED
**Impact**: Mouse input ignored if canvas not sized yet.

**Fix**: Log warning or retry after delay.

---

#### L4. Stuck Lobby Alert Not Reset
**File**: `server/lobby.js:541-544`
**Status**: ⚠️ CONFIRMED
**Impact**: Once marked stuck, alert tracking only clears when lobby resets, not on new activity.

**Fix**: Clear from `stuckLobbyAlerts` when new player joins.

---

#### L5. Ping Interval May Leak on Init Error
**File**: `server/index.js:290-295`
**Status**: ⚠️ CONFIRMED
**Impact**: If WebSocket handler throws during setup, ping interval may not be cleared.

**Fix**: Ensure interval is stored and cleared in all error paths.

---

#### L6. Old Payout Records Never Cleaned
**File**: `server/database.js`
**Status**: ⚠️ CONFIRMED
**Impact**: `payout_attempts` table grows indefinitely.

**Fix**: Add cleanup function for records older than 90 days.

---

#### L7. Match Debug Logs Heavy When 2 Players Remain (NEW)
**File**: `server/match.js:541-571`
**Status**: 🆕 NEW ISSUE
**Impact**: Excessive logging when final 2 players are close together.

**Fix**: Include in Phase 3.1 debug log removal.

---

## Issues That Are NOT Bugs (By Design)

These were flagged in the audit but are actually working as intended:

| Issue | Reason It's OK |
|-------|---------------|
| Admin port allows free joins | Intentional - port 3001 is for testing only, should never be exposed |
| Amount tolerance on payments | Intentional for gas variations, though could be reduced |
| CASCADE DELETE on users | Acceptable if users are never deleted in production |
| Session token in memory | Acceptable for single-instance deployment |
| `receipt.hash` in wallet.js | Correct for ethers.js v6 |
| `loser.alive = false` in physics.js | Already implemented correctly |

---

## Recommended Fix Priority

### IMMEDIATE BLOCKERS (Before ANY Testing)
These issues can cause crashes, data loss, or security vulnerabilities:

| Priority | Issue | File | Effort |
|----------|-------|------|--------|
| 1 | **C12** - Add try-catch around JSON.parse | client/src/network.js:49 | 5 min |
| 2 | **C10** - Add SIGTERM handler | server/index.js | 5 min |
| 3 | **C13** - Guard startGameLoop() against multiple calls | client/src/ui.js | 10 min |
| 4 | **C14** - Call destroy() methods in handleMatchEnd | client/src/ui.js | 10 min |
| 5 | **C15** - Fix BigInt precision with string parsing | client/src/wallet.js:140 | 15 min |
| 6 | **C16** - Add message size limit before JSON.parse | server/index.js:297 | 10 min |
| 7 | **C17** - Replace sleepSync with async sleep | server/database.js:48-52 | 30 min |
| 8 | **C4** - Add rate limit cleanup interval | server/index.js:214 | 15 min |

**Total: ~1.5 hours for critical fixes**

### Before Phase 3 (Quick Wins)
1. ~~**C5** - Client `receipt.hash` → `tx.hash`~~ ✅ Already correct
2. ~~**C8** - Add `player.alive = false` after elimination~~ ✅ Already implemented
3. **C7** - Store countdown interval on match object
4. **C11** - Add try-catch to disconnect handler
5. **H2** - Add null check in lobby broadcast
6. **H12** - Change `tx.wait()` to `tx.wait(3)`

### Before Phase 6 Testing (More Complex)
1. **C1** - Restructure async handling in game loop
2. **C2** - Add mutex to player join flow
3. **C3** - Add mutex to refund flow
4. **C6** - Atomic lobby status check-and-set
5. **C9** - Fix client event listener leaks

### Can Wait Until Post-Launch
- All LOW priority items
- M6-M16 (minor optimizations, excluding elevated items)

---

## Testing Recommendations

After fixes, verify with these scenarios:

1. **Race condition tests**:
   - 3 players join lobby simultaneously
   - 2 players request refund simultaneously
   - Player disconnects during countdown

2. **Memory leak tests**:
   - Run server for 1+ hour with continuous connections
   - Monitor memory usage over time

3. **Client stability tests**:
   - Refresh lobby list 20+ times, verify single click = single action
   - Complete 5+ matches without page reload

4. **Container deployment tests** (NEW):
   - Test SIGTERM handling in Docker
   - Verify graceful shutdown completes

5. **RPC failover tests** (NEW):
   - Manually trigger RPC failures
   - Verify provider switching works

---

## Appendix: Files Audited

| File | Lines | Issues Found |
|------|-------|--------------|
| server/index.js | ~654 | 7 |
| server/match.js | ~1026 | 8 |
| server/lobby.js | ~573 | 5 |
| server/payments.js | ~700 | 5 |
| server/database.js | ~1270 | 5 |
| server/protocol.js | ~454 | 0 |
| server/alerts.js | ~288 | 2 |
| server/physics.js | ~468 | 2 |
| client/src/ui.js | ~606 | 6 |
| client/src/network.js | ~255 | 4 |
| client/src/wallet.js | ~228 | 2 |
| client/src/input.js | ~219 | 2 |
| client/src/main.js | ~70 | 1 |
| database/schema.sql | ~132 | 2 |

---

## Changelog

### 2026-01-17 (Second Independent Verification)
- Comprehensive second audit performed with production checklist cross-reference
- Added 6 NEW CRITICAL issues (C12-C17):
  - C12: Client JSON.parse without try-catch (elevated from H7)
  - C13: Multiple game loops can run simultaneously
  - C14: Renderer/Input.destroy() never called
  - C15: BigInt precision loss (elevated from M7)
  - C16: No message size limit before JSON.parse
  - C17: sleepSync blocks event loop
- Added 2 NEW HIGH issues (NH1, NH2):
  - stuckLobbyAlerts Set unbounded
  - matchTickErrors Map can leak
- Elevated H7 → C12 (client crash = fund loss)
- Elevated M7 → C15 (financial precision = fund disputes)
- Added production checklist verification section
- Identified Phase 1-2 checklist items that are only partially complete
- Reorganized fix priority with "IMMEDIATE BLOCKERS" section
- Updated severity totals: 15 CRITICAL, 18 HIGH, 15 MEDIUM, 7 LOW (55 total active)

### 2026-01-17 (First Update)
- Independent secondary audit performed
- Verified C5 and C8 are already fixed/not bugs
- Added 2 new CRITICAL issues (C10, C11)
- Added 4 new HIGH issues (H14-H17)
- Added 5 new MEDIUM issues (M12-M16)
- Added 1 new LOW issue (L7)
- Updated line numbers to match current code
- Added container deployment testing recommendations

### 2026-01-17 (Original)
- Initial audit report created

---

*End of Audit Report*
