import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomManager,
  validateChatMessage,
  validateDisplayName,
  validatePlayerColor,
  validateRoomName
} from '../server/game/RoomManager.js';
import { escapeHtml, CatanApp, redactEventLogEntryForViewer } from '../public/js/app.js';
import { network } from '../public/js/network.js';
import { RESOURCE_TYPES } from '../server/game/HexGrid.js';
import {
  GameEngine,
  GAME_PHASES,
  sanitizeEventLogEntryForPlayer,
  sanitizeEventLogForPlayer
} from '../server/game/GameEngine.js';
import { i18n } from '../public/js/i18n.js';

describe('SEC-01: multiplayer session authority', () => {
  it('does not reconnect a player from their public ID when legacy matching is disabled', () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const session = roomManager.createPlayerSession();
    const room = roomManager.createRoom({ id: session.id, name: 'Host', socketId: 'host', reconnectTokenHash: session.reconnectTokenHash });

    const result = roomManager.joinRoom(room.code, { id: session.id, name: 'Attacker', socketId: 'attacker', allowLegacyId: false });

    assert.equal(result.reconnected, false);
    assert.equal(room.players.length, 2);
    roomManager.destroyRoom(room.code);
  });

  it('reconnects only with the server-issued reconnect token', () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const session = roomManager.createPlayerSession();
    const room = roomManager.createRoom({ id: session.id, name: 'Host', socketId: 'host', reconnectTokenHash: session.reconnectTokenHash });

    const result = roomManager.joinRoom(room.code, { socketId: 'new-socket', reconnectToken: session.reconnectToken, allowLegacyId: false });

    assert.equal(result.reconnected, true);
    assert.equal(result.playerId, session.id);
    assert.equal(room.players.length, 1);
    roomManager.destroyRoom(room.code);
  });
});

describe('SEC-02: untrusted display content', () => {
  it('rejects markup and invalid colors while preserving valid Unicode names', () => {
    assert.equal(validateDisplayName('Ștefan', 'Player'), 'Ștefan');
    assert.throws(() => validateDisplayName('<img>', 'Player'), /INVALID_PLAYER_NAME/);
    assert.throws(() => validateRoomName('room<script>', 'Room'), /INVALID_ROOM_NAME/);
    assert.throws(() => validateChatMessage('<b>hello</b>'), /INVALID_CHAT_MESSAGE/);
    assert.equal(validatePlayerColor('#AbC123'), '#abc123');
    assert.throws(() => validatePlayerColor('red'), /INVALID_PLAYER_COLOR/);
  });

  it('escapes untrusted content before HTML interpolation', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('SEC-03: agent spawn reservations', () => {
  it('counts pending agents against the room capacity and releases them', () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const room = roomManager.createRoom({ id: 'host', name: 'Host', socketId: 'host' }, { maxPlayers: 2 });

    roomManager.reserveAgentSpawn(room.code);
    assert.throws(() => roomManager.reserveAgentSpawn(room.code), /ROOM_FULL/);
    roomManager.releaseAgentSpawn(room.code);
    assert.doesNotThrow(() => roomManager.reserveAgentSpawn(room.code));
    roomManager.destroyRoom(room.code);
  });
});

describe('SEC-04: lobby bot spawning & host authorization', () => {
  it('RoomManager.addBot rejects addition when capacity reached including pending agent spawns', () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const room = roomManager.createRoom({ id: 'host', name: 'Host', socketId: 'host' }, { maxPlayers: 2 });

    roomManager.reserveAgentSpawn(room.code);
    const bot = roomManager.addBot(room.code, 'medium');
    assert.equal(bot, null);
    roomManager.releaseAgentSpawn(room.code);

    const botAfterRelease = roomManager.addBot(room.code, 'medium');
    assert.ok(botAfterRelease);
    assert.equal(botAfterRelease.isBot, true);
    assert.equal(room.players.length, 2);

    const botWhenFull = roomManager.addBot(room.code, 'medium');
    assert.equal(botWhenFull, null);

    roomManager.destroyRoom(room.code);
  });

  it('CatanApp synchronizes player identity between app and network client', () => {
    const app = new CatanApp(false);
    assert.equal(app.myPlayerId, null);

    network.currentPlayerId = 'p_test_123';
    assert.equal(app.myPlayerId, 'p_test_123');

    app.myPlayerId = 'p_test_456';
    assert.equal(app.myPlayerId, 'p_test_456');
    assert.equal(network.currentPlayerId, 'p_test_456');

    app.myPlayerId = null;
    network.currentPlayerId = null;
  });
});

const HIDDEN_CARD_TYPES = ['wood', 'brick', 'wool', 'wheat', 'ore', 'cloth', 'coin', 'paper'];

function assertNoTypedCards(value, label) {
  const blob = JSON.stringify(value).toLowerCase();
  for (const card of HIDDEN_CARD_TYPES) {
    assert.equal(blob.includes(`"${card}"`), false, `${label} must not include typed card "${card}"`);
  }
}

function engineWithPlayers(mode) {
  const engine = new GameEngine({ mode });
  engine.addPlayer({ id: 'p1', name: 'Alice' });
  engine.addPlayer({ id: 'p2', name: 'Bob' });
  engine.startGame('standard');
  return engine;
}

describe('SEC-13: eventLog fog-of-war for typed resource gains', () => {
  it('hides production resource types from opponents while the owner still sees them', () => {
    const engine = engineWithPlayers();
    const producingHex = Array.from(engine.grid.hexes.values()).find(h => h.token && h.resource !== RESOURCE_TYPES.DESERT);
    const targetVertex = Array.from(engine.grid.vertices.values()).find(v => v.hexes.includes(producingHex.id));
    targetVertex.building = { type: 'settlement', playerId: 'p1', color: '#e63946' };
    engine.players[0].settlementsBuilt.push(targetVertex.id);

    engine.phase = GAME_PHASES.TURN_ROLL;
    const token = producingHex.token;
    const d1 = Math.min(6, Math.max(1, Math.floor(token / 2)));
    const d2 = token - d1;
    let rollCall = 0;
    const origRandom = Math.random;
    Math.random = () => {
      rollCall++;
      return rollCall === 1 ? (d1 - 1) / 6 : (d2 - 1) / 6;
    };
    engine.rollDice('p1');
    Math.random = origRandom;

    const internal = engine.eventLog.filter(e => e.type === 'RESOURCE_PRODUCED');
    assert.ok(internal.length > 0);
    assert.equal(internal[0].args.playerId, 'p1');
    assert.equal(internal[0].args.resource, producingHex.resource);

    const ownerLogs = engine.getStateForPlayer('p1').eventLog.filter(e => e.type === 'RESOURCE_PRODUCED');
    assert.equal(ownerLogs[0].args.resource, producingHex.resource);
    assert.equal(ownerLogs[0].messageKey, 'LOG_RESOURCE_PRODUCED');

    const oppLogs = engine.getStateForPlayer('p2').eventLog.filter(e => e.type === 'RESOURCE_PRODUCED');
    assert.ok(oppLogs.length > 0);
    assert.equal(oppLogs[0].messageKey, 'LOG_RESOURCE_PRODUCED_HIDDEN');
    assert.equal(oppLogs[0].args.resource, undefined);
    assert.equal(oppLogs[0].args.amount, internal[0].args.amount);
    assert.equal(oppLogs[0].args.playerName, 'Alice');
    for (const entry of oppLogs) assertNoTypedCards(entry.args, 'opponent production log args');
  });

  it('hides aqueduct resource types from opponents while the owner still sees them', () => {
    const engine = engineWithPlayers('cities_knights');
    engine.players[0].cityImprovements.science = 5;
    engine.players[0].resources = { wood: 2, brick: 2, wool: 2, wheat: 2, ore: 0 };

    const claimed = engine.applyAqueductBenefit({ p1: {}, p2: { wood: 1 } });
    assert.equal(claimed.p1, 'ore');
    engine.claimAqueductResource('p1', 'wheat');

    const ownerLogs = engine.getStateForPlayer('p1').eventLog.filter(e => e.type === 'AQUEDUCT_RESOURCE');
    assert.deepEqual(ownerLogs.map(e => e.args.resource), ['ore', 'wheat']);
    assert.ok(ownerLogs.every(e => e.messageKey === 'LOG_AQUEDUCT_RESOURCE'));

    const oppLogs = engine.getStateForPlayer('p2').eventLog.filter(e => e.type === 'AQUEDUCT_RESOURCE');
    assert.equal(oppLogs.length, 2);
    for (const oppLog of oppLogs) {
      assert.equal(oppLog.messageKey, 'LOG_AQUEDUCT_RESOURCE_HIDDEN');
      assert.equal(oppLog.args.resource, undefined);
      assert.equal(oppLog.args.amount, 1);
      assertNoTypedCards(oppLog.args, 'opponent aqueduct log args');
    }
  });

  it('hides setup bootstrap resource maps from opponents while the owner still sees them', () => {
    const engine = engineWithPlayers();
    const v1 = Array.from(engine.grid.vertices.keys()).find(id => engine.canBuildSettlement('p1', id, true).ok);
    engine.placeSetupSettlement('p1', v1);
    engine.placeSetupRoad('p1', engine.grid.vertices.get(v1).adjacentEdges[0]);

    const v2 = Array.from(engine.grid.vertices.keys()).find(id => engine.canBuildSettlement('p2', id, true).ok);
    engine.placeSetupSettlement('p2', v2);
    engine.placeSetupRoad('p2', engine.grid.vertices.get(v2).adjacentEdges[0]);

    const v2b = Array.from(engine.grid.vertices.keys()).find(id => engine.canBuildSettlement('p2', id, true).ok);
    engine.placeSetupSettlement('p2', v2b);

    const internal = engine.eventLog.filter(e => e.type === 'BOOTSTRAP_RESOURCES').at(-1);
    assert.ok(internal.args.resources);
    assert.equal(internal.args.playerId, 'p2');
    const expectedCount = Object.values(internal.args.resources).reduce((sum, n) => sum + n, 0);

    const ownerLog = engine.getStateForPlayer('p2').eventLog.filter(e => e.type === 'BOOTSTRAP_RESOURCES').at(-1);
    assert.deepEqual(ownerLog.args.resources, internal.args.resources);
    assert.equal(ownerLog.messageKey, 'LOG_BOOTSTRAP_RESOURCES');

    const oppLog = engine.getStateForPlayer('p1').eventLog.filter(e => e.type === 'BOOTSTRAP_RESOURCES').at(-1);
    assert.equal(oppLog.messageKey, 'LOG_BOOTSTRAP_RESOURCES_HIDDEN');
    assert.equal(oppLog.args.resources, undefined);
    assert.equal(oppLog.args.count, expectedCount);
    assert.equal(oppLog.args.playerName, 'Bob');
    assertNoTypedCards(oppLog.args, 'opponent bootstrap log args');
  });

  it('fail-closes typed gain logs when playerId is missing and keeps the canonical log intact', () => {
    const leaky = {
      type: 'RESOURCE_PRODUCED',
      messageKey: 'LOG_RESOURCE_PRODUCED',
      args: { playerName: 'Alice', amount: 2, resource: 'wheat' }
    };
    const hidden = sanitizeEventLogEntryForPlayer(leaky, 'p1');
    assert.equal(hidden.messageKey, 'LOG_RESOURCE_PRODUCED_HIDDEN');
    assert.equal(hidden.args.resource, undefined);
    assert.equal(leaky.args.resource, 'wheat');

    const ownerView = sanitizeEventLogForPlayer([
      { type: 'AQUEDUCT_RESOURCE', messageKey: 'LOG_AQUEDUCT_RESOURCE', args: { playerId: 'p1', playerName: 'Alice', resource: 'brick' } }
    ], 'p1')[0];
    const oppView = sanitizeEventLogForPlayer([
      { type: 'AQUEDUCT_RESOURCE', messageKey: 'LOG_AQUEDUCT_RESOURCE', args: { playerId: 'p1', playerName: 'Alice', resource: 'brick' } }
    ], 'p2')[0];
    assert.equal(ownerView.args.resource, 'brick');
    assert.equal(oppView.args.resource, undefined);
  });

  it('client log/toasts redact opponent typed gains even if the payload still names them', () => {
    const viewer = { id: 'p2', name: 'Bob' };
    const produced = redactEventLogEntryForViewer({
      type: 'RESOURCE_PRODUCED',
      messageKey: 'LOG_RESOURCE_PRODUCED',
      args: { playerId: 'p1', playerName: 'Alice', amount: 2, resource: 'ore' }
    }, viewer);
    assert.equal(produced.messageKey, 'LOG_RESOURCE_PRODUCED_HIDDEN');
    assert.equal(produced.args.resource, undefined);
    assert.match(i18n.t(produced.messageKey, produced.args), /Alice received 2 cards/);
    assert.equal(/ore/i.test(i18n.t(produced.messageKey, produced.args)), false);

    const own = redactEventLogEntryForViewer({
      type: 'RESOURCE_PRODUCED',
      messageKey: 'LOG_RESOURCE_PRODUCED',
      args: { playerId: 'p2', playerName: 'Bob', amount: 1, resource: 'wool' }
    }, viewer);
    assert.equal(own.args.resource, 'wool');
    assert.match(i18n.t(own.messageKey, { ...own.args, resource: 'Wool' }), /Bob received 1 Wool/);
  });
});
