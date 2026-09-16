/**
 * AI-02: Bot Alchemist chooses the production-maximizing roll, not the largest token.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, GAME_PHASES } from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';

function makeCkEngine() {
  const engine = new GameEngine({ mode: 'cities_knights' });
  engine.addPlayer({ id: 'p1', name: 'Bot', isBot: true });
  engine.addPlayer({ id: 'p2', name: 'Human' });
  engine.startGame('standard');
  return engine;
}

function hexWithToken(engine, token) {
  return Array.from(engine.grid.hexes.values()).find(
    (h) => h.token === token && h.id !== engine.grid.robberHexId
  );
}

function placeIsolatedSettlement(engine, playerId, hex) {
  assert.ok(hex, 'expected a target hex');
  const vertexId = Array.from(engine.grid.vertices.keys()).find((id) => {
    const v = engine.grid.vertices.get(id);
    return v.hexes.includes(hex.id) && !v.building;
  });
  assert.ok(vertexId, `expected a free vertex on hex ${hex.id}`);
  const vertex = engine.grid.vertices.get(vertexId);
  vertex.building = { type: 'settlement', playerId, color: '#e63946' };
  vertex.hexes = [hex.id];
  engine.players.find((p) => p.id === playerId).settlementsBuilt.push(vertexId);
  return hex;
}

describe('AI-02 Alchemist roll selection', () => {
  it('splits every sum 2-12 into valid dice faces', () => {
    for (let sum = 2; sum <= 12; sum++) {
      const { d1, d2 } = BotAI.splitAlchemistDice(sum);
      assert.ok(d1 >= 1 && d1 <= 6, `d1 out of range for ${sum}`);
      assert.ok(d2 >= 1 && d2 <= 6, `d2 out of range for ${sum}`);
      assert.equal(d1 + d2, sum);
    }
  });

  it('prefers 6 or 8 over 12 when the bot sits on 6, 8, and 12', () => {
    const engine = makeCkEngine();
    const bot = engine.players[0];
    const hex6 = hexWithToken(engine, 6);
    const hex8 = hexWithToken(engine, 8);
    const hex12 = hexWithToken(engine, 12);
    assert.ok(hex6 && hex8 && hex12, 'board should have tokens 6, 8, and 12');
    placeIsolatedSettlement(engine, bot.id, hex6);
    placeIsolatedSettlement(engine, bot.id, hex8);
    placeIsolatedSettlement(engine, bot.id, hex12);
    bot.progressCards.push({ id: 'alch-1', type: 'alchemist', played: false, boughtTurn: 0 });
    engine.phase = GAME_PHASES.TURN_ROLL;
    engine.currentPlayerIndex = 0;

    const play = BotAI.decideProgressCardPlay(engine, bot);
    assert.equal(play?.action, 'play_progress_card');
    assert.equal(play.cardId, 'alch-1');
    const sum = play.options.d1 + play.options.d2;
    assert.ok(sum === 6 || sum === 8, `expected 6 or 8, got ${sum} (${play.options.d1}+${play.options.d2})`);
    assert.notEqual(sum, 12);
    assert.ok(play.options.d1 >= 1 && play.options.d1 <= 6);
    assert.ok(play.options.d2 >= 1 && play.options.d2 <= 6);
  });

  it('does not pick a robber-blocked 8 when 6 is open', () => {
    const engine = makeCkEngine();
    const bot = engine.players[0];
    const hex8 = hexWithToken(engine, 8);
    const hex6 = hexWithToken(engine, 6);
    assert.ok(hex6 && hex8);
    placeIsolatedSettlement(engine, bot.id, hex8);
    placeIsolatedSettlement(engine, bot.id, hex6);
    engine.grid.robberHexId = hex8.id;
    bot.progressCards.push({ id: 'alch-2', type: 'alchemist', played: false, boughtTurn: 0 });
    engine.phase = GAME_PHASES.TURN_ROLL;

    const { d1, d2 } = BotAI.chooseAlchemistDice(engine, bot);
    assert.equal(d1 + d2, 6);
  });
});
