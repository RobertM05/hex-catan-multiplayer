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
import { RoomManager, validateChatMessage, validateDisplayName } from './game/RoomManager.js';
import { requireAdminAuth } from './adminAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', true);
app.set('json spaces', 2);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : false }
});

const spawnedAgents = new Map(); // roomCode -> childProcess[]

export function killSpawnedAgentsForRoom(roomCode) {
  const code = String(roomCode || '').toUpperCase();
  if (!code) return;
  const list = spawnedAgents.get(code) || [];
  for (const child of list) {
    try {
      if (child && typeof child.kill === 'function' && !child.killed) {
        child.kill('SIGTERM');
      }
    } catch {
      // Best-effort teardown; room is already going away.
    }
  }
  spawnedAgents.delete(code);
}

const roomManager = new RoomManager(io, {
  onRoomDestroyed: killSpawnedAgentsForRoom
});

// --- Real-time IP & Traffic Telemetry Infrastructure ---
export const MAX_TRAFFIC_LOGS = 200;
export const TRAFFIC_LIMITS = {
  uniqueIps: 5000,
  playerIps: 1000
};
export const trafficBuffer = [];
export const trafficStats = {
  totalHttpRequests: 0,
  totalSocketPackets: 0,
  uniqueIps: new Set(),
  activeSockets: new Map(), // socketId -> { id, ip, country, connectedAt, lastSeen, roomCode, playerName }
  playerIps: new Map() // playerName -> { name, ip, ips: Set, country, roomCode, firstSeen, lastSeen, actionCount }
};

function evictOldestUniqueIp() {
  const oldest = trafficStats.uniqueIps.values().next().value;
  if (oldest !== undefined) trafficStats.uniqueIps.delete(oldest);
}

function evictOldestPlayerIp() {
  let oldestKey = null;
  let oldestTs = Infinity;
  for (const [key, entry] of trafficStats.playerIps) {
    const ts = Date.parse(entry.lastSeen) || 0;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestKey = key;
    }
  }
  if (oldestKey != null) trafficStats.playerIps.delete(oldestKey);
}

export function trackUniqueIp(ip) {
  if (!ip || ip === 'unknown') return;
  if (trafficStats.uniqueIps.has(ip)) {
    trafficStats.uniqueIps.delete(ip);
    trafficStats.uniqueIps.add(ip);
    return;
  }
  while (trafficStats.uniqueIps.size >= TRAFFIC_LIMITS.uniqueIps) {
    evictOldestUniqueIp();
  }
  trafficStats.uniqueIps.add(ip);
}

export function recordPlayerIp(name, ip, country = null, roomCode = null) {
  if (!name || !ip || ip === 'unknown') return null;
  if (!trafficStats.playerIps.has(name)) {
    while (trafficStats.playerIps.size >= TRAFFIC_LIMITS.playerIps) {
      evictOldestPlayerIp();
    }
  }
  const existing = trafficStats.playerIps.get(name) || {
    name,
    ip,
    country: country || null,
    ips: new Set(),
    roomCode: roomCode || null,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    actionCount: 0
  };
  existing.ip = ip;
  if (country) existing.country = country;
  if (roomCode) existing.roomCode = roomCode;
  existing.ips.add(ip);
  existing.lastSeen = new Date().toISOString();
  existing.actionCount++;
  trafficStats.playerIps.set(name, existing);
  return existing;
}

export function extractClientIp(reqOrSocket) {
  const headers = reqOrSocket.headers || reqOrSocket.handshake?.headers || {};
  const cfConnectingIp = headers['cf-connecting-ip'];
  if (cfConnectingIp && typeof cfConnectingIp === 'string') return cfConnectingIp.trim();

  const xRealIp = headers['x-real-ip'];
  if (xRealIp && typeof xRealIp === 'string') return xRealIp.trim();

  const xForwardedFor = headers['x-forwarded-for'];
  if (xForwardedFor && typeof xForwardedFor === 'string') {
    const first = xForwardedFor.split(',')[0].trim();
    if (first) return first;
  }

  const raw = reqOrSocket.ip || reqOrSocket.connection?.remoteAddress || reqOrSocket.socket?.remoteAddress || reqOrSocket.handshake?.address;
  if (!raw) return 'unknown';
  return String(raw).replace(/^::ffff:/, '');
}

export function extractClientCountry(reqOrSocket) {
  const headers = reqOrSocket.headers || reqOrSocket.handshake?.headers || {};
  return headers['cf-ipcountry'] || null;
}

export function capitalizeWord(s) {
  if (!s || typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

export function formatEventStory(e) {
  if (!e) return '';
  const p = e.playerName || 'Player';

  switch (e.type) {
    case 'ACTION_SUCCESS': {
      switch (e.action) {
        case 'roll_dice':
          if (e.dice) {
            const extra = e.eventDie ? ` (Event Die: ${capitalizeWord(e.eventDie)}, Barbarians: ${e.barbarianPosition ?? '?'}/7)` : '';
            return `🎲 ${p} rolled [${e.dice.d1}, ${e.dice.d2}] = ${e.dice.sum}${extra}`;
          }
          return `🎲 ${p} rolled the dice`;
        case 'build_settlement':
        case 'place_setup_settlement':
          return `🏠 ${p} built a Settlement at intersection #${e.vertexId ?? '?'}`;
        case 'build_city':
        case 'upgrade_city':
        case 'place_setup_city':
          return `🏛️ ${p} upgraded Settlement to City at intersection #${e.vertexId ?? '?'}`;
        case 'build_road':
        case 'place_setup_road':
          return `🛣️ ${p} paved a Road on path #${e.edgeId ?? '?'}`;
        case 'build_city_wall':
          return `🛡️ ${p} fortified City with a Wall at intersection #${e.vertexId ?? '?'}`;
        case 'improve_city':
          return `📈 ${p} upgraded City Improvement: ${capitalizeWord(e.track || 'Track')}`;
        case 'place_knight':
          return `⚔️ ${p} hired a Knight at intersection #${e.vertexId ?? '?'}`;
        case 'activate_knight':
          return `✨ ${p} activated Knight at intersection #${e.vertexId ?? '?'}`;
        case 'promote_knight':
          return `🎖️ ${p} promoted Knight at intersection #${e.vertexId ?? '?'}`;
        case 'move_knight':
          return `🏇 ${p} moved Knight from intersection #${e.fromVertexId ?? '?'} to #${e.toVertexId ?? '?'}`;
        case 'relocate_displaced_knight':
        case 'relocate_knight':
          return `🏇 ${p} relocated displaced Knight to intersection #${e.vertexId ?? '?'}`;
        case 'chase_robber':
          return `🏃 ${p} chased Robber with Knight to Hex #${e.hexId ?? '?'}`;
        case 'move_robber':
          return `🥷 ${p} moved Robber to Hex #${e.hexId ?? '?'}${e.targetName ? ` and robbed ${e.targetName}` : ''}`;
        case 'discard_cards':
          return `📤 ${p} discarded cards after 7 was rolled`;
        case 'bank_trade':
          return `⚖️ ${p} traded with Bank: ${e.ratio || 4}x ${capitalizeWord(e.give || 'resource')} for 1x ${capitalizeWord(e.receive || 'resource')}`;
        case 'buy_dev_card':
          return `🃏 ${p} purchased a Development Card`;
        case 'play_dev_card':
          return `🎴 ${p} played Dev Card: ${capitalizeWord(e.cardId || e.cardType || 'card')}`;
        case 'play_progress_card':
          return `📜 ${p} played Progress Card: ${capitalizeWord(e.cardId || e.cardType || 'card')}`;
        case 'claim_aqueduct_resource':
          return `💧 ${p} claimed Aqueduct resource: ${capitalizeWord(e.resource || 'resource')}`;
        case 'choose_metropolis':
          return `👑 ${p} placed Metropolis on City #${e.vertexId ?? '?'}`;
        case 'choose_barbarian_reward':
          return `🎁 ${p} chose Barbarian Defender Progress Card (${capitalizeWord(e.deck || 'deck')})`;
        case 'propose_trade':
          return `🤝 ${p} proposed a trade offer`;
        case 'respond_trade':
          return `💬 ${p} responded to trade offer`;
        case 'confirm_trade':
          return `✅ ${p} completed trade with ${e.targetName || 'partner'}`;
        case 'cancel_trade':
          return `❌ ${p} cancelled trade offer`;
        case 'end_turn':
          return `⌛ ${p} ended turn (Turn ${e.turn ?? '?'})`;
        default:
          return `⚡ ${p} performed "${e.action}"`;
      }
    }
    case 'ACTION_ERROR':
      return `⚠️ ${p} attempted "${e.action}" but was rejected: ${e.error}`;
    case 'ROOM_CREATE':
      return `🏠 Host "${e.hostName || p}" created room [${e.roomCode}] (${e.mode || 'base'} mode)`;
    case 'ROOM_JOIN':
      return `👋 "${e.playerName || p}" joined room [${e.roomCode}]`;
    case 'ROOM_JOIN_ERROR':
      return `🚫 "${e.playerName || p}" failed to join [${e.roomCode}]: ${e.error}`;
    case 'CHAT_MESSAGE':
      return `💬 ${p}: "${e.text}"`;
    case 'GAME_START':
      return `▶️ Game started in [${e.roomCode}] by "${e.startedBy}" (${e.mode || 'base'} mode)`;
    case 'GAME_OVER':
      return `🏆 Game Over in [${e.roomCode}]: ${e.winnerName} won with ${e.winnerPoints} Victory Points!`;
    case 'SOCKET_CONNECT':
      return `🔌 Client connected from ${e.ip} [${e.country || '?'}]`;
    case 'SOCKET_DISCONNECT':
      return `🔌 Client disconnected ${e.playerName ? `(${e.playerName})` : ''} ${e.details || ''}`.trim();
    case 'SOCKET_PACKET':
      if (e.event === 'send_chat') {
        const msg = e.details?.match(/^\(Msg: "(.*)"\)$/)?.[1] || e.details || '';
        return `💬 ${p}: "${msg}"`;
      }
      if (e.event === 'join_room') return `🚪 ${p} joined Room ${e.roomCode || ''}`;
      if (e.event === 'create_room') return `🏰 ${p} created Room`;
      if (e.event === 'roll_dice') return `🎲 ${p} requested dice roll`;
      if (e.event === 'end_turn') return `⌛ ${p} requested end turn`;
      return `📦 ${p} sent packet "${e.event}" ${e.details || ''}`;
    case 'HTTP':
      return `🌐 HTTP ${e.method} ${e.url} - ${e.status} (${e.durationMs}ms)`;
    default:
      return `${e.type}: ${e.details || ''}`;
  }
}

export function recordTrafficEvent(entry) {
  if (!entry.playerName && entry.socketId && trafficStats.activeSockets.has(entry.socketId)) {
    const s = trafficStats.activeSockets.get(entry.socketId);
    if (s?.playerName) entry.playerName = s.playerName;
  }
  if (entry.playerName && entry.ip) {
    recordPlayerIp(entry.playerName, entry.ip, entry.country, entry.roomCode);
  }

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry
  };
  record.story = entry.story || formatEventStory(record);
  trafficBuffer.push(record);
  if (trafficBuffer.length > MAX_TRAFFIC_LOGS) {
    trafficBuffer.shift();
  }
  if (entry.ip && entry.ip !== 'unknown') {
    trackUniqueIp(entry.ip);
  }
  return record;
}

export function summarizePacketPayload(event, data) {
  if (!data || typeof data !== 'object') return '';
  try {
    if (event === 'join_room') {
      return `(Room: ${data.code || data.roomCode || '?'}, Player: ${data.playerName || '?'})`;
    }
    if (event === 'create_room') {
      return `(Room: ${data.roomName || '?'}, Host: ${data.hostName || '?'}, Mode: ${data.mode || 'base'})`;
    }
    if (event === 'send_chat') {
      const msg = typeof data.message === 'string' ? data.message.slice(0, 35) : '';
      return `(Msg: "${msg}")`;
    }
    if (event === 'propose_trade') {
      return `(Give: ${JSON.stringify(data.give || {})}, Get: ${JSON.stringify(data.get || {})})`;
    }
    const copy = { ...data };
    delete copy.reconnectToken;
    delete copy.reconnectTokenHash;
    const str = JSON.stringify(copy);
    return str.length > 70 ? str.slice(0, 67) + '...' : str;
  } catch {
    return '';
  }
}

// HTTP request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const ip = extractClientIp(req);
  const country = extractClientCountry(req);
  const countryTag = country ? `[${country}]` : '';

  trafficStats.totalHttpRequests++;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const url = req.originalUrl || req.url;
    const isStatic = url.startsWith('/css/') || url.startsWith('/js/') || url.startsWith('/assets/') || url.startsWith('/sounds/') || url.endsWith('.ico') || url.endsWith('.png') || url.endsWith('.svg');

    const isClearReq = url.startsWith('/api/admin/traffic/clear') || url.startsWith('/api/admin/traffic/reset') || (req.method === 'DELETE' && url.startsWith('/api/admin/traffic'));
    if (!isClearReq) {
      recordTrafficEvent({
        type: 'HTTP',
        method: req.method,
        url,
        ip,
        country,
        status: res.statusCode,
        durationMs: duration
      });
    }

    const timeStr = new Date().toLocaleTimeString();
    if (!isStatic || res.statusCode >= 400 || url === '/' || url.startsWith('/api')) {
      console.log(`[${timeStr}] [HTTP] ${ip} ${countryTag} ${req.method} ${url} - ${res.statusCode} (${duration}ms)`);
    }
  });

  next();
});

export function spawnAgentProcess(roomCode, agentName = 'AI-Agent') {
  const code = roomCode.toUpperCase();
  const scriptPath = path.join(__dirname, '..', 'scripts', 'aiAgentClient.js');
  const addr = server.address();
  const port = (addr && typeof addr === 'object' && addr.port) ? addr.port : (process.env.PORT || 3000);
  const child = fork(scriptPath, [
    '--server', `http://localhost:${port}`,
    '--room', code,
    '--name', agentName,
    '--spawned-agent'
  ], {
    detached: false
  });

  if (!spawnedAgents.has(code)) {
    spawnedAgents.set(code, []);
  }
  spawnedAgents.get(code).push(child);

  child.on('exit', () => {
    roomManager.releaseAgentSpawn(code);
    const list = spawnedAgents.get(code) || [];
    const filtered = list.filter(c => c !== child);
    if (filtered.length > 0) spawnedAgents.set(code, filtered);
    else spawnedAgents.delete(code);
  });

  return child;
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(requireAdminAuth);
app.use(express.static(publicDir, {
  setHeaders: (res) => {
    // Prevent stale clients after deploys: always revalidate HTML and JS
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// Liveness/readiness for orchestrators (`/health`) and existing admin/telemetry (`/api/health`)
function healthPayload() {
  return {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    },
    activeRooms: roomManager.rooms ? roomManager.rooms.size : 0
  };
}

app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json(healthPayload());
});

// API: List public rooms
app.get('/api/rooms', (req, res) => {
  res.json(roomManager.getPublicRooms());
});

// Admin UI Dashboard
app.get(['/admin', '/admin/traffic'], (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// API: Real-time IP & Traffic Telemetry
app.get('/api/admin/traffic', (req, res) => {
  const limit = Math.min(MAX_TRAFFIC_LOGS, parseInt(req.query.limit, 10) || 100);
  const filterType = req.query.type;
  const filterIp = req.query.ip;
  const filterPlayer = req.query.player ? req.query.player.toLowerCase() : null;
  const sortBy = (req.query.sort || 'time_desc').toLowerCase();
  const refreshParam = req.query.refresh;

  // Auto-refresh support: if explicitly requested via ?refresh=N or if loaded directly in a browser
  const isBrowserDoc = req.headers['sec-fetch-dest'] === 'document' || (req.headers.accept && req.headers.accept.includes('text/html') && !req.headers.accept.includes('application/json'));
  let refreshSec = 0;
  if (refreshParam !== '0') {
    if (refreshParam) {
      refreshSec = Math.max(1, Math.min(60, parseInt(refreshParam, 10) || 3));
    } else if (isBrowserDoc) {
      refreshSec = 3;
    }
  }
  if (refreshSec > 0) {
    res.setHeader('Refresh', String(refreshSec));
  }

  let events = trafficBuffer.slice();
  if (filterType) events = events.filter(e => e.type === filterType);
  if (filterIp) events = events.filter(e => e.ip === filterIp);
  if (filterPlayer) events = events.filter(e => (e.playerName || '').toLowerCase().includes(filterPlayer));

  // Sort events based on user selection
  if (sortBy === 'time_asc') {
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  } else if (sortBy === 'ip') {
    events.sort((a, b) => String(a.ip || '').localeCompare(String(b.ip || '')) || (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
  } else if (sortBy === 'type') {
    events.sort((a, b) => String(a.type || '').localeCompare(String(b.type || '')) || (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
  } else if (sortBy === 'status') {
    events.sort((a, b) => ((b.status || 0) - (a.status || 0)) || (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
  } else {
    // Default: time_desc (newest first)
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  events = events.slice(0, limit);

  const mode = (req.query.mode || req.query.view || 'advanced').toLowerCase();
  let formattedEvents = events;
  if (mode === 'simple') {
    formattedEvents = events.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      player: e.playerName || null,
      ip: e.ip,
      country: e.country,
      event: e.event || e.action || (e.method ? `${e.method} ${e.url}` : e.type),
      details: e.details || (e.status ? `${e.status} (${e.durationMs}ms)` : ''),
      status: e.status,
      durationMs: e.durationMs
    }));
  } else if (mode === 'advanced') {
    formattedEvents = events.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      story: e.story || formatEventStory(e),
      player: e.playerName || null,
      room: e.roomCode || null,
      action: e.action || e.event || e.type,
      type: e.type,
      ip: e.ip,
      country: e.country,
      turn: e.turn,
      phase: e.phase,
      details: e.details,
      status: e.status
    }));
  }

  res.json({
    status: 'ok',
    dashboard: '/admin',
    timestamp: new Date().toISOString(),
    mode,
    availableModes: ['simple', 'advanced', 'all'],
    sort: sortBy,
    availableSorts: ['time_desc', 'time_asc', 'ip', 'type', 'status'],
    refreshSeconds: refreshSec > 0 ? refreshSec : null,
    stats: {
      totalHttpRequests: trafficStats.totalHttpRequests,
      totalSocketPackets: trafficStats.totalSocketPackets,
      uniqueIpCount: trafficStats.uniqueIps.size,
      uniqueIps: Array.from(trafficStats.uniqueIps),
      activeConnectionCount: trafficStats.activeSockets.size,
      identifiedPlayerCount: trafficStats.playerIps.size
    },
    activeConnections: Array.from(trafficStats.activeSockets.values()),
    playerIps: Array.from(trafficStats.playerIps.values()).map(p => ({
      name: p.name,
      ip: p.ip,
      ips: Array.from(p.ips),
      country: p.country,
      roomCode: p.roomCode,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      actionCount: p.actionCount
    })),
    recentEventsCount: formattedEvents.length,
    recentEvents: formattedEvents
  });
});

export function clearTrafficLogs() {
  trafficBuffer.length = 0;
  trafficStats.totalHttpRequests = 0;
  trafficStats.totalSocketPackets = 0;
  trafficStats.uniqueIps.clear();
  trafficStats.playerIps.clear();
  for (const s of trafficStats.activeSockets.values()) {
    if (s.ip && s.ip !== 'unknown') trackUniqueIp(s.ip);
    if (s.playerName && s.ip && s.ip !== 'unknown') {
      recordPlayerIp(s.playerName, s.ip, s.country, s.roomCode);
    }
  }
  return { success: true, count: 0 };
}

// API: Clear traffic logs
app.post(['/api/admin/traffic/clear', '/api/admin/traffic/reset'], (req, res) => {
  clearTrafficLogs();
  res.json({ status: 'ok', message: 'Traffic logs cleared successfully' });
});

app.delete('/api/admin/traffic', (req, res) => {
  clearTrafficLogs();
  res.json({ status: 'ok', message: 'Traffic logs cleared successfully' });
});

// API: Admin Room Inspection (Complete Authoritative Debug State)
app.get('/api/admin/room/:code', (req, res) => {
  const roomCode = req.params.code?.toUpperCase();
  const room = roomManager.getRoom(roomCode);
  if (!room) return res.status(404).json({ status: 'error', error: 'ROOM_NOT_FOUND' });

  res.json({
    status: 'ok',
    roomCode: room.code,
    name: room.name,
    mode: room.mode,
    isStarted: room.isStarted,
    turnDuration: room.turnDuration,
    mapSize: room.mapSize,
    hostId: room.hostId,
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isBot: Boolean(p.isBot),
      hasActiveSocket: Boolean(p.socketId),
      victoryPoints: p.victoryPoints,
      resources: p.resources,
      commodities: p.commodities,
      cityImprovements: p.cityImprovements,
      cityWalls: p.cityWalls,
      knightsAvailable: p.knightsAvailable,
      knightsPlaced: p.knightsPlaced,
      citiesBuilt: p.citiesBuilt,
      settlementsBuilt: p.settlementsBuilt,
      roadsBuilt: p.roadsBuilt
    })),
    engine: room.engine ? {
      phase: room.engine.phase,
      turnNumber: room.engine.turnNumber,
      currentPlayerIndex: room.engine.currentTurnPlayerIndex,
      currentPlayerId: room.engine.getCurrentPlayer()?.id,
      currentPlayerName: room.engine.getCurrentPlayer()?.name,
      barbarianPosition: room.engine.barbarianPosition,
      eventDie: room.engine.eventDie,
      bankStock: room.engine.getBankStock?.(),
      knightsOverview: room.engine.getKnightsOverview?.(),
      pendingDiscards: Array.from(room.engine.pendingDiscards || []),
      pendingBarbarianDowngrades: Array.from(room.engine.pendingBarbarianDowngrades || []),
      recentEventLog: room.engine.eventLog?.slice(-25)
    } : null
  });
});

// API: Spawn external AI agent into a room
app.post('/api/rooms/:code/spawn-agent', (req, res) => {
  let reservedRoomCode = null;
  try {
    const roomCode = req.params.code.toUpperCase();
    const room = roomManager.getRoom(roomCode);
    if (!room) return res.status(404).json({ success: false, error: 'ROOM_NOT_FOUND' });
    const reconnectToken = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const requester = room.players.find(player => roomManager.matchesReconnectToken(player, reconnectToken));
    if (!requester || requester.id !== room.hostId) return res.status(403).json({ success: false, error: 'HOST_AUTHORIZATION_REQUIRED' });
    if (room.isStarted) return res.status(400).json({ success: false, error: 'GAME_ALREADY_STARTED' });
    if (room.players.length >= room.maxPlayers) return res.status(400).json({ success: false, error: 'ROOM_FULL' });

    const name = validateDisplayName(req.body?.name, `Agent-${Math.floor(1000 + Math.random() * 9000)}`);
    roomManager.reserveAgentSpawn(roomCode);
    reservedRoomCode = roomCode;
    const child = spawnAgentProcess(roomCode, name);
    res.json({ success: true, roomCode, name, pid: child?.pid });
  } catch (err) {
    if (reservedRoomCode) roomManager.releaseAgentSpawn(reservedRoomCode);
    res.status(500).json({ success: false, error: 'AGENT_SPAWN_FAILED' });
  }
});

// Socket.IO event handler
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  const ip = extractClientIp(socket);
  const country = extractClientCountry(socket);
  const countryTag = country ? `[${country}]` : '';
  const connectTime = new Date().toLocaleTimeString();

  trafficStats.activeSockets.set(socket.id, {
    id: socket.id,
    ip,
    country,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    roomCode: null,
    playerName: null
  });

  recordTrafficEvent({
    type: 'SOCKET_CONNECT',
    socketId: socket.id,
    ip,
    country
  });

  console.log(`[${connectTime}] [SOCKET CONNECT] ${ip} ${countryTag} (socketId: ${socket.id})`);

  // Real-time packet logging for all incoming client events
  socket.onAny((eventName, ...args) => {
    trafficStats.totalSocketPackets++;
    const active = trafficStats.activeSockets.get(socket.id);
    if (active) {
      active.lastSeen = new Date().toISOString();
      if (currentRoomCode) active.roomCode = currentRoomCode;
    }

    const payloadSummary = summarizePacketPayload(eventName, args[0]);
    const pName = active?.playerName || null;

    recordTrafficEvent({
      type: 'SOCKET_PACKET',
      socketId: socket.id,
      ip,
      country,
      event: eventName,
      details: payloadSummary,
      roomCode: currentRoomCode || null,
      playerId: currentPlayerId || null,
      playerName: pName
    });

    const nowTime = new Date().toLocaleTimeString();
    const playerTag = pName ? ` (${pName})` : '';
    console.log(`[${nowTime}] [SOCKET PACKET] ${ip} ${countryTag} [${socket.id.slice(0, 6)}]${playerTag} -> "${eventName}" ${payloadSummary}`);
  });

  socket.on('create_room', (data, callback) => {
    try {
      if (!data || typeof data !== 'object') throw new Error('INVALID_PAYLOAD');
      const session = roomManager.createPlayerSession();
      const playerId = session.id;
      const room = roomManager.createRoom(
        { id: playerId, name: data.hostName || 'Host', socketId: socket.id, reconnectTokenHash: session.reconnectTokenHash },
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

      const active = trafficStats.activeSockets.get(socket.id);
      if (active) {
        active.roomCode = room.code;
        active.playerName = data.hostName || 'Host';
      }

      console.log(`[${new Date().toLocaleTimeString()}] [ROOM CREATE] [${room.code}] Host: "${data.hostName || 'Host'}" (${ip} ${countryTag}) | Mode: ${room.mode} | Max: ${room.maxPlayers} | Turn: ${room.turnDuration}s | VP: ${room.engine?.vpTarget || 10}`);

      recordTrafficEvent({
        type: 'ROOM_CREATE',
        roomCode: room.code,
        hostName: data.hostName || 'Host',
        mode: room.mode,
        ip,
        country
      });

      if (callback) callback({ success: true, roomCode: room.code, playerId, reconnectToken: session.reconnectToken });
      roomManager.broadcastLobbyState(room);
    } catch (err) {
      console.warn(`[${new Date().toLocaleTimeString()}] [ROOM CREATE FAIL] Host: "${data?.hostName}" | Error: ${err.message}`);
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('join_room', (data, callback) => {
    try {
      if (!data || typeof data !== 'object') throw new Error('INVALID_PAYLOAD');
      const roomCode = data.code || data.roomCode;
      const session = roomManager.createPlayerSession();
      const result = roomManager.joinRoom(roomCode, {
        id: session.id,
        name: data.playerName,
        socketId: socket.id,
        reconnectToken: data.reconnectToken,
        reconnectTokenHash: session.reconnectTokenHash,
        allowLegacyId: false
      });

      if (result.error) {
        console.warn(`[${new Date().toLocaleTimeString()}] [ROOM JOIN FAIL] [${roomCode}] Player: "${data?.playerName}" (${ip} ${countryTag}) | Error: ${result.error}`);
        recordTrafficEvent({
          type: 'ROOM_JOIN_ERROR',
          roomCode,
          playerName: data?.playerName,
          error: result.error,
          ip,
          country
        });
        if (callback) callback({ success: false, error: result.error });
        return;
      }

      const room = result.room;
      currentRoomCode = room.code;
      currentPlayerId = result.playerId;
      socket.join(room.code);
      if (data.isSpawnedAgent) roomManager.releaseAgentSpawn(room.code);

      const active = trafficStats.activeSockets.get(socket.id);
      if (active) {
        active.roomCode = room.code;
        active.playerName = data.playerName;
      }

      console.log(`[${new Date().toLocaleTimeString()}] [ROOM JOIN] [${room.code}] Player: "${data.playerName}" ${result.reconnected ? '(RECONNECTED)' : '(NEW)'} (${ip} ${countryTag}) | Players: ${room.players.length}/${room.maxPlayers}`);

      recordTrafficEvent({
        type: 'ROOM_JOIN',
        roomCode: room.code,
        playerName: data.playerName,
        reconnected: Boolean(result.reconnected),
        playerCount: room.players.length,
        ip,
        country
      });

      if (callback) callback({ success: true, roomCode: room.code, playerId: result.playerId, isStarted: room.isStarted, reconnectToken: result.reconnected ? undefined : session.reconnectToken });

      if (room.isStarted) {
        roomManager.broadcastState(room);
      } else {
        roomManager.broadcastLobbyState(room);
      }
    } catch (err) {
      console.warn(`[${new Date().toLocaleTimeString()}] [ROOM JOIN ERROR] [${data?.code || data?.roomCode}] | Error: ${err.message}`);
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('add_bot', (data, callback) => {
    try {
      const roomCode = ((data && (data.code || data.roomCode)) || currentRoomCode)?.toUpperCase();
      if (!roomCode) throw new Error('ROOM_CODE_REQUIRED');
      if (currentRoomCode && roomCode !== currentRoomCode) throw new Error('ROOM_MISMATCH');
      const existingRoom = roomManager.getRoom(roomCode);
      if (!existingRoom) throw new Error('ROOM_NOT_FOUND');
      if (!currentPlayerId || existingRoom.hostId !== currentPlayerId) throw new Error('ONLY_HOST_CAN_MANAGE_LOBBY');
      if (existingRoom.isStarted) throw new Error('GAME_ALREADY_STARTED');
      if (existingRoom.players.length + (existingRoom.pendingAgentSpawns || 0) >= existingRoom.maxPlayers) throw new Error('ROOM_FULL');

      const bot = roomManager.addBot(roomCode, data?.difficulty || 'medium');
      if (!bot) throw new Error('BOT_ADD_FAILED');
      roomManager.broadcastLobbyState(existingRoom);
      if (callback) callback({ success: true, bot });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('spawn_ai_agent', (data, callback) => {
    try {
      const roomCode = ((data && (data.code || data.roomCode)) || currentRoomCode)?.toUpperCase();
      if (!roomCode) throw new Error('ROOM_CODE_REQUIRED');
      if (currentRoomCode && roomCode !== currentRoomCode) throw new Error('ROOM_MISMATCH');
      const room = roomManager.getRoom(roomCode);
      if (!room) throw new Error('ROOM_NOT_FOUND');
      if (!currentPlayerId || room.hostId !== currentPlayerId) throw new Error('ONLY_HOST_CAN_MANAGE_LOBBY');
      if (room.isStarted) throw new Error('GAME_ALREADY_STARTED');
      if (room.players.length + (room.pendingAgentSpawns || 0) >= room.maxPlayers) throw new Error('ROOM_FULL');

      const agentNames = ['AlphaSettler', 'DeepHex', 'ClaudeBot', 'GeminiKnight', 'SnighiBot', 'HexMaster'];
      const existingNames = room.players.map(p => p.name);
      const name = validateDisplayName((data && data.name), agentNames.find(n => !existingNames.includes(n)) || `Agent-${Math.floor(1000 + Math.random() * 9000)}`);
      roomManager.reserveAgentSpawn(roomCode);

      const child = spawnAgentProcess(roomCode, name);
      if (callback) callback({ success: true, name, pid: child?.pid });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('remove_player', (data, callback) => {
    try {
      const roomCode = ((data && (data.code || data.roomCode)) || currentRoomCode)?.toUpperCase();
      if (!roomCode) throw new Error('ROOM_CODE_REQUIRED');
      if (currentRoomCode && roomCode !== currentRoomCode) throw new Error('ROOM_MISMATCH');
      const room = roomManager.getRoom(roomCode);
      if (!room) throw new Error('ROOM_NOT_FOUND');
      if (!currentPlayerId || (room.hostId !== currentPlayerId && data?.id !== currentPlayerId)) {
        throw new Error('NOT_AUTHORIZED');
      }
      // Lobby kick only. In-game seats use stand-in / leave / concede, not host delete.
      if (room.isStarted) throw new Error('GAME_ALREADY_STARTED');
      const target = room.players.find(p => p.id === data?.id);
      const targetSocketId = target?.socketId;
      const kickedSelf = data?.id === currentPlayerId;
      roomManager.removePlayerOrBot(roomCode, data.id);
      if (targetSocketId) {
        io.to(targetSocketId).emit('player_kicked', { reason: 'KICKED_FROM_LOBBY' });
        const targetSock = io.sockets.sockets.get(targetSocketId);
        targetSock?.leave(roomCode);
      }
      if (kickedSelf) {
        socket.leave(roomCode);
        currentRoomCode = null;
      }
      const updated = roomManager.getRoom(roomCode);
      if (updated) {
        roomManager.broadcastLobbyState(updated);
      }
      if (callback) callback({ success: true });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('set_ready', (data, callback) => {
    const code = ((data && (data.code || data.roomCode)) || currentRoomCode)?.toUpperCase();
    const ok = Boolean(code) && roomManager.setPlayerReady(code, currentPlayerId, data?.isReady);
    if (ok) {
      const room = roomManager.getRoom(code);
      roomManager.broadcastLobbyState(room);
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false });
    }
  });

  socket.on('set_color', (data) => {
    try {
      const code = ((data && (data.code || data.roomCode)) || currentRoomCode)?.toUpperCase();
      const ok = Boolean(code) && roomManager.setPlayerColor(code, currentPlayerId, data?.color);
      if (ok) {
        const room = roomManager.getRoom(code);
        roomManager.broadcastLobbyState(room);
      }
    } catch (err) {
      socket.emit('action_error', { error: err.message });
    }
  });

  socket.on('start_game', (data, callback) => {
    try {
      const roomCode = ((data && (data.code || data.roomCode)) || currentRoomCode)?.toUpperCase();
      if (!roomCode) throw new Error('ROOM_CODE_REQUIRED');
      if (currentRoomCode && roomCode !== currentRoomCode) throw new Error('ROOM_MISMATCH');
      const room = roomManager.startGame(roomCode, currentPlayerId);
      const starterName = room.players.find(p => p.id === currentPlayerId)?.name || 'Host';
      const firstTurnName = room.engine?.getCurrentPlayer()?.name || 'Player 1';

      console.log(`[${new Date().toLocaleTimeString()}] [GAME START] [${room.code}] Started by "${starterName}" (${ip} ${countryTag}) | Mode: ${room.mode} | Players (${room.players.length}): ${room.players.map(p => p.name).join(', ')} | First turn: "${firstTurnName}"`);

      recordTrafficEvent({
        type: 'GAME_START',
        roomCode: room.code,
        mode: room.mode,
        startedBy: starterName,
        players: room.players.map(p => p.name),
        ip,
        country
      });

      io.to(room.code).emit('game_started', { code: room.code });
      roomManager.broadcastState(room);
      if (callback) callback({ success: true });
    } catch (err) {
      console.warn(`[${new Date().toLocaleTimeString()}] [GAME START FAIL] [${currentRoomCode}] Error: ${err.message}`);
      if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('send_chat', (data) => {
    // SEC-05: chat is bound to the seated room only — never fall back to client-supplied data.code.
    if (!currentRoomCode || !currentPlayerId) return;
    const requestedCode = typeof data?.code === 'string' ? data.code.toUpperCase() : null;
    if (requestedCode && requestedCode !== currentRoomCode) return;

    const room = roomManager.getRoom(currentRoomCode);
    const sender = room?.players.find(p => p.id === currentPlayerId);
    if (!room || !sender || !data?.text) return;

    const chatMsg = {
      id: `chat_${Date.now()}`,
      senderId: currentPlayerId,
      senderName: sender.name,
      color: sender.color,
      text: validateChatMessage(data.text),
      timestamp: Date.now()
    };
    room.chatMessages.push(chatMsg);
    recordTrafficEvent({
      type: 'CHAT_MESSAGE',
      roomCode: currentRoomCode,
      playerId: currentPlayerId,
      playerName: sender.name,
      text: chatMsg.text,
      ip,
      country
    });

    console.log(`[${new Date().toLocaleTimeString()}] [CHAT] [${currentRoomCode}] ${sender.name} (${ip}${countryTag ? ' ' + countryTag : ''}): "${chatMsg.text}"`);

    io.to(room.code).emit('chat_received', chatMsg);
  });

  /* =========================================================
   * IN-GAME TURNS & ACTIONS
   * ========================================================= */

  const handleGameAction = (actionNameOrCode, codeOrFn, actionFnOrCallback, maybeCallback, maybePayload) => {
    let actionName = 'game_action';
    let code = currentRoomCode;
    let actionFn = null;
    let callback = null;
    let payload = maybePayload || null;

    if (typeof codeOrFn === 'function') {
      // Called as: handleGameAction(code, actionFn, callback)
      code = actionNameOrCode;
      actionFn = codeOrFn;
      callback = actionFnOrCallback;
    } else {
      // Called as: handleGameAction(actionName, code, actionFn, callback, payload)
      actionName = actionNameOrCode;
      code = codeOrFn;
      actionFn = actionFnOrCallback;
      callback = maybeCallback;
      payload = maybePayload || null;
    }

    const roomCode = (code || currentRoomCode)?.toUpperCase();
    if (!roomCode || (currentRoomCode && code && currentRoomCode !== code.toUpperCase())) {
      const err = 'ROOM_MISMATCH';
      console.warn(`[${new Date().toLocaleTimeString()}] [ACTION REJECTED] "${actionName}" on room "${code}" (current: "${currentRoomCode}"): ${err}`);
      if (callback) callback({ success: false, error: err });
      return;
    }
    const room = roomManager.getRoom(roomCode);
    if (!room || !room.isStarted) {
      const err = 'ROOM_NOT_ACTIVE';
      console.warn(`[${new Date().toLocaleTimeString()}] [ACTION REJECTED] [${roomCode}] "${actionName}": ${err}`);
      if (callback) callback({ success: false, error: err });
      return;
    }

    const player = room.players.find(p => p.id === currentPlayerId);
    const pName = player ? player.name : (currentPlayerId || 'Unknown');
    const phaseBefore = room.engine?.phase || 'UNKNOWN';
    const turnBefore = room.engine?.turnNumber ?? '?';

    try {
      const result = actionFn(room.engine);
      const timeStr = new Date().toLocaleTimeString();

      let diceData = null;
      let eventDie = null;
      let fleetPos = null;
      if (actionName === 'roll_dice' && room.engine?.dice) {
        const d = room.engine.dice;
        const sum = (d.d1 || 0) + (d.d2 || 0);
        diceData = { d1: d.d1, d2: d.d2, sum };
        eventDie = room.engine.eventDie;
        fleetPos = room.engine.barbarianPosition;
        const eventDieInfo = eventDie ? ` | Event Die: ${eventDie} (Fleet: ${fleetPos}/7)` : '';
        console.log(`[${timeStr}] [DICE ROLL] [${roomCode}] ${pName} (${ip}${countryTag ? ' ' + countryTag : ''}) rolled [${d.d1}, ${d.d2}] = ${sum}${eventDieInfo}`);
      } else {
        console.log(`[${timeStr}] [ACTION OK] [${roomCode}] Turn ${turnBefore} (${phaseBefore}) | ${pName} (${ip}${countryTag ? ' ' + countryTag : ''}) -> "${actionName}"`);
      }

      let targetName = null;
      if (payload?.targetPlayerId) {
        const targetPlayer = room.players.find(p => p.id === payload.targetPlayerId);
        targetName = targetPlayer ? targetPlayer.name : payload.targetPlayerId;
      }

      recordTrafficEvent({
        type: 'ACTION_SUCCESS',
        action: actionName,
        roomCode,
        playerId: currentPlayerId,
        playerName: pName,
        turn: turnBefore,
        phase: phaseBefore,
        dice: diceData,
        eventDie,
        barbarianPosition: fleetPos,
        vertexId: payload?.vertexId,
        edgeId: payload?.edgeId,
        hexId: payload?.hexId,
        cardId: payload?.cardId,
        track: payload?.track,
        resource: payload?.resource,
        give: payload?.give,
        receive: payload?.receive,
        ratio: payload?.ratio,
        deck: payload?.deck,
        targetPlayerId: payload?.targetPlayerId,
        targetName,
        ip,
        country
      });

      if (room.engine?.isGameOver) {
        const winner = room.engine.winner;
        console.log(`[${timeStr}] [GAME OVER] [${roomCode}] 🏆 WINNER: ${winner?.name} (${ip || 'unknown'}) with ${winner?.victoryPoints} VP!`);
        recordTrafficEvent({
          type: 'GAME_OVER',
          roomCode,
          winnerName: winner?.name,
          winnerPoints: winner?.victoryPoints
        });
      }

      roomManager.resetTurnTimer(room);
      roomManager.broadcastState(room);
      roomManager.checkAndTriggerBotTurn(room);
      roomManager.checkDiscardTimer(room);
      if (callback) callback({ success: true, ...result });
    } catch (err) {
      const timeStr = new Date().toLocaleTimeString();
      console.warn(`[${timeStr}] [ACTION FAIL] [${roomCode}] Turn ${turnBefore} (${phaseBefore}) | ${pName} (${ip} ${countryTag}) -> "${actionName}" REJECTED: ${err.message}`);

      recordTrafficEvent({
        type: 'ACTION_ERROR',
        action: actionName,
        error: err.message,
        roomCode,
        playerId: currentPlayerId,
        playerName: pName,
        turn: turnBefore,
        phase: phaseBefore,
        ip,
        country
      });

      if (callback) callback({ success: false, error: err.message });
    }
  };

  socket.on('place_setup_settlement', (data, cb) => {
    handleGameAction('place_setup_settlement', data?.code, (engine) => engine.placeSetupSettlement(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('place_setup_city', (data, cb) => {
    handleGameAction('place_setup_city', data?.code, (engine) => engine.placeSetupSettlement(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('place_setup_road', (data, cb) => {
    handleGameAction('place_setup_road', data?.code, (engine) => engine.placeSetupRoad(currentPlayerId, data?.edgeId), cb, data);
  });

  socket.on('roll_dice', (data, cb) => {
    handleGameAction('roll_dice', data?.code, (engine) => engine.rollDice(currentPlayerId), cb, data);
  });

  socket.on('discard_cards', (data, cb) => {
    const discardedCards = data?.discarded || { ...(data?.resources || {}), ...(data?.commodities || {}) };
    handleGameAction('discard_cards', data?.code, (engine) => engine.discardCards(currentPlayerId, discardedCards), cb, data);
  });

  socket.on('move_robber', (data, cb) => {
    handleGameAction('move_robber', data?.code, (engine) => engine.moveRobber(currentPlayerId, data?.hexId, data?.targetPlayerId), cb, data);
  });

  socket.on('build_road', (data, cb) => {
    handleGameAction('build_road', data.code, (engine) => engine.buildRoad(currentPlayerId, data.edgeId), cb, data);
  });

  socket.on('build_settlement', (data, cb) => {
    handleGameAction('build_settlement', data.code, (engine) => engine.buildSettlement(currentPlayerId, data.vertexId), cb, data);
  });

  socket.on('build_city', (data, cb) => {
    handleGameAction('build_city', data?.code, (engine) => engine.buildCity(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('upgrade_city', (data, cb) => {
    handleGameAction('upgrade_city', data?.code, (engine) => engine.buildCity(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('build_city_wall', (data, cb) => {
    handleGameAction('build_city_wall', data?.code, (engine) => engine.buildCityWall(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('improve_city', (data, cb) => {
    handleGameAction('improve_city', data?.code, (engine) => engine.improveCityTrack(currentPlayerId, data?.track), cb, data);
  });

  socket.on('claim_aqueduct_resource', (data, cb) => {
    handleGameAction('claim_aqueduct_resource', data?.code, (engine) => engine.claimAqueductResource(currentPlayerId, data?.resource), cb, data);
  });

  socket.on('choose_metropolis', (data, cb) => {
    handleGameAction('choose_metropolis', data?.code, (engine) => engine.chooseMetropolis(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('place_knight', (data, cb) => {
    handleGameAction('place_knight', data?.code, (engine) => engine.placeKnight(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('activate_knight', (data, cb) => {
    handleGameAction('activate_knight', data?.code, (engine) => engine.activateKnight(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('promote_knight', (data, cb) => {
    handleGameAction('promote_knight', data?.code, (engine) => engine.promoteKnight(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('move_knight', (data, cb) => {
    handleGameAction('move_knight', data?.code, (engine) => engine.moveKnight(currentPlayerId, data?.fromVertexId, data?.toVertexId), cb, data);
  });

  socket.on('relocate_displaced_knight', (data, cb) => {
    handleGameAction('relocate_displaced_knight', data?.code, (engine) => engine.relocateDisplacedKnight(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('relocate_knight', (data, cb) => {
    handleGameAction('relocate_knight', data?.code, (engine) => engine.relocateDisplacedKnight(currentPlayerId, data?.vertexId), cb, data);
  });

  socket.on('chase_robber', (data, cb) => {
    handleGameAction('chase_robber', data.code, (engine) => engine.chaseRobber(currentPlayerId, data.vertexId, data.hexId, data.targetPlayerId), cb, data);
  });

  socket.on('downgrade_city', (data, cb) => {
    handleGameAction('downgrade_city', data.code, (engine) => engine.downgradeCity(currentPlayerId, data.vertexId), cb, data);
  });

  socket.on('choose_barbarian_reward', (data, cb) => {
    handleGameAction('choose_barbarian_reward', data.code, (engine) => engine.chooseBarbarianReward(currentPlayerId, data.deck), cb, data);
  });

  socket.on('claim_barbarian_progress_card', (data, cb) => {
    handleGameAction('claim_barbarian_progress_card', data.code, (engine) => engine.chooseBarbarianReward(currentPlayerId, data.deck), cb, data);
  });

  socket.on('buy_dev_card', (data, cb) => {
    handleGameAction('buy_dev_card', data.code, (engine) => engine.buyDevCard(currentPlayerId), cb, data);
  });

  socket.on('play_dev_card', (data, cb) => {
    handleGameAction('play_dev_card', data.code, (engine) => engine.playDevCard(currentPlayerId, data.cardId, data.options), cb, data);
  });

  socket.on('play_progress_card', (data, cb) => {
    handleGameAction('play_progress_card', data.code, (engine) => engine.playProgressCard(currentPlayerId, data.cardId, data.options), cb, data);
  });

  socket.on('discard_progress_card', (data, cb) => {
    handleGameAction('discard_progress_card', data.code, (engine) => engine.discardProgressCard(currentPlayerId, data.cardId), cb, data);
  });

  socket.on('bank_trade', (data, cb) => {
    handleGameAction('bank_trade', data.code, (engine) => engine.tradeWithBank(currentPlayerId, data.give, data.receive, data.ratio), cb, data);
  });

  socket.on('propose_trade', (data, cb) => {
    handleGameAction('propose_trade', data.code, (engine) => {
      const trade = engine.proposeTrade(currentPlayerId, data.give, data.want);
      const room = roomManager.getRoom(currentRoomCode || data.code);
      if (room) {
        roomManager.evaluateBotsTrade(room);
      }
      return trade;
    }, cb, data);
  });

  socket.on('respond_trade', (data, cb) => {
    handleGameAction('respond_trade', data.code, (engine) => {
      const res = engine.respondToTrade(currentPlayerId, data.accept);
      const room = roomManager.getRoom(currentRoomCode || data.code);
      if (room && engine.activeTrade) {
        const proposer = engine.players.find(p => p.id === engine.activeTrade.fromPlayerId);
        if (proposer && proposer.isBot) {
          if (data.accept) {
            roomManager.resolveBotTrade(room, currentPlayerId);
          } else {
            roomManager.checkBotTradeDeclines(room);
          }
        }
      }
      return res;
    }, cb, data);
  });

  socket.on('confirm_trade', (data, cb) => {
    handleGameAction('confirm_trade', data.code, (engine) => engine.confirmTrade(currentPlayerId, data.targetPlayerId), cb, data);
  });

  socket.on('cancel_trade', (data, cb) => {
    handleGameAction('cancel_trade', data.code, (engine) => engine.cancelTrade(currentPlayerId), cb, data);
  });

  socket.on('leave_room', (data, cb) => {
    const code = currentRoomCode || (data && data.code);
    if (code && currentPlayerId) {
      const room = roomManager.getRoom(code);
      if (room) {
        if (room.isStarted) {
          roomManager.replaceDisconnectedPlayerWithBot(code, currentPlayerId);
        } else {
          roomManager.removePlayerOrBot(code, currentPlayerId);
          if (roomManager.getRoom(code)) {
            roomManager.broadcastLobbyState(room);
          }
        }
        socket.leave(code);
        currentRoomCode = null;
      }
    }
    if (cb) cb({ success: true });
  });

  socket.on('end_turn', (data, cb) => {
    handleGameAction('end_turn', data.code, (engine) => engine.endTurn(currentPlayerId), cb, data);
  });

  socket.on('disconnect', (reason) => {
    const discTime = new Date().toLocaleTimeString();
    const active = trafficStats.activeSockets.get(socket.id);
    const pName = active?.playerName || null;
    const playerTag = pName ? ` (${pName})` : '';
    console.log(`[${discTime}] [SOCKET DISCONNECT] ${ip} ${countryTag}${playerTag} (socketId: ${socket.id}, reason: ${reason})`);

    recordTrafficEvent({
      type: 'SOCKET_DISCONNECT',
      socketId: socket.id,
      ip,
      country,
      playerName: pName,
      details: `reason: ${reason}`
    });

    trafficStats.activeSockets.delete(socket.id);

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
                console.log(`Player ${p.name} (${pId}) disconnected permanently, replacing with bot.`);
                roomManager.replaceDisconnectedPlayerWithBot(code, pId);
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

export { app, server, io, roomManager, spawnedAgents };
