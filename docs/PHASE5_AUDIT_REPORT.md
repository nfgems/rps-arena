# Phase 5: Infrastructure & Deployment - Comprehensive Audit Report

> **Audit Date:** 2026-01-18
> **Auditor:** Claude Opus 4.5
> **Scope:** Phase 5 - Infrastructure & Deployment
> **Status:** PASS WITH RECOMMENDATIONS

---

## Executive Summary

Phase 5 implementation is **functionally complete** and ready for production deployment with the caveats noted below. The infrastructure code is well-structured with appropriate error handling, fallback mechanisms, and monitoring. However, there are several areas requiring attention before going fully live, categorized by severity.

### Overall Assessment

| Category | Status | Notes |
|----------|--------|-------|
| 5.1 HTTPS/WSS Setup | ✅ PASS | Railway handles TLS automatically |
| 5.2 Database Backup | ✅ PASS | Automated hourly backups implemented |
| 5.3 Session Management | ✅ PASS | Single-instance design documented |
| 5.4 Monitoring (Sentry) | ✅ PASS | Optional integration ready |
| 5.5 RPC Provider | ✅ PASS | Fallback chain implemented |
| 5.6 Deployment Config | ⚠️ PASS | Minor improvements recommended |

---

## Detailed Findings

### 5.1 HTTPS/WSS Setup ✅ COMPLETE

**Implementation Review:**

| Item | Status | Location | Notes |
|------|--------|----------|-------|
| TLS termination | ✅ | Railway platform | Railway handles automatically |
| SSL certificate | ✅ | Railway platform | Auto-provisioned |
| WSS enforcement | ✅ | [network.js:33](../client/src/network.js#L33) | Protocol detection works correctly |
| HSTS headers | ✅ | Railway platform | Enforced by default |
| WebSocket upgrade | ✅ | Railway platform | Works with Railway's reverse proxy |

**Code Analysis:**
```javascript
// network.js:33 - Correct protocol selection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
```

**Verdict:** ✅ No issues found. The client correctly detects HTTPS and upgrades to WSS.

---

### 5.2 Database Backup ✅ COMPLETE

**Implementation Review:**

| Item | Status | Location | Notes |
|------|--------|----------|-------|
| Automated backups | ✅ | [index.js:913-935](../server/index.js#L913-L935) | Hourly by default |
| WAL checkpointing | ✅ | [database.js:447-476](../server/database.js#L447-L476) | Runs before each backup |
| Backup cleanup | ✅ | [database.js:566-587](../server/database.js#L566-L587) | Keeps 24 by default |
| Admin endpoints | ✅ | [index.js:395-440](../server/index.js#L395-L440) | POST backup, GET list |
| Online backup | ✅ | [database.js:485-520](../server/database.js#L485-L520) | Uses better-sqlite3 backup API |

**Code Analysis:**

The backup implementation is solid:
- Uses SQLite's online backup API (safe during writes)
- Runs WAL checkpoint before backup to ensure consistency
- Timestamped backups with automatic cleanup
- Configurable via `BACKUP_INTERVAL_HOURS` and `BACKUP_KEEP_COUNT`

**Findings:**

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| B-1 | LOW | Backup directory not created on Railway | Ensure `./backups/` exists in Railway volume |
| B-2 | LOW | No backup verification | Consider adding integrity check after backup |
| B-3 | INFO | Admin endpoints only on port 3001 | Document that Railway doesn't expose admin port |

**Verdict:** ✅ Implementation is production-ready. Minor improvements possible.

---

### 5.3 Session & State Management ✅ COMPLETE

**Implementation Review:**

| Item | Status | Location | Notes |
|------|--------|----------|-------|
| Single-instance docs | ✅ | [DEPLOYMENT.md](../docs/DEPLOYMENT.md) | Architecture clearly documented |
| In-memory sessions | ✅ | [session.js](../server/session.js) | Appropriate for single instance |
| Token rotation | ✅ | [session.js:52-68](../server/session.js#L52-L68) | Security improvement from Phase 4 |
| Session cleanup | ✅ | [session.js:73-81](../server/session.js#L73-L81) | Runs hourly |
| Match state persistence | ✅ | [match.js:57-91](../server/match.js#L57-L91) | Every 5 ticks (~167ms) |

**Code Analysis:**

Session token format is secure:
- 64 hex characters (32 bytes of entropy)
- Generated via `crypto.randomBytes(32)`
- Validated before use with length check

**Findings:**

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| S-1 | MEDIUM | Session stored in DB survives restart but active WebSocket connections lost | Document that server restart = all active games voided |
| S-2 | LOW | `SESSION_SECRET` env var not used in session.js | Remove from `.env.example` or implement for cookie signing if adding cookies |
| S-3 | INFO | Session expiry is 24h by default | Consider shorter expiry for production (4-8h) |

**Verdict:** ✅ Appropriate for single-instance deployment. Limitations documented.

---

### 5.4 Monitoring & Alerting (Sentry) ✅ COMPLETE

**Implementation Review:**

| Item | Status | Location | Notes |
|------|--------|----------|-------|
| Sentry integration | ✅ | [sentry.js](../server/sentry.js) | Full implementation |
| Sensitive data scrubbing | ✅ | [sentry.js:38-47](../server/sentry.js#L38-L47) | Mnemonics and keys removed |
| Error capture | ✅ | [index.js:991-1003](../server/index.js#L991-L1003) | Uncaught exceptions handled |
| Graceful flush | ✅ | [index.js:974](../server/index.js#L974) | Flushes before shutdown |
| Optional enablement | ✅ | [sentry.js:35](../server/sentry.js#L35) | Only active if DSN provided |

**Code Analysis:**

The Sentry implementation is well-designed:
```javascript
// sentry.js:38-47 - Good security practice
beforeSend(event) {
  if (event.extra) {
    delete event.extra.TREASURY_MNEMONIC;
    delete event.extra.LOBBY_WALLET_SEED;
    delete event.extra.WALLET_ENCRYPTION_KEY;
    delete event.extra.SESSION_SECRET;
  }
  return event;
}
```

**Findings:**

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| M-1 | LOW | `@sentry/node` version `^8.0.0` may have breaking changes | Pin to specific version (e.g., `8.0.0`) |
| M-2 | LOW | Performance sampling at 10% in production | Consider 1-5% for cost efficiency |
| M-3 | INFO | No Sentry profiling configured | Optional but useful for performance debugging |

**Verdict:** ✅ Ready for production. Consider tuning sample rates.

---

### 5.5 RPC Provider ✅ COMPLETE

**Implementation Review:**

| Item | Status | Location | Notes |
|------|--------|----------|-------|
| Primary RPC config | ✅ | [payments.js:188-195](../server/payments.js#L188-L195) | Custom RPC first |
| Fallback chain | ✅ | [payments.js:39-43](../server/payments.js#L39-L43) | 3 public fallbacks |
| Auto-switch | ✅ | [payments.js:228-254](../server/payments.js#L228-L254) | On transient errors |
| Health check | ✅ | [payments.js:260-270](../server/payments.js#L260-L270) | Returns latency metrics |
| Error classification | ✅ | [payments.js:97-116](../server/payments.js#L97-L116) | Transient vs permanent |

**Code Analysis:**

Fallback chain order:
1. Custom `BASE_RPC_URL` (Alchemy/Infura recommended)
2. `https://mainnet.base.org` (official, rate-limited)
3. `https://base.publicnode.com` (public)
4. `https://1rpc.io/base` (public)

**Findings:**

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| R-1 | HIGH | No RPC health check on startup | Add RPC connectivity test in `initialize()` |
| R-2 | MEDIUM | `currentRpcIndex` wraps around silently | Log when cycling back to primary after exhausting all |
| R-3 | LOW | No periodic health checks | Consider background health polling |
| R-4 | INFO | Free RPCs have rate limits | Document expected limits in DEPLOYMENT.md |

**Critical Issue R-1 Details:**

The server initializes the RPC provider lazily on first use ([payments.js:200-222](../server/payments.js#L200-L222)). If the RPC is unreachable, the first payment operation will fail. Consider adding:

```javascript
// In initialize() function, after payments.initProvider():
const rpcHealth = await payments.testRpcConnection();
if (!rpcHealth.healthy) {
  console.error('[FATAL] RPC provider unreachable:', rpcHealth.error);
  // Don't exit - fallbacks may work, but alert admin
  sendAlert(AlertType.RPC_ERROR, { operation: 'startup', error: rpcHealth.error });
}
```

**Verdict:** ⚠️ Functional but R-1 should be addressed before production.

---

### 5.6 Deployment Configuration ✅ COMPLETE

**Implementation Review:**

| File | Status | Notes |
|------|--------|-------|
| [railway.json](../railway.json) | ✅ | Proper health checks configured |
| [nixpacks.toml](../nixpacks.toml) | ✅ | Native module compilation handled |
| [DEPLOYMENT.md](../docs/DEPLOYMENT.md) | ✅ | Comprehensive guide |
| [.env.example](../.env.example) | ✅ | All variables documented |
| [.gitignore](../.gitignore) | ✅ | Sensitive files excluded |

**railway.json Analysis:**
```json
{
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

This is appropriate - automatic restart on failures with a cap.

**nixpacks.toml Analysis:**
```toml
[phases.setup]
nixPkgs = ["nodejs_20", "python3", "gcc", "gnumake"]
```

Correctly includes build dependencies for `better-sqlite3` native module.

**Findings:**

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| D-1 | MEDIUM | No PORT env var handling for Railway | Railway sets PORT automatically, but code uses fallback to 3000 which is correct |
| D-2 | MEDIUM | `npm run init-db` in build phase may fail | Move to start script or use SQLite's CREATE IF NOT EXISTS |
| D-3 | LOW | No start script health logging | Add log when server successfully listens |
| D-4 | LOW | Admin port 3001 not accessible on Railway | Document this clearly (already done) |
| D-5 | INFO | No explicit Node.js version in nixpacks | Consider pinning to `nodejs_20` in package.json engines |

**Issue D-2 Details:**

The `nixpacks.toml` runs `npm run init-db` during build, but the database directory may not persist between builds. The current implementation handles this via `CREATE TABLE IF NOT EXISTS` in schema.sql, so this is fine.

**Verdict:** ✅ Configuration is production-ready.

---

## Environment Variables Audit

### Required Variables (Must be set for production)

| Variable | Set in .env.example | Notes |
|----------|---------------------|-------|
| `NODE_ENV` | ✅ | Must be `production` |
| `SESSION_SECRET` | ✅ | Placeholder - MUST generate unique |
| `BASE_RPC_URL` | ✅ | Placeholder - MUST use Alchemy/Infura |
| `TREASURY_MNEMONIC` | ✅ | Placeholder - MUST generate and fund |
| `LOBBY_WALLET_SEED` | ✅ | Placeholder - MUST generate and fund |
| `WALLET_ENCRYPTION_KEY` | ✅ | Placeholder - MUST generate |

### Recommended Variables

| Variable | Set in .env.example | Notes |
|----------|---------------------|-------|
| `DISCORD_WEBHOOK_URL` | ✅ | Critical alerts |
| `DISCORD_ACTIVITY_WEBHOOK_URL` | ✅ | Activity logs |
| `SENTRY_DSN` | ✅ | Error tracking |
| `LOG_LEVEL` | ✅ | Default: info |

### Missing/Unclear Variables

| Issue | Variable | Recommendation |
|-------|----------|----------------|
| Unused | `SESSION_SECRET` | Remove from .env.example or implement |
| Unclear | `CHAIN_ID` | Document that 8453 = Base Mainnet |

---

## Security Considerations

### Credentials That Must Be Unique Per Deployment

1. **TREASURY_MNEMONIC** - Generate fresh, never reuse
2. **LOBBY_WALLET_SEED** - Generate fresh, never reuse
3. **WALLET_ENCRYPTION_KEY** - Generate: `openssl rand -hex 32`
4. **SESSION_SECRET** - Generate: `openssl rand -hex 32`

### Credentials You Mentioned Still Need Updating

Based on your note about personal credentials:

| Service | Variable | Action Required |
|---------|----------|-----------------|
| Railway | N/A | Deploy via Railway dashboard |
| Alchemy | `BASE_RPC_URL` | Get API key from alchemy.com |
| Sentry | `SENTRY_DSN` | Get DSN from sentry.io |

---

## Production Readiness Checklist

### Critical (Must fix before production)

| ID | Finding | Status | Action |
|----|---------|--------|--------|
| R-1 | No RPC health check on startup | ✅ FIXED | Added connectivity test in index.js |

### High Priority (Should fix before production)

| ID | Finding | Status | Action |
|----|---------|--------|--------|
| R-2 | Silent RPC cycling | ✅ FIXED | Added alert in payments.js |
| S-1 | Server restart behavior | ✅ FIXED | Documented in DEPLOYMENT.md |

### Medium Priority (Fix soon after launch)

| ID | Finding | Status | Action |
|----|---------|--------|--------|
| D-2 | Init-db in build phase | ✅ FIXED | Removed from nixpacks.toml (runs at startup) |
| S-2 | Unused SESSION_SECRET | ✅ FIXED | Removed from .env.example |
| M-1 | Sentry version pinning | ✅ FIXED | Pinned to 8.0.0 |

### Low Priority (Nice to have)

| ID | Finding | Status | Action |
|----|---------|--------|--------|
| B-1 | Backup directory creation | ✅ FIXED | Created on startup in index.js |
| B-2 | Backup integrity check | ✅ FIXED | Verify after each backup in index.js |
| R-3 | Periodic RPC health checks | ✅ FIXED | 5-minute polling in payments.js |
| M-2 | Sentry sample rate | ✅ FIXED | Reduced to 5% |
| D-3 | Startup health logging | ✅ FIXED | Added startup summary banner |

---

## Recommendations for Live Production

### 1. Pre-Deployment Checklist

```bash
# Generate all secrets (run locally, save securely offline)
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 32  # WALLET_ENCRYPTION_KEY

# Generate mnemonics using a trusted wallet
# DO NOT use online generators
# Use hardware wallet or reputable software wallet

# Fund wallets on Base mainnet
# Treasury: 0.01 ETH only (no USDC needed - receives swept fees)
# Lobby wallets (10): 0.01 ETH each (for payouts, refunds, fee sweeps)
```

### 2. Railway Configuration

```
# Environment Variables to Set in Railway Dashboard:
NODE_ENV=production
DATABASE_PATH=./data/rps-arena.db
SESSION_SECRET=<your-generated-secret>
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<YOUR_KEY>
CHAIN_ID=8453
USDC_CONTRACT_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
TREASURY_MNEMONIC=<your-treasury-mnemonic>
LOBBY_WALLET_SEED=<your-lobby-seed>
WALLET_ENCRYPTION_KEY=<your-encryption-key>
DISCORD_WEBHOOK_URL=<your-webhook>
DISCORD_ACTIVITY_WEBHOOK_URL=<your-activity-webhook>
SENTRY_DSN=<your-sentry-dsn>
LOG_LEVEL=info
```

### 3. Post-Deployment Verification

1. Visit `https://your-domain.up.railway.app/api/health`
2. Verify database is healthy
3. Check Sentry for any startup errors
4. Monitor Discord for SERVER_START alert
5. Test with small amount (0.01 USDC) before funding fully

### 4. Things That May Not Work In Production

| Concern | Likelihood | Mitigation |
|---------|------------|------------|
| SQLite file locking on Railway | LOW | Railway uses persistent volumes |
| better-sqlite3 native module | LOW | nixpacks.toml handles this |
| WebSocket timeouts behind Railway proxy | LOW | Railway supports long-lived WebSockets |
| Backup directory not persisting | MEDIUM | Configure Railway volume for ./backups |
| Admin port inaccessible | EXPECTED | Use Railway CLI for manual operations |

### 5. Monitoring in Production

Set up monitoring for:
- `/api/health` endpoint (use Railway's built-in or external uptime monitor)
- Discord alerts channel for critical issues
- Sentry dashboard for errors
- Treasury and lobby wallet balances (set up low balance alerts)

---

## Conclusion

Phase 5 implementation is **production-ready** with audit fixes applied (2026-01-18):

### All Fixes Applied ✅
- ✅ **R-1**: RPC health check added on startup
- ✅ **R-2**: Alert added when RPC providers exhausted
- ✅ **R-3**: Periodic RPC health checks (every 5 minutes)
- ✅ **S-1**: Server restart behavior documented prominently
- ✅ **S-2**: Unused SESSION_SECRET removed
- ✅ **M-1**: Sentry pinned to version 8.0.0
- ✅ **M-2**: Sentry sampling reduced to 5%
- ✅ **B-1**: Backup directory created on startup
- ✅ **B-2**: Backup integrity verification after each backup
- ✅ **D-2**: Removed init-db from build phase (runs at startup)
- ✅ **D-3**: Startup health summary logging added

### Pre-Launch Requirements
1. **Credentials** - Must be generated fresh and securely stored
2. **Testing** - Complete Phase 6 testing before real money is at stake

The codebase demonstrates good engineering practices:
- Proper error handling with retry logic
- Graceful degradation when services fail
- Comprehensive alerting
- Well-documented deployment process

**Recommendation:** Proceed to Phase 6 (Testing). After successful testing, Phase 5 is ready for production deployment.

---

*End of Phase 5 Audit Report*
