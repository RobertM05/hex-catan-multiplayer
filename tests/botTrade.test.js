import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, GAME_PHASES } from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';
import { RoomManager } from '../server/game/RoomManager.js';
import { server, roomManager, io } from '../server/server.js';
import { CatanAIAgent } from '../scripts/aiAgentClient.js';

describe('AI-03 & UX-10: Bot & AI Agent Trading System', () => {
  describe('BotAI Player Trade Proposal & Heuristics', () => {
    it('proposes fair 1:1 trade when missing 1 card for a settlement', () => {
      const engine = new GameEngine({ mode: 'base' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      // Settlement needs: 1 wood, 1 brick, 1 wool, 1 wheat
      // Bot has: 1 wood, 1 brick, 2 wool, 0 wheat (deficit: 1 wheat, surplus: 1 wool)
      bot.resources = { wood: 1, brick: 1, wool: 2, wheat: 0, ore: 0 };
      engine.phase = GAME_PHASES.TURN_ACTION;

      const action = BotAI.decideTurnAction(engine, bot);
      assert.equal(action.action, 'propose_trade');
      assert.deepEqual(action.give, { wool: 1 });
      assert.deepEqual(action.want, { wheat: 1 });
    });

    it('proposes fair 1:1 trade when missing 1 card for a city', () => {
      const engine = new GameEngine({ mode: 'base' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      const vId = Array.from(engine.grid.vertices.keys())[0];
      engine.grid.vertices.get(vId).building = { type: 'settlement', playerId: bot.id };
      bot.settlementsBuilt.push(vId);

      // City needs: 3 ore, 2 wheat
      // Bot has: 3 ore, 1 wheat, 2 wood (deficit: 1 wheat, surplus: 2 wood)
      bot.resources = { wood: 2, brick: 0, wool: 0, wheat: 1, ore: 3 };
      engine.phase = GAME_PHASES.TURN_ACTION;

      const action = BotAI.decideTurnAction(engine, bot);
      assert.equal(action.action, 'propose_trade');
      assert.deepEqual(action.give, { wood: 1 });
      assert.deepEqual(action.want, { wheat: 1 });
    });

    it('proposes fair 1:1 trade when missing 1 card for a road', () => {
      const engine = new GameEngine({ mode: 'base' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      bot.settlementsRemaining = 0; // settlements maxed out, prioritizing roads
      // Road needs: 1 wood, 1 brick
      // Bot has: 1 wood, 0 brick, 2 ore (deficit: 1 brick, surplus: 2 ore)
      bot.resources = { wood: 1, brick: 0, wool: 0, wheat: 0, ore: 2 };
      engine.phase = GAME_PHASES.TURN_ACTION;

      const action = BotAI.decideTurnAction(engine, bot);
      assert.equal(action.action, 'propose_trade');
      assert.deepEqual(action.give, { ore: 1 });
      assert.deepEqual(action.want, { brick: 1 });
    });

    it('does not propose trade when deficit is greater than 1', () => {
      const engine = new GameEngine({ mode: 'base' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      // Bot has only 1 wood, 0 of everything else (deficit for settlement is 3)
      bot.resources = { wood: 1, brick: 0, wool: 0, wheat: 0, ore: 0 };
      engine.phase = GAME_PHASES.TURN_ACTION;

      const trade = BotAI.decidePlayerTrade(engine, bot);
      assert.equal(trade, null);
    });

    it('does not propose trade when no surplus card is available', () => {
      const engine = new GameEngine({ mode: 'base' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      // Has 1 wood, 1 brick, 1 wool, 0 wheat (deficit: 1 wheat, but 0 surplus)
      bot.resources = { wood: 1, brick: 1, wool: 1, wheat: 0, ore: 0 };
      engine.phase = GAME_PHASES.TURN_ACTION;

      const trade = BotAI.decidePlayerTrade(engine, bot);
      assert.equal(trade, null);
    });

    it('does not propose trade if hasProposedTradeThisTurn is already true', () => {
      const engine = new GameEngine({ mode: 'base' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      bot.resources = { wood: 1, brick: 1, wool: 2, wheat: 0, ore: 0 };
      bot.hasProposedTradeThisTurn = true;
      engine.phase = GAME_PHASES.TURN_ACTION;

      const trade = BotAI.decidePlayerTrade(engine, bot);
      assert.equal(trade, null);
    });

    it('in C&K mode does not offer resource for commodity (unfair trade)', () => {
      const engine = new GameEngine({ mode: 'cities_knights' });
      engine.addPlayer({ id: 'bot1', name: 'Bot1', isBot: true });
      engine.addPlayer({ id: 'p2', name: 'Human' });
      engine.startGame('standard');

      const bot = engine.players[0];
      // Only has basic resources, no commodities
      bot.resources = { wood: 3, brick: 0, wool: 0, wheat: 0, ore: 0 };
      bot.commodities = { cloth: 0, coin: 0, paper: 0 };
      engine.phase = GAME_PHASES.TURN_ACTION;

      const trade = BotAI.decidePlayerTrade(engine, bot);
      if (trade) {
        const giveKey = Object.keys(trade.give)[0];
        const wantKey = Object.keys(trade.want)[0];
        const isCommodity = (k) => ['cloth', 'coin', 'paper'].includes(k);
        assert.ok(!(!isCommodity(giveKey) && isCommodity(wantKey)), 'Bot should never offer resource for commodity');
      }
    });
  });

  describe('RoomManager Bot Trade Lifecycle & WebSocket Confirmation', () => {
    let serverPort = null;
    let serverUrl = null;

    before(async () => {
      await new Promise((resolve) => {
        server.listen(0, () => {
          serverPort = server.address().port;
          serverUrl = `http://localhost:${serverPort}`;
          resolve();
        });
      });
    });

    after(async () => {
      io.close();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    });

    it('executes full bot proposal, player acceptance, bot confirmation, and city building', async () => {
      const rm = new RoomManager({ emit: () => {} });
      const humanData = { id: 'human1', name: 'HumanPlayer' };
      const room = rm.createRoom(humanData, { name: 'TradeRoom', turnDuration: 60 });
      rm.addBot(room.code, 'hard');
      rm.setPlayerReady(room.code, humanData.id, true);
      rm.startGame(room.code, humanData.id);

      const human = room.engine.players[0];
      const bot = room.engine.players[1];

      // Give bot a settlement to upgrade to a city
      const vId = Array.from(room.engine.grid.vertices.keys())[0];
      room.engine.grid.vertices.get(vId).building = { type: 'settlement', playerId: bot.id };
      bot.settlementsBuilt.push(vId);

      // Bot needs: 3 ore, 2 wheat. Has: 3 ore, 1 wheat, 2 wood. Deficit: 1 wheat, surplus: 2 wood.
      bot.resources = { wood: 2, brick: 0, wool: 0, wheat: 1, ore: 3 };
      // Human has 2 wheat
      human.resources = { wood: 0, brick: 0, wool: 0, wheat: 2, ore: 0 };

      room.engine.phase = GAME_PHASES.TURN_ACTION;
      room.engine.currentTurnPlayerIndex = 1; // Bot turn

      // Bot decides and proposes trade
      const action = BotAI.decideTurnAction(room.engine, bot);
      assert.equal(action.action, 'propose_trade');
      BotAI.applyTurnAction(room.engine, bot, action);

      assert.ok(room.engine.activeTrade);
      assert.equal(room.engine.activeTrade.fromPlayerId, bot.id);
      assert.deepEqual(room.engine.activeTrade.give, { wood: 1 });
      assert.deepEqual(room.engine.activeTrade.want, { wheat: 1 });

      // Human accepts trade
      room.engine.respondToTrade(human.id, true);
      assert.ok(room.engine.activeTrade.acceptedBy.has(human.id));

      // Trigger bot confirmation
      rm.resolveBotTrade(room, human.id);

      // Wait for the confirmation timeout (400ms)
      await new Promise((r) => setTimeout(r, 500));

      // Verify trade executed
      assert.equal(room.engine.activeTrade, null);
      assert.equal(bot.resources.wheat, 2);
      assert.equal(bot.resources.wood, 1);
      assert.equal(human.resources.wheat, 1);
      assert.equal(human.resources.wood, 1);

      // Bot should now be able to build city with the acquired wheat
      assert.equal(room.engine.canBuildCity(bot.id, vId).ok, true);
      const nextAction = BotAI.decideTurnAction(room.engine, bot);
      assert.equal(nextAction.action, 'build_city');
      BotAI.applyTurnAction(room.engine, bot, nextAction);
      assert.equal(room.engine.grid.vertices.get(vId).building.type, 'city');

      rm.destroyRoom(room.code);
    });

    it('fast-cancels bot trade when the sole human declines', async () => {
      const rm = new RoomManager({ emit: () => {} });
      const room = rm.createRoom({ id: 'human1', name: 'HumanPlayer' }, { name: 'DeclineRoom', turnDuration: 60 });
      rm.addBot(room.code, 'medium');
      room.isStarted = true;
      room.engine.startGame('standard');

      const human = room.engine.players[0];
      const bot = room.engine.players[1];

      bot.resources = { wood: 1, brick: 1, wool: 2, wheat: 0, ore: 0 };
      human.resources = { wood: 0, brick: 0, wool: 0, wheat: 2, ore: 0 };

      room.engine.phase = GAME_PHASES.TURN_ACTION;
      room.engine.currentTurnPlayerIndex = 1;

      const action = BotAI.decideTurnAction(room.engine, bot);
      BotAI.applyTurnAction(room.engine, bot, action);
      rm.startBotTradeTimer(room, bot.id);
      assert.ok(room.engine.activeTrade);

      // Human declines
      room.engine.respondToTrade(human.id, false);
      rm.checkBotTradeDeclines(room);

      // Wait for fast-cancel timeout (300ms)
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(room.engine.activeTrade, null);
      assert.equal(bot.hasProposedTradeThisTurn, true);

      rm.destroyRoom(room.code);
    });

    it('multi-bot trading: Bot A proposes, Bot B accepts, Bot A confirms', async () => {
      const rm = new RoomManager({ emit: () => {} });
      const room = rm.createRoom({ id: 'human1', name: 'HumanPlayer' }, { name: 'MultiBotRoom', turnDuration: 60 });
      rm.addBot(room.code, 'hard');
      rm.addBot(room.code, 'medium');
      room.isStarted = true;
      room.engine.startGame('standard');

      const botA = room.engine.players[1];
      const botB = room.engine.players[2];

      // Bot A needs 1 wheat for settlement, has 2 wool surplus
      botA.resources = { wood: 1, brick: 1, wool: 2, wheat: 0, ore: 0 };
      // Bot B has 3 wheat surplus (can afford giving 1 wheat while having surplus >= 1)
      botB.resources = { wood: 1, brick: 1, wool: 0, wheat: 3, ore: 0 };

      room.engine.phase = GAME_PHASES.TURN_ACTION;
      room.engine.currentTurnPlayerIndex = 1; // Bot A's turn

      const action = BotAI.decideTurnAction(room.engine, botA);
      assert.equal(action.action, 'propose_trade');
      BotAI.applyTurnAction(room.engine, botA, action);

      assert.ok(room.engine.activeTrade);
      // Bot B evaluates
      assert.equal(BotAI.canBotAcceptTrade(room.engine, botB, room.engine.activeTrade), true);
      rm.evaluateBotsTrade(room);

      // Wait for bot response and confirmation
      await new Promise((r) => setTimeout(r, 1200));

      assert.equal(room.engine.activeTrade, null);
      assert.equal(botA.resources.wheat, 1);
      assert.equal(botA.resources.wool, 1);
      assert.equal(botB.resources.wool, 1);
      assert.equal(botB.resources.wheat, 2);

      rm.destroyRoom(room.code);
    });

    it('autonomous CatanAIAgent proposes trades to fulfill build deficits', async () => {
      const hostData = { id: 'agent_host', name: 'HostAgent', socketId: 'sock_agent_host' };
      const room = roomManager.createRoom(hostData, { name: 'AgentTradeRoom', mode: 'base', maxPlayers: 2 });
      roomManager.setPlayerReady(room.code, hostData.id, true);

      const agent = new CatanAIAgent({
        serverUrl,
        name: 'TraderAgent',
        turnDelay: 10,
        autoReady: true,
        log: () => {}
      });

      await agent.connect();
      await agent.joinRoom(room.code);

      roomManager.startGame(room.code, hostData.id);
      const engine = room.engine;

      engine.phase = GAME_PHASES.TURN_ACTION;
      const agentPlayer = engine.players.find(p => p.id === agent.myPlayerId);
      const hostPlayer = engine.players.find(p => p.id === hostData.id);

      // Set agent turn
      engine.currentTurnPlayerIndex = engine.players.findIndex(p => p.id === agent.myPlayerId);

      // Agent needs 1 wheat for settlement, has 2 wool
      agentPlayer.resources = { wood: 1, brick: 1, wool: 2, wheat: 0, ore: 0 };
      hostPlayer.resources = { wood: 0, brick: 0, wool: 0, wheat: 2, ore: 0 };

      // Trigger agent action
      roomManager.broadcastState(room);

      // Wait for agent to propose trade
      let attempts = 0;
      while (attempts < 30) {
        await new Promise(r => setTimeout(r, 100));
        if (engine.activeTrade && engine.activeTrade.fromPlayerId === agent.myPlayerId) {
          break;
        }
        attempts++;
      }

      assert.ok(engine.activeTrade, 'Agent should have proposed a trade');
      assert.equal(engine.activeTrade.fromPlayerId, agent.myPlayerId);
      assert.deepEqual(engine.activeTrade.give, { wool: 1 });
      assert.deepEqual(engine.activeTrade.want, { wheat: 1 });

      // Host accepts
      engine.respondToTrade(hostData.id, true);
      roomManager.broadcastState(room);

      // Wait for agent to confirm
      attempts = 0;
      while (attempts < 30) {
        await new Promise(r => setTimeout(r, 100));
        if (!engine.activeTrade) {
          break;
        }
        attempts++;
      }

      assert.equal(engine.activeTrade, null, 'Agent should have confirmed trade');
      assert.equal(agentPlayer.resources.wheat, 1);
      assert.equal(agentPlayer.resources.wool, 1);

      agent.disconnect();
      roomManager.destroyRoom(room.code);
    });
  });
});
