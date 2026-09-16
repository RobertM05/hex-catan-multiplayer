/**
 * RoomManager.js
 * Manages multiplayer game rooms, lobby state, bot lifecycle, and turn timers.
 */

import { GameEngine, GAME_PHASES, GAME_MODES, normalizeGameMode, DISCARD_TIMEOUT_MS } from './GameEngine.js';
import { BotAI } from './BotAI.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const DISPLAY_NAME_MAX_LENGTH = 32;
const ROOM_NAME_MAX_LENGTH = 48;
const CHAT_MESSAGE_MAX_LENGTH = 200;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function validateDisplayName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return fallback;
  if (name.length > DISPLAY_NAME_MAX_LENGTH || /[<>]/.test(name)) throw new Error('INVALID_PLAYER_NAME');
  return name;
}

export function validateRoomName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return fallback;
  if (name.length > ROOM_NAME_MAX_LENGTH || /[<>]/.test(name)) throw new Error('INVALID_ROOM_NAME');
  return name;
}

export function validateChatMessage(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > CHAT_MESSAGE_MAX_LENGTH || /[<>]/.test(text)) throw new Error('INVALID_CHAT_MESSAGE');
  return text;
}

export function validatePlayerColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) throw new Error('INVALID_PLAYER_COLOR');
  return value.toLowerCase();
}

export const STALE_ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const STALE_ROOM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class RoomManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map(); // roomCode -> Room object
    this.onRoomDestroyed = typeof options.onRoomDestroyed === 'function'
      ? options.onRoomDestroyed
      : null;
    this.staleRoomMaxAgeMs = options.staleRoomMaxAgeMs ?? STALE_ROOM_MAX_AGE_MS;
    const cleanupMs = options.staleCleanupIntervalMs ?? STALE_ROOM_CLEANUP_INTERVAL_MS;
    this.staleCleanupInterval = null;
    if (cleanupMs > 0) {
      this.staleCleanupInterval = setInterval(() => this.cleanupStaleRooms(), cleanupMs);
      if (typeof this.staleCleanupInterval.unref === 'function') {
        this.staleCleanupInterval.unref();
      }
    }
  }

  touchRoom(room) {
    if (room) room.lastActivity = Date.now();
  }

  cleanupStaleRooms(now = Date.now()) {
    const removed = [];
    for (const [code, room] of this.rooms) {
      const last = room.lastActivity || room.createdAt || 0;
      if (now - last >= this.staleRoomMaxAgeMs) removed.push(code);
    }
    for (const code of removed) this.destroyRoom(code);
    return removed;
  }

  stopStaleCleanup() {
    if (this.staleCleanupInterval) {
      clearInterval(this.staleCleanupInterval);
      this.staleCleanupInterval = null;
    }
  }

  createPlayerSession() {
    const reconnectToken = randomBytes(32).toString('base64url');
    return {
      id: `p_${randomUUID()}`,
      reconnectToken,
      reconnectTokenHash: createHash('sha256').update(reconnectToken).digest('hex')
    };
  }

  matchesReconnectToken(player, reconnectToken) {
    const storedHex = player?.reconnectTokenHash;
    if (typeof storedHex !== 'string' || typeof reconnectToken !== 'string') {
      return false;
    }

    // SHA-256 hex digest is 64 chars / 32 bytes. Wrong size or non-hex fails closed
    // before timingSafeEqual, which throws on unequal lengths.
    if (storedHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(storedHex)) {
      return false;
    }

    const expected = Buffer.from(storedHex, 'hex');
    const actual = createHash('sha256').update(reconnectToken).digest();
    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return this.rooms.has(code) ? this.generateRoomCode() : code;
  }

  createRoom(hostData, options = {}) {
    const code = this.generateRoomCode();
    const mode = normalizeGameMode(options.mode);
    const engine = new GameEngine({
      roomId: code,
      mode,
      vpTarget: options.vpTarget || (mode === GAME_MODES.CITIES_KNIGHTS ? 13 : 10),
      turnDuration: options.turnDuration || 60
    });

    const room = {
      code,
      name: validateRoomName(options.name, `Room ${code}`),
      hostId: hostData.id,
      maxPlayers: Math.max(2, Math.min(8, options.maxPlayers || 4)),
      mode,
      mapSize: options.mapSize || 'auto',
      turnDuration: options.turnDuration || 60,
      vpTarget: engine.vpTarget,
      isStarted: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      players: [], // { id, name, color, isReady, isBot, socketId }
      engine,
      turnTimerInterval: null,
      discardTimer: null,
      turnTimeRemaining: options.turnDuration || 60,
      chatMessages: [],
      pendingAgentSpawns: 0,
      agentSpawnTimestamps: []
    };

    // Add host as first player
    room.players.push({
      id: hostData.id,
      name: validateDisplayName(hostData.name, 'Host Player'),
      color: '#e63946',
      isReady: true,
      isBot: false,
      socketId: hostData.socketId,
      reconnectTokenHash: hostData.reconnectTokenHash || null
    });

    engine.addPlayer({
      id: hostData.id,
      name: validateDisplayName(hostData.name, 'Host Player'),
      color: '#e63946',
      isBot: false
    });

    this.rooms.set(code, room);
    this.touchRoom(room);
    return room;
  }

  getRoom(code) {
    return typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : undefined;
  }

  getPublicRooms() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (!room.isStarted && room.players.length < room.maxPlayers) {
        list.push({
          code: room.code,
          name: room.name,
          playersCount: room.players.length,
          maxPlayers: room.maxPlayers,
          mode: room.mode,
          turnDuration: room.turnDuration,
          hostName: room.players[0] ? room.players[0].name : 'Host'
        });
      }
    }
    return list;
  }

  joinRoom(code, playerData) {
    const room = this.getRoom(code);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    // Check if player is already in the room (by ID or socketId)
    const existing = room.players.find(p => this.matchesReconnectToken(p, playerData.reconnectToken)
      || (playerData.allowLegacyId !== false && (p.id === playerData.id || (p.socketId && playerData.socketId && p.socketId === playerData.socketId))));
    if (existing) {
      existing.socketId = playerData.socketId;
      if (existing.isStandInBot) {
        this.reclaimStandInBot(room, existing);
      }
      this.touchRoom(room);
      return { room, reconnected: playerData.allowLegacyId === false, playerId: existing.id };
    }

    if (room.isStarted) {
      return { error: 'GAME_ALREADY_STARTED' };
    }
    if (room.players.length >= room.maxPlayers) {
      return { error: 'ROOM_FULL' };
    }

    const availableColors = ['#e63946', '#1d3557', '#e76f51', '#2a9d8f', '#9b5de5', '#00b4d8', '#f4a261', '#48cae4'];
    const usedColors = room.players.map(p => p.color);
    const assignedColor = availableColors.find(c => !usedColors.includes(c)) || '#f1faee';

    const playerObj = {
      id: playerData.id || this.createPlayerSession().id,
      name: validateDisplayName(playerData.name, `Player ${room.players.length + 1}`),
      color: assignedColor,
      isReady: false,
      isBot: false,
      socketId: playerData.socketId,
      reconnectTokenHash: playerData.reconnectTokenHash || null
    };

    room.players.push(playerObj);
    room.engine.addPlayer({
      id: playerObj.id,
      name: playerObj.name,
      color: playerObj.color,
      isBot: false
    });

    this.touchRoom(room);
    return { room, reconnected: false, playerId: playerObj.id };
  }

  addBot(code, difficulty = 'medium') {
    const room = this.getRoom(code);
    if (!room || room.isStarted) return null;
    if (room.players.length + (room.pendingAgentSpawns || 0) >= room.maxPlayers) return null;

    const botNames = ['Bot Ada', 'Bot Gauss', 'Bot Euler', 'Bot Turing', 'Bot Pascal', 'Bot Fermat'];
    const existingNames = room.players.map(p => p.name);
    const botName = botNames.find(n => !existingNames.includes(n)) || `Bot ${room.players.length + 1}`;

    const availableColors = ['#e63946', '#1d3557', '#e76f51', '#2a9d8f', '#9b5de5', '#00b4d8', '#f4a261', '#48cae4'];
    const usedColors = room.players.map(p => p.color);
    const assignedColor = availableColors.find(c => !usedColors.includes(c)) || '#a8dadc';

    const botId = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const botPlayer = {
      id: botId,
      name: botName,
      color: assignedColor,
      isReady: true,
      isBot: true,
      botDifficulty: difficulty,
      socketId: null
    };

    room.players.push(botPlayer);
    room.engine.addPlayer({
      id: botPlayer.id,
      name: botPlayer.name,
      color: botPlayer.color,
      isBot: true,
      botDifficulty: difficulty
    });

    return botPlayer;
  }

  removePlayerOrBot(code, id) {
    const room = this.getRoom(code);
    if (!room) return null;

    const pIndex = room.players.findIndex(p => p.id === id);
    if (pIndex === -1) return null;

    const removed = room.players.splice(pIndex, 1)[0];
    room.engine.removePlayer(id);

    // If host left and players remain, promote next human
    if (room.hostId === id && room.players.length > 0) {
      const nextHuman = room.players.find(p => !p.isBot) || room.players[0];
      room.hostId = nextHuman.id;
    }

    // If game has started, update active room state
    if (room.isStarted) {
      if (room.engine.players.length < 2) {
        room.engine.phase = GAME_PHASES.GAME_OVER;
        if (room.turnTimerInterval) clearInterval(room.turnTimerInterval);
      } else {
        this.resetTurnTimer(room);
        this.checkAndTriggerBotTurn(room);
      }
      this.broadcastState(room);
    }

    // Keep in-game rooms if a disconnected human may still rejoin via a stand-in bot.
    const hasHumanOrStandIn = room.players.some(p => !p.isBot || p.isStandInBot);
    if (!hasHumanOrStandIn) {
      this.destroyRoom(code);
    }

    return removed;
  }

  replaceDisconnectedPlayerWithBot(code, playerId) {
    const room = this.getRoom(code);
    if (!room || !room.isStarted) return null;
    const p = room.players.find(x => x.id === playerId);
    if (!p || p.isBot) return null;

    p.isBot = true;
    p.isStandInBot = true;
    p.socketId = null;
    const enginePlayer = room.engine.players.find(x => x.id === playerId);
    if (enginePlayer) enginePlayer.isBot = true;

    this.resetTurnTimer(room);
    this.checkAndTriggerBotTurn(room);
    this.broadcastState(room);
    return p;
  }

  reclaimStandInBot(room, player) {
    player.isBot = false;
    player.isStandInBot = false;
    const enginePlayer = room.engine.players.find(x => x.id === player.id);
    if (enginePlayer) enginePlayer.isBot = false;
  }

  // A socket may act as playerId only while it owns the live human seat.
  // Leave/disconnect replaces the seat with a stand-in bot (socketId cleared);
  // reconnect-token reclaim restores a matching socketId and human control.
  hasActionAuthority(room, playerId, socketId) {
    if (!room || !playerId || !socketId) return false;
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.isBot || player.isStandInBot) return false;
    return player.socketId === socketId;
  }

  setPlayerReady(code, playerId, isReady) {
    const room = this.getRoom(code);
    if (!room || room.isStarted) return false;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.isReady = isReady;
      return true;
    }
    return false;
  }

  setPlayerColor(code, playerId, color) {
    const room = this.getRoom(code);
    if (!room || room.isStarted) return false;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.color = validatePlayerColor(color);
      const engineP = room.engine.players.find(p => p.id === playerId);
      if (engineP) engineP.color = player.color;
      return true;
    }
    return false;
  }

  reserveAgentSpawn(code) {
    const room = this.getRoom(code);
    if (!room || room.isStarted) throw new Error('ROOM_NOT_AVAILABLE');
    const now = Date.now();
    room.agentSpawnTimestamps = room.agentSpawnTimestamps.filter(timestamp => now - timestamp < 60_000);
    if (room.agentSpawnTimestamps.length >= 3) throw new Error('AGENT_SPAWN_RATE_LIMITED');
    if (room.players.length + room.pendingAgentSpawns >= room.maxPlayers) throw new Error('ROOM_FULL');
    room.pendingAgentSpawns += 1;
    room.agentSpawnTimestamps.push(now);
    return room;
  }

  releaseAgentSpawn(code) {
    const room = this.getRoom(code);
    if (room) room.pendingAgentSpawns = Math.max(0, room.pendingAgentSpawns - 1);
  }

  startGame(code, hostPlayerId) {
    const room = this.getRoom(code);
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.hostId !== hostPlayerId) throw new Error('ONLY_HOST_CAN_START');
    if (room.players.length < 2) throw new Error('NEED_AT_LEAST_2_PLAYERS');

    // Auto-ready all bots
    for (const p of room.players) {
      if (p.isBot) p.isReady = true;
    }

    const notReady = room.players.filter(p => !p.isBot && !p.isReady);
    if (notReady.length > 0) {
      throw new Error('PLAYERS_NOT_READY');
    }

    const mapSize = room.mapSize === 'auto'
      ? (room.players.length <= 4 ? 'standard' : room.players.length <= 6 ? 'extended' : 'large')
      : room.mapSize;

    room.engine.startGame(mapSize);
    room.isStarted = true;

    this.startTurnTimer(room);
    this.checkAndTriggerBotTurn(room);
    this.touchRoom(room);

    return room;
  }

  startTurnTimer(room) {
    if (room.turnTimerInterval) clearInterval(room.turnTimerInterval);
    room.turnTimeRemaining = room.turnDuration;

    room.turnTimerInterval = setInterval(() => {
      if (!room.isStarted || room.engine.phase === GAME_PHASES.GAME_OVER) {
        clearInterval(room.turnTimerInterval);
        return;
      }

      room.turnTimeRemaining--;

      this.io.to(room.code).emit('timer_tick', {
        remaining: room.turnTimeRemaining,
        duration: room.turnDuration
      });

      if (room.turnTimeRemaining <= 0) {
        this.handleTurnTimeout(room);
      }
    }, 1000);
    if (room.turnTimerInterval && typeof room.turnTimerInterval.unref === 'function') {
      room.turnTimerInterval.unref();
    }
  }

  resetTurnTimer(room) {
    room.turnTimeRemaining = room.turnDuration;
  }

  // Schedule the auto discard timeout for humans who must discard after a 7.
  // Bots are handled by checkAndTriggerBotTurn; this covers real players only.
  checkDiscardTimer(room) {
    const engine = room.engine;
    if (engine.phase !== GAME_PHASES.TURN_DISCARD) {
      if (room.discardTimer) {
        clearTimeout(room.discardTimer);
        room.discardTimer = null;
      }
      return;
    }
    if (room.discardTimer) return; // already scheduled

    const humansPending = Array.from(engine.pendingDiscards).filter(id => {
      const p = engine.players.find(x => x.id === id);
      return p && !p.isBot;
    });
    if (humansPending.length === 0) return;

    const waitMs = Math.max(0, (engine.discardDeadline || (Date.now() + DISCARD_TIMEOUT_MS)) - Date.now());
    room.discardTimer = setTimeout(() => {
      room.discardTimer = null;
      try {
        if (room.engine.phase !== GAME_PHASES.TURN_DISCARD) return;
        for (const id of Array.from(room.engine.pendingDiscards)) {
          const p = room.engine.players.find(x => x.id === id);
          if (p && !p.isBot) {
            try {
              room.engine.autoDiscardCards(id);
            } catch (err) {
              console.error('Auto discard error:', err);
            }
          }
        }
        this.broadcastState(room);
        this.checkAndTriggerBotTurn(room);
      } catch (err) {
        console.error('Discard timer error:', err);
      }
    }, waitMs);
    if (typeof room.discardTimer.unref === 'function') {
      room.discardTimer.unref();
    }
  }

  handleTurnTimeout(room) {
    if (!room || !room.isStarted || room.engine.phase === GAME_PHASES.GAME_OVER) return;

    try {
      const engine = room.engine;
      const curPlayer = engine.getCurrentPlayer();
      if (!curPlayer) return;

      if (engine.phase === GAME_PHASES.SETUP_ROUND_1 || engine.phase === GAME_PHASES.SETUP_ROUND_2) {
        // Auto place setup for player
        const botAction = BotAI.decideSetupAction(engine, curPlayer);
        if (botAction) {
          if (botAction.action === 'place_setup_settlement') {
            engine.placeSetupSettlement(curPlayer.id, botAction.vertexId);
          } else if (botAction.action === 'place_setup_road') {
            engine.placeSetupRoad(curPlayer.id, botAction.edgeId);
          }
        }
      } else if (engine.phase === GAME_PHASES.TURN_ROLL) {
        engine.rollDice(curPlayer.id);
        // AFK timeout: auto-pick for humans too so the turn can advance
        BotAI.resolvePendingAqueductClaims(engine, { includeHumans: true });
      } else if (engine.phase === GAME_PHASES.TURN_DISCARD) {
        // Auto discard for any player still pending
        for (const pId of Array.from(engine.pendingDiscards)) {
          const p = engine.players.find(x => x.id === pId);
          if (p) {
            const botDis = BotAI.decideDiscard(engine, p);
            engine.discardCards(pId, botDis.discarded);
          }
        }
        if (engine.phase === GAME_PHASES.TURN_ROBBER) {
          const botRob = BotAI.decideRobberMove(engine, curPlayer);
          if (botRob && botRob.hexId) {
            engine.moveRobber(curPlayer.id, botRob.hexId, botRob.targetPlayerId);
          }
        }
      } else if (engine.phase === GAME_PHASES.TURN_ROBBER) {
        const botRob = BotAI.decideRobberMove(engine, curPlayer);
        if (botRob && botRob.hexId) {
          engine.moveRobber(curPlayer.id, botRob.hexId, botRob.targetPlayerId);
        }
      } else if (engine.phase === GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) {
        for (const pId of Array.from(engine.pendingBarbarianDowngrades)) {
          const p = engine.players.find(x => x.id === pId);
          const cityId = p ? engine.getFirstVulnerableCityId(p) : null;
          if (cityId) engine.downgradeCity(pId, cityId);
        }
      } else if (engine.phase === GAME_PHASES.TURN_BARBARIAN_REWARD) {
        for (const pId of Array.from(engine.pendingBarbarianTieDraws || [])) {
          const p = engine.players.find(x => x.id === pId);
          const deck = p ? BotAI.chooseBarbarianRewardDeck(p) : 'trade';
          engine.chooseBarbarianReward(pId, deck);
        }
      } else if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
        const pending = engine.pendingMetropolisChoice;
        const chooser = pending && engine.players.find(p => p.id === pending.playerId);
        const cityId = chooser ? engine.getFirstVulnerableCityId(chooser) : null;
        if (pending && cityId) {
          engine.chooseMetropolis(pending.playerId, cityId);
        } else {
          engine.pendingMetropolisChoice = null;
          engine.phase = engine.previousPhase || GAME_PHASES.TURN_ACTION;
          engine.previousPhase = null;
        }
      } else if (engine.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
        engine.autoResolveKnightRelocation();
      } else if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
        // AFK humans over the progress-card hand limit cannot endTurn; force the
        // same auto-discard bots already do so the table cannot softlock forever.
        if (engine.phase === GAME_PHASES.TURN_ACTION && engine.isCitiesKnights()) {
          engine.autoDiscardProgressCards(curPlayer.id, (p) => BotAI.decideProgressDiscard(p));
        }
        engine.endTurn(curPlayer.id);
      }

      this.resetTurnTimer(room);
      this.broadcastState(room);
      this.checkAndTriggerBotTurn(room);
    } catch (err) {
      console.error('Error in handleTurnTimeout:', err);
      this.resetTurnTimer(room);
    }
  }

  checkAndTriggerBotTurn(room) {
    const engine = room.engine;
    if (engine.phase === GAME_PHASES.GAME_OVER) return;

    if (engine.pendingAqueductClaims && engine.pendingAqueductClaims.size) {
      const claimed = BotAI.resolvePendingAqueductClaims(engine);
      if (claimed) this.broadcastState(room);
    }

    if (engine.pendingProgressDiscard && engine.pendingProgressDiscard.size) {
      for (const pId of Array.from(engine.pendingProgressDiscard)) {
        const p = engine.players.find(x => x.id === pId);
        if (p && p.isBot) {
          setTimeout(() => {
            if (room.isStarted && engine.pendingProgressDiscard.has(pId)) {
              try {
                const cardId = BotAI.decideProgressDiscard(p);
                if (cardId) engine.discardProgressCard(pId, cardId);
                this.broadcastState(room);
                this.checkAndTriggerBotTurn(room);
              } catch (err) {
                console.error('Bot progress discard error:', err);
              }
            }
          }, 800);
        }
      }
    }

    // Discard phase: check if any bots need to discard
    if (engine.phase === GAME_PHASES.TURN_DISCARD) {
      for (const pId of Array.from(engine.pendingDiscards)) {
        const p = engine.players.find(x => x.id === pId);
        if (p && p.isBot) {
          setTimeout(() => {
            if (room.isStarted && engine.pendingDiscards.has(pId)) {
              try {
                const dis = BotAI.decideDiscard(engine, p);
                engine.discardCards(pId, dis.discarded);
                this.broadcastState(room);
                this.checkAndTriggerBotTurn(room);
              } catch (err) {
                console.error('Bot discard error:', err);
              }
            }
          }, 800);
        }
      }
      return;
    }

    if (engine.phase === GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) {
      for (const pId of Array.from(engine.pendingBarbarianDowngrades)) {
        const p = engine.players.find(x => x.id === pId);
        if (p && p.isBot) {
          setTimeout(() => {
            if (room.isStarted && engine.pendingBarbarianDowngrades.has(pId)) {
              try {
                const city = BotAI.chooseCityToDowngrade(engine, pId) || engine.getFirstVulnerableCityId?.(p) || p.citiesBuilt[0];
                if (city) engine.downgradeCity(pId, city);
                this.broadcastState(room);
                this.checkAndTriggerBotTurn(room);
              } catch (err) {
                console.error('Bot barbarian downgrade error:', err);
              }
            }
          }, 800);
        }
      }
      return;
    }

    if (engine.phase === GAME_PHASES.TURN_BARBARIAN_REWARD) {
      for (const pId of Array.from(engine.pendingBarbarianTieDraws || [])) {
        const p = engine.players.find(x => x.id === pId);
        if (p && p.isBot) {
          setTimeout(() => {
            if (room.isStarted && engine.pendingBarbarianTieDraws?.has(pId)) {
              try {
                const deck = BotAI.chooseBarbarianRewardDeck(p);
                engine.chooseBarbarianReward(pId, deck);
                this.broadcastState(room);
                this.checkAndTriggerBotTurn(room);
              } catch (err) {
                console.error('Bot barbarian reward error:', err);
              }
            }
          }, 800);
        }
      }
      return;
    }

    if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
      const chooserId = engine.pendingMetropolisChoice?.playerId || engine.getCurrentPlayer()?.id;
      const chooser = engine.players.find(p => p.id === chooserId);
      if (chooser && chooser.isBot) {
        setTimeout(() => {
          if (room.isStarted && engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
            try {
              const city = BotAI.chooseCityForMetropolis(engine, chooserId) || engine.getFirstVulnerableCityId?.(chooser);
              if (city) engine.chooseMetropolis(chooserId, city);
              this.broadcastState(room);
              this.checkAndTriggerBotTurn(room);
            } catch (err) {
              console.error('Bot metropolis choice error:', err);
            }
          }
        }, 800);
      }
      return;
    }

    if (engine.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
      const pending = engine.pendingKnightRelocation;
      const chooser = pending && engine.players.find(p => p.id === pending.playerId);
      if (chooser && chooser.isBot) {
        setTimeout(() => {
          if (room.isStarted && engine.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
            try {
              engine.autoResolveKnightRelocation();
              this.broadcastState(room);
              this.checkAndTriggerBotTurn(room);
            } catch (err) {
              console.error('Bot knight relocate error:', err);
            }
          }
        }, 800);
      }
      return;
    }

    const curPlayer = engine.getCurrentPlayer();
    if (!curPlayer || !curPlayer.isBot) return;

    setTimeout(() => {
      if (!room.isStarted || engine.phase === GAME_PHASES.GAME_OVER) return;

      try {
        if (engine.phase === GAME_PHASES.SETUP_ROUND_1 || engine.phase === GAME_PHASES.SETUP_ROUND_2) {
          const setupAction = BotAI.decideSetupAction(engine, curPlayer);
          if (setupAction) {
            if (setupAction.action === 'place_setup_settlement') {
              engine.placeSetupSettlement(curPlayer.id, setupAction.vertexId);
            } else if (setupAction.action === 'place_setup_road') {
              engine.placeSetupRoad(curPlayer.id, setupAction.edgeId);
            }
          }
        } else if (engine.phase === GAME_PHASES.TURN_ROLL) {
          const alchemist = BotAI.decideProgressCardPlay(engine, curPlayer);
          if (alchemist?.action === 'play_progress_card') {
            engine.playProgressCard(curPlayer.id, alchemist.cardId, alchemist.options);
          }
          engine.rollDice(curPlayer.id);
          BotAI.resolvePendingAqueductClaims(engine);
        } else if (engine.phase === GAME_PHASES.TURN_ROBBER) {
          const robAction = BotAI.decideRobberMove(engine, curPlayer);
          engine.moveRobber(curPlayer.id, robAction.hexId, robAction.targetPlayerId);
        } else if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
          if (engine.activeTrade && engine.activeTrade.fromPlayerId === curPlayer.id) {
            if (engine.activeTrade.acceptedBy && engine.activeTrade.acceptedBy.size > 0) {
              const partnerId = Array.from(engine.activeTrade.acceptedBy)[0];
              this.resolveBotTrade(room, partnerId);
              return;
            }
            return;
          }

          const action = BotAI.decideTurnAction(engine, curPlayer);
          if (action.action === 'end_turn') {
            engine.endTurn(curPlayer.id);
            this.resetTurnTimer(room);
          } else if (action.action === 'propose_trade') {
            BotAI.applyTurnAction(engine, curPlayer, action);
            this.broadcastState(room);
            this.evaluateBotsTrade(room);
            this.startBotTradeTimer(room, curPlayer.id);
            return;
          } else {
            BotAI.applyTurnAction(engine, curPlayer, action);
            if (action.action === 'end_turn') this.resetTurnTimer(room);
          }
        }

        this.broadcastState(room);
        // Chain next bot step if needed
        this.checkAndTriggerBotTurn(room);
      } catch (err) {
        console.error('Bot turn execution error:', err);
        // Fallback: try ending turn if stuck in action
        if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
          try {
            engine.endTurn(curPlayer.id);
            this.resetTurnTimer(room);
            this.broadcastState(room);
            this.checkAndTriggerBotTurn(room);
          } catch (e) {}
        } else if (engine.phase === GAME_PHASES.TURN_ROLL) {
          try {
            engine.rollDice(curPlayer.id);
            BotAI.resolvePendingAqueductClaims(engine);
            this.broadcastState(room);
            this.checkAndTriggerBotTurn(room);
          } catch (e) {}
        }
      }
    }, 900);
  }

  startBotTradeTimer(room, botPlayerId) {
    if (room.botTradeTimer) {
      clearTimeout(room.botTradeTimer);
      room.botTradeTimer = null;
    }
    room.botTradeTimer = setTimeout(() => {
      room.botTradeTimer = null;
      const engine = room.engine;
      if (room.isStarted && engine.activeTrade && engine.activeTrade.fromPlayerId === botPlayerId) {
        if (engine.activeTrade.acceptedBy && engine.activeTrade.acceptedBy.size > 0) {
          const partnerId = Array.from(engine.activeTrade.acceptedBy)[0];
          this.resolveBotTrade(room, partnerId);
        } else {
          try {
            engine.cancelTrade(botPlayerId);
          } catch (e) {}
          this.broadcastState(room);
          this.checkAndTriggerBotTurn(room);
        }
      }
    }, 6000);
  }

  resolveBotTrade(room, partnerId) {
    if (room.botTradeTimer) {
      clearTimeout(room.botTradeTimer);
      room.botTradeTimer = null;
    }
    if (room.isResolvingBotTrade) return;
    room.isResolvingBotTrade = true;

    setTimeout(() => {
      room.isResolvingBotTrade = false;
      const engine = room.engine;
      if (!room.isStarted || !engine.activeTrade) return;

      const proposerId = engine.activeTrade.fromPlayerId;
      try {
        engine.confirmTrade(proposerId, partnerId);
      } catch (err) {
        console.warn('Bot trade confirmation failed:', err.message);
      }

      this.broadcastState(room);
      this.checkAndTriggerBotTurn(room);
    }, 400);
  }

  checkBotTradeDeclines(room) {
    const engine = room.engine;
    if (!engine.activeTrade) return;
    const proposer = engine.players.find(p => p.id === engine.activeTrade.fromPlayerId);
    if (!proposer?.isBot) return;

    const otherPlayers = engine.players.filter(p => p.id !== proposer.id);
    const allDeclinedOrUnviable = otherPlayers.every(p => {
      const hasDeclined = engine.activeTrade.declinedBy?.has(p.id);
      const canAfford = Object.entries(engine.activeTrade.want).every(
        ([res, amt]) => engine.getPlayerCardCount(p, res) >= amt
      );
      return hasDeclined || !canAfford;
    });

    if (allDeclinedOrUnviable) {
      if (room.botTradeTimer) {
        clearTimeout(room.botTradeTimer);
        room.botTradeTimer = null;
      }
      setTimeout(() => {
        if (room.isStarted && engine.activeTrade && engine.activeTrade.fromPlayerId === proposer.id) {
          try {
            engine.cancelTrade(proposer.id);
          } catch (e) {}
          this.broadcastState(room);
          this.checkAndTriggerBotTurn(room);
        }
      }, 300);
    }
  }

  evaluateBotsTrade(room) {
    const engine = room.engine;
    if (!engine.activeTrade) return;

    for (const player of room.players) {
      if (player.isBot && player.id !== engine.activeTrade.fromPlayerId) {
        const botPlayer = engine.players.find(p => p.id === player.id);
        if (!botPlayer) continue;

        if (BotAI.canBotAcceptTrade(engine, botPlayer, engine.activeTrade)) {
          setTimeout(() => {
            if (room.isStarted && engine.activeTrade && engine.activeTrade.fromPlayerId !== botPlayer.id) {
              try {
                engine.respondToTrade(botPlayer.id, true);
                this.broadcastState(room);
                const proposer = engine.players.find(p => p.id === engine.activeTrade.fromPlayerId);
                if (proposer?.isBot) {
                  this.resolveBotTrade(room, botPlayer.id);
                }
              } catch (e) {
                // ignore
              }
            }
          }, 600);
        } else {
          if (engine.activeTrade.declinedBy) {
            engine.activeTrade.declinedBy.add(botPlayer.id);
          }
        }
      }
    }
  }

  broadcastState(room) {
    this.touchRoom(room);
    const seenSockets = new Set();
    for (const player of room.players) {
      if (player.socketId && !seenSockets.has(player.socketId)) {
        seenSockets.add(player.socketId);
        const state = room.engine.getStateForPlayer(player.id);
        this.io.to(player.socketId).emit('game_state_update', {
          state,
          room: {
            code: room.code,
            name: room.name,
            hostId: room.hostId,
            turnDuration: room.turnDuration,
            turnTimeRemaining: room.turnTimeRemaining,
            players: room.players
          }
        });
      }
    }
  }

  broadcastLobbyState(room) {
    this.touchRoom(room);
    this.io.to(room.code).emit('lobby_state_update', {
      code: room.code,
      name: room.name,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      mode: room.mode,
      turnDuration: room.turnDuration,
      vpTarget: room.vpTarget,
      isStarted: room.isStarted,
      players: room.players
    });
  }

  destroyRoom(code) {
    const room = this.rooms.get(code);
    if (room) {
      if (room.turnTimerInterval) clearInterval(room.turnTimerInterval);
      if (room.discardTimer) clearTimeout(room.discardTimer);
      if (room.botTradeTimer) clearTimeout(room.botTradeTimer);
    }
    this.rooms.delete(code);
    if (this.onRoomDestroyed) this.onRoomDestroyed(code);
  }
}
