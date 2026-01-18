# RPS Arena WebSocket API

This document describes the WebSocket protocol used for real-time communication between the client and server.

## Connection

Connect to the WebSocket server at:
- **Development**: `ws://localhost:3000`
- **Production**: `wss://your-domain.com`

## Authentication Flow

1. Client connects to WebSocket
2. Client sends `HELLO` message with session token
3. Server responds with `WELCOME` message containing user ID
4. Server automatically sends initial `LOBBY_LIST`

## Message Format

All messages are JSON objects with a `type` field indicating the message type.

---

## Client Messages (Client → Server)

### HELLO
Authentication message sent immediately after connecting.

```json
{
  "type": "HELLO",
  "sessionToken": "string (64-char hex)"
}
```

### JOIN_LOBBY
Request to join a lobby with payment proof.

```json
{
  "type": "JOIN_LOBBY",
  "lobbyId": 1,
  "paymentTxHash": "0x..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `lobbyId` | integer | Lobby ID (1-10) |
| `paymentTxHash` | string | Ethereum tx hash (0x + 64 hex chars) |

### REQUEST_REFUND
Request a refund from a timed-out lobby.

```json
{
  "type": "REQUEST_REFUND",
  "lobbyId": 1
}
```

**Note**: Refunds are only available after the lobby timeout (30 minutes) has expired.

### INPUT
Player movement input during a match.

```json
{
  "type": "INPUT",
  "targetX": 800,
  "targetY": 450,
  "sequence": 42,
  "frozen": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `targetX` | number | Target X coordinate (0-1600) |
| `targetY` | number | Target Y coordinate (0-900) |
| `sequence` | integer | Sequence number (monotonically increasing) |
| `frozen` | boolean | (Optional) Whether player is frozen |

**Rate**: Send at 60 Hz for best responsiveness.

### PING
Latency measurement.

```json
{
  "type": "PING",
  "clientTime": 1705331234567
}
```

---

## Server Messages (Server → Client)

### WELCOME
Sent after successful authentication.

```json
{
  "type": "WELCOME",
  "userId": "uuid-string",
  "serverTime": 1705331234567
}
```

### LOBBY_LIST
List of all lobbies. Sent on connect and periodically.

```json
{
  "type": "LOBBY_LIST",
  "lobbies": [
    {
      "id": 1,
      "status": "waiting",
      "playerCount": 2,
      "timeRemaining": 1500000,
      "depositAddress": "0x..."
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Lobby ID (1-10) |
| `status` | string | `"empty"`, `"waiting"`, `"ready"`, `"in_progress"` |
| `playerCount` | integer | Current players (0-3) |
| `timeRemaining` | number\|null | ms until timeout, null if not started |
| `depositAddress` | string | Lobby's USDC deposit address |

### LOBBY_UPDATE
Sent when lobby state changes (player joins/leaves, status changes).

```json
{
  "type": "LOBBY_UPDATE",
  "lobbyId": 1,
  "players": [
    { "id": "uuid", "username": "Player1" }
  ],
  "status": "waiting",
  "timeRemaining": 1500000,
  "depositAddress": "0x..."
}
```

### REFUND_PROCESSED
Sent when refunds are processed for a timed-out lobby.

```json
{
  "type": "REFUND_PROCESSED",
  "lobbyId": 1,
  "reason": "timeout",
  "players": [
    {
      "userId": "uuid",
      "username": "Player1",
      "amount": "1.00",
      "txHash": "0x..."
    }
  ]
}
```

### MATCH_STARTING
Sent when 3 players have joined and match is starting.

```json
{
  "type": "MATCH_STARTING",
  "matchId": "uuid-string",
  "countdown": 3
}
```

### ROLE_ASSIGNMENT
Sent to each player with their role and spawn position.

```json
{
  "type": "ROLE_ASSIGNMENT",
  "role": "rock",
  "spawnX": 400,
  "spawnY": 450
}
```

| Role | Color | Beats |
|------|-------|-------|
| `rock` | Orange | scissors |
| `paper` | Blue | rock |
| `scissors` | Green | paper |

### COUNTDOWN
Sent each second during countdown.

```json
{
  "type": "COUNTDOWN",
  "secondsRemaining": 2
}
```

When `secondsRemaining` is 0, the game starts.

### SNAPSHOT
Game state snapshot sent at 20 Hz during match.

```json
{
  "type": "SNAPSHOT",
  "tick": 150,
  "players": [
    {
      "id": "uuid",
      "x": 400.5,
      "y": 300.25,
      "alive": true,
      "role": "rock"
    }
  ]
}
```

### ELIMINATION
Sent when a player is eliminated.

```json
{
  "type": "ELIMINATION",
  "tick": 175,
  "eliminatedId": "uuid-of-eliminated",
  "eliminatorId": "uuid-of-winner"
}
```

### BOUNCE
Sent when same-role players collide (they bounce apart).

```json
{
  "type": "BOUNCE",
  "tick": 180,
  "players": [
    { "id": "uuid1", "x": 400, "y": 300 },
    { "id": "uuid2", "x": 420, "y": 310 }
  ]
}
```

### MATCH_END
Sent when match ends (one player remaining or all disconnected).

```json
{
  "type": "MATCH_END",
  "winnerId": "uuid-of-winner",
  "payout": {
    "winner": "2.40",
    "treasury": "0.60"
  }
}
```

### PONG
Response to PING.

```json
{
  "type": "PONG",
  "serverTime": 1705331234567,
  "yourPing": 45
}
```

### ERROR
Sent when an error occurs.

```json
{
  "type": "ERROR",
  "code": 2002,
  "message": "Lobby already has 3 players"
}
```

---

## Error Codes

### Authentication Errors (1xxx)
| Code | Message |
|------|---------|
| 1001 | Session token invalid or expired |
| 1002 | Session has expired, re-authenticate |

### Lobby Errors (2xxx)
| Code | Message |
|------|---------|
| 2001 | Lobby ID doesn't exist |
| 2002 | Lobby already has 3 players |
| 2003 | Player is already in a lobby |
| 2004 | Lobby timeout expired, cannot join |
| 2005 | Payment transaction not found or not confirmed |
| 2006 | Refund only available after 30-minute timeout |
| 2007 | Player not in this lobby |

### Payment Errors (3xxx)
| Code | Message |
|------|---------|
| 3001 | Buy-in payment failed |
| 3002 | Wallet has insufficient USDC |

### Match Errors (4xxx)
| Code | Message |
|------|---------|
| 4001 | Match ID doesn't exist |
| 4002 | Player not part of this match |

### Rate Limiting (5xxx)
| Code | Message |
|------|---------|
| 5001 | Too many requests, slow down |

### Server Errors (9xxx)
| Code | Message |
|------|---------|
| 9999 | Server error, try again |

---

## Game Constants

| Constant | Value | Description |
|----------|-------|-------------|
| Arena Width | 1600 | Logical arena width in pixels |
| Arena Height | 900 | Logical arena height in pixels |
| Player Radius | 22 | Player collision radius |
| Max Speed | 450 | Maximum player speed (pixels/second) |
| Tick Rate | 30 | Server physics tick rate (Hz) |
| Snapshot Rate | 20 | State broadcast rate (Hz) |
| Buy-in | 1 USDC | Entry fee per player |
| Winner Payout | 2.4 USDC | Winner receives |
| Treasury Cut | 0.6 USDC | Platform fee |

---

## Typical Message Flow

### Joining a Game
```
Client                          Server
  |-- HELLO ---------------------->|
  |<-------------- WELCOME --------|
  |<---------- LOBBY_LIST ---------|
  |                                |
  | (User pays USDC on-chain)      |
  |                                |
  |-- JOIN_LOBBY ----------------->|
  |<-------- LOBBY_UPDATE ---------|
  |                                |
  | (2 more players join)          |
  |                                |
  |<------- MATCH_STARTING --------|
  |<------ ROLE_ASSIGNMENT --------|
  |<--------- COUNTDOWN (3) -------|
  |<--------- COUNTDOWN (2) -------|
  |<--------- COUNTDOWN (1) -------|
  |<--------- COUNTDOWN (0) -------|
```

### During Match
```
Client                          Server
  |-- INPUT ---------------------->|
  |<----------- SNAPSHOT ----------|  (20 Hz)
  |-- INPUT ---------------------->|  (60 Hz)
  |<----------- SNAPSHOT ----------|
  |<--------- ELIMINATION ---------|
  |<----------- SNAPSHOT ----------|
  |<----------- BOUNCE ------------|  (if same-role collision)
  |<----------- SNAPSHOT ----------|
  |<---------- MATCH_END ----------|
```

### Refund Flow
```
Client                          Server
  |                                |
  | (30 min timeout expires)       |
  |                                |
  |-- REQUEST_REFUND ------------->|
  |<----- REFUND_PROCESSED --------|
  |<-------- LOBBY_UPDATE ---------|
```
