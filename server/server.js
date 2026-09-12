/**
 * server.js
 * Main entry point for Hexagonal Strategy Game backend.
 * Serves static assets and provides Socket.IO real-time gameplay synchronization.
 */

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { RoomManager } from './game/RoomManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const roomManager = new RoomManager(io);
const spawnedAgents = new Map(); // roomCode -> childProcess[]

export function spawnAgentProcess(roomCode, agentName = 'AI-Agent') {
  const code = roomCode.toUpperCase();
  const scriptPath = path.join(__dirname, '..', 'scripts', 'aiAgentClient.js');
  const addr = server.address();
  const port = (addr && typeof addr === 'object' && addr.port) ? addr.port : (process.env.PORT || 3000);
  const child = fork(scriptPath, [
    '--server', `http://localhost:${port}`,
    '--room', code,
    '--name', agentName
  ], {
    detached: false
  });

  if (!spawnedAgents.has(code)) {
    spawnedAgents.set(code, []);
  }
  spawnedAgents.get(code).push(child);

  child.on('exit', () => {
    const list = spawnedAgents.get(code) || [];
    const filtered = list.filter(c => c !== child);
    if (filtered.length > 0) spawnedAgents.set(code, filtered);
    else spawnedAgents.delete(code);
  });

  return child;
}

app.use(express.static(publicDir, {
  setHeaders: (res) => {
    // Prevent stale clients after deploys: always revalidate HTML and JS
    res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use(express.json());

// API: Health check and telemetry
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    },
    activeRooms: roomManager.rooms ? roomManager.rooms.size : 0
  });
});

// API: List public rooms
app.get('/api/rooms', (req, res) => {
  res.json(roomManager.getPublicRooms());
});

// API: Spawn external AI agent into a room
app.post('/api/rooms/:code/spawn-agent', (req, res) => {
  try {
    const roomCode = req.params.code.toUpperCase();
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ success: false, error: 'ROOM_NOT_FOUND' });
    if (room.isStarted) return res.status(400).json({ success: false, error: 'GAME_ALREADY_STARTED' });
    if (room.players.length >= room.maxPlayers) return res.status(400).json({ success: false, error: 'ROOM_FULL' });

    const name = req.body?.name || `Agent-${Math.floor(1000 + Math.random() * 9000)}`;
    const child = spawnAgentProcess(roomCode, name);
    res.json({ success: true, roomCode, name, pid: child?.pid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Socket.IO event handler
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  socket.on('create_room', (data, callback) => {
    try {
      const playerId = data.playerId || `p_${socket.id.substring(0, 6)}`;
      const room = roomManager.createRoom(
        { id: playerId, name: data.hostName || 'Host', socketId: socket.id },
        {
          name: data.roomName,
          mode: data.mode,
          maxPlayers: data.maxPlayers,
          turnDuration: data.turnDuration,
          mapSize: data.mapSize,
          vpTarget: data.vpTarget
        }
      );

      currentRoomCode = room.code;
      currentPlayerId = playerId;
      socket.join(room.code);

      if (callback) callback({ success: true, roomCode: room.code, playerId });
      roomManager.broadcastLobbyState(room);
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('join_room', (data, callback) => {
    try {
      const playerId = data.playerId || `p_${socket.id.substring(0, 6)}`;
      const roomCode = data.code || data.roomCode;
      const result = roomManager.joinRoom(roomCode, {
        id: playerId,
        name: data.playerName,
        socketId: socket.id
      });

      if (result.error) {
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      const room = result.room;
      currentRoomCode = room.code;
      currentPlayerId = playerId;
      socket.join(room.code);

      if (callback) callback({ success: true, roomCode: room.code, playerId, isStarted: room.isStarted });

      if (room.isStarted) {
        roomManager.broadcastState(room);
      } else {
        roomManager.broadcastLobbyState(room);
      }
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('add_bot', (data, callback) => {
    try {
      const bot = roomManager.addBot(data.code, data.difficulty);
      const room = roomManager.getRoom(data.code);
      if (room) {
        roomManager.broadcastLobbyState(room);
        if (callback) callback({ success: true, bot });
      }
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('spawn_ai_agent', (data, callback) => {
    try {
      const roomCode = (data && (data.code || data.roomCode)) || currentRoomCode;
      if (!roomCode) throw new Error('ROOM_CODE_REQUIRED');
      const room = roomManager.getRoom(roomCode);
      if (!room) throw new Error('ROOM_NOT_FOUND');
      if (room.isStarted) throw new Error('GAME_ALREADY_STARTED');
      if (room.players.length >= room.maxPlayers) throw new Error('ROOM_FULL');

      const agentNames = ['AlphaSettler', 'DeepHex', 'ClaudeBot', 'GeminiKnight', 'SnighiBot', 'HexMaster'];
      const existingNames = room.players.map(p => p.name);
      const name = (data && data.name) || agentNames.find(n => !existingNames.includes(n)) || `Agent-${Math.floor(1000 + Math.random() * 9000)}`;

      const child = spawnAgentProcess(roomCode, name);
      if (callback) callback({ success: true, name, pid: child?.pid });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('remove_player', (data, callback) => {
    try {
      const room = roomManager.getRoom(data.code);
      if (room && (room.hostId === currentPlayerId || data.id === currentPlayerId)) {
        roomManager.removePlayerOrBot(data.code, data.id);
        const updated = roomManager.getRoom(data.code);
        if (updated) {
          roomManager.broadcastLobbyState(updated);
        }
        if (callback) callback({ success: true });
      }
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('set_ready', (data, callback) => {
    const code = (data && (data.code || data.roomCode));
    const ok = roomManager.setPlayerReady(code, currentPlayerId, data.isReady);
    if (ok) {
      const room = roomManager.getRoom(code);
      roomManager.broadcastLobbyState(room);
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false });
    }
  });

  socket.on('set_color', (data) => {
    const ok = roomManager.setPlayerColor(data.code, currentPlayerId, data.color);
    if (ok) {
      const room = roomManager.getRoom(data.code);
      roomManager.broadcastLobbyState(room);
    }
  });

  socket.on('start_game', (data, callback) => {
    try {
      const room = roomManager.startGame(data.code, currentPlayerId);
      io.to(room.code).emit('game_started', { code: room.code });
      roomManager.broadcastState(room);
      if (callback) callback({ success: true });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('send_chat', (data) => {
    const roomCode = currentRoomCode || data.code;
    if (!roomCode || (currentRoomCode && data.code && currentRoomCode !== data.code)) return;
    const room = roomManager.getRoom(roomCode);
    if (room && data.text) {
      const sender = room.players.find(p => p.id === currentPlayerId) || { name: 'Player' };
      const chatMsg = {
        id: `chat_${Date.now()}`,
        senderId: currentPlayerId,
        senderName: sender.name,
        color: sender.color,
        text: data.text.trim().substring(0, 200),
        timestamp: Date.now()
      };
      room.chatMessages.push(chatMsg);
      if (room.chatMessages.length > 50) room.chatMessages.shift();
      io.to(room.code).emit('chat_received', chatMsg);
    }
  });

  /* =========================================================
   * IN-GAME TURNS & ACTIONS
   * ========================================================= */

  const handleGameAction = (code, actionFn, callback) => {
    const roomCode = currentRoomCode || code;
    if (!roomCode || (currentRoomCode && code && currentRoomCode !== code)) {
      if (callback) callback({ success: false, error: 'ROOM_MISMATCH' });
      return;
    }
    const room = roomManager.getRoom(roomCode);
    if (!room || !room.isStarted) {
      if (callback) callback({ success: false, error: 'ROOM_NOT_ACTIVE' });
      return;
    }

    try {
      const result = actionFn(room.engine);
      roomManager.resetTurnTimer(room);
      roomManager.broadcastState(room);
      roomManager.checkAndTriggerBotTurn(room);
      roomManager.checkDiscardTimer(room);
      if (callback) callback({ success: true, ...result });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  };

  socket.on('place_setup_settlement', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.placeSetupSettlement(currentPlayerId, data.vertexId), cb);
  });

  socket.on('place_setup_road', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.placeSetupRoad(currentPlayerId, data.edgeId), cb);
  });

  socket.on('roll_dice', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.rollDice(currentPlayerId), cb);
  });

  socket.on('discard_cards', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.discardCards(currentPlayerId, data.discarded), cb);
  });

  socket.on('move_robber', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.moveRobber(currentPlayerId, data.hexId, data.targetPlayerId), cb);
  });

  socket.on('build_road', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.buildRoad(currentPlayerId, data.edgeId), cb);
  });

  socket.on('build_settlement', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.buildSettlement(currentPlayerId, data.vertexId), cb);
  });

  socket.on('build_city', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.buildCity(currentPlayerId, data.vertexId), cb);
  });

  socket.on('build_city_wall', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.buildCityWall(currentPlayerId, data.vertexId), cb);
  });

  socket.on('improve_city', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.improveCityTrack(currentPlayerId, data.track), cb);
  });

  socket.on('choose_metropolis', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.chooseMetropolis(currentPlayerId, data.vertexId), cb);
  });

  socket.on('place_knight', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.placeKnight(currentPlayerId, data.vertexId), cb);
  });

  socket.on('activate_knight', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.activateKnight(currentPlayerId, data.vertexId), cb);
  });

  socket.on('promote_knight', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.promoteKnight(currentPlayerId, data.vertexId), cb);
  });

  socket.on('move_knight', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.moveKnight(currentPlayerId, data.fromVertexId, data.toVertexId), cb);
  });

  socket.on('relocate_displaced_knight', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.relocateDisplacedKnight(currentPlayerId, data.vertexId), cb);
  });

  socket.on('chase_robber', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.chaseRobber(currentPlayerId, data.vertexId, data.hexId, data.targetPlayerId), cb);
  });

  socket.on('downgrade_city', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.downgradeCity(currentPlayerId, data.vertexId), cb);
  });

  socket.on('buy_dev_card', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.buyDevCard(currentPlayerId), cb);
  });

  socket.on('play_dev_card', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.playDevCard(currentPlayerId, data.cardId, data.options), cb);
  });

  socket.on('play_progress_card', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.playProgressCard(currentPlayerId, data.cardId, data.options), cb);
  });

  socket.on('discard_progress_card', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.discardProgressCard(currentPlayerId, data.cardId), cb);
  });

  socket.on('bank_trade', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.tradeWithBank(currentPlayerId, data.give, data.receive, data.ratio), cb);
  });

  socket.on('propose_trade', (data, cb) => {
    handleGameAction(data.code, (engine) => {
      const trade = engine.proposeTrade(currentPlayerId, data.give, data.want);
      const room = roomManager.getRoom(currentRoomCode || data.code);
      if (room) {
        roomManager.evaluateBotsTrade(room);
      }
      return trade;
    }, cb);
  });

  socket.on('respond_trade', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.respondToTrade(currentPlayerId, data.accept), cb);
  });

  socket.on('confirm_trade', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.confirmTrade(currentPlayerId, data.targetPlayerId), cb);
  });

  socket.on('cancel_trade', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.cancelTrade(currentPlayerId), cb);
  });

  socket.on('leave_room', (data, cb) => {
    const code = currentRoomCode || (data && data.code);
    if (code && currentPlayerId) {
      const room = roomManager.getRoom(code);
      if (room) {
        roomManager.removePlayerOrBot(code, currentPlayerId);
        socket.leave(code);
        currentRoomCode = null;
        if (!room.isStarted) {
          roomManager.broadcastLobbyState(room);
        }
      }
    }
    if (cb) cb({ success: true });
  });

  socket.on('end_turn', (data, cb) => {
    handleGameAction(data.code, (engine) => engine.endTurn(currentPlayerId), cb);
  });

  socket.on('disconnect', () => {
    if (currentRoomCode && currentPlayerId) {
      const room = roomManager.getRoom(currentRoomCode);
      if (room) {
        const pId = currentPlayerId;
        const code = currentRoomCode;
        const player = room.players.find(p => p.id === pId);
        if (player) {
          player.socketId = null;
        }

        if (!room.isStarted) {
          // In lobby: immediately remove player so empty spot shows up
          roomManager.removePlayerOrBot(code, pId);
          roomManager.broadcastLobbyState(room);
        } else {
          // In an active game: give 10s grace period for page refresh, then remove if still disconnected
          setTimeout(() => {
            const curRoom = roomManager.getRoom(code);
            if (curRoom && curRoom.isStarted) {
              const p = curRoom.players.find(x => x.id === pId);
              if (p && !p.socketId && !p.isBot) {
                console.log(`Player ${p.name} (${pId}) disconnected permanently, removing from game.`);
                roomManager.removePlayerOrBot(code, pId);
              }
            }
          }, 10000);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  server.listen(PORT, () => {
    console.log(`Hexagonal Strategy Game Server running on http://localhost:${PORT}`);
  });
}

export { app, server, io, roomManager };
