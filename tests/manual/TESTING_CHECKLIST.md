# RPS-ARENA Phase 6 Testing Checklist

> **Purpose**: Comprehensive manual testing procedures for Phase 6 validation
> **Admin Port**: http://localhost:3001 (free joins, bot management)
> **Production Port**: http://localhost:3000 (real USDC required)

---

## Pre-Testing Setup

### Server Configuration
- [ ] Server running with both ports (3000 and 3001)
- [ ] Database initialized and clean
- [ ] Discord webhooks configured (for alert testing)
- [ ] Environment variables set correctly

### Verification Commands
```bash
# Check server is running
curl http://localhost:3000/api/health
curl http://localhost:3001/api/health

# Verify dev mode status
curl http://localhost:3000/api/dev-mode  # Should return devMode: false
curl http://localhost:3001/api/dev-mode  # Should return devMode: true
```

---

## 6.1 Functional Testing

### F1: Complete Game Flow (Admin Port)

**Objective**: Verify full game cycle works correctly

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Open http://localhost:3001 | Landing page loads | [ ] |
| 2 | Click "Connect Wallet" | Wallet selection modal appears | [ ] |
| 3 | Select wallet and sign message | Redirected to lobby screen | [ ] |
| 4 | Verify username displays | Shows wallet address or username | [ ] |
| 5 | Select Lobby 1 | Lobby details shown | [ ] |
| 6 | Click "Dev Join" button | LOBBY_UPDATE received, playerCount: 1 | [ ] |
| 7 | Fill lobby with bots (command below) | 2 bots added, lobby status: "ready" | [ ] |
| 8 | Wait for match start | MATCH_STARTING message received | [ ] |
| 9 | Verify role assignment | ROLE_ASSIGNMENT with role + spawn position | [ ] |
| 10 | Verify countdown | COUNTDOWN: 3, 2, 1, 0 | [ ] |
| 11 | Game starts | Player can move, SNAPSHOT at ~20Hz | [ ] |
| 12 | Play until end | MATCH_END with winner + payout info | [ ] |
| 13 | Verify lobby reset | Lobby status back to "empty" | [ ] |

**Bot Fill Command**:
```bash
curl -X POST http://localhost:3001/api/bot/fill \
  -H "Content-Type: application/json" \
  -d '{"lobbyId": 1}'
```

**Console Verification** (Browser DevTools):
- [ ] No JavaScript errors
- [ ] WebSocket connection stable
- [ ] All message types received in correct order

---

### F2: Refund Scenarios

#### F2a: Timeout Refund

**Setup**: Configure short timeout for testing
```bash
# In .env, set:
LOBBY_TIMEOUT_MS=60000  # 1 minute for testing
```

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Join Lobby 1 via Dev Join | Player in lobby, status: "waiting" | [ ] |
| 2 | Wait for timeout (1 min) | Timeout message appears in UI | [ ] |
| 3 | Click "Request Refund" | REFUND_PROCESSED message | [ ] |
| 4 | Check server logs | Refund transaction logged | [ ] |
| 5 | Verify lobby reset | Lobby status: "empty" | [ ] |

#### F2b: Disconnect During Lobby Wait

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Join Lobby 1 with Player A | Player A in lobby | [ ] |
| 2 | Add 1 bot to lobby | 2 players in lobby | [ ] |
| 3 | Close Player A's browser | WebSocket close event fired | [ ] |
| 4 | Check lobby status | Player A removed from lobby | [ ] |
| 5 | Verify no crash | Server still responsive | [ ] |

**Bot Add Command**:
```bash
curl -X POST http://localhost:3001/api/bot/add \
  -H "Content-Type: application/json" \
  -d '{"lobbyId": 1}'
```

#### F2c: Server Crash Mid-Match (Recovery Test)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start match with 3 players | Match running | [ ] |
| 2 | Note match ID from logs | Match ID recorded | [ ] |
| 3 | Kill server (Ctrl+C) | Server stops | [ ] |
| 4 | Restart server | Server starts | [ ] |
| 5 | Check startup logs | "Recovering interrupted matches" logged | [ ] |
| 6 | Verify match voided | Match status: "void" in database | [ ] |
| 7 | Verify refund attempted | Refund transactions logged | [ ] |
| 8 | Check Discord alerts | MATCH_RECOVERED alert sent | [ ] |

---

### F3: Collision Detection

#### F3a: Elimination Collision (Rock vs Scissors)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start match | 3 players with different roles | [ ] |
| 2 | Move rock player toward scissors | Players approach each other | [ ] |
| 3 | Collision occurs | ELIMINATION message for scissors | [ ] |
| 4 | Verify correct loser | Rock beats scissors | [ ] |
| 5 | Eliminated player frozen | Scissors player stops moving | [ ] |

#### F3b: Same-Role Bounce (Rock vs Rock)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start match with controlled roles | Two players have same role | [ ] |
| 2 | Move same-role players together | Players approach each other | [ ] |
| 3 | Collision occurs | BOUNCE message received | [ ] |
| 4 | Verify push-apart | Players separated, no elimination | [ ] |

**Note**: May need to modify bot code or use multiple browser tabs to control specific roles.

#### F3c: Arena Boundary

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Move player to edge | Player approaches boundary | [ ] |
| 2 | Verify boundary enforcement | Player stops at edge (0-1600 x 0-900) | [ ] |
| 3 | No escape possible | Player contained in arena | [ ] |

---

### F4: Reconnection During Match

#### F4a: Successful Reconnection (Within Grace Period)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start match with human player | Match running | [ ] |
| 2 | Open Network tab in DevTools | Network monitoring active | [ ] |
| 3 | Set network to "Offline" | Connection drops | [ ] |
| 4 | Verify disconnect message | Other players see PLAYER_DISCONNECT | [ ] |
| 5 | Wait 10 seconds | Grace period counting down | [ ] |
| 6 | Set network back to "Online" | Connection restored | [ ] |
| 7 | Verify reconnection | RECONNECT_STATE message received | [ ] |
| 8 | Other players notified | PLAYER_RECONNECT broadcast | [ ] |
| 9 | Game continues normally | Player can move, snapshots resume | [ ] |

#### F4b: Failed Reconnection (Grace Period Exceeded)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start match with human player | Match running | [ ] |
| 2 | Close browser tab | WebSocket closes | [ ] |
| 3 | Wait 35 seconds | Beyond 30s grace period | [ ] |
| 4 | Check server logs | "Grace period expired" logged | [ ] |
| 5 | Player eliminated | ELIMINATION message for disconnected player | [ ] |
| 6 | Match continues | Remaining players still playing | [ ] |

---

## 6.2 Load Testing

### Targets
- **Concurrent Players**: 30 (10 full lobbies)
- **Server CPU**: < 80%
- **Server Memory**: < 512MB
- **Game Loop**: Stable 30 Hz

### L1: Concurrent Connections Test

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Run load test script | 30 connections established | [ ] |
| 2 | Monitor for 5 minutes | All connections stable | [ ] |
| 3 | Check message throughput | ~1800 INPUT/sec total | [ ] |
| 4 | Verify no disconnects | 0 unexpected disconnections | [ ] |

**Run Load Test**:
```bash
node tests/load/load-test.js
```

### L2: Server Resource Monitoring

**Windows PowerShell**:
```powershell
# Monitor Node.js process
Get-Process node | Select-Object CPU, WorkingSet, Handles

# Count WebSocket connections
netstat -an | Select-String "3001" | Measure-Object
```

| Metric | Target | Actual | Pass/Fail |
|--------|--------|--------|-----------|
| CPU Usage | < 80% | ___% | [ ] |
| Memory (WorkingSet) | < 512MB | ___MB | [ ] |
| Open Connections | 30 | ___ | [ ] |
| Errors | 0 | ___ | [ ] |

### L3: Game Loop Stability

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start 10 matches simultaneously | 10 active game loops | [ ] |
| 2 | Monitor tick timing | ~33ms between ticks (30 Hz) | [ ] |
| 3 | Check for stalls | No ticks > 100ms apart | [ ] |
| 4 | Verify snapshots | 20 Hz snapshot rate maintained | [ ] |

---

## 6.3 Security Testing

### S1: Payment Bypass Attempts (Port 3000)

| Test | Command/Action | Expected | Pass/Fail |
|------|----------------|----------|-----------|
| Fake tx hash | JOIN_LOBBY with `0xaaa...` (64 chars) | ERROR 2005 | [ ] |
| Dev tx hash on prod | JOIN_LOBBY with `0xdev_test` | ERROR 2005 | [ ] |
| Bot tx hash on prod | JOIN_LOBBY with `0xbot_tx_test` | ERROR 2005 | [ ] |
| Empty tx hash | JOIN_LOBBY with `""` | ERROR (validation) | [ ] |

**Run Security Tests**:
```bash
node tests/security/security-tests.js
```

### S2: Rate Limiting

| Test | Action | Expected | Pass/Fail |
|------|--------|----------|-----------|
| INPUT flood (>120/sec) | Send 150 INPUT in 1 second | ERROR 5001 after ~120 | [ ] |
| OTHER flood (>10/sec) | Send 15 PING in 1 second | ERROR 5001 after ~10 | [ ] |
| Connection limit (>3/IP) | Open 5 WebSocket connections | 4th+ rejected | [ ] |

### S3: Invalid Messages

| Test | Message | Expected | Pass/Fail |
|------|---------|----------|-----------|
| Malformed JSON | `not json` | Ignored, no crash | [ ] |
| Unknown type | `{"type": "HACK"}` | ERROR unknown type | [ ] |
| Oversized (>16KB) | 20KB payload | ERROR too large | [ ] |
| Invalid coordinates | `targetX: "string"` | Validation error | [ ] |
| Negative sequence | `sequence: -1` | Validation error | [ ] |
| NaN coordinates | `targetX: NaN` | Validation error | [ ] |

### S4: SQL Injection

| Test | Input | Expected | Pass/Fail |
|------|-------|----------|-----------|
| Username injection | `'; DROP TABLE users; --` | Blocked by validation | [ ] |
| Wallet injection | `0x' OR 1=1 --` | Blocked by regex | [ ] |

### S5: Authentication

| Test | Action | Expected | Pass/Fail |
|------|--------|----------|-----------|
| Invalid signature | Random signature bytes | Auth rejected | [ ] |
| Expired timestamp | timestamp - 10 minutes | Auth rejected | [ ] |
| Wrong wallet | Sign as A, claim as B | Auth rejected | [ ] |

### S6: Bot Endpoints on Production Port

```bash
# All should return 404
curl -X POST http://localhost:3000/api/bot/add -d '{"lobbyId":1}'
curl -X POST http://localhost:3000/api/bot/fill -d '{"lobbyId":1}'
curl -X GET http://localhost:3000/api/bot/list
curl -X POST http://localhost:3000/api/dev/reset -d '{"lobbyId":1}'
```

| Endpoint | Response | Pass/Fail |
|----------|----------|-----------|
| POST /api/bot/add | 404 | [ ] |
| POST /api/bot/fill | 404 | [ ] |
| GET /api/bot/list | 404 | [ ] |
| POST /api/dev/reset | 404 | [ ] |

---

## 6.4 Edge Case Testing

### E1: All 3 Players Disconnect Simultaneously

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Start match with 3 connections | Match running | [ ] |
| 2 | Close all 3 connections at once | All disconnect events fired | [ ] |
| 3 | Wait 30+ seconds | Grace periods expire | [ ] |
| 4 | Check match status | Match voided (no winner) | [ ] |
| 5 | Verify refunds attempted | Refund transactions logged | [ ] |
| 6 | Lobby reset | Status: "empty" | [ ] |

### E2: Low ETH Balance

**Setup**: Drain lobby wallet ETH (keep minimal for test)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Check lobby wallet ETH | Below LOW_ETH_THRESHOLD | [ ] |
| 2 | Start match | Match starts normally | [ ] |
| 3 | Complete match | Winner determined | [ ] |
| 4 | Payout attempted | Fails with "insufficient funds" | [ ] |
| 5 | Discord alert | LOW_ETH_LOBBY alert received | [ ] |
| 6 | Match voided | Status: "void" | [ ] |
| 7 | Refund attempted | May also fail if no ETH | [ ] |

### E3: RPC Provider Failure

**Setup**: Set invalid primary RPC URL

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Set BASE_RPC_URL to invalid | Primary RPC unreachable | [ ] |
| 2 | Attempt payment verification | Retry with fallbacks | [ ] |
| 3 | Check logs | "Switching to fallback RPC" logged | [ ] |
| 4 | Verify fallback works | Payment verified via backup RPC | [ ] |

### E4: Quick Join/Leave

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Join lobby | LOBBY_UPDATE received | [ ] |
| 2 | Close browser immediately (<1s) | WebSocket closes | [ ] |
| 3 | Check lobby status | Player removed | [ ] |
| 4 | Lobby empty | Status: "empty" | [ ] |
| 5 | Server stable | No errors, no crash | [ ] |

### E5: Same Wallet Multiple Lobbies

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Join Lobby 1 | Successfully joined | [ ] |
| 2 | Attempt to join Lobby 2 | ERROR 2003 (already in lobby) | [ ] |
| 3 | Leave Lobby 1 | Successfully left | [ ] |
| 4 | Join Lobby 2 | Successfully joined | [ ] |

---

## Real USDC Testing (Production Port)

> **WARNING**: These tests use real USDC on Base mainnet. Use minimal amounts.

### Prerequisites
- [ ] Test wallet funded with 5 USDC on Base
- [ ] Test wallet has ~0.002 ETH for gas
- [ ] Server running on port 3000 (production mode)
- [ ] Discord alerts configured and working

### R1: Payment Verification (1 USDC)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Connect wallet to port 3000 | Authentication successful | [ ] |
| 2 | Select Lobby 1 | Payment modal appears | [ ] |
| 3 | Note deposit address | Address displayed | [ ] |
| 4 | Send 1 USDC via wallet | Transaction submitted | [ ] |
| 5 | Wait for confirmations | 3+ block confirmations | [ ] |
| 6 | Submit tx hash | JOIN_LOBBY message sent | [ ] |
| 7 | Verify join | LOBBY_UPDATE with playerCount: 1 | [ ] |
| 8 | Check server logs | Payment verified successfully | [ ] |

**Tx Hash**: `0x_____________________________________`

### R2: Winner Payout (2.4 USDC)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Fill lobby (2 more players/bots) | 3 players in lobby | [ ] |
| 2 | Match starts | MATCH_STARTING received | [ ] |
| 3 | Complete match | MATCH_END with winner | [ ] |
| 4 | Check winner's wallet | +2.4 USDC received | [ ] |
| 5 | Check payout_attempts table | Transaction logged | [ ] |
| 6 | Discord notification | MATCH_COMPLETED alert | [ ] |

**Payout Tx Hash**: `0x_____________________________________`

### R3: Refund Test (1 USDC)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 1 | Join lobby with 1 USDC payment | Joined successfully | [ ] |
| 2 | Wait for timeout (or trigger) | Timeout reached | [ ] |
| 3 | Request refund | REFUND_PROCESSED message | [ ] |
| 4 | Check wallet | +1 USDC returned | [ ] |
| 5 | Check server logs | Refund transaction logged | [ ] |

**Refund Tx Hash**: `0x_____________________________________`

---

## Test Summary

### Functional Tests (6.1)
| Test | Status |
|------|--------|
| F1: Complete Game Flow | [ ] PASS / [ ] FAIL |
| F2a: Timeout Refund | [ ] PASS / [ ] FAIL |
| F2b: Disconnect Refund | [ ] PASS / [ ] FAIL |
| F2c: Server Crash Recovery | [ ] PASS / [ ] FAIL |
| F3a: Elimination Collision | [ ] PASS / [ ] FAIL |
| F3b: Same-Role Bounce | [ ] PASS / [ ] FAIL |
| F3c: Arena Boundary | [ ] PASS / [ ] FAIL |
| F4a: Successful Reconnection | [ ] PASS / [ ] FAIL |
| F4b: Failed Reconnection | [ ] PASS / [ ] FAIL |

### Load Tests (6.2)
| Test | Status |
|------|--------|
| L1: 30 Concurrent Connections | [ ] PASS / [ ] FAIL |
| L2: Resource Usage | [ ] PASS / [ ] FAIL |
| L3: Game Loop Stability | [ ] PASS / [ ] FAIL |

### Security Tests (6.3)
| Test | Status |
|------|--------|
| S1: Payment Bypass | [ ] PASS / [ ] FAIL |
| S2: Rate Limiting | [ ] PASS / [ ] FAIL |
| S3: Invalid Messages | [ ] PASS / [ ] FAIL |
| S4: SQL Injection | [ ] PASS / [ ] FAIL |
| S5: Authentication | [ ] PASS / [ ] FAIL |
| S6: Bot Endpoints Blocked | [ ] PASS / [ ] FAIL |

### Edge Cases (6.4)
| Test | Status |
|------|--------|
| E1: All Disconnect | [ ] PASS / [ ] FAIL |
| E2: Low ETH | [ ] PASS / [ ] FAIL |
| E3: RPC Failure | [ ] PASS / [ ] FAIL |
| E4: Quick Join/Leave | [ ] PASS / [ ] FAIL |
| E5: Same Wallet Multi-Lobby | [ ] PASS / [ ] FAIL |

### Real USDC Tests
| Test | Status |
|------|--------|
| R1: Payment Verification | [ ] PASS / [ ] FAIL |
| R2: Winner Payout | [ ] PASS / [ ] FAIL |
| R3: Refund | [ ] PASS / [ ] FAIL |

---

## Issues Found

| # | Description | Severity | Status |
|---|-------------|----------|--------|
| 1 | | | |
| 2 | | | |
| 3 | | | |

---

## Sign-Off

**Tester**: _____________________
**Date**: _____________________
**Overall Status**: [ ] PASS / [ ] FAIL

**Notes**:
