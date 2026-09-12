# Hex Catan Autonomous AI Agent Protocol & Guide

This document specifies the autonomous AI agent architecture, WebSocket protocol, state schema, and LLM prompt templates for connecting autonomous AI players (e.g. Gemini, DeepSeek, Claude, or local heuristics) to live Hex Catan multiplayer rooms.

---

## 1. Architecture Overview

```
 ┌────────────────────────────────────────────────────────┐
 │                   Hex Catan Server                     │
 │          (Express + Socket.IO + GameEngine)            │
 └─────────────┬────────────────────────────┬─────────────┘
               │ WebSocket                  │ WebSocket
               ▼                            ▼
 ┌───────────────────────────┐ ┌───────────────────────────┐
 │       Human Player        │ │     Autonomous AI Agent   │
 │   (Browser SVG Frontend)  │ │  (scripts/aiAgentClient.js)│
 └───────────────────────────┘ └────────────┬──────────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  ▼                   ▼
                           [Heuristic Core]    [LLM Adapter]
                                           (Gemini/DeepSeek/Claude)
```

1. **Native Client**: The AI Agent connects directly over Socket.IO just like any real human web browser.
2. **Server Authoritative**: All game rules, validation, dice generation, and state mutations remain strictly authoritative on the server.
3. **Paced Execution**: The agent introduces configurable pacing delays (e.g. 500ms - 1200ms) to allow human opponents and spectators to follow actions on the live board.
4. **On-Demand Summoning**: Game hosts can summon external agent worker processes via the lobby UI ("🤖 Summon AI Agent"), Socket event (`spawn_ai_agent`), or REST API (`POST /api/rooms/:code/spawn-agent`).

---

## 2. CLI Execution & Parameters

To launch an agent from the command line into any local or remote room:

```bash
# Connect to local room ABCD
node scripts/aiAgentClient.js --room ABCD --name "AlphaSettler"

# Connect to remote instance with custom color
node scripts/aiAgentClient.js --server https://catan.example.com --room EFGH --name "GeminiKnight" --color "#3b82f6"
```

### CLI Arguments:
- `--room <CODE>`: *(Required)* 4-letter room code.
- `--server <URL>`: Server address (default: `http://localhost:3000`).
- `--name <NAME>`: Player display name (default: `Agent-XXXX`).
- `--color <HEX>`: Desired hex player color (e.g. `#e63946`).

---

## 3. Server API & Socket Events

### 3.1 REST API: Summon Agent
```http
POST /api/rooms/:code/spawn-agent
Content-Type: application/json

{
  "name": "Gemini-Bot"
}
```

**Response:**
```json
{
  "success": true,
  "roomCode": "ABCD",
  "name": "Gemini-Bot",
  "pid": 48291
}
```

### 3.2 Socket.IO Summon Event
```javascript
socket.emit('spawn_ai_agent', { roomCode: 'ABCD', name: 'ClaudeSettler' }, (response) => {
  console.log(response); // { success: true, name: 'ClaudeSettler', pid: 48292 }
});
```

---

## 4. State Payload & Action Protocol

### Inbound Events (`game_state_update`)
The server broadcasts the authoritative state to each connected player:
```json
{
  "state": {
    "phase": "TURN_ACTION",
    "turnNumber": 3,
    "currentTurnPlayerIndex": 1,
    "dice": [4, 3],
    "hasRolledDice": true,
    "grid": {
      "hexes": { ... },
      "vertices": { ... },
      "edges": { ... }
    },
    "players": [
      {
        "id": "p1",
        "name": "Robert",
        "color": "#e63946",
        "resources": { "wood": 2, "brick": 1, "wool": 0, "wheat": 3, "ore": 2 },
        "commodities": { "cloth": 1, "coin": 0, "paper": 0 },
        "roadsBuilt": ["e1", "e2"],
        "settlementsBuilt": ["v1"],
        "citiesBuilt": ["v2"],
        "cityImprovements": { "trade": 1, "politics": 0, "science": 0 },
        "victoryPoints": 4
      }
    ]
  },
  "room": {
    "code": "ABCD",
    "turnDuration": 60,
    "turnTimeRemaining": 42
  }
}
```

### Outbound Actions
The agent responds by emitting action events:
- **Setup Settlement / City**: `place_setup_settlement`, `place_setup_city` `{ code, vertexId }`
- **Setup Road**: `place_setup_road` `{ code, edgeId }`
- **Roll Dice**: `roll_dice` `{ code }`
- **Discard Cards (7-roll)**: `discard_cards` `{ code, resources, commodities }`
- **Move Robber**: `move_robber` `{ code, hexId, targetPlayerId }`
- **Build Road**: `build_road` `{ code, edgeId }`
- **Build Settlement**: `build_settlement` `{ code, vertexId }`
- **Upgrade City**: `upgrade_city` `{ code, vertexId }`
- **Improve City Track (C&K)**: `improve_city` `{ code, track }`
- **End Turn**: `end_turn` `{ code }`

---

## 5. LLM Prompt Schema (Gemini / Claude / DeepSeek)

When integrating frontier LLM models to drive the agent's strategy, use the following structured system prompt and schema:

### System Prompt
```
You are an expert grandmaster AI player in Hex Catan (Settlers of Catan & Cities and Knights).
Your objective is to maximize Victory Points (target: 10 base / 13 C&K) while denying expansion routes to leaders.

Input: JSON representation of current game state, available legal actions, and player hand.
Output: Return ONLY a JSON object specifying your chosen action and concise tactical reasoning.
```

### Response Schema
```json
{
  "action": "upgrade_city | build_settlement | build_road | improve_city | buy_dev_card | end_turn",
  "targetId": "vertex or edge ID (e.g. 'v-2-4')",
  "track": "trade | politics | science (if improve_city)",
  "reasoning": "Upgrading settlement on ore hex 8/wheat 5 to city guarantees double production and accelerates progress towards Metropolis."
}
```
