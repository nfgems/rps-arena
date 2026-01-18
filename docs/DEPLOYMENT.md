# RPS-ARENA Deployment Guide

> **Target Platform:** Railway (single instance)
> **Last Updated:** 2026-01-18

---

## Overview

This guide covers deploying RPS-ARENA to Railway. The application is designed for single-instance deployment with SQLite database storage.

### Architecture Constraints

- **Single Instance Only:** Match state and WebSocket connections are stored in-memory. Running multiple instances would cause players to be on different servers.
- **SQLite Database:** File-based database - cannot be shared across instances.
- **Session Storage:** In-memory - sticky sessions not needed for single instance.

> **IMPORTANT: Server Restart Behavior**
>
> When the server restarts (deploy, crash, or manual restart):
> - All active WebSocket connections are dropped
> - All in-progress matches are voided (players receive refunds from lobby wallet)
> - Players must reconnect and rejoin lobbies
> - Session tokens persist in database, so players won't need to re-authenticate
>
> The server automatically detects interrupted matches on startup and processes refunds. Monitor Discord alerts for `SERVER_START` notifications to detect unexpected restarts.

If you need multi-instance scaling in the future, you would need to:
1. Migrate to PostgreSQL for the database
2. Use Redis for session storage
3. Implement WebSocket clustering (e.g., Socket.IO with Redis adapter)

---

## Prerequisites

1. **Railway Account** - Sign up at [railway.app](https://railway.app)
2. **GitHub Repository** - Your code pushed to GitHub
3. **Base RPC Provider** - Alchemy or Infura API key (free tier works)
4. **Wallet Setup:**
   - Treasury wallet with mnemonic (funded with ETH for gas only - no USDC needed)
   - Lobby wallet seed mnemonic (lobby wallets need ETH for gas)
   - Encryption key for wallet storage

---

## Step 1: Create Railway Project

1. Go to [railway.app/new](https://railway.app/new)
2. Click "Deploy from GitHub repo"
3. Select your RPS-ARENA repository
4. Railway will auto-detect Node.js and start building

---

## Step 2: Configure Environment Variables

In Railway dashboard → Your Project → Variables, add:

### Required Variables

```
NODE_ENV=production
DATABASE_PATH=./data/rps-arena.db

# Blockchain
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY
CHAIN_ID=8453
USDC_CONTRACT_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# Wallets (CRITICAL - keep these secret!)
TREASURY_MNEMONIC=<your 12-word treasury mnemonic>
LOBBY_WALLET_SEED=<your 12-word lobby seed mnemonic>
WALLET_ENCRYPTION_KEY=<generate: openssl rand -hex 32>
```

### Recommended Variables

```
# Discord Alerts (create webhooks in your Discord server)
DISCORD_WEBHOOK_URL=<your critical alerts webhook>
DISCORD_ACTIVITY_WEBHOOK_URL=<your activity webhook>

# Error Tracking (free at sentry.io)
SENTRY_DSN=<your Sentry DSN>

# Logging
LOG_LEVEL=info
```

### Optional Variables

```
# Game Settings (defaults are fine)
COUNTDOWN_DURATION=3
RECONNECT_GRACE_PERIOD=30

# Backup Settings
BACKUP_INTERVAL_HOURS=1
BACKUP_KEEP_COUNT=24

# Payment Amounts (in micro-USDC, 1 USDC = 1000000)
BUY_IN_AMOUNT=1000000
WINNER_PAYOUT=2400000
TREASURY_CUT=600000
```

---

## Step 3: Configure Domain

1. In Railway dashboard → Your Project → Settings → Domains
2. Click "Generate Domain" for a `*.up.railway.app` subdomain
3. Or add your custom domain

Railway automatically provisions SSL certificates - HTTPS is enforced.

---

## Step 4: Verify Deployment

1. Wait for the build to complete (2-3 minutes)
2. Visit your domain - you should see the RPS-ARENA game
3. Check the health endpoint: `https://your-domain.up.railway.app/api/health`

Expected health response:
```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "database": {
    "healthy": true,
    "journalMode": "wal"
  },
  "gameLoop": {
    "activeMatches": 0,
    "matches": []
  }
}
```

---

## Step 5: Setup RPC Provider

The game needs a reliable RPC provider to interact with the Base blockchain. Free public RPCs are rate-limited and not recommended for production.

### Recommended: Alchemy (Free Tier)

1. Sign up at [alchemy.com](https://www.alchemy.com/)
2. Create a new app:
   - Name: RPS-ARENA
   - Chain: Base
   - Network: Mainnet
3. Copy your API key from the dashboard
4. Set in Railway: `BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY`

**Free tier limits:** 300M compute units/month (plenty for a small game)

### Alternative: Infura

1. Sign up at [infura.io](https://infura.io/)
2. Create a new key for Base
3. Set: `BASE_RPC_URL=https://base-mainnet.infura.io/v3/YOUR_API_KEY`

### Fallback Behavior

The app automatically falls back to public RPCs if your primary fails:
1. Your configured `BASE_RPC_URL` (primary)
2. `https://mainnet.base.org`
3. `https://base.publicnode.com`
4. `https://1rpc.io/base`

---

## Step 6: Fund Your Wallets

Before players can join, you need to fund your wallets:

### Wallet Architecture

- **Lobby Wallets:** Receive player deposits, send winner payouts, and process refunds. All USDC flows through lobby wallets.
- **Treasury Wallet:** Receives swept fees from lobby wallets after matches. Only needs ETH for gas to receive sweeps (no USDC needed).

### Funding Instructions

1. **Get your Treasury wallet address:**
   - The treasury address is derived from `TREASURY_MNEMONIC`
   - Check server logs on startup for the address, or use:
   ```javascript
   const { ethers } = require('ethers');
   const wallet = ethers.Wallet.fromPhrase(process.env.TREASURY_MNEMONIC);
   console.log('Treasury:', wallet.address);
   ```

2. **Fund the Treasury:**
   - Send ETH for gas only (0.01 ETH is plenty)
   - **No USDC needed** - treasury only receives fees swept from lobby wallets

3. **Get your Lobby wallet addresses:**
   - Lobby wallets are derived from `LOBBY_WALLET_SEED` with index 0-9
   - Fund each with ETH for gas (0.01 ETH each recommended)
   - **Important:** Lobby wallets need enough ETH to:
     - Send winner payouts (2.4 USDC)
     - Process refunds if matches are voided
     - Sweep fees to treasury after matches
   - Players send USDC directly to lobby wallets

---

## Database Backups

### Automated Backups

The server automatically creates hourly backups:
- Stored in `./backups/` directory
- Keeps last 24 backups by default
- Uses SQLite's online backup (safe during writes)

### Manual Backup

Railway doesn't expose the admin port, but you can:

1. **SSH into Railway (Pro plan):**
   ```bash
   railway run node -e "require('./server/database').createTimestampedBackup()"
   ```

2. **Download via Railway CLI:**
   ```bash
   railway run cat ./backups/latest.db > local-backup.db
   ```

### Restore from Backup

1. Stop the Railway deployment
2. Upload backup file to `./data/rps-arena.db`
3. Restart the deployment

---

## Monitoring

### Health Check

Railway pings `/api/health` automatically. The app is configured for:
- 30-second health check timeout
- Automatic restart on failure (up to 3 retries)

### Discord Alerts

Set up Discord webhooks to receive alerts for:
- Server start/restart (helps detect crashes)
- Payout failures
- Low wallet balance
- Database errors
- Match completions

### Sentry (Error Tracking)

1. Create account at [sentry.io](https://sentry.io)
2. Create a Node.js project
3. Add the DSN to `SENTRY_DSN` env var

---

## Scaling Considerations

### Current Limits (Single Instance)

| Resource | Limit | Notes |
|----------|-------|-------|
| Concurrent players | ~50-100 | Limited by CPU for 30Hz game loop |
| Concurrent matches | ~15-30 | Each match uses ~3-5% CPU |
| Database size | Unlimited | SQLite handles large DBs well |
| WebSocket connections | ~500 | Railway's container limits |

### If You Need to Scale

For 100+ concurrent players:

1. **Upgrade Railway plan** - More CPU/RAM
2. **Optimize game loop** - Reduce tick rate for idle matches
3. **Consider VPS** - Better performance per dollar at scale

For 500+ concurrent players, you'd need to re-architect for multiple instances (PostgreSQL, Redis, etc.).

---

## Troubleshooting

### Build Fails

**Error:** `better-sqlite3` native module compilation
**Solution:** The `nixpacks.toml` file includes necessary build dependencies. If issues persist, check Railway build logs.

### WebSocket Connection Fails

**Symptom:** Game connects but WebSocket immediately disconnects
**Check:**
1. Domain is using HTTPS (Railway enforces this)
2. No proxy/CDN interfering with WebSocket upgrade

### Payments Not Verifying

**Check:**
1. RPC provider is working (not rate limited)
2. Correct USDC contract address for Base mainnet
3. Transaction is on correct chain (Base, not Ethereum mainnet)

### Database Corruption

**Symptom:** Server won't start, database errors in logs
**Solution:**
1. Check Railway logs for specific error
2. If WAL corruption: delete `*.db-wal` and `*.db-shm` files
3. If severe: restore from backup

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Railway sets this automatically |
| `NODE_ENV` | Yes | development | Set to `production` |
| `DATABASE_PATH` | No | ./data/rps-arena.db | SQLite file path |
| `SESSION_EXPIRY_HOURS` | No | 24 | Session expiration time |
| `BASE_RPC_URL` | Yes | mainnet.base.org | Base RPC endpoint |
| `CHAIN_ID` | No | 8453 | Base mainnet chain ID |
| `USDC_CONTRACT_ADDRESS` | No | 0x833589... | Base USDC address |
| `TREASURY_MNEMONIC` | Yes | - | 12-word mnemonic |
| `LOBBY_WALLET_SEED` | Yes | - | 12-word mnemonic |
| `WALLET_ENCRYPTION_KEY` | Yes | - | 32-byte hex key |
| `DISCORD_WEBHOOK_URL` | No | - | Critical alerts webhook |
| `DISCORD_ACTIVITY_WEBHOOK_URL` | No | - | Activity webhook |
| `SENTRY_DSN` | No | - | Sentry error tracking |
| `LOG_LEVEL` | No | info | error/warn/info/debug |
| `BACKUP_INTERVAL_HOURS` | No | 1 | Hours between backups |
| `BACKUP_KEEP_COUNT` | No | 24 | Number of backups to keep |

---

## Security Checklist

Before going live:

- [ ] `NODE_ENV=production` is set
- [ ] Wallet mnemonics are securely generated and backed up offline
- [ ] `WALLET_ENCRYPTION_KEY` is a strong random value
- [ ] Discord alerts are configured
- [ ] Treasury wallet is funded with ETH for gas (no USDC needed)
- [ ] Lobby wallets are funded with ETH for gas (0.01 ETH each)
- [ ] Domain is using HTTPS (Railway enforces this)
- [ ] You've tested a complete game flow with real USDC (small amounts)

---

## Quick Reference Commands

```bash
# Generate session secret
openssl rand -hex 32

# Generate encryption key
openssl rand -hex 32

# Generate wallet mnemonic (use a proper tool, not this)
# Recommended: Use a hardware wallet or reputable wallet app

# Check health
curl https://your-domain.up.railway.app/api/health

# View logs
railway logs
```

---

*End of Deployment Guide*
