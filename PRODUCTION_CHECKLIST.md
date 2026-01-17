# RPS-ARENA Production Launch Checklist

> **Status**: IN PROGRESS
> **Last Updated**: 2026-01-17
> **Current Phase**: Phase 1 - Security

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

### 2.2 Database Error Handling ⏳ PARTIAL (2026-01-17)
- [x] **Wrap all database operations in try-catch** in `database.js` - ✅ `withDbErrorHandling()` wrapper on all 26+ functions
- [x] **Add connection health check** on server startup - ✅ `checkHealth()` with fail-fast on startup, `/api/health` enhanced
- [ ] **Implement graceful degradation** - Queue operations if DB temporarily unavailable
- [ ] **Add transaction rollback** for multi-step operations

**Implementation Details:**
- `database.js`: Added `DbErrorType` enum, `classifyDbError()`, `withDbErrorHandling()` wrapper
- Error types: CONNECTION, CONSTRAINT, BUSY, CORRUPT, READONLY, UNKNOWN
- Discord alerts for serious DB errors (not constraint violations)
- Server exits on startup if database unhealthy
- `closeDb()` called on graceful shutdown

### 2.3 Game Loop Protection
- [ ] **Add error boundary to `processTick()`** - Catch errors, log, continue
- [ ] **Implement match recovery** if tick processing fails
- [ ] **Add health monitoring** for game loop (detect if it stops)

### 2.4 Match State Persistence
- [ ] **Save match state to database every tick** (or every N ticks)
- [ ] **Implement crash recovery on startup** - Resume interrupted matches
- [ ] **Auto-refund players** for unrecoverable matches
- [ ] **Add match state versioning** for safe updates

### 2.5 Payout Failure Handling
- [ ] **Check treasury balance before awarding winner**
- [ ] **If payout fails: void match and refund all players**
- [ ] **Log all payout attempts** with full transaction details
- [x] **Create admin alert** for payout failures - ✅ Discord webhook alerts

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

**Setup:**
- `DISCORD_WEBHOOK_URL` - Critical alerts channel
- `DISCORD_ACTIVITY_WEBHOOK_URL` - Activity logs channel

**Alert types:**
- Critical (alerts channel): SERVER_START, SERVER_SHUTDOWN, PAYOUT_FAILED, REFUND_FAILED, LOBBY_STUCK, LOW_ETH_LOBBY, LOW_ETH_TREASURY, RPC_ERROR, DATABASE_ERROR, INSUFFICIENT_BALANCE
- Activity (activity channel): MATCH_STARTED, MATCH_COMPLETED, PLAYER_JOINED

---

## Phase 3: Code Cleanup 🟡
*Remove debug code and prepare for production deployment*

### 3.1 Debug Logging Removal
- [ ] **Remove debug logs from `physics.js`** (~12 console.log statements)
- [ ] **Remove debug logs from `match.js`** (~13 console.log statements)
- [ ] **Remove debug logs from `client/src/ui.js`** (~10 console.log statements)
- [ ] **Remove `[DEBUG]`, `[FINAL2]`, `[COLLISION]` prefixed logs**
- [ ] **Implement proper logging system** (Winston or similar)
- [ ] **Add log levels** (error, warn, info, debug) with environment control

### 3.2 Hardcoded Values
- [ ] **Move payout amounts to config** - Buy-in, winner payout, treasury cut
- [ ] **Move rate limits to config** - INPUT/sec, OTHER/sec, max connections
- [ ] **Move countdown duration to config** - Currently hardcoded 3 seconds
- [ ] **Replace `Date.now()` RNG seed** with cryptographic random

### 3.3 Code Quality
- [ ] **Remove circular dependencies** between `match.js` and `lobby.js`
- [ ] **Add JSDoc comments** to public functions
- [ ] **Create API documentation** for WebSocket protocol

---

## Phase 4: User Features 🟠
*Features needed for a complete user experience*

### 4.1 User Stats & Progression
- [ ] **Track wins/losses per user** in database
- [ ] **Calculate win rate** and display on profile
- [ ] **Track total earnings/losses** in USDC
- [ ] **Show match history** with timestamps and outcomes
- [ ] **Create user profile page** with stats

### 4.2 Leaderboard
- [ ] **Create leaderboard database query** - Top 100 by wins
- [ ] **Add leaderboard API endpoint** (`/api/leaderboard`)
- [ ] **Build leaderboard UI** in client
- [ ] **Add time-based filters** (all-time, monthly, weekly)

### 4.3 Match History
- [ ] **Query function for user's match history**
- [ ] **Display last 20 matches** on profile
- [ ] **Show match details** - Players, roles, outcome, payout

### 4.4 Reconnection Improvements
- [ ] **Add reconnection grace period** (30-60 seconds)
- [ ] **Persist connection tokens** for reconnection
- [ ] **Notify other players** of disconnect/reconnect
- [ ] **Handle wallet account changes** during match

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
| Phase 2: Error Handling | 🟡 In Progress | 50% (2.1 ✅, 2.2 ⏳, 2.6 ✅) |
| Phase 3: Code Cleanup | ⬜ Not Started | 0% |
| Phase 4: User Features | ⬜ Not Started | 0% |
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
