import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomManager,
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

describe('SEC-15: leave_room drops action authority while stand-in bot controls seat', () => {
  function startedTwoPlayerRoom() {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const host = roomManager.createPlayerSession();
    const guest = roomManager.createPlayerSession();
    const room = roomManager.createRoom({
      id: host.id,
      name: 'Host',
      socketId: 'host-socket',
      reconnectTokenHash: host.reconnectTokenHash
    });
    roomManager.joinRoom(room.code, {
      id: guest.id,
      name: 'Guest',
      socketId: 'guest-socket',
      reconnectTokenHash: guest.reconnectTokenHash
    });
    roomManager.setPlayerReady(room.code, guest.id, true);
    roomManager.startGame(room.code, host.id);
    return { roomManager, room, host, guest };
  }

  it('revokes action authority for the old socket after stand-in replacement', () => {
    const { roomManager, room, host, guest } = startedTwoPlayerRoom();

    assert.equal(roomManager.hasActionAuthority(room, guest.id, 'guest-socket'), true);
    assert.equal(roomManager.hasActionAuthority(room, host.id, 'host-socket'), true);

    const replaced = roomManager.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    assert.ok(replaced);
    assert.equal(replaced.isStandInBot, true);
    assert.equal(replaced.socketId, null);

    assert.equal(roomManager.hasActionAuthority(room, guest.id, 'guest-socket'), false);
    assert.equal(roomManager.hasActionAuthority(room, guest.id, null), false);
    assert.equal(roomManager.hasActionAuthority(room, host.id, 'host-socket'), true);

    roomManager.destroyRoom(room.code);
  });

  it('restores action authority only after reconnect-token reclaim', () => {
    const { roomManager, room, guest } = startedTwoPlayerRoom();
    roomManager.replaceDisconnectedPlayerWithBot(room.code, guest.id);

    const stolen = roomManager.joinRoom(room.code, {
      socketId: 'attacker-socket',
      id: guest.id,
      allowLegacyId: false
    });
    assert.equal(stolen.reconnected, false);
    assert.equal(roomManager.hasActionAuthority(room, guest.id, 'attacker-socket'), false);
    assert.equal(roomManager.hasActionAuthority(room, guest.id, 'guest-socket'), false);

    const back = roomManager.joinRoom(room.code, {
      socketId: 'guest-reclaim',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false
    });
    assert.equal(back.reconnected, true);
    assert.equal(back.playerId, guest.id);
    const seat = room.players.find(p => p.id === guest.id);
    assert.equal(seat.isBot, false);
    assert.equal(seat.isStandInBot, false);
    assert.equal(seat.socketId, 'guest-reclaim');
    assert.equal(roomManager.hasActionAuthority(room, guest.id, 'guest-reclaim'), true);
    assert.equal(roomManager.hasActionAuthority(room, guest.id, 'guest-socket'), false);

    roomManager.destroyRoom(room.code);
  });
});
