import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { server, roomManager, io as serverIo } from '../server/server.js';

describe('SEC-15: leave_room socket action authority', () => {
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

  it('rejects handleGameAction from the old socket after leave until reconnect-token reclaim', async () => {
    const hostSocket = createClient();
    const guestSocket = createClient();

    await Promise.all([
      new Promise(res => hostSocket.on('connect', res)),
      new Promise(res => guestSocket.on('connect', res))
    ]);

    const createRes = await new Promise((resolve) => {
      hostSocket.emit('create_room', {
        hostName: 'AuthorityHost',
        roomName: 'AuthorityRoom',
        maxPlayers: 4,
        mode: 'base'
      }, resolve);
    });
    assert.equal(createRes.success, true);
    const roomCode = createRes.roomCode;

    const guestJoinRes = await new Promise((resolve) => {
      guestSocket.emit('join_room', { code: roomCode, playerName: 'AuthorityGuest' }, resolve);
    });
    assert.equal(guestJoinRes.success, true);
    const guestPlayerId = guestJoinRes.playerId;
    const guestToken = guestJoinRes.reconnectToken;
    assert.ok(guestToken);

    await new Promise((resolve) => {
      guestSocket.emit('set_ready', { code: roomCode, isReady: true }, resolve);
    });

    const startRes = await new Promise((resolve) => {
      hostSocket.emit('start_game', { code: roomCode }, resolve);
    });
    assert.equal(startRes.success, true);

    const leaveRes = await new Promise((resolve) => {
      guestSocket.emit('leave_room', { code: roomCode }, resolve);
    });
    assert.equal(leaveRes.success, true);

    const room = roomManager.getRoom(roomCode);
    const seat = room.players.find(p => p.id === guestPlayerId);
    assert.equal(seat.isBot, true);
    assert.equal(seat.isStandInBot, true);
    assert.equal(seat.socketId, null);
    assert.equal(roomManager.hasActionAuthority(room, guestPlayerId, guestSocket.id), false);

    const leftAction = await new Promise((resolve) => {
      guestSocket.emit('roll_dice', { code: roomCode }, resolve);
    });
    assert.equal(leftAction.success, false);
    assert.equal(leftAction.error, 'NO_ACTION_AUTHORITY');

    const setupAction = await new Promise((resolve) => {
      guestSocket.emit('place_setup_settlement', { code: roomCode, vertexId: 'v1' }, resolve);
    });
    assert.equal(setupAction.success, false);
    assert.equal(setupAction.error, 'NO_ACTION_AUTHORITY');

    const reclaimRes = await new Promise((resolve) => {
      guestSocket.emit('join_room', {
        code: roomCode,
        playerName: 'AuthorityGuest',
        reconnectToken: guestToken
      }, resolve);
    });
    assert.equal(reclaimRes.success, true);
    assert.equal(reclaimRes.playerId, guestPlayerId);

    const reclaimed = room.players.find(p => p.id === guestPlayerId);
    assert.equal(reclaimed.isBot, false);
    assert.equal(reclaimed.isStandInBot, false);
    assert.equal(reclaimed.socketId, guestSocket.id);
    assert.equal(roomManager.hasActionAuthority(room, guestPlayerId, guestSocket.id), true);

    const afterReclaim = await new Promise((resolve) => {
      guestSocket.emit('roll_dice', { code: roomCode }, resolve);
    });
    assert.notEqual(afterReclaim.error, 'NO_ACTION_AUTHORITY');

    hostSocket.disconnect();
    guestSocket.disconnect();
    roomManager.destroyRoom(roomCode);
  });
});
