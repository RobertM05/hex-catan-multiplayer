# Contributing to Hex Catan Multiplayer

## 🔀 Branching Strategy

- **Branch per ticket**: Create a branch named `feature/CK-XX-short-description` for each ticket
  - Example: `feature/CK-01-commodities-data-model`
- Push directly to `main` after local testing (no PRs required — casual project)
- Run `npm test` before every push. All 25+ tests must pass.
- Run `node --check server/server.js && node --check server/game/GameEngine.js` to verify syntax

## 📐 Code Conventions

- **ESM modules** — all server files use `import`/`export` syntax
- **No TypeScript** — pure JavaScript
- **Node.js built-in test runner** — `node --test tests/*.test.js`, no Jest/Mocha
- **Error codes as thrown strings** — e.g., `throw new Error('NOT_YOUR_TURN')`
- **Game phases** — all phases defined in `GAME_PHASES` enum at `GameEngine.js:8-17`
- **State broadcasting** — after any state mutation, `handleGameAction()` in `server.js` calls `broadcastState()` automatically
- **i18n** — all user-facing strings go through `i18n.js` with both EN and RO translations

## 🏗️ Architecture Overview

```
server/
  server.js              — Express + Socket.IO entry point. All socket events here.
  game/
    GameEngine.js        — Authoritative game logic. ~1355 lines. ALL rules enforced here.
    HexGrid.js           — Hex board generation, vertices, edges, harbors.
    BotAI.js             — Bot decision-making AI.
    RoomManager.js       — Room lifecycle, bot turns, state broadcasting.
public/
  js/
    app.js               — Main client app. UI rendering, event binding. ~1740 lines.
    renderer.js          — SVG board renderer. ~700 lines.
    network.js           — Socket.IO client wrapper.
    i18n.js              — Translations (EN/RO).
tests/
  qaAuditAndRules.test.js + gameEngine.test.js — all tests (25). Node built-in test runner.
```

## 🔑 Key Patterns to Follow

### Adding a New Game Action
1. Add method to `GameEngine.js` (validates input, mutates state, logs event)
2. Add socket event handler in `server.js` using `handleGameAction()` wrapper
3. Add client-side UI trigger in `app.js` that calls `network.sendAction()`
4. Add test in `tests/` (new C&K features go in `tests/citiesKnights.test.js`)
5. Add translations in `i18n.js` (EN + RO)

### Adding a New Game Phase
1. Add to `GAME_PHASES` enum in `GameEngine.js:8-17`
2. Add phase handling in `renderGameState()` in `app.js:1406+`
3. Add bot handling in `RoomManager.checkAndTriggerBotTurn()` at `RoomManager.js:341+`
4. Handle phase transitions in relevant engine methods

### State Serialization
- `getStateForPlayer(playerId)` at `GameEngine.js:1309` controls what each player sees
- Opponent resources/cards are HIDDEN (only totals shown)
- Sets must be converted to Arrays: `Array.from(mySet)`

## 🧪 Testing

- Run: `npm test`
- Framework: Node.js built-in `node:test` with `node:assert`
- Pattern: `describe()` + `it()` blocks
- Create a separate test file for C&K: `tests/citiesKnights.test.js`
- Each ticket should include at least 2-3 tests covering happy path and error cases

## 🤖 AI Development Tips

- Always read the full method you're modifying before editing
- The `handleGameAction()` wrapper in `server.js:176-198` auto-broadcasts state after any engine method
- Check `BotAI.js` after adding new actions — bots may need updates to handle new phases
- `renderer.js` uses SVG with manual coordinate math — no D3 or other libs
- Client state arrives via `network.onStateUpdate` callback bound in `app.js:1395-1399`
