import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomManager,
  validateChatMessage,
  validateDisplayName,
  validatePlayerColor,
  validateRoomName,
  isBotActionAllowed,
  BOT_DISCARD_DELAY_MS,
  BOT_TURN_DELAY_MS
} from '../server/game/RoomManager.js';
import { GAME_PHASES } from '../server/game/GameEngine.js';
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startedTwoPlayerRoom(roomManager, { withBot = false } = {}) {
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
    const { room, guest } = startedTwoPlayerRoom(roomManager);
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
    const { room, guest } = startedTwoPlayerRoom(roomManager);
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
    const { room, guest } = startedTwoPlayerRoom(roomManager);
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
    const { room, guest, bot } = startedTwoPlayerRoom(roomManager, { withBot: true });
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
