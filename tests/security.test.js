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

describe('SEC-05: send_chat requires seated room membership', () => {
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
    serverIo.close();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  function createClient() {
    return ioClient(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
  }

  function connectClient() {
    const socket = createClient();
    return new Promise((resolve) => {
      socket.on('connect', () => resolve(socket));
    });
  }

  function emitCreateRoom(socket, hostName, roomName) {
    return new Promise((resolve) => {
      socket.emit('create_room', {
        hostName,
        roomName,
        maxPlayers: 4,
        mode: 'base'
      }, resolve);
    });
  }

  function emitJoinRoom(socket, code, playerName) {
    return new Promise((resolve) => {
      socket.emit('join_room', { code, playerName }, resolve);
    });
  }

  function nextChat(socket, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('chat_received', onChat);
        reject(new Error('timed out waiting for chat_received'));
      }, timeoutMs);
      function onChat(msg) {
        clearTimeout(timer);
        socket.off('chat_received', onChat);
        resolve(msg);
      }
      socket.on('chat_received', onChat);
    });
  }

  function assertNoChat(socket, timeoutMs = 400) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('chat_received', onChat);
        resolve();
      }, timeoutMs);
      function onChat(msg) {
        clearTimeout(timer);
        socket.off('chat_received', onChat);
        reject(new Error(`unexpected chat_received: ${JSON.stringify(msg)}`));
      }
      socket.on('chat_received', onChat);
    });
  }

  it('allows a seated player to broadcast chat using the bound room', async () => {
    const host = await connectClient();
    const guest = await connectClient();
    const created = await emitCreateRoom(host, 'ChatHost', 'ChatRoom');
    assert.equal(created.success, true);
    const joined = await emitJoinRoom(guest, created.roomCode, 'ChatGuest');
    assert.equal(joined.success, true);

    const received = nextChat(guest);
    host.emit('send_chat', { code: created.roomCode, text: 'hello lobby' });
    const msg = await received;

    assert.equal(msg.senderId, created.playerId);
    assert.equal(msg.senderName, 'ChatHost');
    assert.equal(msg.text, 'hello lobby');
    const room = liveRoomManager.getRoom(created.roomCode);
    assert.equal(room.chatMessages.at(-1).text, 'hello lobby');

    host.disconnect();
    guest.disconnect();
    liveRoomManager.destroyRoom(created.roomCode);
  });

  it('rejects chat from a socket that is not in any room even if data.code is supplied', async () => {
    const host = await connectClient();
    const attacker = await connectClient();
    const created = await emitCreateRoom(host, 'TargetHost', 'TargetRoom');
    assert.equal(created.success, true);

    const noChat = assertNoChat(host);
    attacker.emit('send_chat', { code: created.roomCode, text: 'injected from outside' });
    await noChat;

    const room = liveRoomManager.getRoom(created.roomCode);
    assert.equal(room.chatMessages.some(m => m.text === 'injected from outside'), false);
    assert.equal(room.chatMessages.some(m => m.senderName === 'Player'), false);

    host.disconnect();
    attacker.disconnect();
    liveRoomManager.destroyRoom(created.roomCode);
  });

  it('rejects cross-room chat from a player seated in a different room', async () => {
    const hostA = await connectClient();
    const hostB = await connectClient();
    const roomA = await emitCreateRoom(hostA, 'HostA', 'RoomA');
    const roomB = await emitCreateRoom(hostB, 'HostB', 'RoomB');
    assert.equal(roomA.success, true);
    assert.equal(roomB.success, true);

    const noChatA = assertNoChat(hostA);
    const noChatB = assertNoChat(hostB);
    hostA.emit('send_chat', { code: roomB.roomCode, text: 'cross-room ping' });
    await Promise.all([noChatA, noChatB]);

    assert.equal(liveRoomManager.getRoom(roomA.roomCode).chatMessages.some(m => m.text === 'cross-room ping'), false);
    assert.equal(liveRoomManager.getRoom(roomB.roomCode).chatMessages.some(m => m.text === 'cross-room ping'), false);

    hostA.disconnect();
    hostB.disconnect();
    liveRoomManager.destroyRoom(roomA.roomCode);
    liveRoomManager.destroyRoom(roomB.roomCode);
  });

  it('rejects chat after the socket is no longer seated in room.players', async () => {
    const host = await connectClient();
    const guest = await connectClient();
    const created = await emitCreateRoom(host, 'KickHost', 'KickRoom');
    const joined = await emitJoinRoom(guest, created.roomCode, 'KickGuest');
    assert.equal(created.success, true);
    assert.equal(joined.success, true);

    const kickRes = await new Promise((resolve) => {
      host.emit('remove_player', { code: created.roomCode, id: joined.playerId }, resolve);
    });
    assert.equal(kickRes.success, true);
    assert.equal(liveRoomManager.getRoom(created.roomCode).players.some(p => p.id === joined.playerId), false);

    const noChat = assertNoChat(host);
    guest.emit('send_chat', { code: created.roomCode, text: 'still here after kick' });
    await noChat;

    assert.equal(liveRoomManager.getRoom(created.roomCode).chatMessages.some(m => m.text === 'still here after kick'), false);

    host.disconnect();
    guest.disconnect();
    liveRoomManager.destroyRoom(created.roomCode);
  });
});

