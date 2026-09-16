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

describe('SEC-18: Saboteur callback fog-of-war', () => {
  function playSaboteurAgainstAheadOpponent() {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;

    engine.players[1].defenderCards = 2;
    engine.recalculateVictoryPoints();
    engine.players[1].resources = { wood: 4, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[1].commodities = { cloth: 2, coin: 0, paper: 0 };

    const card = { id: 'sab1', type: 'saboteur', played: false, boughtTurn: 0 };
    engine.players[0].progressCards.push(card);

    const result = engine.playProgressCard('p1', 'sab1', {});
    return { engine, result };
  }

  it('omits typed discard maps and reveals only who discarded and how many', () => {
    const { engine, result } = playSaboteurAgainstAheadOpponent();
    const callbackPayload = JSON.parse(JSON.stringify({ success: true, ...result }));

    assert.equal(callbackPayload.cardType, 'saboteur');
    assert.equal(callbackPayload.victims.length, 1);
    assert.deepEqual(Object.keys(callbackPayload.victims[0]).sort(), ['count', 'playerId']);
    assert.equal(callbackPayload.victims[0].playerId, 'p2');
    assert.equal(callbackPayload.victims[0].count, 3);
    assert.equal(callbackPayload.victims[0].discarded, undefined);

    const serialized = JSON.stringify(callbackPayload);
    assert.equal(serialized.includes('"wood"'), false);
    assert.equal(serialized.includes('"cloth"'), false);
    assert.equal(serialized.includes('"brick"'), false);

    assert.equal(engine.countTotalCards(engine.players[1]), 3);
  });

  it('keeps opponent hand types hidden after Saboteur in getStateForPlayer', () => {
    const { engine } = playSaboteurAgainstAheadOpponent();
    const asCaster = engine.getStateForPlayer('p1').players.find(p => p.id === 'p2');
    const asVictim = engine.getStateForPlayer('p2').players.find(p => p.id === 'p2');

    assert.equal(asCaster.resources.total + asCaster.commodities.total, 3);
    assert.equal(asCaster.resources.wood, undefined);
    assert.equal(asCaster.commodities.cloth, undefined);
    assert.equal(typeof asVictim.resources.wood, 'number');
    assert.equal(typeof asVictim.commodities.cloth, 'number');
  });
});
