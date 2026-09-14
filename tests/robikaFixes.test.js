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
    for (let i = 0; i < 80; i++) {
      const grid = new HexGrid({ mapSize: 'standard' });
      assert.equal(grid.hasTightSameResourceCluster(), false);
    }
    for (let i = 0; i < 20; i++) {
      const grid = new HexGrid({ mapSize: 'extended' });
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

  it('keeps a trade open when one opponent declines so others can still accept', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.addPlayer({ id: 'p3', name: 'Cara' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wood = 2;
    engine.players[1].resources.brick = 2;
    engine.players[2].resources.brick = 2;
    engine.proposeTrade('p1', { wood: 1 }, { brick: 1 });
    const res = engine.respondToTrade('p2', false);
    assert.equal(res.declined, true);
    assert.ok(engine.activeTrade, 'offer stays open for other players');
    assert.equal(engine.lastTradeEvent.type, 'declined');
    assert.equal(engine.lastTradeEvent.playerId, 'p2');
    const state = engine.getStateForPlayer('p1');
    assert.equal(state.lastTradeEvent.type, 'declined');
    assert.deepEqual(state.activeTrade.declinedBy, ['p2']);
    assert.throws(() => engine.respondToTrade('p2', true), /TRADE_ALREADY_DECLINED/);
    engine.respondToTrade('p3', true);
    engine.confirmTrade('p1', 'p3');
    assert.equal(engine.activeTrade, null);
    assert.equal(engine.players[2].resources.wood, 1);
  });

  it('closes the trade only after every other player declines', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.addPlayer({ id: 'p3', name: 'Cara' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wood = 2;
    engine.players[1].resources.brick = 2;
    engine.players[2].resources.brick = 2;
    engine.proposeTrade('p1', { wood: 1 }, { brick: 1 });
    engine.respondToTrade('p2', false);
    assert.ok(engine.activeTrade);
    engine.respondToTrade('p3', false);
    assert.equal(engine.activeTrade, null);
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

  it('Diplomat relocates an own open road and rolls back if the new edge is invalid', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    vertex.building = { type: 'settlement', playerId: 'p1', color: engine.players[0].color };
    engine.players[0].settlementsBuilt.push(vertex.id);
    const edgeId = vertex.adjacentEdges[0];
    const edge = engine.grid.edges.get(edgeId);
    edge.road = { playerId: 'p1', color: engine.players[0].color };
    engine.players[0].roadsBuilt.push(edgeId);
    const newEdgeId = vertex.adjacentEdges.find(id => id !== edgeId);
    const card = { id: 'dip1', type: 'diplomat', played: false };
    engine.players[0].progressCards.push(card);

    assert.throws(
      () => engine.playProgressCard('p1', card.id, { edgeId, newEdgeId: 'missing-edge' }),
      /EDGE_OCCUPIED/
    );
    assert.ok(engine.grid.edges.get(edgeId).road, 'original road restored');
    assert.equal(card.played, false);

    engine.playProgressCard('p1', card.id, { edgeId, newEdgeId });
    assert.equal(engine.grid.edges.get(edgeId).road, null);
    assert.ok(engine.grid.edges.get(newEdgeId).road);
    assert.equal(card.played, true);
  });

  it('lets Master Merchant peek a richer hand before stealing', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].victoryPoints = 1;
    engine.players[1].victoryPoints = 4;
    engine.players[1].resources.wool = 1;
    engine.players[1].commodities.cloth = 1;
    const card = { id: 'mm1', type: 'master_merchant', played: false };
    engine.players[0].progressCards.push(card);
    const peek = engine.playProgressCard('p1', card.id, { targetPlayerId: 'p2', peek: true });
    assert.equal(peek.peek, true);
    assert.equal(card.played, false);
    assert.equal(peek.revealedHand.resources.wool, 1);
    engine.playProgressCard('p1', card.id, { targetPlayerId: 'p2', steal: ['wool', 'cloth'] });
    assert.equal(card.played, true);
    assert.equal(engine.players[0].resources.wool, 1);
  });

  it('rejects Master Merchant steal until the hand has been peeked', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].victoryPoints = 1;
    engine.players[1].victoryPoints = 4;
    engine.players[1].resources.wool = 1;
    engine.players[1].commodities.cloth = 1;
    const card = { id: 'mm2', type: 'master_merchant', played: false };
    engine.players[0].progressCards.push(card);
    const first = engine.playProgressCard('p1', card.id, { targetPlayerId: 'p2', steal: ['wool', 'cloth'] });
    assert.equal(first.peek, true);
    assert.equal(card.played, false);
    assert.equal(engine.players[0].resources.wool || 0, 0);
  });

  it('lets Spy peek opponent progress cards without consuming the Spy', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const spy = { id: 'c-spy', type: 'spy', played: false };
    engine.players[0].progressCards.push(spy);
    engine.players[1].progressCards.push({ id: 'c-crane', type: 'crane', played: false });
    const peek = engine.playProgressCard('p1', spy.id, { targetPlayerId: 'p2', peek: true });
    assert.equal(peek.peek, true);
    assert.equal(spy.played, false);
    assert.equal(peek.targetProgressCards[0].id, 'c-crane');
    const steal = engine.playProgressCard('p1', spy.id, { targetPlayerId: 'p2', stealCardId: 'c-crane' });
    assert.equal(steal.stolenCard.type, 'crane');
    assert.equal(spy.played, true);
  });

  it('keeps merchantHexId on player state for the map token', () => {
    const engine = makeCkEngine();
    const vertex = emptyVertex(engine);
    const hexId = vertex.hexes[0];
    vertex.building = { type: 'city', playerId: 'p1', color: engine.players[0].color, hasWall: false };
    engine.players[0].citiesBuilt.push(vertex.id);
    engine.phase = GAME_PHASES.TURN_ACTION;
    const card = { id: 'mer1', type: 'merchant', played: false };
    engine.players[0].progressCards.push(card);
    engine.playProgressCard('p1', card.id, { hexId });
    const state = engine.getStateForPlayer('p1');
    assert.equal(state.merchantHexId, hexId);
    assert.equal(state.merchantHolder, 'p1');
  });

  it('does not apply Inventor until both hexes are provided', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const hexes = Array.from(engine.grid.hexes.values()).filter(h => h.token && ![2, 6, 8, 12].includes(h.token));
    const card = { id: 'inv1', type: 'inventor', played: false };
    engine.players[0].progressCards.push(card);
    const token = hexes[0].token;
    assert.throws(
      () => engine.playProgressCard('p1', card.id, { hexId1: hexes[0].id }),
      /INVALID_HEX/
    );
    assert.equal(hexes[0].token, token);
    assert.equal(card.played, false);
  });

  it('blocks a kicked session from rejoining the same room', () => {
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
    rm.removePlayerOrBot(room.code, guest.id, { kicked: true });
    const again = rm.joinRoom(room.code, {
      socketId: 's2-new',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false,
      name: 'Guest'
    });
    assert.equal(again.error, 'KICKED_FROM_ROOM');
    rm.destroyRoom(room.code);
  });

  it('keeps robber hex clicks ahead of leftover Inventor targeting', () => {
    const app = readFileSync(join(root, 'public/js/app.js'), 'utf8');
    const clickHandler = app.slice(app.indexOf('this.boardRenderer.onHexClick'));
    const robberIdx = clickHandler.indexOf("phase === 'TURN_ROBBER'");
    const progressIdx = clickHandler.indexOf("progress_hex");
    assert.ok(robberIdx >= 0 && progressIdx > robberIdx);
  });
});
