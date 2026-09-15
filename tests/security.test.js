import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomManager,
  sanitizePlayerForClient,
  sanitizePlayersForClient,
  validateChatMessage,
  validateDisplayName,
  validatePlayerColor,
  validateRoomName
} from '../server/game/RoomManager.js';
import { escapeHtml, CatanApp } from '../public/js/app.js';
import { network } from '../public/js/network.js';

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

describe('SEC-09: reconnect secrets not broadcast to clients', () => {
  function capturingIo() {
    const emitted = [];
    const io = {
      to(target) {
        return {
          emit(event, payload) {
            emitted.push({ target, event, payload });
          }
        };
      }
    };
    return { io, emitted };
  }

  function assertSanitizedPlayers(players) {
    assert.ok(Array.isArray(players));
    assert.ok(players.length > 0);
    for (const player of players) {
      assert.equal(Object.hasOwn(player, 'reconnectToken'), false, 'raw reconnect token must not be emitted');
      assert.equal(Object.hasOwn(player, 'reconnectTokenHash'), false, 'reconnectTokenHash must not be emitted');
      assert.equal(Object.hasOwn(player, 'socketId'), false, 'socketId must not be emitted');
      assert.ok(player.id);
      assert.ok(player.name);
      assert.equal(typeof player.isBot, 'boolean');
    }
  }

  it('strips reconnectToken, reconnectTokenHash, and socketId from a player copy without mutating the original', () => {
    const original = {
      id: 'p1',
      name: 'Host',
      color: '#e63946',
      isReady: true,
      isBot: false,
      socketId: 'sock-secret',
      reconnectTokenHash: 'hash-secret',
      reconnectToken: 'raw-secret'
    };

    const sanitized = sanitizePlayerForClient(original);

    assert.deepEqual(sanitizePlayersForClient([original]), [sanitized]);
    assert.equal(Object.hasOwn(sanitized, 'reconnectToken'), false);
    assert.equal(Object.hasOwn(sanitized, 'reconnectTokenHash'), false);
    assert.equal(Object.hasOwn(sanitized, 'socketId'), false);
    assert.equal(sanitized.id, 'p1');
    assert.equal(sanitized.name, 'Host');
    assert.equal(original.socketId, 'sock-secret');
    assert.equal(original.reconnectTokenHash, 'hash-secret');
    assert.equal(original.reconnectToken, 'raw-secret');
  });

  it('omits reconnectTokenHash, raw reconnect token, and socketId from lobby broadcasts', () => {
    const { io, emitted } = capturingIo();
    const roomManager = new RoomManager(io);
    const host = roomManager.createPlayerSession();
    const guest = roomManager.createPlayerSession();
    const room = roomManager.createRoom({
      id: host.id,
      name: 'Host',
      socketId: 'sock-host',
      reconnectTokenHash: host.reconnectTokenHash
    });
    room.players[0].reconnectToken = host.reconnectToken;
    roomManager.joinRoom(room.code, {
      id: guest.id,
      name: 'Guest',
      socketId: 'sock-guest',
      reconnectTokenHash: guest.reconnectTokenHash
    });
    room.players[1].reconnectToken = guest.reconnectToken;

    roomManager.broadcastLobbyState(room);

    const lobbyEmits = emitted.filter(entry => entry.event === 'lobby_state_update');
    assert.equal(lobbyEmits.length, 1);
    assertSanitizedPlayers(lobbyEmits[0].payload.players);
    assert.equal(lobbyEmits[0].payload.players.length, 2);
    assert.equal(lobbyEmits[0].payload.players[0].id, host.id);
    assert.equal(lobbyEmits[0].payload.players[1].id, guest.id);

    assert.equal(room.players[0].reconnectTokenHash, host.reconnectTokenHash);
    assert.equal(room.players[0].socketId, 'sock-host');
    assert.equal(room.players[0].reconnectToken, host.reconnectToken);
    roomManager.destroyRoom(room.code);
  });

  it('omits reconnectTokenHash, raw reconnect token, and socketId from game broadcasts', () => {
    const { io, emitted } = capturingIo();
    const roomManager = new RoomManager(io);
    const host = roomManager.createPlayerSession();
    const guest = roomManager.createPlayerSession();
    const room = roomManager.createRoom({
      id: host.id,
      name: 'Host',
      socketId: 'sock-host',
      reconnectTokenHash: host.reconnectTokenHash
    });
    room.players[0].reconnectToken = host.reconnectToken;
    roomManager.joinRoom(room.code, {
      id: guest.id,
      name: 'Guest',
      socketId: 'sock-guest',
      reconnectTokenHash: guest.reconnectTokenHash
    });
    room.players[1].reconnectToken = guest.reconnectToken;
    roomManager.setPlayerReady(room.code, guest.id, true);
    roomManager.startGame(room.code, host.id);

    roomManager.broadcastState(room);

    const gameEmits = emitted.filter(entry => entry.event === 'game_state_update');
    assert.equal(gameEmits.length, 2);
    for (const entry of gameEmits) {
      assertSanitizedPlayers(entry.payload.room.players);
      assert.equal(entry.payload.room.players.length, 2);
      assert.ok(entry.payload.state);
    }

    assert.equal(room.players[0].reconnectTokenHash, host.reconnectTokenHash);
    assert.equal(room.players[0].socketId, 'sock-host');
    assert.equal(room.players[1].reconnectTokenHash, guest.reconnectTokenHash);
    assert.equal(room.players[1].socketId, 'sock-guest');
    roomManager.destroyRoom(room.code);
  });
});
