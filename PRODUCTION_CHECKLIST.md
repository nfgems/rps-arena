# RPS-ARENA Production Launch Checklist

> **Status**: IN PROGRESS
> **Last Updated**: 2026-01-18
> **Current Phase**: Phase 5 - Infrastructure & Deployment
> **Note**: Phase 4 audit fixes completed (see section 4.5)

This is the master checklist for taking RPS-ARENA from test/prototype to a live production game. Each item must be completed and checked off before launch.

---

## Phase 1: Critical Security Fixes 🔴
*These are production blockers - the game cannot go live until ALL are complete*

### 1.1 Credentials & Secrets ✅ COMPLETE (2026-01-17)
- [x] **Remove real mnemonics from `.env`** - ✅ N/A - Never committed to git (verified)
- [x] **Add `.env` to `.gitignore`** - ✅ Already configured
- [x] **Create `.env.example` with placeholder values only** - ✅ Already exists with safe placeholders
- [x] **Rotate all compromised keys** - ✅ N/A - Keys were never exposed in git history
- [ ] **Use proper key derivation** - ⚪ Low priority - Current SHA256 is acceptable for this use case

### 1.2 Dev Mode Removal ✅ COMPLETE (2026-01-17)
*Implemented via dual-port architecture instead of removal - more secure and preserves testing capability*

- [x] **Remove `DEV_MODE` flag entirely** - ✅ Removed from `.env` and server code
- [x] **Isolate bot management endpoints** (`/api/bot/*`) - ✅ Moved to admin port 3001 only
- [x] **Isolate `/api/dev/reset` endpoint** - ✅ Moved to admin port 3001 only
- [x] **Isolate client-side dev features** - ✅ Only visible on admin port (server returns `devMode: false` on port 3000)
- [x] **Isolate `handleDevJoin()` function** - ✅ Only activates on admin port

**Architecture Change:**
- Port 3000 (PUBLIC): Production server - payments required, no dev features
- Port 3001 (ADMIN): Testing server - free joins, bot management (keep private/local only)

This approach is MORE secure than removal because:
1. Production port has zero dev code paths reachable
2. Testing capability preserved for development
3. Even if client code is inspected, server enforces restrictions

### 1.3 Input Validation ✅ COMPLETE (2026-01-17)
- [x] **Validate WebSocket message types** against whitelist in `protocol.js` - ✅ Added VALID_CLIENT_MESSAGE_TYPES Set
- [x] **Validate `targetX`/`targetY`** are numbers within arena bounds - ✅ isValidCoordinate() checks finite numbers 0-1600/0-900
- [x] **Validate `lobbyId`** is integer 1-10 (or configured max) - ✅ isValidLobbyId() validates integer in range
- [x] **Validate `paymentTxHash`** is valid Ethereum hash format (0x + 64 hex chars) - ✅ isValidTxHash() with regex (also accepts dev/bot hashes)
- [x] **Add schema validation** for all incoming WebSocket messages - ✅ MESSAGE_VALIDATORS map with validators for each message type

**Implementation Details:**
- All validation in `server/protocol.js` with `parseMessage()` returning `{message, error}`
- `server/index.js` updated to handle new return format and log validation errors
- Validation errors logged server-side but not exposed to client (security)

### 1.4 Payment Security ✅ COMPLETE (2026-01-17)
- [x] **Check lobby wallet balance before match starts** - ✅ Checks balance >= 2.4 USDC before starting match, throws INSUFFICIENT_LOBBY_BALANCE
- [x] **Add confirmation count check** for payment verification (minimum 3 blocks) - ✅ MIN_CONFIRMATIONS = 3 in payments.js
- [x] **Add transaction age limit** - Reject payments older than 1 hour - ✅ MAX_TX_AGE_MS = 60 min in payments.js
- [x] **Implement payment amount tolerance** - Handle gas price variations - ✅ AMOUNT_TOLERANCE_PERCENT = 1% in payments.js

**Implementation Details:**
- Balance check in `match.js:startMatch()` verifies lobby wallet has enough for winner payout
- All payment verification options in `payments.js:verifyPayment()` with configurable checks
- Payouts come from lobby wallet, not treasury (treasury only receives swept fees)

---

## Phase 2: Error Handling & Reliability 🔴
*Server must not crash or lose player funds under any circumstance*

### 2.1 Blockchain Error Handling ✅ COMPLETE (2026-01-17)
- [x] **Add try-catch to `sendWinnerPayout()`** in `match.js:322-331` - ✅ Catches exceptions, converts to error result
- [x] **Add try-catch to `sendRefundFromLobby()`** in `lobby.js:295-304` - ✅ Both timeout and treasury refunds wrapped
- [x] **Handle RPC connection failures** in `payments.js:initProvider()` - ✅ Try-catch with fallback on init failure
- [x] **Implement RPC provider fallback list** - ✅ 3 public Base RPCs: mainnet.base.org, base.publicnode.com, 1rpc.io/base
- [x] **Distinguish error types** - ✅ `classifyError()` returns 'transient', 'permanent', or 'unknown'
- [x] **Add retry logic** for transient blockchain errors - ✅ `withRetry()` with 3 attempts, exponential backoff (1s→2s→4s)

**Implementation Details:**
- `payments.js`: Added `classifyError()`, `withRetry()`, `switchToNextProvider()`, `testRpcConnection()`
- Transient errors (timeouts, rate limits, 5xx) trigger retry with RPC provider switch
- Permanent errors (insufficient funds, reverts) fail immediately without retry
- Custom RPC via `BASE_RPC_URL` env var is used first, then fallbacks

### 2.2 Database Error Handling ✅ COMPLETE (2026-01-17)
- [x] **Wrap all database operations in try-catch** in `database.js` - ✅ `withDbErrorHandling()` wrapper on all 26+ functions
- [x] **Add connection health check** on server startup - ✅ `checkHealth()` with fail-fast on startup, `/api/health` enhanced
- [x] **Implement graceful degradation** - ✅ Retry logic for BUSY errors + deferred queue for non-critical operations
- [x] **Add transaction rollback** for multi-step operations - ✅ `withTransaction()` + 3 atomic operations

**Implementation Details:**
- `database.js`: Added `DbErrorType` enum, `classifyDbError()`, `withDbErrorHandling()` wrapper
- Error types: CONNECTION, CONSTRAINT, BUSY, CORRUPT, READONLY, UNKNOWN
- Discord alerts for serious DB errors (not constraint violations)
- Server exits on startup if database unhealthy
- `closeDb()` called on graceful shutdown
- Graceful degradation: BUSY errors retry 3x with 50ms→100ms→200ms backoff
- Non-critical operations (reads, logs) queued for later if BUSY persists
- Critical operations (createUser, addLobbyPlayer, etc.) fail immediately if unrecoverable
- `/api/health` now includes `deferredQueue` status
- Transaction support: `withTransaction()` wrapper with automatic rollback on failure
- Atomic operations: `createMatchWithPlayers()`, `resetLobbyWithPlayers()`, `endMatchWithLobbyReset()`

### 2.3 Game Loop Protection ✅ COMPLETE (2026-01-17)
- [x] **Add error boundary to `processTick()`** - ✅ Try-catch in `startGameLoop()` with error classification
- [x] **Implement match recovery** if tick processing fails - ✅ Transient errors allow retry, critical errors void match
- [x] **Add health monitoring** for game loop (detect if it stops) - ✅ `startHealthMonitor()` detects stalled loops

**Implementation Details:**
- `match.js`: Added error boundary in game loop interval
- `classifyTickError()` distinguishes critical vs transient errors
- Consecutive error tracking via `matchTickErrors` Map
- `MAX_CONSECUTIVE_TICK_ERRORS = 3` before voiding match
- `MAX_TICK_STALENESS = 2000ms` before health monitor voids match
- Health monitor runs every 5s checking all active matches
- `getHealthStatus()` returns match health for `/api/health`
- Discord alerts on game loop failures

### 2.4 Match State Persistence ✅ COMPLETE (2026-01-17)
- [x] **Save match state to database every tick** (or every N ticks) - ✅ Saves every 5 ticks (~167ms) via `persistMatchState()`
- [x] **Implement crash recovery on startup** - Resume interrupted matches - ✅ `recoverInterruptedMatches()` voids and refunds on startup
- [x] **Auto-refund players** for unrecoverable matches - ✅ Treasury refunds via `voidAndRefundFromRecovery()`
- [x] **Add match state versioning** for safe updates - ✅ `CURRENT_STATE_VERSION = 1`, `COMPATIBLE_STATE_VERSIONS` array

**Implementation Details:**
- `database/schema.sql`: Added `match_state` table (match_id, version, tick, status, state_json, updated_at)
- `database.js`: Added `saveMatchState()`, `getMatchState()`, `getInterruptedMatches()`, `deleteMatchState()`
- `match.js`: Added `persistMatchState()`, `recoverInterruptedMatches()`, `voidAndRefundFromRecovery()`
- State saved every 5 ticks (PERSISTENCE_INTERVAL) - balances SQLite performance with acceptable state loss (~167ms max)
- State older than 5 minutes (MAX_STATE_AGE_MS) is considered unrecoverable
- Recovery currently always voids and refunds (reconnection not implemented yet)
- Discord MATCH_RECOVERED alerts sent for each recovered match
- State cleaned up automatically when match ends (endMatch/voidMatch)

### 2.5 Payout Failure Handling ✅ COMPLETE (2026-01-17)
- [x] **Check treasury balance before awarding winner** - ✅ Checks treasury can cover refunds before payout attempt
- [x] **If payout fails: void match and refund all players** - ✅ `endMatch()` now voids and calls `processTreasuryRefund()` on failure
- [x] **Log all payout attempts** with full transaction details - ✅ New `payout_attempts` table with full audit trail
- [x] **Create admin alert** for payout failures - ✅ Discord webhook alerts (already existed)

**Implementation Details:**
- `database/schema.sql`: Added `payout_attempts` table tracking match_id, recipient, amount, status, tx_hash, errors, source_wallet, treasury_balance
- `database.js`: Added `logPayoutAttempt()`, `updatePayoutAttempt()`, `getPayoutAttempts()`, `getFailedPayouts()`
- `match.js:endMatch()`: Now checks treasury balance before payout, logs attempt, voids match on failure, refunds all players
- Logs warning if treasury balance insufficient for potential refunds (payout still attempted)
- Sends `PAYOUT_FAILED` alert with action taken when payout fails

### 2.6 Admin Monitoring & Alerts ✅ COMPLETE (2026-01-17)
- [x] **Discord webhook integration** - `server/alerts.js` module with dual channel support
- [x] **Server start/shutdown alerts** - Notifies on restart (potential crash detection)
- [x] **Payout failure alerts** - Immediate notification with lobby ID, match ID, winner address
- [x] **Refund failure alerts** - Immediate notification with player wallet address
- [x] **Stuck lobby detection** - Alerts if lobby active 2+ hours without completing
- [x] **Match started alerts** - Activity notification when match begins
- [x] **Match completed alerts** - Activity notification with winner and payout status
- [x] **Player joined alerts** - Activity notification when player pays and joins lobby
- [x] **Low ETH balance alerts** - Warns when lobby/treasury wallet low on gas
- [x] **RPC error alerts** - Blockchain connection issues after all retries exhausted
- [x] **Database error alerts** - Database operation failures (except expected constraint errors)
- [x] **Insufficient balance alerts** - Notifies when lobby wallet lacks funds for payout
- [x] **Match recovered alerts** - Notifies when interrupted match is voided/refunded on startup

**Setup:**
- `DISCORD_WEBHOOK_URL` - Critical alerts channel
- `DISCORD_ACTIVITY_WEBHOOK_URL` - Activity logs channel

**Alert types:**
- Critical (alerts channel): SERVER_START, SERVER_SHUTDOWN, PAYOUT_FAILED, REFUND_FAILED, LOBBY_STUCK, LOW_ETH_LOBBY, LOW_ETH_TREASURY, RPC_ERROR, DATABASE_ERROR, INSUFFICIENT_BALANCE, MATCH_RECOVERED
- Activity (activity channel): MATCH_STARTED, MATCH_COMPLETED, PLAYER_JOINED

**Implementation locations:**
- `alerts.js`: Alert module with `sendAlert()` and `AlertType` enum
- `index.js:611,617`: SERVER_START, SERVER_SHUTDOWN
- `index.js:478`: INSUFFICIENT_BALANCE
- `match.js:129`: MATCH_RECOVERED
- `match.js:276`: MATCH_STARTED
- `match.js:462,937`: DATABASE_ERROR (tick persistence failures)
- `match.js:684`: MATCH_COMPLETED
- `match.js:708`: PAYOUT_FAILED
- `lobby.js:237`: PLAYER_JOINED
- `lobby.js:333,385`: REFUND_FAILED
- `lobby.js:533`: LOBBY_STUCK
- `payments.js:171`: RPC_ERROR
- `payments.js:635,641`: LOW_ETH_LOBBY, LOW_ETH_TREASURY
- `database.js:219,317`: DATABASE_ERROR

---

## Phase 3: Code Cleanup 🟡
*Remove debug code and prepare for production deployment*

### 3.1 Debug Logging Removal
- [x] **Remove debug logs from `physics.js`** (~12 console.log statements) - ✅ Already gated behind DEBUG_PHYSICS env var (audit fix M12)
- [x] **Remove debug logs from `match.js`** (~13 console.log statements) - ✅ All gated behind DEBUG_MATCH env var (audit fix L7 + 4 additional)
- [x] **Remove debug logs from `client/src/ui.js`** (~10 console.log statements) - ✅ Removed 6 debug logs (lines 302, 326, 334, 347, 356, 592-596)
- [x] **Remove `[DEBUG]`, `[FINAL2]`, `[COLLISION]` prefixed logs** - ✅ Server logs gated behind DEBUG_* env vars; Client logs removed from input.js (9) and interpolation.js (1)
- [x] **Implement proper logging system** (Winston or similar) - ✅ Created server/appLogger.js with Winston, category loggers, file rotation
- [x] **Add log levels** (error, warn, info, debug) with environment control - ✅ LOG_LEVEL env var, defaults to 'info' in production, 'debug' in development

### 3.2 Hardcoded Values
- [x] **Move payout amounts to config** - Buy-in, winner payout, treasury cut - ✅ Created server/config.js with env var overrides (BUY_IN_AMOUNT, WINNER_PAYOUT, TREASURY_CUT)
- [x] **Move rate limits to config** - INPUT/sec, OTHER/sec, max connections - ✅ RATE_LIMIT_INPUT, RATE_LIMIT_OTHER, MAX_CONNECTIONS_PER_IP env vars
- [x] **Move countdown duration to config** - Currently hardcoded 3 seconds - ✅ COUNTDOWN_DURATION env var
- [x] **Replace `Date.now()` RNG seed** with cryptographic random - ✅ Using crypto.randomInt() in config.generateSecureRngSeed()

### 3.3 Code Quality
- [x] **Remove circular dependencies** between `match.js` and `lobby.js` - ✅ Verified: No circular dependency exists (match.js → lobby.js is one-way)
- [x] **Add JSDoc comments** to public functions - ✅ Added JSDoc to all public functions across server (lobby.js, database.js) and client modules (renderer.js, network.js, interpolation.js, input.js, wallet.js)
- [x] **Create API documentation** for WebSocket protocol - ✅ Created docs/WEBSOCKET_API.md with complete protocol documentation

---

## Phase 4: User Features 🟠
*Features needed for a complete user experience*

### 4.1 User Stats & Progression
- [x] **Track wins/losses per player** in database - ✅ Added `player_stats` table keyed by wallet_address (only created when player pays to join); tracks wins, losses, streaks, earnings/spending
- [x] **Track total earnings/losses** in USDC - ✅ `total_earnings_usdc` and `total_spent_usdc` tracked in `player_stats`
- [x] **Calculate win rate** and display on profile - ✅ Win rate calculated in `/api/player/:wallet` endpoint
- [x] **Show match history** with timestamps and outcomes - ✅ `/api/player/:wallet/history` endpoint with opponents, roles, results
- [x] **Create user profile page** with stats - ✅ Added profile tab with stats, match history, photo upload, username editing
- [x] **Username system** - ✅ Usernames permanently reserved (no re-use); requires 1+ completed match to set
- [x] **Profile photo upload** - ✅ Base64 image storage with 500KB limit; requires 1+ completed match

### 4.2 Leaderboard
- [x] **Create leaderboard database query** - ✅ `getLeaderboard()` returns top players by wins
- [x] **Add leaderboard API endpoint** - ✅ `/api/leaderboard` with win rates, earnings, streaks
- [x] **Build leaderboard UI** in client - ✅ Added leaderboard tab showing top 50 players with rank, wins, winrate, earnings
- [x] **Add time-based filters** (all-time, monthly, weekly) - ✅ Added `?period=all|monthly|weekly` to `/api/leaderboard`; UI filter buttons in client

### 4.3 Match History
- [x] **Query function for user's match history** - ✅ `getPlayerMatchHistory()` in database.js
- [x] **Display last 20 matches** on profile - ✅ Available via `/api/player/:wallet/history?limit=20`
- [x] **Show match details** - ✅ Returns players, roles, outcome, payout per match

### 4.4 Reconnection Improvements
- [x] **Add reconnection grace period** (30-60 seconds) - ✅ `RECONNECT_GRACE_PERIOD=30` env var; disconnected players have 30s to reconnect before auto-elimination
- [x] **Persist connection tokens** for reconnection - ✅ Session tokens used for auth allow reconnection to active match via `handleReconnect()`
- [x] **Notify other players** of disconnect/reconnect - ✅ `PLAYER_DISCONNECT` and `PLAYER_RECONNECT` messages; visual "DC" indicator on disconnected players
- [x] **Handle wallet account changes** during match - ✅ Wallet changes during match = forfeit; player gets disconnected and grace period applies

### 4.5 Phase 4 Audit Fixes ✅ COMPLETE (2026-01-18)
*Security and reliability fixes identified in Phase 4 audit (see docs/PHASE4_AUDIT_REPORT.md)*

#### Critical Fixes
- [x] **CRITICAL-1: Win streak race condition** - ✅ Changed `recordMatchResult()` to use atomic SQL `CASE WHEN` for streak calculation instead of read-calculate-write pattern
- [x] **CRITICAL-2: Session token replay attack** - ✅ Added `rotateToken()` in session.js; tokens rotated on reconnection to prevent hijacking; `TOKEN_UPDATE` message sent to client

#### High Priority Fixes
- [x] **HIGH-1: Grace period not persisted** - ✅ Added `disconnectedAt` to `persistMatchState()` for crash recovery
- [x] **HIGH-2: Reconnect/grace period race** - ✅ Added `clearGracePeriod()` called immediately on reconnect message receipt before `handleReconnect()`
- [x] **HIGH-3: Missing composite index** - ✅ Added `idx_matches_status_ended ON matches(status, ended_at)` for time-filtered leaderboard queries
- [x] **HIGH-4: Incomplete pagination** - ✅ Added `offset` parameter to `getPlayerMatchHistory()`, new `getPlayerMatchCount()` function, updated API with pagination response

#### Medium Priority Fixes
- [x] **MEDIUM-2: XSS defense-in-depth** - ✅ Changed leaderboard username display to use `textContent` instead of innerHTML
- [x] **MEDIUM-3: Linear reconnection backoff** - ✅ Implemented exponential backoff with jitter in client network.js (1s→2s→4s→8s→16s, capped at 30s)
- [x] **MEDIUM-4: Duplicate reconnect protection** - ✅ Added cleanup of old WebSocket (`oldWs.close(1008)`) before reconnection in `handleReconnect()`
- [x] **MEDIUM-6: Missing HTTP status check** - ✅ Added `response.ok` checks in ui.js for leaderboard and match history fetches
- [x] **MEDIUM-7: Negative limit validation** - ✅ Added `Math.max(1, ...)` to limit parsing in `/api/leaderboard` and `/api/player/:wallet/history`

#### Deferred (Lower Priority)
- [ ] **MEDIUM-1: USDC floating-point** - Requires schema migration to INTEGER with microUSDC
- [ ] **MEDIUM-5: N+1 query pattern** - Performance optimization for match history opponents
- [ ] **MEDIUM-8: Username case-sensitivity** - Design decision on normalization
- [ ] **MEDIUM-9: Stat scope mismatch** - API design decision for time-filtered stats

---

## Phase 5: Infrastructure & Deployment 🔴
*Required infrastructure for production hosting*

### 5.1 HTTPS/WSS Setup
- [ ] **Configure TLS termination** (nginx or CloudFlare)
- [ ] **Obtain SSL certificate** (Let's Encrypt)
- [ ] **Update client to enforce WSS** connections
- [ ] **Add HSTS headers** to HTTP responses
- [ ] **Configure secure WebSocket upgrade**

### 5.2 Database
- [ ] **Evaluate PostgreSQL migration** for multi-instance support
- [ ] **Or: Document single-instance SQLite limitations**
- [ ] **Implement automated backups** (hourly)
- [ ] **Create backup restoration procedure**
- [ ] **Test backup restoration**
- [ ] **Setup WAL checkpointing**

### 5.3 Session & State Management
- [ ] **Evaluate Redis** for session storage (if multi-instance)
- [ ] **Or: Use sticky sessions** with load balancer
- [ ] **Persist active match state** for crash recovery

### 5.4 Monitoring & Alerting
- [ ] **Setup error tracking** (Sentry or similar)
- [ ] **Setup performance monitoring** (APM)
- [ ] **Create alerts for**:
  - [ ] Server errors > 1/minute
  - [ ] Payout failures
  - [ ] Low treasury balance (< 50 USDC)
  - [ ] High latency (> 200ms average)
  - [ ] Database errors
- [ ] **Setup uptime monitoring** (ping every 30 seconds)

### 5.5 RPC Provider
- [ ] **Setup primary RPC provider** (Alchemy/Infura with API key)
- [ ] **Configure fallback providers** (minimum 2 backups)
- [ ] **Add RPC health check** on startup
- [ ] **Monitor RPC latency** and error rates

### 5.6 Deployment Process
- [ ] **Create deployment documentation**
- [ ] **Setup staging environment**
- [ ] **Create deployment script** with rollback capability
- [ ] **Document environment variables** required for production
- [ ] **Setup CI/CD pipeline** (optional but recommended)

---

## Phase 6: Testing & Validation 🟠
*Comprehensive testing before launch*

### 6.1 Functional Testing
- [ ] **Test complete game flow** - Join → Pay → Play → Win → Payout
- [ ] **Test refund scenarios** - Timeout, disconnect, server error
- [ ] **Test with real USDC** on Base mainnet (small amounts)
- [ ] **Test collision detection** edge cases
- [ ] **Test reconnection** during match

### 6.2 Load Testing
- [ ] **Simulate 30 concurrent players** (10 full lobbies)
- [ ] **Measure server CPU/memory** under load
- [ ] **Test WebSocket connection limits**
- [ ] **Verify game loop stability** at 30 Hz under load

### 6.3 Security Testing
- [ ] **Attempt payment bypass** - Verify impossible on port 3000 (production)
- [ ] **Test rate limiting** - Verify protection works
- [ ] **Test invalid WebSocket messages** - Verify graceful handling
- [ ] **Test SQL injection attempts** (should be safe but verify)
- [ ] **Verify wallet signatures** can't be forged
- [ ] **Verify bot endpoints unreachable on port 3000**

### 6.4 Edge Cases
- [ ] **All 3 players disconnect simultaneously**
- [ ] **Treasury runs out of USDC mid-match**
- [ ] **RPC provider goes down during payout**
- [ ] **Player joins then closes browser immediately**
- [ ] **Same wallet tries to join multiple lobbies**

---

## Phase 7: Launch Preparation 🟢
*Final steps before going live*

### 7.1 Legal & Compliance (Consult Attorney)
- [ ] **Terms of Service** document
- [ ] **Privacy Policy** document
- [ ] **Gambling/gaming regulations** compliance (jurisdiction dependent)
- [ ] **Age verification** requirements
- [ ] **Tax reporting** obligations

### 7.2 Treasury Setup
- [ ] **Fund treasury wallet** with initial USDC (recommend 500+ USDC)
- [ ] **Document treasury management** procedures
- [ ] **Setup treasury balance alerts**
- [ ] **Create emergency procedures** for treasury issues

### 7.3 Communication
- [ ] **Create Discord/Telegram** for community
- [ ] **Setup support contact** method
- [ ] **Prepare launch announcement**
- [ ] **Document known issues/limitations**

### 7.4 Soft Launch
- [ ] **Launch with limited lobbies** (2-3 instead of 10)
- [ ] **Monitor closely** for first 48 hours
- [ ] **Have rollback plan** ready
- [ ] **Gather early user feedback**

---

## Phase 8: Post-Launch Improvements 🟢
*Nice-to-have features for after stable launch*

### 8.1 UX Improvements
- [ ] **Sound effects** for collisions, wins, countdown
- [ ] **Better visual feedback** during gameplay
- [ ] **Smoother animations** with interpolation tuning
- [ ] **Player names/avatars** display during match
- [ ] **Improved result screen** with stats

### 8.2 Game Features
- [ ] **Spectator mode** - Watch ongoing matches
- [ ] **Match replays** - Using logged match events
- [ ] **Private lobbies** with invite codes
- [ ] **Friends list** and invite system
- [ ] **Different buy-in tiers** (0.5, 1, 5 USDC)

### 8.3 Mobile Support
- [ ] **Touch controls** for mobile devices
- [ ] **Responsive UI** for different screen sizes
- [ ] **Mobile wallet integration** (WalletConnect)

### 8.4 Advanced Features
- [ ] **Skill-based matchmaking** using ELO rating
- [ ] **Tournaments** with prize pools
- [ ] **Achievements/badges** system
- [ ] **Seasonal leaderboards** with rewards

---

## Progress Tracking

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 1: Security | ✅ Complete | 100% (1.1 ✅, 1.2 ✅, 1.3 ✅, 1.4 ✅) |
| Phase 2: Error Handling | ✅ Complete | 100% (2.1 ✅, 2.2 ✅, 2.3 ✅, 2.4 ✅, 2.5 ✅, 2.6 ✅) |
| Phase 3: Code Cleanup | ✅ Complete | 100% (3.1 ✅, 3.2 ✅, 3.3 ✅) |
| Phase 4: User Features | ✅ Complete | 100% (4.1 ✅, 4.2 ✅, 4.3 ✅, 4.4 ✅, 4.5 ✅) |
| Phase 5: Infrastructure | ⬜ Not Started | 0% |
| Phase 6: Testing | ⬜ Not Started | 0% |
| Phase 7: Launch Prep | ⬜ Not Started | 0% |
| Phase 8: Post-Launch | ⬜ Not Started | 0% |

---

## Critical Path to Minimum Viable Launch

**Absolute minimum required before ANY real users:**
1. Phase 1 (Security) - ALL items
2. Phase 2 (Error Handling) - ALL items
3. Phase 3.1 (Debug Removal) - ALL items
4. Phase 5.1 (HTTPS) - ALL items
5. Phase 5.2 (Database Backups) - ALL items
6. Phase 5.4 (Basic Monitoring) - Error tracking minimum
7. Phase 6.1 (Functional Testing) - ALL items
8. Phase 6.3 (Security Testing) - ALL items
9. Phase 7.2 (Treasury Setup) - ALL items

**Estimated effort for minimum viable launch**: Significant development work required.

---

## Notes

- Update this document as items are completed
- Mark items with ✅ when done, include date
- Add blockers/issues as they're discovered
- This is a living document - add items as needed
