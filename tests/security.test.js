import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import {
  RoomManager,
  sanitizePlayerForClient,
  sanitizePlayersForClient,
  validateChatMessage,
  validateDisplayName,
  validatePlayerColor,
  validateRoomName,
  isBotActionAllowed,
  BOT_DISCARD_DELAY_MS,
  BOT_TURN_DELAY_MS
} from '../server/game/RoomManager.js';
import { RESOURCE_TYPES } from '../server/game/HexGrid.js';
import {
  GameEngine,
  GAME_PHASES,
  sanitizeEventLogEntryForPlayer,
  sanitizeEventLogForPlayer
} from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';
import { escapeHtml, CatanApp, redactEventLogEntryForViewer } from '../public/js/app.js';
import { network } from '../public/js/network.js';
import { i18n } from '../public/js/i18n.js';
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
    return vertex.hexes.includes(hexId) && !vertex.building && !vertex.knight;
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
    assert.equal(stolen.error, 'GAME_ALREADY_STARTED');
    assert.equal(stolen.reconnected, undefined);
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
    assert.deepEqual(Object.keys(callbackPayload.victims[0]).sort(), ['discardNeeded', 'playerId']);
    assert.equal(callbackPayload.victims[0].playerId, 'p2');
    assert.equal(callbackPayload.victims[0].discardNeeded, 3);
    assert.equal(callbackPayload.victims[0].discarded, undefined);

    const serialized = JSON.stringify(callbackPayload);
    assert.equal(serialized.includes('"wood"'), false);
    assert.equal(serialized.includes('"cloth"'), false);
    assert.equal(serialized.includes('"brick"'), false);

    engine.discardCards('p2', { wood: 2, cloth: 1 });
    assert.equal(engine.countTotalCards(engine.players[1]), 3);
  });

  it('keeps opponent hand types hidden after Saboteur in getStateForPlayer', () => {
    const { engine } = playSaboteurAgainstAheadOpponent();
    engine.discardCards('p2', { wood: 2, cloth: 1 });
    const asCaster = engine.getStateForPlayer('p1').players.find(p => p.id === 'p2');
    const asVictim = engine.getStateForPlayer('p2').players.find(p => p.id === 'p2');

    assert.equal(asCaster.resources.total + asCaster.commodities.total, 3);
    assert.equal(asCaster.resources.wood, undefined);
    assert.equal(asCaster.commodities.cloth, undefined);
    assert.equal(typeof asVictim.resources.wood, 'number');
    assert.equal(typeof asVictim.commodities.cloth, 'number');
  });
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startedTwoPlayerRoomSec06(roomManager, { withBot = false } = {}) {
  const host = roomManager.createPlayerSession();
  const guest = roomManager.createPlayerSession();
  const room = roomManager.createRoom({
    id: host.id,
    name: 'Host',
    socketId: 's1',
    reconnectTokenHash: host.reconnectTokenHash
  }, { maxPlayers: 4 });
  roomManager.joinRoom(room.code, {
    id: guest.id,
    name: 'Guest',
    socketId: 's2',
    reconnectTokenHash: guest.reconnectTokenHash
  });
  const bot = withBot ? roomManager.addBot(room.code, 'easy') : null;
  roomManager.setPlayerReady(room.code, guest.id, true);
  roomManager.startGame(room.code, host.id);
  return { room, host, guest, bot };
}

describe('SEC-06: stand-in bot timers after human reclaim', () => {
  it('isBotActionAllowed is false after both isBot and isStandInBot are cleared', () => {
    const room = {
      players: [{ id: 'p1', isBot: false, isStandInBot: false }],
      engine: { players: [{ id: 'p1', isBot: false }] }
    };
    assert.equal(isBotActionAllowed(room, 'p1'), false);
    room.players[0].isBot = true;
    room.players[0].isStandInBot = true;
    room.engine.players[0].isBot = true;
    assert.equal(isBotActionAllowed(room, 'p1'), true);
    room.players[0].isBot = true;
    room.players[0].isStandInBot = false;
    assert.equal(isBotActionAllowed(room, 'p1'), true);
  });

  it('does not apply a pending stand-in discard after the human reclaims', async () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const { room, guest } = startedTwoPlayerRoomSec06(roomManager);
    const engine = room.engine;
    const guestEngine = engine.players.find(p => p.id === guest.id);
    guestEngine.resources = { wood: 4, brick: 4, wool: 0, wheat: 0, ore: 0 };
    engine.phase = GAME_PHASES.TURN_DISCARD;
    engine.pendingDiscards = new Set([guest.id]);

    const replaced = roomManager.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    assert.equal(replaced.isStandInBot, true);
    assert.ok(room.botActionTimers.size > 0);

    const back = roomManager.joinRoom(room.code, {
      socketId: 's2-reclaim',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false
    });
    assert.equal(back.reconnected, true);
    assert.equal(isBotActionAllowed(room, guest.id), false);
    assert.equal(room.botActionTimers.size, 0);

    await wait(BOT_DISCARD_DELAY_MS + 250);

    assert.equal(engine.pendingDiscards.has(guest.id), true);
    assert.equal(engine.countTotalCards(guestEngine), 8);
    assert.equal(engine.phase, GAME_PHASES.TURN_DISCARD);
    roomManager.destroyRoom(room.code);
  });

  it('does not apply a pending stand-in turn action after the human reclaims', async () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const { room, guest } = startedTwoPlayerRoomSec06(roomManager);
    const engine = room.engine;
    engine.phase = GAME_PHASES.TURN_ROLL;
    engine.hasRolledDice = false;
    engine.currentTurnPlayerIndex = engine.players.findIndex(p => p.id === guest.id);

    roomManager.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    assert.ok(room.botActionTimers.size > 0);

    const back = roomManager.joinRoom(room.code, {
      socketId: 's2-reclaim',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false
    });
    assert.equal(back.reconnected, true);
    assert.equal(isBotActionAllowed(room, guest.id), false);

    await wait(BOT_TURN_DELAY_MS + 250);

    assert.equal(engine.hasRolledDice, false);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROLL);
    roomManager.destroyRoom(room.code);
  });

  it('still applies stand-in discard when the human does not reclaim', async () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const { room, guest } = startedTwoPlayerRoomSec06(roomManager);
    const engine = room.engine;
    const guestEngine = engine.players.find(p => p.id === guest.id);
    guestEngine.resources = { wood: 4, brick: 4, wool: 0, wheat: 0, ore: 0 };
    engine.phase = GAME_PHASES.TURN_DISCARD;
    engine.pendingDiscards = new Set([guest.id]);

    roomManager.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    await wait(BOT_DISCARD_DELAY_MS + 250);

    assert.equal(engine.pendingDiscards.has(guest.id), false);
    assert.equal(engine.countTotalCards(guestEngine), 4);
    roomManager.destroyRoom(room.code);
  });

  it('does not cancel a permanent bot discard when a different seat is reclaimed', async () => {
    const roomManager = new RoomManager({ to: () => ({ emit() {} }) });
    const { room, guest, bot } = startedTwoPlayerRoomSec06(roomManager, { withBot: true });
    const engine = room.engine;
    const guestEngine = engine.players.find(p => p.id === guest.id);
    const botEngine = engine.players.find(p => p.id === bot.id);
    guestEngine.resources = { wood: 4, brick: 4, wool: 0, wheat: 0, ore: 0 };
    botEngine.resources = { wood: 4, brick: 4, wool: 0, wheat: 0, ore: 0 };
    engine.phase = GAME_PHASES.TURN_DISCARD;
    engine.pendingDiscards = new Set([guest.id, bot.id]);

    roomManager.replaceDisconnectedPlayerWithBot(room.code, guest.id);
    const back = roomManager.joinRoom(room.code, {
      socketId: 's2-reclaim',
      reconnectToken: guest.reconnectToken,
      allowLegacyId: false
    });
    assert.equal(back.reconnected, true);

    await wait(BOT_DISCARD_DELAY_MS + 250);

    assert.equal(engine.pendingDiscards.has(guest.id), true);
    assert.equal(engine.countTotalCards(guestEngine), 8);
    assert.equal(engine.pendingDiscards.has(bot.id), false);
    assert.equal(engine.countTotalCards(botEngine), 4);
    roomManager.destroyRoom(room.code);
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

function makeChaseEngine() {
  const engine = new GameEngine({ roomId: 'sec-17', mode: 'cities_knights' });
  engine.addPlayer({ id: 'p1', name: 'Alice', color: '#e63946' });
  engine.addPlayer({ id: 'p2', name: 'Bob', color: '#1d3557' });
  engine.addPlayer({ id: 'p3', name: 'Carol', color: '#2a9d8f' });
  engine.startGame('standard');
  engine.phase = GAME_PHASES.TURN_ACTION;
  engine.barbariansHaveAttacked = true;
  for (const player of engine.players) {
    player.resources = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    player.commodities = { cloth: 0, coin: 0, paper: 0 };
  }
  return engine;
}


function plantChaseKnight(engine, playerId) {
  const robberHex = engine.grid.robberHexId;
  const vertex = Array.from(engine.grid.vertices.values()).find(
    (v) => !v.building && !v.knight && v.hexes.includes(robberHex)
  );
  assert.ok(vertex, 'expected empty vertex adjacent to robber');
  const player = engine.players.find((p) => p.id === playerId);
  const knight = {
    playerId,
    vertexId: vertex.id,
    rank: 'basic',
    active: true,
    strength: 1
  };
  vertex.knight = knight;
  player.knightsPlaced.push(knight);
  player.knightsAvailable.basic--;
  return vertex.id;
}

describe('SEC-17: chaseRobber mandatory steal', () => {
  it('rejects a missing steal target when an adjacent victim has cards', () => {
    const engine = makeChaseEngine();
    const hexId = destHexId(engine);
    const robberBefore = engine.grid.robberHexId;
    const vertexId = plantChaseKnight(engine, 'p1');
    attachSettlement(engine, 'p2', hexId);
    engine.players[1].resources.wood = 2;

    assert.throws(() => engine.chaseRobber('p1', vertexId, hexId), /STEAL_TARGET_REQUIRED/);
    assert.throws(() => engine.chaseRobber('p1', vertexId, hexId, null), /STEAL_TARGET_REQUIRED/);
    assert.equal(engine.grid.robberHexId, robberBefore);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
    assert.equal(engine.players[0].knightsPlaced[0].lastActionTurn, undefined);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
    assert.equal(engine.players[1].resources.wood, 2);
    assert.equal(engine.players[0].resources.wood, 0);
  });

  it('rejects invalid, self, and non-adjacent targets when victims exist', () => {
    const engine = makeChaseEngine();
    const hexId = destHexId(engine);
    const robberBefore = engine.grid.robberHexId;
    const vertexId = plantChaseKnight(engine, 'p1');
    attachSettlement(engine, 'p2', hexId);
    const farVertexId = Array.from(engine.grid.vertices.keys()).find((id) => {
      const vertex = engine.grid.vertices.get(id);
      return !vertex.building && !vertex.knight && !vertex.hexes.includes(hexId);
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

    assert.throws(() => engine.chaseRobber('p1', vertexId, hexId, 'nobody'), /STEAL_TARGET_REQUIRED/);
    assert.throws(() => engine.chaseRobber('p1', vertexId, hexId, 'p1'), /STEAL_TARGET_REQUIRED/);
    assert.throws(() => engine.chaseRobber('p1', vertexId, hexId, 'p3'), /STEAL_TARGET_REQUIRED/);
    assert.equal(engine.grid.robberHexId, robberBefore);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
  });

  it('rejects a broke adjacent player when another adjacent victim has cards', () => {
    const engine = makeChaseEngine();
    const hexId = destHexId(engine);
    const robberBefore = engine.grid.robberHexId;
    const vertexId = plantChaseKnight(engine, 'p1');
    attachSettlement(engine, 'p2', hexId);
    attachSettlement(engine, 'p3', hexId);
    engine.players[2].resources.ore = 1;

    assert.throws(() => engine.chaseRobber('p1', vertexId, hexId, 'p2'), /STEAL_TARGET_REQUIRED/);
    assert.equal(engine.grid.robberHexId, robberBefore);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
    assert.equal(engine.players[2].resources.ore, 1);
  });

  it('allows skipping steal when no adjacent opponent has cards', () => {
    const engine = makeChaseEngine();
    const hexId = destHexId(engine);
    const vertexId = plantChaseKnight(engine, 'p1');
    attachSettlement(engine, 'p2', hexId);
    attachSettlement(engine, 'p1', hexId);

    const result = engine.chaseRobber('p1', vertexId, hexId, null);
    assert.equal(result.stolenResource, null);
    assert.equal(engine.grid.robberHexId, hexId);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });

  it('steals from a valid adjacent victim and deactivates the knight', () => {
    const engine = makeChaseEngine();
    const hexId = destHexId(engine);
    const vertexId = plantChaseKnight(engine, 'p1');
    attachSettlement(engine, 'p2', hexId);
    engine.players[1].resources.wheat = 1;

    const result = engine.chaseRobber('p1', vertexId, hexId, 'p2');
    assert.equal(result.stolenFrom, 'p2');
    assert.equal(result.stolenResource, 'wheat');
    assert.equal(engine.players[1].resources.wheat, 0);
    assert.equal(engine.players[0].resources.wheat, 1);
    assert.equal(engine.grid.robberHexId, hexId);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
    assert.equal(engine.players[0].knightsPlaced[0].lastActionTurn, engine.turnNumber);
  });

  it('BotAI supplies a stealable target when adjacent victims have cards', () => {
    const engine = makeChaseEngine();
    plantChaseKnight(engine, 'p1');
    const dest = destHexId(engine);
    attachSettlement(engine, 'p2', dest);
    engine.players[1].resources.brick = 2;

    const decision = BotAI.decideCkTurnAction(engine, engine.players[0]);
    assert.equal(decision.action, 'chase_robber');
    const victims = engine.getRobberStealVictims(decision.hexId, 'p1');
    if (victims.length > 0) {
      assert.ok(victims.some((p) => p.id === decision.targetPlayerId));
    }
    assert.doesNotThrow(() =>
      engine.chaseRobber('p1', decision.vertexId, decision.hexId, decision.targetPlayerId)
    );
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
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

    const claimed = engine.applyAqueductBenefit({ p1: {}, p2: { wood: 1 } }, { p1: 'ore' });
    assert.equal(claimed.p1, 'ore');
    engine.clearAqueductRoll();
    engine.hasRolledDice = true;
    engine.dice = [2, 3];
    engine.armAqueductEligibility({ p1: {}, p2: { wood: 1 } });
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
    assert.match(i18n.t(produced.messageKey, produced.args), /Alice received 2 card\(s\)/);
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


