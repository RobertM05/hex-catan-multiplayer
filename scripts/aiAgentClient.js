/**
 * aiAgentClient.js
 * Autonomous AI Agent player client for Hex Catan Multiplayer.
 * Connects over Socket.IO to any live server instance, joins a room,
 * and plays full games autonomously through all phases.
 */

import { io } from 'socket.io-client';

const TOKEN_PIPS = {
  2: 1, 12: 1,
  3: 2, 11: 2,
  4: 3, 10: 3,
  5: 4, 9: 4,
  6: 5, 8: 5
};

export class CatanAIAgent {
  constructor({
    serverUrl = 'http://localhost:3000',
    roomCode,
    name = 'AI-Agent',
    color = null,
    turnDelay = 600,
    autoReady = true,
    spawnedAgent = false,
    log = console.log
  }) {
    this.serverUrl = serverUrl;
    this.roomCode = roomCode ? roomCode.toUpperCase() : null;
    this.name = name;
    this.color = color;
    this.turnDelay = turnDelay;
    this.autoReady = autoReady;
    this.log = log;

    this.socket = null;
    this.myPlayerId = null;
    this.gameState = null;
    this.currentRoom = null;
    this.isActing = false;
    this.hasJoined = false;
    this.spawnedAgent = spawnedAgent;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = io(this.serverUrl, {
        reconnection: true,
        transports: ['websocket', 'polling']
      });

      this.socket.on('connect', () => {
        this.log(`[AI-Agent] Connected to server at ${this.serverUrl} (Socket ID: ${this.socket.id})`);
        resolve(this);
      });

      this.socket.on('connect_error', (err) => {
        this.log(`[AI-Agent] Connection error: ${err.message}`);
        reject(err);
      });

      this.socket.on('game_state_update', (payload) => {
        this.gameState = payload.state;
        this.currentRoom = payload.room;
        this.onStateUpdate(payload.state, payload.room);
      });

      this.socket.on('lobby_state_update', (lobbyData) => {
        this.currentRoom = lobbyData;
        if (this.autoReady && !this.gameState?.isStarted) {
          const me = lobbyData.players?.find(p => p.id === this.myPlayerId);
          if (me && !me.isReady) {
            this.setReady(true);
          }
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.log(`[AI-Agent] Disconnected from server: ${reason}`);
      });
    });
  }

  joinRoom(roomCode) {
    if (roomCode) this.roomCode = roomCode.toUpperCase();
    if (!this.roomCode) throw new Error('ROOM_CODE_REQUIRED');

    return new Promise((resolve, reject) => {
      this.socket.emit('join_room', {
        code: this.roomCode,
        roomCode: this.roomCode,
        playerName: this.name,
        color: this.color,
        isSpawnedAgent: this.spawnedAgent
      }, async (res) => {
        if (res && res.success) {
          this.myPlayerId = res.playerId;
          this.hasJoined = true;
          this.log(`[AI-Agent] Joined room ${this.roomCode} as ${this.name} (${this.myPlayerId})`);

          if (this.autoReady) {
            await this.setReady(true);
          }
          resolve(res);
        } else {
          const errMsg = res ? res.error : 'Failed to join room';
          this.log(`[AI-Agent] Join room failed: ${errMsg}`);
          reject(new Error(errMsg));
        }
      });
    });
  }

  setReady(isReady = true) {
    if (!this.roomCode || !this.socket) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      this.socket.emit('set_ready', { code: this.roomCode, roomCode: this.roomCode, isReady }, (res) => {
        if (!settled) {
          settled = true;
          resolve(res);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ success: true });
        }
      }, 50);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendChat(message) {
    if (!this.roomCode || !this.socket) return;
    this.socket.emit('send_chat', { roomCode: this.roomCode, message });
  }

  async onStateUpdate(state, room) {
    if (!state || !this.hasJoined) return;

    if (state.phase === 'GAME_OVER') {
      const winner = state.winner ? state.winner.name : 'Unknown';
      this.log(`[AI-Agent] Game Over! Winner: ${winner}`);
      this.sendChat(`Good game everyone! Congrats to ${winner}!`);
      return;
    }

    const me = state.players?.find(p => p.id === this.myPlayerId);
    if (!me) return;

    const curPlayer = state.players[state.currentTurnPlayerIndex];
    const isMyTurn = curPlayer?.id === this.myPlayerId;

    const hasAction = (
      ((state.phase === 'SETUP_ROUND_1' || state.phase === 'SETUP_ROUND_2') && isMyTurn) ||
      (state.phase === 'TURN_DISCARD' && state.pendingDiscards?.includes(this.myPlayerId)) ||
      (state.phase === 'TURN_ROLL' && isMyTurn) ||
      (state.phase === 'TURN_ROBBER' && isMyTurn) ||
      (state.phase === 'TURN_ACTION' && isMyTurn) ||
      (state.phase === 'TURN_CHOOSE_METROPOLIS' && state.pendingMetropolisChoice?.playerId === this.myPlayerId) ||
      (state.phase === 'TURN_CHOOSE_KNIGHT_RELOCATE' && state.pendingKnightRelocation?.playerId === this.myPlayerId) ||
      (state.phase === 'TURN_BARBARIAN_DOWNGRADE' && state.pendingBarbarianDowngrades?.includes(this.myPlayerId))
    );

    if (!hasAction) return;

    if (this.isActing) {
      this.hasQueuedAction = true;
      return;
    }

    try {
      this.isActing = true;
      if (this.turnDelay > 0) {
        await this.sleep(this.turnDelay);
      }

      // Re-fetch latest state and player object
      const curState = this.gameState || state;
      const curMe = curState.players?.find(p => p.id === this.myPlayerId) || me;
      const curIsMyTurn = curState.players[curState.currentTurnPlayerIndex]?.id === this.myPlayerId;

      // 1. Setup Phase
      if (curState.phase === 'SETUP_ROUND_1' || curState.phase === 'SETUP_ROUND_2') {
        if (curIsMyTurn) {
          await this.handleSetup(curState, curMe);
        }
      }
      // 2. Discard Phase
      else if (curState.phase === 'TURN_DISCARD') {
        if (curState.pendingDiscards && curState.pendingDiscards.includes(this.myPlayerId)) {
          await this.handleDiscard(curState, curMe);
        }
      }
      // 3. Roll Phase
      else if (curState.phase === 'TURN_ROLL') {
        if (curIsMyTurn) {
          await this.handleRoll();
        }
      }
      // 4. Robber Phase
      else if (curState.phase === 'TURN_ROBBER') {
        if (curIsMyTurn) {
          await this.handleRobber(curState, curMe);
        }
      }
      // 5. Action Phase
      else if (curState.phase === 'TURN_ACTION') {
        if (curIsMyTurn) {
          await this.handleAction(curState, curMe);
        }
      }
      // 6. Metropolis Choice (C&K)
      else if (curState.phase === 'TURN_CHOOSE_METROPOLIS') {
        if (curState.pendingMetropolisChoice?.playerId === this.myPlayerId) {
          await this.handleMetropolis(curState, curMe);
        }
      }
      // 7. Knight Relocate (C&K)
      else if (curState.phase === 'TURN_CHOOSE_KNIGHT_RELOCATE') {
        if (curState.pendingKnightRelocation?.playerId === this.myPlayerId) {
          await this.handleRelocateKnight(curState);
        }
      }
      // 8. Barbarian Downgrade (C&K)
      else if (curState.phase === 'TURN_BARBARIAN_DOWNGRADE') {
        if (curState.pendingBarbarianDowngrades?.includes(this.myPlayerId)) {
          await this.handleBarbarianDowngrade(curState, curMe);
        }
      }
    } catch (err) {
      this.log(`[AI-Agent] Action error: ${err.message}`);
    } finally {
      this.isActing = false;
      if (this.hasQueuedAction) {
        this.hasQueuedAction = false;
        if (this.gameState) {
          this.onStateUpdate(this.gameState, this.currentRoom);
        }
      }
    }
  }

  /* ------------------- Phase Handlers ------------------- */

  async handleSetup(state, me) {
    const grid = state.grid;
    if (!grid) return;

    const isCk = state.mode === 'cities_knights';
    const isRound2 = state.phase === 'SETUP_ROUND_2';
    const buildingType = (isCk && isRound2) ? 'city' : 'settlement';

    // Check if need to place building or road
    const settlementsCount = (me.settlementsBuilt || []).length;
    const citiesCount = (me.citiesBuilt || []).length;
    const roadsCount = (me.roadsBuilt || []).length;
    const totalBuildings = settlementsCount + citiesCount;

    const isBuildingStep = state.setupStep
      ? (state.setupStep === 'settlement' || state.setupStep === 'city')
      : totalBuildings === roadsCount;

    if (isBuildingStep) {
      // Find valid empty vertex
      let bestVId = null;
      let highestScore = -1;

      for (const [vId, v] of Object.entries(grid.vertices)) {
        if (v.building || v.knight) continue;
        const noAdj = v.adjacentVertices.every(adjId => !grid.vertices[adjId]?.building && !grid.vertices[adjId]?.knight);
        if (!noAdj) continue;

        const score = this.scoreVertex(grid, v);
        if (score > highestScore) {
          highestScore = score;
          bestVId = vId;
        }
      }

      if (bestVId) {
        this.log(`[AI-Agent] Setup: Placing ${buildingType} at vertex ${bestVId}`);
        await this.sendAction('place_setup_settlement', { vertexId: bestVId });
      }
    } else {
      // Place road adjacent to last placed settlement/city
      const lastVId = state.lastSetupSettlementVertex
        || me.citiesBuilt?.[me.citiesBuilt.length - 1]
        || me.settlementsBuilt?.[me.settlementsBuilt.length - 1];

      if (lastVId && grid.vertices[lastVId]) {
        const candidateEdges = (grid.vertices[lastVId].adjacentEdges || []).filter(eId => !grid.edges[eId]?.road);
        if (candidateEdges.length > 0) {
          const chosenEdge = candidateEdges[0];
          this.log(`[AI-Agent] Setup: Placing road at edge ${chosenEdge}`);
          await this.sendAction('place_setup_road', { edgeId: chosenEdge });
        } else {
          this.log(`[AI-Agent] Setup warning: No open adjacent edges at vertex ${lastVId}`);
        }
      } else {
        this.log('[AI-Agent] Setup warning: Could not identify last placed setup building vertex');
      }
    }
  }

  async handleRoll() {
    this.log('[AI-Agent] Rolling dice...');
    await this.sendAction('roll_dice', {});
  }

  async handleDiscard(state, me) {
    const resCount = Object.values(me.resources || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const comCount = Object.values(me.commodities || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const totalCards = resCount + comCount;
    const discardTarget = Math.floor(totalCards / 2);

    const discardedResources = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    const discardedCommodities = { cloth: 0, coin: 0, paper: 0 };
    let discardedCount = 0;

    // Discard from largest stacks first
    const pool = [
      ...Object.entries(me.resources || {}).map(([k, v]) => ({ type: 'res', key: k, count: typeof v === 'number' ? v : 0 })),
      ...Object.entries(me.commodities || {}).map(([k, v]) => ({ type: 'com', key: k, count: typeof v === 'number' ? v : 0 }))
    ].filter(i => i.count > 0).sort((a, b) => b.count - a.count);

    while (discardedCount < discardTarget && pool.length > 0) {
      const top = pool[0];
      if (top.count > 0) {
        if (top.type === 'res') discardedResources[top.key]++;
        else discardedCommodities[top.key]++;
        top.count--;
        discardedCount++;
      }
      pool.sort((a, b) => b.count - a.count);
    }

    const discardedCombined = { ...discardedResources, ...discardedCommodities };
    this.log(`[AI-Agent] Discarding ${discardTarget} cards on 7-roll`);
    await this.sendAction('discard_cards', {
      discarded: discardedCombined,
      resources: discardedResources,
      commodities: discardedCommodities
    });
  }

  async handleRobber(state, me) {
    const grid = state.grid;
    if (!grid) return;

    let bestHexId = null;
    let maxOpponentStrength = -1;

    for (const [hId, hex] of Object.entries(grid.hexes)) {
      if (hId === grid.robberHexId || hex.resource === 'desert') continue;

      let score = 0;
      for (const vId of hex.vertices || []) {
        const v = grid.vertices[vId];
        if (v && v.building) {
          if (v.building.playerId === this.myPlayerId) {
            score -= 5; // Avoid targeting own buildings
          } else {
            score += (v.building.type === 'city' ? 3 : 2);
          }
        }
      }

      if (score > maxOpponentStrength) {
        maxOpponentStrength = score;
        bestHexId = hId;
      }
    }

    if (!bestHexId) {
      bestHexId = Object.keys(grid.hexes).find(h => h !== grid.robberHexId && grid.hexes[h].resource !== 'desert');
    }

    // Pick target opponent with resources adjacent to hex
    let targetPlayerId = null;
    if (bestHexId) {
      const hex = grid.hexes[bestHexId];
      for (const vId of hex.vertices || []) {
        const v = grid.vertices[vId];
        if (v && v.building && v.building.playerId !== this.myPlayerId) {
          targetPlayerId = v.building.playerId;
          break;
        }
      }
    }

    this.log(`[AI-Agent] Moving robber to hex ${bestHexId} (Target: ${targetPlayerId || 'none'})`);
    await this.sendAction('move_robber', { hexId: bestHexId, targetPlayerId });
  }

  async handleAction(state, me) {
    const isCk = state.mode === 'cities_knights';
    const res = me.resources || {};
    const com = me.commodities || {};

    // 1. In C&K, check City Improvements
    if (isCk && me.citiesBuilt?.length > 0) {
      const tracks = [
        { track: 'science', comType: 'paper' },
        { track: 'politics', comType: 'coin' },
        { track: 'trade', comType: 'cloth' }
      ];
      for (const item of tracks) {
        const curLvl = me.cityImprovements?.[item.track] || 0;
        const cost = curLvl + 1;
        if (curLvl < 5 && (com[item.comType] || 0) >= cost) {
          try {
            this.log(`[AI-Agent] Improving city track ${item.track} to level ${curLvl + 1}`);
            await this.sendAction('improve_city', { track: item.track });
            await this.sleep(this.turnDelay);
            return;
          } catch (err) {
            this.log(`[AI-Agent] Action improve_city failed: ${err.message}`);
          }
        }
      }
    }

    // 2. City Upgrade: 3 Ore + 2 Wheat
    if (res.ore >= 3 && res.wheat >= 2 && (me.citiesRemaining || 0) > 0 && me.settlementsBuilt?.length > 0) {
      const targetSettlement = me.settlementsBuilt[0];
      try {
        this.log(`[AI-Agent] Upgrading settlement ${targetSettlement} to city`);
        await this.sendAction('build_city', { vertexId: targetSettlement });
        await this.sleep(this.turnDelay);
        return;
      } catch (err) {
        this.log(`[AI-Agent] Action build_city failed: ${err.message}`);
      }
    }

    // 3. Settlement: 1 Wood, 1 Brick, 1 Wool, 1 Wheat
    if (res.wood >= 1 && res.brick >= 1 && res.wool >= 1 && res.wheat >= 1 && (me.settlementsRemaining || 0) > 0) {
      const candidateVId = this.findBuildableSettlementVertex(state.grid, me);
      if (candidateVId) {
        try {
          this.log(`[AI-Agent] Building settlement at vertex ${candidateVId}`);
          await this.sendAction('build_settlement', { vertexId: candidateVId });
          await this.sleep(this.turnDelay);
          return;
        } catch (err) {
          this.log(`[AI-Agent] Action build_settlement failed: ${err.message}`);
        }
      }
    }

    // 4. In C&K, City Wall: 2 Brick
    if (isCk && res.brick >= 2 && (me.cityWalls || 0) > 0 && me.citiesBuilt?.length > 0) {
      const targetCity = me.citiesBuilt.find(cId => !state.grid.vertices[cId]?.hasCityWall);
      if (targetCity) {
        try {
          this.log(`[AI-Agent] Building city wall at ${targetCity}`);
          await this.sendAction('build_city_wall', { vertexId: targetCity });
          await this.sleep(this.turnDelay);
          return;
        } catch (err) {
          this.log(`[AI-Agent] Action build_city_wall failed: ${err.message}`);
        }
      }
    }

    // 5. In C&K, Activate Knight: 1 Wheat
    if (isCk && res.wheat >= 1) {
      const inactiveKnightVertex = (me.knightsPlaced || []).find(k => !k.active)?.vertexId;
      if (inactiveKnightVertex) {
        try {
          this.log(`[AI-Agent] Activating knight at vertex ${inactiveKnightVertex}`);
          await this.sendAction('activate_knight', { vertexId: inactiveKnightVertex });
          await this.sleep(this.turnDelay);
          return;
        } catch (err) {
          this.log(`[AI-Agent] Action activate_knight failed: ${err.message}`);
        }
      }
    }

    // 6. Road: 1 Wood, 1 Brick
    if (res.wood >= 1 && res.brick >= 1 && (me.roadsRemaining || 0) > 0) {
      const candidateEdgeId = this.findBuildableRoadEdge(state.grid, me);
      if (candidateEdgeId) {
        try {
          this.log(`[AI-Agent] Building road at edge ${candidateEdgeId}`);
          await this.sendAction('build_road', { edgeId: candidateEdgeId });
          await this.sleep(this.turnDelay);
          return;
        } catch (err) {
          this.log(`[AI-Agent] Action build_road failed: ${err.message}`);
        }
      }
    }

    // 7. Base Game: Buy Dev Card (1 Ore, 1 Wool, 1 Wheat)
    if (!isCk && res.ore >= 1 && res.wool >= 1 && res.wheat >= 1 && (state.devCardsRemaining || 0) > 0) {
      try {
        this.log('[AI-Agent] Buying development card');
        await this.sendAction('buy_dev_card', {});
        await this.sleep(this.turnDelay);
        return;
      } catch (err) {
        this.log(`[AI-Agent] Action buy_dev_card failed: ${err.message}`);
      }
    }

    // Done with actions: End turn
    try {
      this.log('[AI-Agent] Ending turn');
      await this.sendAction('end_turn', {});
    } catch (err) {
      this.log(`[AI-Agent] End turn error: ${err.message}`);
    }
  }

  async handleMetropolis(state, me) {
    const candidateCities = (me.citiesBuilt || []).filter(cId => state.grid?.vertices?.[cId]?.building?.type === 'city');
    const chosen = candidateCities[0];
    if (chosen) {
      this.log(`[AI-Agent] Choosing metropolis city ${chosen}`);
      await this.sendAction('choose_metropolis', { vertexId: chosen });
    }
  }

  async handleRelocateKnight(state) {
    const options = state.pendingKnightRelocation?.options || [];
    if (options.length > 0) {
      this.log(`[AI-Agent] Relocating knight to vertex ${options[0]}`);
      await this.sendAction('relocate_displaced_knight', { vertexId: options[0] });
    }
  }

  async handleBarbarianDowngrade(state, me) {
    const cities = me.citiesBuilt || [];
    if (cities.length > 0) {
      this.log(`[AI-Agent] Downgrading city ${cities[0]} after barbarian attack`);
      await this.sendAction('downgrade_city', { vertexId: cities[0] });
    }
  }

  /* ------------------- Helpers ------------------- */

  scoreVertex(grid, vertex) {
    let score = 0;
    const resources = new Set();

    for (const hId of vertex.hexes || []) {
      const hex = grid.hexes[hId];
      if (hex && hex.resource && hex.resource !== 'desert') {
        resources.add(hex.resource);
        score += (TOKEN_PIPS[hex.token] || 0) * 2;
      }
    }

    score += resources.size * 3;
    if (vertex.harbor) score += 3;
    return score;
  }

  findBuildableSettlementVertex(grid, me) {
    for (const [vId, v] of Object.entries(grid.vertices)) {
      if (v.building || v.knight) continue;
      // Distance rule
      const noAdj = v.adjacentVertices.every(adjId => !grid.vertices[adjId]?.building && !grid.vertices[adjId]?.knight);
      if (!noAdj) continue;

      // Must connect to player's road
      const hasRoad = v.adjacentEdges.some(eId => grid.edges[eId]?.road?.playerId === this.myPlayerId);
      if (hasRoad) return vId;
    }
    return null;
  }

  findBuildableRoadEdge(grid, me) {
    for (const [eId, edge] of Object.entries(grid.edges)) {
      if (edge.road) continue;

      // Connected to player's road or building
      const v1 = grid.vertices[edge.v1];
      const v2 = grid.vertices[edge.v2];

      const v1Blocked = (v1?.building && v1.building.playerId !== this.myPlayerId) ||
                        (v1?.knight && v1.knight.playerId !== this.myPlayerId);
      const v2Blocked = (v2?.building && v2.building.playerId !== this.myPlayerId) ||
                        (v2?.knight && v2.knight.playerId !== this.myPlayerId);

      const v1Connected = (v1?.building?.playerId === this.myPlayerId) ||
        (!v1Blocked && v1?.adjacentEdges.some(adjId => adjId !== eId && grid.edges[adjId]?.road?.playerId === this.myPlayerId));
      const v2Connected = (v2?.building?.playerId === this.myPlayerId) ||
        (!v2Blocked && v2?.adjacentEdges.some(adjId => adjId !== eId && grid.edges[adjId]?.road?.playerId === this.myPlayerId));

      if (v1Connected || v2Connected) {
        return eId;
      }
    }
    return null;
  }

  sendAction(event, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Action ${event} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.socket.emit(event, { code: this.roomCode, ...payload }, (res) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (res && res.success) resolve(res);
          else reject(new Error(res ? res.error : `Action ${event} failed`));
        }
      });
    });
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

/* ------------------- CLI Runner ------------------- */

export async function runCliAgent() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const serverUrl = getArg('--server', 'http://localhost:3000');
  const roomCode = getArg('--room', null);
  const name = getArg('--name', `Agent-${Math.floor(1000 + Math.random() * 9000)}`);
  const color = getArg('--color', null);

  if (!roomCode) {
    console.error('Usage: node scripts/aiAgentClient.js --room <ROOM_CODE> [--server <URL>] [--name <NAME>] [--color <HEX>]');
    process.exit(1);
  }

  const agent = new CatanAIAgent({ serverUrl, roomCode, name, color, spawnedAgent: args.includes('--spawned-agent') });
  try {
    await agent.connect();
    await agent.joinRoom(roomCode);
    console.log(`[AI-Agent] Agent "${name}" is actively listening to room ${roomCode}...`);
  } catch (err) {
    console.error(`[AI-Agent] Fatal error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('aiAgentClient.js')) {
  runCliAgent();
}
