# RPS-ARENA

A real-time 3-player Rock-Paper-Scissors arena game with USDC payments on Base network.

## Overview

RPS-ARENA is a competitive web-based game where three players battle in a physics-enabled arena with real monetary stakes. Players connect their wallets, join lobbies, and compete for USDC prizes.

## Features

- **Real-Time Multiplayer** - 3 players compete simultaneously in physics-enabled arenas
- **Rock-Paper-Scissors Combat** - Each player is assigned Rock, Paper, or Scissors
- **Blockchain Payments** - 1 USDC entry fee, 2.4 USDC winner payout (Base network)
- **Wallet Authentication** - Sign-In With Ethereum (SIWE)
- **Showdown Mode** - Special end-game mechanic with heart collection
- **12 Fixed Lobbies** - Pre-created lobbies with dedicated deposit wallets
- **Reconnection Support** - 30-second grace period during matches

## Tech Stack

**Backend:** Node.js, Express, WebSocket (ws), SQLite, Ethers.js

**Frontend:** Vanilla JavaScript, HTML5 Canvas, WebSocket API

**Blockchain:** Base network, USDC stablecoin

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- Base network RPC provider (Alchemy or Infura)
- Wallet mnemonics for treasury and lobby wallets

### Installation

```bash
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```env
BASE_RPC_URL=https://mainnet.base.org
TREASURY_MNEMONIC=your-treasury-wallet-mnemonic
LOBBY_WALLET_SEED=your-lobby-wallet-seed
WALLET_ENCRYPTION_KEY=32-byte-encryption-key
```

### Running

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

### Ports

- **Port 3000** - Production server (requires real USDC payments)
- **Port 3001** - Admin/testing server (free joins, bot management)

## Testing

```bash
npm run test:security    # Security vulnerability tests
npm run test:load        # Load/performance tests
npm run test:e2e         # End-to-end game flow tests
```

## Project Structure

```
├── server/           # Backend (Express + WebSocket)
│   ├── index.js      # Main entry point
│   ├── match.js      # Match management & game loop
│   ├── physics.js    # Physics engine & RPS logic
│   ├── lobby.js      # Lobby management
│   ├── payments.js   # Blockchain transactions
│   └── ...
├── client/           # Frontend
│   ├── index.html    # Main page
│   ├── style.css     # Styling
│   └── src/          # JavaScript modules
├── database/         # SQLite schema
├── tests/            # Test suites
└── docs/             # Documentation
```

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md) - Railway deployment instructions
- [WebSocket API](docs/WEBSOCKET_API.md) - Protocol documentation

## Game Mechanics

1. Players connect wallet and join a lobby
2. Once 3 players join, match begins after countdown
3. Players are assigned Rock, Paper, or Scissors roles
4. Use keyboard (WASD/Arrow keys) to move in the arena
5. Collide with opponents to attack (RPS rules apply)
6. 2 hits eliminates a player
7. Last player standing wins (or collect 2 hearts in Showdown mode)

## License

MIT
