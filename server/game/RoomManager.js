/**
 * RoomManager.js
 * Manages multiplayer game rooms, lobby state, bot lifecycle, and turn timers.
 */

import { GameEngine, GAME_PHASES, GAME_MODES, normalizeGameMode, DISCARD_TIMEOUT_MS } from './GameEngine.js';
import { BotAI } from './BotAI.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

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

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomCode -> Room object
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
    return Boolean(player.reconnectTokenHash && typeof reconnectToken === 'string'
      && createHash('sha256').update(reconnectToken).digest('hex') === player.reconnectTokenHash);
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

    // If room is now empty, destroy it
    if (room.players.filter(p => !p.isBot).length === 0) {
      this.destroyRoom(code);
    }

    return removed;
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

    const mapSize = room.mapSize === 'auto'
      ? (room.players.length <= 4 ? 'standard' : room.players.length <= 6 ? 'extended' : 'large')
      : room.mapSize;

    room.engine.startGame(mapSize);
    room.isStarted = true;

    this.startTurnTimer(room);
    this.checkAndTriggerBotTurn(room);

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
      } else if (engine.phase === GAME_PHASES.TURN_ACTION) {
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

    if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
      const chooserId = engine.pendingMetropolisChoice?.playerId || engine.getCurrentPlayer()?.id;
      const chooser = engine.players.find(p => p.id === chooserId);
      if (chooser && chooser.isBot) {
        setTimeout(() => {
          if (room.isStarted && engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
            try {
              const city = BotAI.chooseCityForMetropolis(engine, chooserId) || engine.getFirstVulnerableCityId?.(chooser) || chooser.citiesBuilt[0];
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
        } else if (engine.phase === GAME_PHASES.TURN_ROBBER) {
          const robAction = BotAI.decideRobberMove(engine, curPlayer);
          engine.moveRobber(curPlayer.id, robAction.hexId, robAction.targetPlayerId);
        } else if (engine.phase === GAME_PHASES.TURN_ACTION) {
          const action = BotAI.decideTurnAction(engine, curPlayer);
          if (action.action === 'end_turn') {
            engine.endTurn(curPlayer.id);
            this.resetTurnTimer(room);
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
        if (engine.phase === GAME_PHASES.TURN_ACTION) {
          try {
            engine.endTurn(curPlayer.id);
            this.resetTurnTimer(room);
            this.broadcastState(room);
            this.checkAndTriggerBotTurn(room);
          } catch (e) {}
        } else if (engine.phase === GAME_PHASES.TURN_ROLL) {
          try {
            engine.rollDice(curPlayer.id);
            this.broadcastState(room);
            this.checkAndTriggerBotTurn(room);
          } catch (e) {}
        }
      }
    }, 900);
  }

  evaluateBotsTrade(room) {
    const engine = room.engine;
    if (!engine.activeTrade) return;

    const proposer = engine.players.find(p => p.id === engine.activeTrade.fromPlayerId);
    const vpTarget = engine.vpTarget || 10;
    // Kingmaking protection: reject trading to a leader who is within 2 VP of victory
    if (proposer && (proposer.victoryPoints || 0) >= vpTarget - 2) {
      return;
    }

    const COMMODITY_KEYS = ['cloth', 'coin', 'paper'];
    const getCardValue = (type) => (COMMODITY_KEYS.includes(type) ? 2.5 : 1.0);

    for (const player of room.players) {
      if (player.isBot && player.id !== engine.activeTrade.fromPlayerId) {
        const botPlayer = engine.players.find(p => p.id === player.id);
        if (!botPlayer) continue;

        let canAfford = true;
        for (const [res, amt] of Object.entries(engine.activeTrade.want)) {
          if (amt > 0 && engine.getPlayerCardCount(botPlayer, res) < amt) {
            canAfford = false;
            break;
          }
        }

        if (canAfford) {
          let giveValue = 0;
          let giveTotal = 0;
          for (const [res, amt] of Object.entries(engine.activeTrade.give)) {
            if (amt > 0) {
              giveTotal += amt;
              giveValue += amt * getCardValue(res);
            }
          }

          let wantValue = 0;
          let wantTotal = 0;
          for (const [res, amt] of Object.entries(engine.activeTrade.want)) {
            if (amt > 0) {
              wantTotal += amt;
              wantValue += amt * getCardValue(res);
            }
          }

          // Reject 1:2 rip-offs (proposer must offer at least as many cards as asked)
          if (giveTotal < wantTotal) continue;

          // Reject commodity milking (value offered must be at least value demanded)
          if (giveValue < wantValue) continue;

          // Bot only gives away cards if it has a comfortable surplus or if the trade is strictly profitable
          const hasSurplus = Object.entries(engine.activeTrade.want).every(([res, amt]) =>
            amt <= 0 || engine.getPlayerCardCount(botPlayer, res) >= amt + 1
          );
          const isProfitable = giveValue > wantValue;

          if (isProfitable || hasSurplus) {
            setTimeout(() => {
              if (room.isStarted && engine.activeTrade && engine.activeTrade.fromPlayerId !== botPlayer.id) {
                try {
                  engine.respondToTrade(botPlayer.id, true);
                  this.broadcastState(room);
                } catch (e) {
                  // ignore
                }
              }
            }, 600);
          }
        }
      }
    }
  }

  broadcastState(room) {
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
    }
    this.rooms.delete(code);
  }
}
