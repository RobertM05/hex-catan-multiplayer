import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, GAME_PHASES } from '../server/game/GameEngine.js';
import { InProcessBotRunner } from '../server/game/BotRunner.js';
import { RoomManager } from '../server/game/RoomManager.js';
import { spawnAgentProcess, roomManager } from '../server/server.js';

function createMockIo() {
  return {
    to: () => ({
      emit: () => {}
    }),
    emit: () => {}
  };
}

describe('SCALE-01: In-process bot runner', () => {
  it('adds bots to room without spawning external OS child processes', () => {
    const mockIo = createMockIo();
    const rm = new RoomManager(mockIo);
    const room = rm.createRoom({ id: 'host_u', name: 'HumanHost', socketId: 'sock_1' });

    const bot1 = rm.addBot(room.code, 'easy');
    const bot2 = rm.addBot(room.code, 'medium');
    const bot3 = rm.addBot(room.code, 'hard');

    assert.ok(bot1);
    assert.ok(bot2);
    assert.ok(bot3);
    assert.equal(room.players.length, 4);

    // Verify all bots are marked correctly
    assert.equal(bot1.isBot, true);
    assert.equal(bot2.isBot, true);
    assert.equal(bot3.isBot, true);

    // Verify engine has all players
    assert.equal(room.engine.players.length, 4);

    rm.destroyRoom(room.code);
  });

  it('spawnAgentProcess adds bot in-process without fork()', () => {
    const room = roomManager.createRoom({ id: 'host_x', name: 'HostX', socketId: 'sock_x' });

    // Calling spawnAgentProcess should create in-process mock handle
    const handle = spawnAgentProcess(room.code, 'AlphaBot');
    assert.ok(handle);
    assert.equal(handle.name, 'AlphaBot');
    assert.ok(handle.pid);

    // Killing handle removes player from room cleanly
    handle.kill();
    assert.equal(handle.killed, true);
    assert.equal(room.players.find(p => p.id === handle.botId), undefined);

    roomManager.destroyRoom(room.code);
  });

  it('InProcessBotRunner schedules and clears timers cleanly', async () => {
    const runner = new InProcessBotRunner({ minDelayMs: 15, maxDelayMs: 30 });
    const mockIo = createMockIo();
    const rm = new RoomManager(mockIo, { botRunner: runner });
    const room = rm.createRoom({ id: 'h1', name: 'Host1' });
    const bot = rm.addBot(room.code);

    let executed = false;
    runner.scheduleAction(room, 15, bot.id, () => {
      executed = true;
    });

    assert.equal(room.botActionTimers.size, 1);
    await new Promise(r => setTimeout(r, 45));
    assert.equal(executed, true);
    assert.equal(room.botActionTimers.size, 0);

    // Test clearing timers on human reclaim
    runner.scheduleAction(room, 100, bot.id, () => {
      executed = false;
    });
    assert.equal(room.botActionTimers.size, 1);
    runner.clearTimersForPlayer(room, bot.id);
    assert.equal(room.botActionTimers.size, 0);

    // Test clearAllTimers
    runner.scheduleAction(room, 100, bot.id, () => {});
    runner.clearAllTimers(room);
    assert.equal(room.botActionTimers.size, 0);

    rm.destroyRoom(room.code);
  });

  it('completes end-to-end 4-bot match simulation without errors', () => {
    const engine = new GameEngine({ mode: 'base', vpTarget: 10 });
    const botIds = ['b1', 'b2', 'b3', 'b4'];
    const botColors = ['#e63946', '#1d3557', '#e76f51', '#2a9d8f'];

    botIds.forEach((id, idx) => {
      engine.addPlayer({
        id,
        name: `Bot-${idx + 1}`,
        color: botColors[idx],
        isBot: true,
        botDifficulty: 'medium'
      });
    });

    engine.startGame();
    assert.equal(engine.phase, GAME_PHASES.SETUP_ROUND_1);

    const runner = new InProcessBotRunner();
    const result = runner.stepMatchSync(engine, 1000);

    assert.ok(result.steps > 20, 'Game must advance through setup and action turns');
    for (const p of engine.players) {
      assert.ok(p.settlementsBuilt.length + p.citiesBuilt.length >= 2, `${p.name} must have built at least 2 colonies`);
      assert.ok(p.roadsBuilt.length >= 2, `${p.name} must have built setup roads`);
    }
  });

  it('completes end-to-end 4-bot Cities & Knights match simulation without errors', () => {
    const engine = new GameEngine({ mode: 'cities_knights', vpTarget: 13 });
    const botIds = ['ck_b1', 'ck_b2', 'ck_b3', 'ck_b4'];
    const botColors = ['#e63946', '#1d3557', '#e76f51', '#2a9d8f'];

    botIds.forEach((id, idx) => {
      engine.addPlayer({
        id,
        name: `CK-Bot-${idx + 1}`,
        color: botColors[idx],
        isBot: true,
        botDifficulty: 'hard'
      });
    });

    engine.startGame();
    assert.equal(engine.phase, GAME_PHASES.SETUP_ROUND_1);

    const runner = new InProcessBotRunner();
    const result = runner.stepMatchSync(engine, 500);

    assert.ok(result.steps > 20, 'C&K match must advance through setup and gameplay');
    for (const p of engine.players) {
      assert.ok(p.settlementsBuilt.length + p.citiesBuilt.length >= 2, `${p.name} must have built at least 2 buildings`);
    }
  });
});
