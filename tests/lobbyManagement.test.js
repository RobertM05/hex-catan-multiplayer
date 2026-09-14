import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { server, roomManager, io as serverIo } from '../server/server.js';

describe('LOBBY: Socket Bot Spawning, Case-Insensitive Codes & Host Authorization', () => {
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

  it('allows host to add bots, enforces host-only authorization, and handles case-insensitive room codes', async () => {
    const hostSocket = createClient();
    const guestSocket = createClient();

    await Promise.all([
      new Promise(res => hostSocket.on('connect', res)),
      new Promise(res => guestSocket.on('connect', res))
    ]);

    let createdRoomCode = null;
    let hostPlayerId = null;

    // 1. Host creates room (max 4 players)
    const createRes = await new Promise((resolve) => {
      hostSocket.emit('create_room', {
        hostName: 'TestHost',
        roomName: 'BotLobby',
        maxPlayers: 4,
        mode: 'base'
      }, resolve);
    });

    assert.equal(createRes.success, true);
    assert.ok(createRes.roomCode);
    assert.ok(createRes.playerId);
    createdRoomCode = createRes.roomCode;
    hostPlayerId = createRes.playerId;

    // 2. Host adds first bot with standard payload
    const addBotRes1 = await new Promise((resolve) => {
      hostSocket.emit('add_bot', { code: createdRoomCode, difficulty: 'medium' }, resolve);
    });
    assert.equal(addBotRes1.success, true);
    assert.ok(addBotRes1.bot);
    assert.equal(addBotRes1.bot.isBot, true);

    // 3. Host adds second bot with lowercase room code (case-insensitivity test)
    const addBotRes2 = await new Promise((resolve) => {
      hostSocket.emit('add_bot', { code: createdRoomCode.toLowerCase(), difficulty: 'easy' }, resolve);
    });
    assert.equal(addBotRes2.success, true);
    assert.ok(addBotRes2.bot);

    // 4. Host adds bot without explicit code (fallback to socket's currentRoomCode)
    // Wait, let's first join guest so room has: host (1) + 2 bots (2) + guest (1) = 4 players
    const guestJoinRes = await new Promise((resolve) => {
      guestSocket.emit('join_room', { code: createdRoomCode.toLowerCase(), playerName: 'GuestPlayer' }, resolve);
    });
    assert.equal(guestJoinRes.success, true);
    assert.ok(guestJoinRes.playerId);

    // 5. Guest attempts to add bot -> must be rejected
    const guestAddBotRes = await new Promise((resolve) => {
      guestSocket.emit('add_bot', { code: createdRoomCode, difficulty: 'medium' }, resolve);
    });
    assert.equal(guestAddBotRes.success, false);
    assert.equal(guestAddBotRes.error, 'ONLY_HOST_CAN_MANAGE_LOBBY');

    // 6. Room is now full (4 / 4 players). Host attempts to add another bot -> rejected with ROOM_FULL
    const fullAddBotRes = await new Promise((resolve) => {
      hostSocket.emit('add_bot', { code: createdRoomCode, difficulty: 'medium' }, resolve);
    });
    assert.equal(fullAddBotRes.success, false);
    assert.equal(fullAddBotRes.error, 'ROOM_FULL');

    // 6. Guest must ready up before start
    await new Promise((resolve) => {
      guestSocket.emit('set_ready', { code: createdRoomCode, isReady: true }, resolve);
    });

    // 7. Host starts game
    const startRes = await new Promise((resolve) => {
      hostSocket.emit('start_game', { code: createdRoomCode }, resolve);
    });
    assert.equal(startRes.success, true);

    // 8. After game started, add_bot is rejected with GAME_ALREADY_STARTED
    const startedAddBotRes = await new Promise((resolve) => {
      hostSocket.emit('add_bot', { code: createdRoomCode, difficulty: 'medium' }, resolve);
    });
    assert.equal(startedAddBotRes.success, false);
    assert.equal(startedAddBotRes.error, 'GAME_ALREADY_STARTED');

    hostSocket.disconnect();
    guestSocket.disconnect();
    roomManager.destroyRoom(createdRoomCode);
  });

  it('allows host to add bot without specifying code in payload', async () => {
    const hostSocket = createClient();
    await new Promise(res => hostSocket.on('connect', res));

    const createRes = await new Promise((resolve) => {
      hostSocket.emit('create_room', {
        hostName: 'TestHost2',
        roomName: 'BotLobby2',
        maxPlayers: 4,
        mode: 'base'
      }, resolve);
    });
    assert.equal(createRes.success, true);

    // Emit add_bot with only difficulty (no code property)
    const addBotRes = await new Promise((resolve) => {
      hostSocket.emit('add_bot', { difficulty: 'hard' }, resolve);
    });
    assert.equal(addBotRes.success, true);
    assert.ok(addBotRes.bot);

    hostSocket.disconnect();
    roomManager.destroyRoom(createRes.roomCode);
  });
});
