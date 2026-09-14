import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HexGrid } from '../server/game/HexGrid.js';
import { GameEngine, GAME_PHASES, GAME_MODES } from '../server/game/GameEngine.js';
import { RoomManager } from '../server/game/RoomManager.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeCkEngine() {
  const engine = new GameEngine({ mode: GAME_MODES.CITIES_KNIGHTS });
  engine.addPlayer({ id: 'p1', name: 'Alice' });
  engine.addPlayer({ id: 'p2', name: 'Bob' });
  engine.startGame('standard');
  return engine;
}

function emptyVertex(engine) {
  return Array.from(engine.grid.vertices.values()).find(v => !v.building && !v.knight);
}

describe('Robika fixes', () => {
  it('avoids three mutually adjacent hexes of the same resource', () => {
    for (let i = 0; i < 12; i++) {
      const grid = new HexGrid({ mapSize: 'standard' });
      assert.equal(grid.hasTightSameResourceCluster(), false);
    }
  });

  it('blocks start until every human player is ready', () => {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const room = rm.createRoom({ id: 'h1', name: 'Host', socketId: 's1' });
    rm.joinRoom(room.code, { id: 'p2', name: 'Guest', socketId: 's2' });
    assert.throws(() => rm.startGame(room.code, 'h1'), /PLAYERS_NOT_READY/);
    rm.setPlayerReady(room.code, 'p2', true);
    assert.equal(rm.startGame(room.code, 'h1').isStarted, true);
    rm.destroyRoom(room.code);
  });

  it('replaces a disconnected human with a stand-in bot and reclaims the seat on reconnect', () => {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const host = rm.createPlayerSession();
    const guest = rm.createPlayerSession();
    const room = rm.createRoom({
      id: host.id,
      name: 'Host',
      socketId: 's1',
      reconnectTokenHash: host.reconnectTokenHash
    });
    rm.joinRoom(room.code, {
      id: guest.id,
      name: 'Guest',
      socketId: 's2',
      reconnectTokenHash: guest.reconnectTokenHash
    });
    rm.setPlayerReady(room.code, guest.id, true);
    rm.startGame(room.code, host.id);

    const replaced = rm.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    assert.ok(replaced);
    assert.equal(replaced.isBot, true);
    assert.equal(replaced.isStandInBot, true);
    assert.equal(room.engine.players.find(p => p.id === guest.id).isBot, true);

    const back = rm.joinRoom(room.code, {
      socketId: 's2-new',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false
    });
    assert.equal(back.reconnected, true);
    assert.equal(back.playerId, guest.id);
    const seat = room.players.find(p => p.id === guest.id);
    assert.equal(seat.isBot, false);
    assert.equal(seat.isStandInBot, false);
    rm.destroyRoom(room.code);
  });

  it('wires leave-confirm UI and drops the in-match Leave match button', () => {
    const html = readFileSync(join(root, 'public/index.html'), 'utf8');
    const app = readFileSync(join(root, 'public/js/app.js'), 'utf8');
    assert.match(html, /id="confirm-home-modal"/);
    assert.doesNotMatch(html, /id="btn-leave-match"/);
    assert.match(app, /openHomeConfirm/);
  });

  it('clears the trade and notifies when a player declines', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wood = 2;
    engine.players[1].resources.brick = 2;
    engine.proposeTrade('p1', { wood: 1 }, { brick: 1 });
    const res = engine.respondToTrade('p2', false);
    assert.equal(res.declined, true);
    assert.equal(engine.activeTrade, null);
    assert.equal(engine.lastTradeEvent.type, 'declined');
    assert.equal(engine.lastTradeEvent.playerId, 'p2');
    const state = engine.getStateForPlayer('p1');
    assert.equal(state.lastTradeEvent.type, 'declined');
  });

  it('lets barbarians pillage a walled city and returns the wall to supply', () => {
    const engine = makeCkEngine();
    const vertex = emptyVertex(engine);
    vertex.building = { type: 'city', playerId: 'p1', color: engine.players[0].color, hasWall: true };
    engine.players[0].citiesBuilt.push(vertex.id);
    engine.players[0].cityWalls = 2;
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');
    assert.equal(engine.hasVulnerableCity(engine.players[0]), true, 'walls do not protect from barbarians');
    engine.downgradeCity('p1', vertex.id);
    assert.equal(vertex.building.hasWall, false);
    assert.equal(vertex.building.type, 'settlement');
    assert.equal(engine.players[0].cityWalls, 3);
  });
});
