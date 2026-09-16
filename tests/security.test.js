import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import {
  RoomManager,
  validateChatMessage,
  validateDisplayName,
  validatePlayerColor,
  validateRoomName
} from '../server/game/RoomManager.js';
import { GameEngine, GAME_PHASES } from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';
import { escapeHtml, CatanApp } from '../public/js/app.js';
import { network } from '../public/js/network.js';
import { server, roomManager as liveRoomManager, io as serverIo } from '../server/server.js';

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

describe('SEC-10: constant-time reconnect token compare', () => {
  it('accepts the matching token and rejects a wrong token', () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const session = roomManager.createPlayerSession();
    const player = { reconnectTokenHash: session.reconnectTokenHash };

    assert.equal(roomManager.matchesReconnectToken(player, session.reconnectToken), true);
    assert.equal(roomManager.matchesReconnectToken(player, session.reconnectToken + 'x'), false);
    assert.equal(roomManager.matchesReconnectToken(player, ''), false);
  });

  it('fails closed on missing hash, non-string token, and invalid digest length', () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const session = roomManager.createPlayerSession();

    assert.equal(roomManager.matchesReconnectToken({}, session.reconnectToken), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: null }, session.reconnectToken), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: session.reconnectTokenHash }, null), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: session.reconnectTokenHash }, 123), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: 'abcd' }, session.reconnectToken), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: 'z'.repeat(64) }, session.reconnectToken), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: 'a'.repeat(63) }, session.reconnectToken), false);
    assert.equal(roomManager.matchesReconnectToken({ reconnectTokenHash: 'a'.repeat(65) }, session.reconnectToken), false);
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

function makeRobberEngine() {
  const engine = new GameEngine({ roomId: 'sec-07' });
  engine.addPlayer({ id: 'p1', name: 'Alice', color: '#e63946' });
  engine.addPlayer({ id: 'p2', name: 'Bob', color: '#1d3557' });
  engine.addPlayer({ id: 'p3', name: 'Carol', color: '#2a9d8f' });
  engine.startGame('standard');
  engine.phase = GAME_PHASES.TURN_ROBBER;
  engine.hasRolledDice = true;
  for (const player of engine.players) {
    player.resources = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
  }
  return engine;
}

function destHexId(engine) {
  return Array.from(engine.grid.hexes.keys()).find((id) => id !== engine.grid.robberHexId);
}

function attachSettlement(engine, playerId, hexId) {
  const vertexId = Array.from(engine.grid.vertices.keys()).find((id) => {
    const vertex = engine.grid.vertices.get(id);
    return vertex.hexes.includes(hexId) && !vertex.building;
  });
  assert.ok(vertexId, `expected an empty vertex on ${hexId}`);
  const player = engine.players.find((p) => p.id === playerId);
  engine.grid.vertices.get(vertexId).building = {
    type: 'settlement',
    playerId,
    color: player.color
  };
  player.settlementsBuilt.push(vertexId);
  return vertexId;
}

describe('SEC-07: moveRobber mandatory steal', () => {
  it('rejects a missing steal target when an adjacent victim has cards', () => {
    const engine = makeRobberEngine();
    const hexId = destHexId(engine);
    const robberBefore = engine.grid.robberHexId;
    attachSettlement(engine, 'p2', hexId);
    engine.players[1].resources.wood = 2;

    assert.throws(() => engine.moveRobber('p1', hexId), /STEAL_TARGET_REQUIRED/);
    assert.throws(() => engine.moveRobber('p1', hexId, null), /STEAL_TARGET_REQUIRED/);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
    assert.equal(engine.grid.robberHexId, robberBefore);
    assert.equal(engine.players[1].resources.wood, 2);
    assert.equal(engine.players[0].resources.wood, 0);
  });

  it('rejects invalid, self, and non-adjacent targets when victims exist', () => {
    const engine = makeRobberEngine();
    const hexId = destHexId(engine);
    attachSettlement(engine, 'p2', hexId);
    const farVertexId = Array.from(engine.grid.vertices.keys()).find((id) => {
      const vertex = engine.grid.vertices.get(id);
      return !vertex.building && !vertex.hexes.includes(hexId);
    });
    assert.ok(farVertexId, 'expected a vertex that does not touch the dest hex');
    const p3 = engine.players[2];
    engine.grid.vertices.get(farVertexId).building = {
      type: 'settlement',
      playerId: 'p3',
      color: p3.color
    };
    p3.settlementsBuilt.push(farVertexId);
    engine.players[1].resources.wool = 1;
    engine.players[2].resources.brick = 1;

    assert.throws(() => engine.moveRobber('p1', hexId, 'nobody'), /STEAL_TARGET_REQUIRED/);
    assert.throws(() => engine.moveRobber('p1', hexId, 'p1'), /STEAL_TARGET_REQUIRED/);
    assert.throws(() => engine.moveRobber('p1', hexId, 'p3'), /STEAL_TARGET_REQUIRED/);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
  });

  it('rejects a broke adjacent player when another adjacent victim has cards', () => {
    const engine = makeRobberEngine();
    const hexId = destHexId(engine);
    attachSettlement(engine, 'p2', hexId);
    attachSettlement(engine, 'p3', hexId);
    engine.players[2].resources.ore = 1;

    assert.throws(() => engine.moveRobber('p1', hexId, 'p2'), /STEAL_TARGET_REQUIRED/);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
  });

  it('allows skipping steal when no adjacent opponent has cards', () => {
    const engine = makeRobberEngine();
    const hexId = destHexId(engine);
    attachSettlement(engine, 'p2', hexId);
    attachSettlement(engine, 'p1', hexId);

    const result = engine.moveRobber('p1', hexId, null);
    assert.equal(result.stolenResource, null);
    assert.equal(engine.grid.robberHexId, hexId);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });

  it('steals from a valid adjacent victim and advances the phase', () => {
    const engine = makeRobberEngine();
    const hexId = destHexId(engine);
    attachSettlement(engine, 'p2', hexId);
    engine.players[1].resources.wheat = 1;

    const result = engine.moveRobber('p1', hexId, 'p2');
    assert.equal(result.stolenFrom, 'p2');
    assert.equal(result.stolenResource, 'wheat');
    assert.equal(engine.players[1].resources.wheat, 0);
    assert.equal(engine.players[0].resources.wheat, 1);
    assert.equal(engine.grid.robberHexId, hexId);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });

  it('BotAI supplies a stealable target when adjacent victims have cards', () => {
    const engine = makeRobberEngine();
    const hexId = destHexId(engine);
    attachSettlement(engine, 'p2', hexId);
    engine.players[1].resources.brick = 2;

    const decision = BotAI.decideRobberMove(engine, engine.players[0]);
    const victims = engine.getRobberStealVictims(decision.hexId, 'p1');
    if (victims.length > 0) {
      assert.ok(victims.some((p) => p.id === decision.targetPlayerId));
    }
    assert.doesNotThrow(() => engine.moveRobber('p1', decision.hexId, decision.targetPlayerId));
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });
});
