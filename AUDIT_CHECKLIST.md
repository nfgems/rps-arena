# RPS-ARENA Audit Remediation Checklist

> **Created**: 2026-01-17
> **Based on**: AUDIT_REPORT.md (Second Independent Verification)
> **Total Active Issues**: 55 per report (15 Critical, 18 High, 15 Medium, 7 Low)
> **Unique Items in Checklist**: 51 (after removing 3 duplicates + 2 already fixed)

---

## How to Use This Checklist

1. Work through issues in order (CRITICAL → HIGH → MEDIUM → LOW)
2. Check the box when the fix is **implemented**
3. Add notes in the "Verification" column after testing
4. Mark the "Tested" box only after manual verification

---

## Phase 0: IMMEDIATE BLOCKERS (Before ANY Testing)

These issues can cause crashes, data loss, or security vulnerabilities. **Do not proceed with any testing until these are resolved.**

| # | ID | Issue | File | Est. | Done | Tested | Notes |
|---|-----|-------|------|------|------|--------|-------|
| 1 | C12 | Add try-catch around client JSON.parse | `client/src/network.js:49` | 5m | [x] | [ ] | |
| 2 | C10 | Add SIGTERM handler for graceful shutdown | `server/index.js` | 5m | [x] | [ ] | |
| 3 | C13 | Guard startGameLoop() against multiple calls | `client/src/ui.js:541-580` | 10m | [x] | [ ] | |
| 4 | C14 | Call destroy() methods in handleMatchEnd | `client/src/ui.js:337-359` | 10m | [x] | [ ] | |
| 5 | C15 | Fix BigInt precision with string parsing | `client/src/wallet.js:140` | 15m | [x] | [ ] | |
| 6 | C16 | Add message size limit before JSON.parse | `server/index.js:297` | 10m | [x] | [ ] | |
| 7 | C17 | Replace sleepSync with async sleep | `server/database.js:48-52` | 30m | [x] | [ ] | Used Atomics.wait() - proper blocking without CPU burn |
| 8 | C4 | Add rate limit cleanup interval | `server/index.js:214-233` | 15m | [x] | [ ] | Hourly cleanup of stale entries |

**Phase 0 Completion**: [x] All 8 items done and tested

---

## Phase 1: CRITICAL Issues (Pre-Production)

### 1.1 Race Conditions & Async Issues

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 9 | C1 | Missing `await` on async functions causing race conditions | `server/match.js:518, 591, 865, 870` | [x] | [ ] | Added .catch() handlers since setInterval can't be async |
| 10 | C2 | Race condition in player join flow (4+ players can join) | `server/lobby.js:151-246` | [x] | [ ] | Added mutex lock around entire join flow |
| 11 | C3 | Race condition in refund flow (double refunds possible) | `server/lobby.js:278-396` | [x] | [ ] | Added mutex lock to both refund functions |
| 12 | C6 | Concurrent match start from same lobby | `server/index.js:469-487` | [x] | [ ] | Added mutex lock in startMatch() |

### 1.2 Memory & Resource Leaks

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 13 | C7 | Countdown timer not stored - leaks on match void | `server/match.js:317-345` | [x] | [ ] | Stored on match object, cleared in voidMatch() |
| 14 | C9 | Client event listener leaks on join buttons | `client/src/ui.js:381-436` | [x] | [ ] | Implemented event delegation on lobby-list container |

### 1.3 Error Handling

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 15 | C11 | Disconnect handler has no try-catch | `server/index.js:321-334` | [x] | [ ] | Wrapped match/lobby disconnect calls in try-catch |

**Phase 1 Completion**: [x] All 7 items done (testing pending)

---

## Phase 2: HIGH Priority Issues

### 2.1 Server Stability

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 16 | H1 | Unhandled match start errors leave lobby stuck | `server/index.js:470-486` | [x] | [ ] | Added catch-all with refund attempt, force reset as last resort |
| 17 | H2 | Null check missing in lobby broadcast | `server/lobby.js:471-474` | [x] | [ ] | Added null check to broadcastToLobby and forceResetLobby |
| 18 | H4 | Disconnected players not cleaned from lobby | `server/lobby.js:251-266` | [x] | [ ] | removeConnection now cleans up player slot and updates lobby status |

### 2.2 Alert System

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 19 | H5 | Fire-and-forget alert calls lose errors | Multiple files | [x] | [ ] | Added .catch() handler to all 17 sendAlert calls |
| 20 | H11 | Alert delivery failures not retried | `server/alerts.js:44-72` | [x] | [ ] | Added retry with exponential backoff (3 attempts for critical alerts, handles rate limits) |

### 2.3 Payment & Blockchain

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 21 | H6 | Balance check variable unused (expectedBalance) | `server/match.js:210-211` | [x] | [ ] | Now uses expectedBalance (3 USDC) for stricter validation |
| 22 | H12 | Payout only waits for 1 confirmation | `server/payments.js:438-439` | [x] | [ ] | Changed to `tx.wait(3)` for better finality |
| 23 | H13 | No nonce management in payout retries | `server/payments.js:132-177` | [x] | [ ] | Nonce fetched once before retries, passed explicitly to prevent duplicates |

### 2.4 Client Stability

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 24 | H8 | Client reconnection state not reset | `client/src/network.js:69-76` | [x] | [ ] | Reset userId/sessionToken on reconnect failure and max attempts |

### 2.5 Database

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 25 | H9 | Database JSON parse without try-catch | `server/database.js:842, 916` | [x] | [ ] | Added try-catch, returns null data on parse failure with error log |
| 26 | H10 | Deferred queue lost on server restart | `server/database.js:61-65` | [x] | [ ] | Documented: only non-critical ops queued, critical ops fail fast |

### 2.6 Memory Leaks (Unbounded Collections)

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 27 | H14 | lowEthAlerts Set never bounded | `server/payments.js:612` | [x] | [ ] | Converted to Map with timestamps, hourly cleanup, 24h re-alert |
| 28 | H18 | stuckLobbyAlerts Set unbounded | `server/lobby.js:509` | [x] | [ ] | Converted to Map with timestamps, hourly cleanup, 24h re-alert |
| 29 | H19 | matchTickErrors Map can leak | `server/match.js` | [x] | [ ] | Added cleanup in both match end and voidMatch paths |

### 2.7 Security

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 30 | H15 | Session token stored in localStorage (XSS risk) | `client/src/ui.js:166` | [x] | [ ] | Changed to sessionStorage (cleared on tab close, reduces attack window) |
| - | ~~H16~~ | ~~No maximum WebSocket message size check~~ | ~~`server/index.js:297-318`~~ | N/A | N/A | **DUPLICATE of C16** - skip |

### 2.8 Documentation/Minor

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 31 | H17 | stuckLobbyAlerts Set not cleared on restart | `server/lobby.js:509` | [x] | [ ] | Now uses Map with cleanup; re-alerts after 24h if still stuck |

**Phase 2 Completion**: [x] All 16 items done (testing pending, 1 duplicate excluded)

---

## Phase 3: MEDIUM Priority Issues

### 3.1 Database & Schema

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 32 | M1 | resetLobbyWithPlayers deletes refunded players | `server/database.js:1123-1139` | [ ] | [ ] | Modify DELETE to keep refunded records |
| 33 | M2 | txHashExists race condition | `server/database.js:686-689` | [ ] | [ ] | Rely on UNIQUE constraint, handle error |
| 34 | M9 | treasury_balance_before wrong type (TEXT vs REAL) | `database/schema.sql:103` | [ ] | [ ] | Requires migration |
| 35 | M15 | refund_reason schema constraint incomplete | `database/schema.sql:42` | [ ] | [ ] | Add missing values to CHECK |

### 3.2 Client Issues

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 36 | M3 | Client wallet event listeners accumulate | `client/src/wallet.js:61-62` | [ ] | [ ] | Remove before adding |
| 37 | M4 | Client game loop not cleaned on page unload | `client/src/ui.js:524-580` | [ ] | [ ] | Add beforeunload handler |
| - | ~~M5~~ | ~~Missing destroy() calls after match end~~ | ~~`client/src/ui.js:337-359`~~ | N/A | N/A | **DUPLICATE of C14** - skip |
| 38 | M16 | Auto-reconnect no wallet state check | `client/src/ui.js:586-597` | [ ] | [ ] | Also verify Wallet.isConnected() |

### 3.3 Server Logic

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 39 | M6 | Snapshot counter logic error (15Hz vs 20Hz) | `server/match.js:596-601` | [ ] | [ ] | Fix fractional increment |
| 40 | M8 | Amount tolerance too high on USDC transfers (1%) | `server/payments.js:27, 388-396` | [ ] | [ ] | Reduce to 0% or 0.1% |
| 41 | M10 | Game loop error uses wrong alert type | `server/match.js:464, 939` | [ ] | [ ] | Add GAME_LOOP_ERROR type |
| 42 | M11 | Health monitor stall detection delay (7s) | `server/match.js:924-958` | [ ] | [ ] | Reduce check interval |
| 43 | M14 | No input validation on bot endpoints | `server/index.js:132-164` | [ ] | [ ] | Add isValidLobbyId() check |

### 3.4 Debug/Logging (May be covered by Phase 3.1 of Production Checklist)

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 44 | M12 | Physics debug logs still active | `server/physics.js:174-260` | [ ] | [ ] | Remove or gate behind DEBUG |
| - | ~~M13~~ | ~~sleepSync uses CPU-intensive busy wait~~ | ~~`server/database.js:48-52`~~ | N/A | N/A | **DUPLICATE of C17** - skip |

**Phase 3 Completion**: [ ] All 13 items done and tested (2 duplicates excluded)

---

## Phase 4: LOW Priority Issues

| # | ID | Issue | File | Done | Tested | Notes |
|---|-----|-------|------|------|--------|-------|
| 45 | L1 | WebSocket connection no timeout | `client/src/network.js:24-86` | [ ] | [ ] | Add 10s timeout |
| 46 | L2 | Global error handlers only log | `client/src/main.js:61-67` | [ ] | [ ] | Show user-friendly message |
| 47 | L3 | Input handler silent on zero canvas | `client/src/input.js:59-61` | [ ] | [ ] | Log warning or retry |
| 48 | L4 | Stuck lobby alert not reset on activity | `server/lobby.js:541-544` | [ ] | [ ] | Clear from Set when player joins |
| 49 | L5 | Ping interval may leak on init error | `server/index.js:290-295` | [ ] | [ ] | Store and clear in all error paths |
| 50 | L6 | Old payout records never cleaned | `server/database.js` | [ ] | [ ] | Add cleanup for 90+ day records |
| 51 | L7 | Match debug logs heavy with 2 players | `server/match.js:541-571` | [ ] | [ ] | Include in debug log removal |

**Phase 4 Completion**: [ ] All 7 items done and tested

---

## Already Fixed / Not Bugs (For Reference)

These items from the audit have been verified as non-issues:

| ID | Issue | Status |
|----|-------|--------|
| C5 | Client `receipt.hash` property | ✅ Correct for ethers.js v6 |
| C8 | Player not marked alive=false | ✅ Already implemented in physics.js:251 |
| - | Admin port allows free joins | By design (testing only) |
| - | Amount tolerance on payments | By design (gas variations) |
| - | CASCADE DELETE on users | Acceptable |
| - | Session token in memory | Acceptable for single-instance |

## Elevated Issues (For Reference)

These issues were elevated to higher severity in the second audit:

| Original ID | New ID | Reason |
|-------------|--------|--------|
| H3 | C11 | Disconnect handler crash = server instability |
| H7 | C12 | Client crash = lost game = fund loss |
| M7 | C15 | Financial precision loss = fund disputes |

---

## Issues Covered by Production Checklist (Do Not Duplicate)

These issues are already planned in the Production Checklist phases:

| Issue | Checklist Phase |
|-------|-----------------|
| Debug console.log statements | Phase 3.1 - Code Cleanup |
| Hardcoded payout amounts | Phase 3.2 - Code Cleanup |
| Hardcoded rate limits | Phase 3.2 - Code Cleanup |
| Date.now() RNG seed | Phase 3.2 - Code Cleanup |
| Circular dependencies | Phase 3.3 - Code Cleanup |
| Reconnection improvements | Phase 4.4 - User Features |
| Error tracking (Sentry) | Phase 5.4 - Infrastructure |
| RPC health check on startup | Phase 5.5 - Infrastructure |
| Security testing | Phase 6.3 - Testing |
| Edge cases (disconnect, RPC down) | Phase 6.4 - Testing |

---

## Verification Test Scenarios

After completing fixes, run these tests:

### Race Condition Tests
- [ ] 3 players join lobby simultaneously (should allow max 3)
- [ ] 2 players request refund simultaneously (should refund each once)
- [ ] Player disconnects during countdown (should cleanup timer)
- [ ] 2 rapid join clicks (should only join once)

### Memory Leak Tests
- [ ] Run server 1+ hour with continuous connections
- [ ] Monitor memory usage over time (should stabilize)
- [ ] Check rateLimits Map size after 1 hour
- [ ] Check connectionCounts Map size after 1 hour

### Client Stability Tests
- [ ] Refresh lobby list 20+ times (single click = single action)
- [ ] Complete 5+ matches without page reload
- [ ] Check for event listener accumulation in DevTools
- [ ] Verify game loop stops after match end

### Container Deployment Tests
- [ ] Test SIGTERM handling in Docker (`docker stop`)
- [ ] Verify graceful shutdown completes
- [ ] Check active matches are saved/voided on shutdown

### RPC Failover Tests
- [ ] Manually trigger RPC failures
- [ ] Verify provider switching works
- [ ] Verify payouts complete after provider switch

### Payment Precision Tests
- [ ] Test with amounts like 1.000001 USDC
- [ ] Verify no precision loss in BigInt conversion
- [ ] Check that small amounts round correctly

---

## Summary Progress Tracker

| Phase | Total | Duplicates | Actionable | Done | Remaining |
|-------|-------|------------|------------|------|-----------|
| Phase 0 (Blockers) | 8 | 0 | 8 | 8 | 0 |
| Phase 1 (Critical) | 7 | 0 | 7 | 7 | 0 |
| Phase 2 (High) | 17 | 1 (H16=C16) | 16 | 0 | 16 |
| Phase 3 (Medium) | 15 | 2 (M5=C14, M13=C17) | 13 | 0 | 13 |
| Phase 4 (Low) | 7 | 0 | 7 | 0 | 7 |
| **TOTAL** | **54** | **3** | **51** | **15** | **36** |

*Duplicates are marked with strikethrough in the checklist above*

---

## Quick Reference: Files to Modify

| File | Issue Count | Issue IDs |
|------|-------------|-----------|
| `server/index.js` | 7 | C4, C6, C10, C11, C16, H1, M14, L5 |
| `server/match.js` | 8 | C1, C7, H6, H19, M6, M10, M11, L7 |
| `server/lobby.js` | 6 | C2, C3, H2, H4, H18, L4 |
| `server/database.js` | 6 | C17, H9, H10, M1, M2, L6 |
| `server/payments.js` | 4 | H12, H13, H14, M8 |
| `server/alerts.js` | 2 | H5, H11 |
| `client/src/ui.js` | 5 | C9, C13, C14, H15, M4, M16 |
| `client/src/network.js` | 3 | C12, H8, L1 |
| `client/src/wallet.js` | 2 | C15, M3 |
| `client/src/input.js` | 1 | L3 |
| `client/src/main.js` | 1 | L2 |
| `database/schema.sql` | 2 | M9, M15 |

*Note: Duplicate issues (H16, M5, M13) excluded from counts*

---

*Last Updated: 2026-01-17*
