/**
 * GameEngine.js
 * Authoritative game engine for Hexagonal Strategy Game (Catan-style).
 */

import { HexGrid, RESOURCE_TYPES } from './HexGrid.js';

export const GAME_MODES = {
  BASE: 'base',
  CITIES_KNIGHTS: 'cities_knights'
};

export const COMMODITY_TYPES = {
  CLOTH: 'cloth',
  COIN: 'coin',
  PAPER: 'paper'
};

export const RESOURCE_TO_COMMODITY = {
  [RESOURCE_TYPES.WOOL]: COMMODITY_TYPES.CLOTH,
  [RESOURCE_TYPES.ORE]: COMMODITY_TYPES.COIN,
  [RESOURCE_TYPES.WOOD]: COMMODITY_TYPES.PAPER
};

export const COMMODITY_VALUES = Object.values(COMMODITY_TYPES);
export const RESOURCE_VALUES = [
  RESOURCE_TYPES.WOOD,
  RESOURCE_TYPES.BRICK,
  RESOURCE_TYPES.WOOL,
  RESOURCE_TYPES.WHEAT,
  RESOURCE_TYPES.ORE
];

export const IMPROVEMENT_TRACKS = {
  trade: COMMODITY_TYPES.CLOTH,
  politics: COMMODITY_TYPES.COIN,
  science: COMMODITY_TYPES.PAPER
};

/** Official C&K Aqueduct (Science named building) unlocks at level 3. */
export const AQUEDUCT_UNLOCK_LEVEL = 3;

export const PROGRESS_CARD_DECKS = {
  trade: [
    { type: 'commercial_harbor', count: 2 },
    { type: 'master_merchant', count: 2 },
    { type: 'merchant', count: 6 },
    { type: 'merchant_fleet', count: 2 },
    { type: 'resource_monopoly', count: 4 },
    { type: 'trade_monopoly', count: 2 }
  ],
  politics: [
    { type: 'bishop', count: 2 },
    { type: 'constitution', count: 1 },
    { type: 'deserter', count: 2 },
    { type: 'diplomat', count: 2 },
    { type: 'intrigue', count: 2 },
    { type: 'saboteur', count: 2 },
    { type: 'spy', count: 3 },
    { type: 'warlord', count: 2 },
    { type: 'wedding', count: 2 }
  ],
  science: [
    { type: 'alchemist', count: 2 },
    { type: 'crane', count: 2 },
    { type: 'engineer', count: 1 },
    { type: 'inventor', count: 2 },
    { type: 'irrigation', count: 2 },
    { type: 'medicine', count: 2 },
    { type: 'mining', count: 2 },
    { type: 'printer', count: 1 },
    { type: 'road_building', count: 2 },
    { type: 'smith', count: 2 }
  ]
};

export const PROGRESS_CARD_HAND_LIMIT = 4;

export function normalizeGameMode(mode) {
  if (mode === GAME_MODES.CITIES_KNIGHTS || mode === 'advanced') {
    return GAME_MODES.CITIES_KNIGHTS;
  }
  return GAME_MODES.BASE;
}

export const GAME_PHASES = {
  LOBBY: 'LOBBY',
  SETUP_ROUND_1: 'SETUP_ROUND_1',
  SETUP_ROUND_2: 'SETUP_ROUND_2',
  TURN_ROLL: 'TURN_ROLL',
  TURN_DISCARD: 'TURN_DISCARD',
  TURN_ROBBER: 'TURN_ROBBER',
  TURN_ACTION: 'TURN_ACTION',
  TURN_BARBARIAN_RESOLVE: 'TURN_BARBARIAN_RESOLVE',
  TURN_BARBARIAN_DOWNGRADE: 'TURN_BARBARIAN_DOWNGRADE',
  TURN_BARBARIAN_REWARD: 'TURN_BARBARIAN_REWARD',
  TURN_CHOOSE_METROPOLIS: 'TURN_CHOOSE_METROPOLIS',
  TURN_CHOOSE_KNIGHT_RELOCATE: 'TURN_CHOOSE_KNIGHT_RELOCATE',
  GAME_OVER: 'GAME_OVER'
};

export const EVENT_DIE_FACES = ['barbarian', 'barbarian', 'barbarian', 'trade', 'politics', 'science'];
export const BARBARIAN_TRACK_MAX = 7;
export const CITY_WALL_SUPPLY = 3;

export const KNIGHT_RANKS = {
  basic: { strength: 1, next: 'strong', politicsRequired: 0 },
  strong: { strength: 2, next: 'mighty', politicsRequired: 1 },
  mighty: { strength: 3, next: null, politicsRequired: 2 }
};

export const COSTS = {
  ROAD: { wood: 1, brick: 1 },
  SETTLEMENT: { wood: 1, brick: 1, wool: 1, wheat: 1 },
  CITY: { ore: 3, wheat: 2 },
  DEV_CARD: { ore: 1, wool: 1, wheat: 1 },
  KNIGHT: { ore: 1, wool: 1 },
  ACTIVATE_KNIGHT: { wheat: 1 },
  PROMOTE_KNIGHT: { ore: 1, wool: 1 },
  CITY_WALL: { brick: 2 },
  MEDICINE_CITY: { ore: 2, wheat: 1 }
};

export const DEV_CARD_TYPES = {
  KNIGHT: 'knight',
  VICTORY_POINT: 'victory_point',
  ROAD_BUILDING: 'road_building',
  YEAR_OF_PLENTY: 'year_of_plenty',
  MONOPOLY: 'monopoly'
};

// How long players have to choose discard cards after a 7 before auto discard kicks in
export const DISCARD_TIMEOUT_MS = 30000;

export class GameEngine {
  constructor(options = {}) {
    this.roomId = options.roomId || 'default-room';
    this.mode = normalizeGameMode(options.mode);
    this.vpTarget = options.vpTarget || (this.mode === GAME_MODES.CITIES_KNIGHTS ? 13 : 10);
    this.turnDuration = options.turnDuration || 60; // seconds

    this.players = []; // array of player objects
    this.currentTurnPlayerIndex = 0;
    this.turnNumber = 1;
    this.phase = GAME_PHASES.LOBBY;
    this.grid = null;

    this.dice = [1, 1];
    this.eventDie = null;
    this.hasRolledDice = false;
    this.devCardPlayedThisTurn = false;

    // Cities & Knights shared state (serialized even in base mode as empty/defaults)
    this.barbarianPosition = 0;
    this.defenderOfCatan = null;
    this.pendingBarbarianDowngrades = new Set();
    this.pendingBarbarianTieDraws = new Set();
    this.pendingProgressCardColor = null;
    this.pendingProgressDraws = [];
    this.lastBarbarianResult = null;
    this.postBarbarianPhase = null;
    this.progressDecks = { trade: [], politics: [], science: [] };
    this.merchantHolder = null;
    this.merchantHexId = null;
    this.pendingProgressDiscard = new Set();
    this.alchemistDice = null;
    this.metropolises = { trade: null, politics: null, science: null };
    this.pendingMetropolisChoice = null;
    this.pendingKnightRelocation = null;
    this.previousPhase = null;
    this.pendingAqueductClaims = new Set();
    this.claimedAqueductThisRoll = new Set();

    // Discard tracking for 7-roll
    this.pendingDiscards = new Set(); // playerIds needing to discard
    this.discardDeadline = null; // timestamp by which pending players must discard

    // Trade state
    this.activeTrade = null; // { fromPlayerId, give, want, responses: { [playerId]: boolean } }
    this.lastTradeEvent = null;

    // Road building state
    this.freeRoadsRemaining = 0;

    // Dev card deck
    this.devCardDeck = [];
    this.initDevCardDeck();

    // Special awards
    this.longestRoadHolder = null; // { playerId, length }
    this.largestArmyHolder = null; // { playerId, count }

    // Event history
    this.eventLog = [];
  }

  initDevCardDeck() {
    this.devCardDeck = [];
    // C&K replaces the base development deck with progress cards (CK-05/06/07).
    if (this.isCitiesKnights()) return;
    // 14 Knights
    for (let i = 0; i < 14; i++) this.devCardDeck.push(DEV_CARD_TYPES.KNIGHT);
    // 5 Victory points
    for (let i = 0; i < 5; i++) this.devCardDeck.push(DEV_CARD_TYPES.VICTORY_POINT);
    // 2 Road building
    for (let i = 0; i < 2; i++) this.devCardDeck.push(DEV_CARD_TYPES.ROAD_BUILDING);
    // 2 Year of plenty
    for (let i = 0; i < 2; i++) this.devCardDeck.push(DEV_CARD_TYPES.YEAR_OF_PLENTY);
    // 2 Monopoly
    for (let i = 0; i < 2; i++) this.devCardDeck.push(DEV_CARD_TYPES.MONOPOLY);

    // Shuffle
    for (let i = this.devCardDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.devCardDeck[i], this.devCardDeck[j]] = [this.devCardDeck[j], this.devCardDeck[i]];
    }
  }

  addPlayer(player) {
    if (this.players.find(p => p.id === player.id)) return false;
    this.players.push({
      id: player.id,
      name: player.name,
      color: player.color || this.getAvailableColor(),
      isBot: Boolean(player.isBot),
      botDifficulty: player.botDifficulty || 'medium',
      resources: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 },
      commodities: { cloth: 0, coin: 0, paper: 0 },
      cityImprovements: { trade: 0, politics: 0, science: 0 },
      knightsAvailable: { basic: 2, strong: 2, mighty: 1 },
      knightsPlaced: [],
      cityWalls: CITY_WALL_SUPPLY, // remaining walls in supply (CK-01 / CK-08 count model)
      metropolis: { trade: false, politics: false, science: false },
      progressCards: [],
      merchantFleetActive: false,
      devCards: [], // { type, boughtTurn, played }
      playedKnights: 0,
      settlementsRemaining: 5,
      citiesRemaining: 4,
      roadsRemaining: 15,
      roadsBuilt: [],
      settlementsBuilt: [],
      citiesBuilt: [],
      defenderCards: 0,
      victoryPoints: 0,
      publicVictoryPoints: 0
    });
    return true;
  }

  removePlayer(playerId) {
    const index = this.players.findIndex(p => p.id === playerId);
    if (index === -1) return false;

    this.players.splice(index, 1);

    // If removed player was active trade initiator or accepted, clean up
    if (this.activeTrade) {
      if (this.activeTrade.fromPlayerId === playerId) {
        this.activeTrade = null;
      } else {
        this.activeTrade.acceptedBy.delete(playerId);
        this.activeTrade.declinedBy?.delete(playerId);
      }
    }
    this.pendingDiscards.delete(playerId);
    this.pendingBarbarianDowngrades.delete(playerId);
    if (this.pendingBarbarianTieDraws) {
      this.pendingBarbarianTieDraws.delete(playerId);
      if (this.phase === GAME_PHASES.TURN_BARBARIAN_REWARD && this.pendingBarbarianTieDraws.size === 0) {
        this.continueAfterBarbarian();
      }
    }
    if (this.pendingProgressDiscard) {
      this.pendingProgressDiscard.delete(playerId);
    }
    this.pendingAqueductClaims?.delete(playerId);
    this.claimedAqueductThisRoll?.delete(playerId);

    // Clean up interrupted phases if removed player was the decider
    if (this.pendingMetropolisChoice && this.pendingMetropolisChoice.playerId === playerId) {
      this.pendingMetropolisChoice = null;
      if (this.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
        this.phase = this.previousPhase || GAME_PHASES.TURN_ACTION;
        this.previousPhase = null;
      }
    }

    if (this.pendingKnightRelocation && this.pendingKnightRelocation.playerId === playerId) {
      this.pendingKnightRelocation = null;
      if (this.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
        this.phase = this.previousPhase || GAME_PHASES.TURN_ACTION;
        this.previousPhase = null;
      }
    }

    // If removed during setup, reset setupStep so next player starts with settlement
    if (this.phase === GAME_PHASES.SETUP_ROUND_1 || this.phase === GAME_PHASES.SETUP_ROUND_2) {
      this.setupStep = 'settlement';
      this.lastSetupSettlementVertex = null;
    }

    // Adjust turn player index if needed
    if (this.players.length > 0) {
      if (index < this.currentTurnPlayerIndex) {
        this.currentTurnPlayerIndex--;
      } else if (this.currentTurnPlayerIndex >= this.players.length) {
        this.currentTurnPlayerIndex = 0;
      }
    } else {
      this.currentTurnPlayerIndex = 0;
    }

    // Clean up Longest Road & Largest Army if held by removed player
    if (this.longestRoadHolder && this.longestRoadHolder.playerId === playerId) {
      this.longestRoadHolder = null;
      this.recalculateLongestRoad();
    }
    if (this.largestArmyHolder && this.largestArmyHolder.playerId === playerId) {
      this.largestArmyHolder = null;
      this.recalculateLargestArmy();
    }
    this.recalculateVictoryPoints();

    return true;
  }

  getAvailableColor() {
    const colors = ['#e63946', '#1d3557', '#e76f51', '#2a9d8f', '#9b5de5', '#00b4d8', '#f4a261', '#f1faee'];
    const used = this.players.map(p => p.color);
    return colors.find(c => !used.includes(c)) || '#f1faee';
  }

  startGame(mapSize) {
    if (this.players.length < 2) {
      throw new Error('At least 2 players needed to start');
    }

    this.grid = new HexGrid({
      playerCount: this.players.length,
      mapSize: mapSize || (this.players.length <= 4 ? 'standard' : this.players.length <= 6 ? 'extended' : 'large')
    });

    this.phase = GAME_PHASES.SETUP_ROUND_1;
    this.currentTurnPlayerIndex = 0;
    this.setupStep = 'settlement'; // 'settlement' or 'road'
    this.lastSetupSettlementVertex = null;

    this.logEvent({
      type: 'GAME_STARTED',
      messageKey: 'LOG_GAME_STARTED',
      args: { playersCount: this.players.length }
    });

    if (this.isCitiesKnights()) this.initProgressCardDecks();

    return true;
  }

  getCurrentPlayer() {
    return this.players[this.currentTurnPlayerIndex];
  }

  logEvent(event) {
    const entry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      ...event
    };
    this.eventLog.push(entry);
    if (this.eventLog.length > 100) this.eventLog.shift();
    return entry;
  }

  buildRobberMovedLog(playerName, hexId) {
    const hex = this.grid.hexes.get(hexId);
    const isDesert = !hex || hex.resource === RESOURCE_TYPES.DESERT || hex.token == null;
    if (isDesert) {
      return {
        type: 'ROBBER_MOVED',
        messageKey: 'LOG_ROBBER_MOVED_DESERT',
        args: { playerName }
      };
    }
    return {
      type: 'ROBBER_MOVED',
      messageKey: 'LOG_ROBBER_MOVED',
      args: { playerName, number: hex.token }
    };
  }

  /* =========================================================
   * VALIDATIONS & RULES
   * ========================================================= */

  canBuildSettlement(playerId, vertexId, isSetup = false) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.settlementsRemaining <= 0) return { ok: false, reason: 'NO_SETTLEMENTS_LEFT' };

    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex || vertex.building || vertex.knight) return { ok: false, reason: 'VERTEX_OCCUPIED' };

    // Distance rule: no settlement/city/knight on adjacent vertices
    if (this.violatesDistanceRule(vertexId)) {
      return { ok: false, reason: 'DISTANCE_RULE_VIOLATION' };
    }

    if (isSetup) {
      return { ok: true };
    }

    // Normal game: must connect to a player's road
    let hasConnectingRoad = false;
    for (const edgeId of vertex.adjacentEdges) {
      const edge = this.grid.edges.get(edgeId);
      if (edge && edge.road && edge.road.playerId === playerId) {
        hasConnectingRoad = true;
        break;
      }
    }

    if (!hasConnectingRoad) {
      return { ok: false, reason: 'MUST_CONNECT_TO_ROAD' };
    }

    // Cost check
    if (!this.hasResources(player, COSTS.SETTLEMENT)) {
      return { ok: false, reason: 'NOT_ENOUGH_RESOURCES' };
    }

    return { ok: true };
  }

  canBuildRoad(playerId, edgeId, isSetup = false, setupSettlementVertexId = null) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.roadsRemaining <= 0) return { ok: false, reason: 'NO_ROADS_LEFT' };

    const edge = this.grid.edges.get(edgeId);
    if (!edge || edge.road) return { ok: false, reason: 'EDGE_OCCUPIED' };

    if (isSetup) {
      // Must connect to the settlement placed right before
      if (setupSettlementVertexId) {
        if (edge.v1 === setupSettlementVertexId || edge.v2 === setupSettlementVertexId) {
          return { ok: true };
        }
        return { ok: false, reason: 'MUST_CONNECT_TO_SETUP_SETTLEMENT' };
      }
      return { ok: true };
    }

    // Normal game: must connect to own road or own building
    let connects = false;
    const v1 = this.grid.vertices.get(edge.v1);
    const v2 = this.grid.vertices.get(edge.v2);

    if ((v1.building && v1.building.playerId === playerId) || (v2.building && v2.building.playerId === playerId)) {
      connects = true;
    }

    if (!connects) {
      for (const adjEdgeId of edge.adjacentEdges) {
        const adjEdge = this.grid.edges.get(adjEdgeId);
        if (adjEdge && adjEdge.road && adjEdge.road.playerId === playerId) {
          // Check if an opponent's settlement/city or knight blocks this intersection
          const sharedVertexId = (edge.v1 === adjEdge.v1 || edge.v1 === adjEdge.v2) ? edge.v1 : edge.v2;
          const sharedVertex = this.grid.vertices.get(sharedVertexId);
          const blockedByBuilding = sharedVertex.building && sharedVertex.building.playerId !== playerId;
          const blockedByKnight = sharedVertex.knight && sharedVertex.knight.playerId !== playerId;
          if (!blockedByBuilding && !blockedByKnight) {
            connects = true;
            break;
          }
        }
      }
    }

    if (!connects) {
      return { ok: false, reason: 'MUST_CONNECT_TO_NETWORK' };
    }

    if (this.freeRoadsRemaining > 0) {
      return { ok: true, isFree: true };
    }

    if (!this.hasResources(player, COSTS.ROAD)) {
      return { ok: false, reason: 'NOT_ENOUGH_RESOURCES' };
    }

    return { ok: true };
  }

  canBuildCity(playerId, vertexId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.citiesRemaining <= 0) return { ok: false, reason: 'NO_CITIES_LEFT' };

    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex || !vertex.building || vertex.building.type !== 'settlement' || vertex.building.playerId !== playerId) {
      return { ok: false, reason: 'MUST_UPGRADE_OWN_SETTLEMENT' };
    }

    if (!this.hasResources(player, player.medicineActive ? COSTS.MEDICINE_CITY : COSTS.CITY)) {
      return { ok: false, reason: 'NOT_ENOUGH_RESOURCES' };
    }

    return { ok: true };
  }

  canBuyDevCard(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
    if (this.isCitiesKnights()) return { ok: false, reason: 'DEV_CARDS_DISABLED_IN_CK' };
    if (this.devCardDeck.length === 0) return { ok: false, reason: 'DECK_EMPTY' };
    if (!this.hasResources(player, COSTS.DEV_CARD)) return { ok: false, reason: 'NOT_ENOUGH_RESOURCES' };
    return { ok: true };
  }

  violatesDistanceRule(vertexId, ignoreVertexIds = []) {
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex) return true;
    const ignored = new Set(ignoreVertexIds);
    for (const adjVId of vertex.adjacentVertices) {
      if (ignored.has(adjVId)) continue;
      const adjVertex = this.grid.vertices.get(adjVId);
      if (adjVertex && adjVertex.building) return true;
    }
    return false;
  }

  vertexHasPlayerRoad(vertex, playerId) {
    for (const edgeId of vertex.adjacentEdges) {
      const edge = this.grid.edges.get(edgeId);
      if (edge && edge.road && edge.road.playerId === playerId) return true;
    }
    return false;
  }

  listLegalKnightPlacementVertices(playerId) {
    const ids = [];
    for (const [vid, v] of this.grid.vertices) {
      if (v.building || v.knight) continue;
      if (!this.vertexHasPlayerRoad(v, playerId)) continue;
      ids.push(vid);
    }
    return ids;
  }

  verticesSharePlayerRoad(fromId, toId, playerId) {
    const from = this.grid.vertices.get(fromId);
    if (!from) return false;
    for (const edgeId of from.adjacentEdges) {
      const edge = this.grid.edges.get(edgeId);
      if (!edge || !edge.road || edge.road.playerId !== playerId) continue;
      if (edge.v1 === toId || edge.v2 === toId) return true;
    }
    return false;
  }

  hasResources(player, cost) {
    for (const [res, amount] of Object.entries(cost)) {
      if ((player.resources[res] || 0) < amount) return false;
    }
    return true;
  }

  deductResources(player, cost) {
    for (const [res, amount] of Object.entries(cost)) {
      player.resources[res] -= amount;
    }
  }

  addResources(player, resources) {
    for (const [res, amount] of Object.entries(resources)) {
      player.resources[res] = (player.resources[res] || 0) + amount;
    }
  }

  isCitiesKnights() {
    return this.mode === GAME_MODES.CITIES_KNIGHTS;
  }

  countCommodities(player) {
    if (!player.commodities) return 0;
    return Object.values(player.commodities).reduce((sum, count) => sum + count, 0);
  }

  countResources(player) {
    return Object.values(player.resources || {}).reduce((sum, count) => sum + count, 0);
  }

  countTotalCards(player) {
    return this.countResources(player) + this.countCommodities(player);
  }

  forceDiscardHalfFromLargestStacks(player) {
    const need = Math.floor(this.countTotalCards(player) / 2);
    if (need <= 0) return {};
    const discarded = {};
    let left = need;
    while (left > 0) {
      let maxKey = null;
      let maxCount = -1;
      const consider = (bag) => {
        for (const [key, count] of Object.entries(bag || {})) {
          const remaining = count - (discarded[key] || 0);
          if (remaining > maxCount && remaining > 0) {
            maxCount = remaining;
            maxKey = key;
          }
        }
      };
      consider(player.resources);
      consider(player.commodities);
      if (!maxKey) break;
      discarded[maxKey] = (discarded[maxKey] || 0) + 1;
      left--;
    }
    for (const [type, n] of Object.entries(discarded)) {
      this.adjustPlayerCard(player, type, -n);
    }
    return discarded;
  }

  getBuiltCityWallCount(player) {
    let walls = 0;
    for (const vid of player.citiesBuilt || []) {
      const vertex = this.grid?.vertices.get(vid);
      if (vertex?.building?.hasWall) walls++;
    }
    return walls;
  }

  getDiscardThreshold(player) {
    return 7 + this.getBuiltCityWallCount(player) * 2;
  }

  playerBuildingTouchesHex(player, hexId) {
    const ids = (player.settlementsBuilt || []).concat(player.citiesBuilt || []);
    return ids.some((vid) => this.grid.vertices.get(vid)?.hexes?.includes(hexId));
  }

  getPlayersAdjacentToHex(hexId) {
    const seen = new Set();
    const adjacent = [];
    for (const vertex of this.grid.vertices.values()) {
      if (!vertex.hexes?.includes(hexId) || !vertex.building) continue;
      const owner = this.players.find(p => p.id === vertex.building.playerId);
      if (!owner || seen.has(owner.id)) continue;
      seen.add(owner.id);
      adjacent.push(owner);
    }
    return adjacent;
  }

  stealRandomResource(target) {
    const pool = [];
    for (const [res, count] of Object.entries(target.resources || {})) {
      for (let i = 0; i < count; i++) pool.push({ bag: 'resources', type: res });
    }
    if (this.isCitiesKnights()) {
      for (const [com, count] of Object.entries(target.commodities || {})) {
        for (let i = 0; i < count; i++) pool.push({ bag: 'commodities', type: com });
      }
    }
    if (pool.length === 0) return null;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    if (picked.bag === 'commodities') {
      target.commodities[picked.type]--;
    } else {
      target.resources[picked.type]--;
    }
    return picked.type;
  }

  isOpenRoad(edgeId) {
    const edge = this.grid.edges.get(edgeId);
    if (!edge?.road) return false;
    const ownerId = edge.road.playerId;

    const isEndClosed = (vertexId) => {
      const vertex = this.grid.vertices.get(vertexId);
      if (!vertex) return false;
      if (vertex.building && vertex.building.playerId === ownerId) return true;
      for (const adjId of vertex.adjacentEdges || []) {
        if (adjId === edgeId) continue;
        const adj = this.grid.edges.get(adjId);
        if (adj?.road?.playerId === ownerId) return true;
      }
      return false;
    };

    return !isEndClosed(edge.v1) || !isEndClosed(edge.v2);
  }

  removeRoadSegment(edgeId) {
    const edge = this.grid.edges.get(edgeId);
    if (!edge?.road) throw new Error('NO_ROAD');
    const owner = this.players.find(p => p.id === edge.road.playerId);
    edge.road = null;
    if (owner) {
      owner.roadsRemaining++;
      owner.roadsBuilt = (owner.roadsBuilt || []).filter(id => id !== edgeId);
    }
    this.recalculateLongestRoad();
    this.recalculateVictoryPoints();
    return owner;
  }

  playerControlsAdjacentVertex(playerId, vertexId) {
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex) return false;
    for (const adjId of vertex.adjacentVertices || []) {
      const adj = this.grid.vertices.get(adjId);
      if (adj?.building?.playerId === playerId) return true;
      if (adj?.knight?.playerId === playerId) return true;
    }
    return this.vertexHasPlayerRoad(vertex, playerId);
  }

  isTradableType(type) {
    if (RESOURCE_VALUES.includes(type)) return true;
    return this.isCitiesKnights() && COMMODITY_VALUES.includes(type);
  }

  getPlayerCardCount(player, type) {
    if (COMMODITY_VALUES.includes(type)) return player.commodities?.[type] || 0;
    return player.resources?.[type] || 0;
  }

  adjustPlayerCard(player, type, delta) {
    if (COMMODITY_VALUES.includes(type)) {
      player.commodities[type] = (player.commodities[type] || 0) + delta;
      return;
    }
    player.resources[type] = (player.resources[type] || 0) + delta;
  }

  getProgressCardEligiblePlayers(track, dieNumber) {
    return this.players.filter(p => (p.cityImprovements?.[track] || 0) >= dieNumber);
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  initProgressCardDecks() {
    this.progressDecks = { trade: [], politics: [], science: [] };
    for (const [deck, cards] of Object.entries(PROGRESS_CARD_DECKS)) {
      for (const card of cards) {
        for (let i = 0; i < card.count; i++) {
          this.progressDecks[deck].push({ type: card.type, id: `${deck}-${card.type}-${i}` });
        }
      }
      this.shuffle(this.progressDecks[deck]);
    }
  }

  countUnplayedProgressCards(player) {
    return (player.progressCards || []).filter(c => !c.played).length;
  }

  getActiveKnightStrength(player) {
    return (player.knightsPlaced || []).reduce((sum, k) => sum + (k.active ? k.strength : 0), 0);
  }

  /* =========================================================
   * GAME SETUP ACTIONS
   * ========================================================= */

  placeSetupSettlement(playerId, vertexId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.setupStep !== 'settlement') throw new Error('EXPECTED_ROAD_PLACEMENT');

    const placeCity = this.isCitiesKnights() && this.phase === GAME_PHASES.SETUP_ROUND_2;
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex || vertex.building || vertex.knight) throw new Error('VERTEX_OCCUPIED');
    if (this.violatesDistanceRule(vertexId)) throw new Error('DISTANCE_RULE_VIOLATION');
    if (placeCity) {
      if ((player.citiesRemaining || 0) <= 0) throw new Error('NO_CITIES_LEFT');
    } else {
      const check = this.canBuildSettlement(playerId, vertexId, true);
      if (!check.ok) throw new Error(check.reason);
    }

    if (placeCity) {
      vertex.building = { type: 'city', playerId, color: player.color };
      player.citiesRemaining--;
      player.citiesBuilt.push(vertexId);
    } else {
      vertex.building = { type: 'settlement', playerId, color: player.color };
      player.settlementsRemaining--;
      player.settlementsBuilt.push(vertexId);
    }
    this.lastSetupSettlementVertex = vertexId;
    this.setupStep = 'road';

    // If second round, award bootstrap from adjacent hexes (C&K cities use city production)
    if (this.phase === GAME_PHASES.SETUP_ROUND_2) {
      const production = { [player.id]: {} };
      for (const hexId of vertex.hexes) {
        const hex = this.grid.hexes.get(hexId);
        if (hex && hex.resource && hex.resource !== RESOURCE_TYPES.DESERT) {
          this.applyHexProduction(player, hex.resource, vertex.building.type, production);
        }
      }
      this.logEvent({
        type: 'BOOTSTRAP_RESOURCES',
        messageKey: 'LOG_BOOTSTRAP_RESOURCES',
        args: { playerName: player.name, resources: production[player.id] }
      });
    }

    this.recalculateVictoryPoints();
    this.logEvent({
      type: placeCity ? 'BUILD_CITY' : 'BUILD_SETTLEMENT',
      messageKey: placeCity ? 'LOG_SETUP_CITY' : 'LOG_BUILT_SETTLEMENT',
      args: { playerName: player.name }
    });

    return { vertexId };
  }

  placeSetupRoad(playerId, edgeId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.setupStep !== 'road') throw new Error('EXPECTED_SETTLEMENT_PLACEMENT');

    const check = this.canBuildRoad(playerId, edgeId, true, this.lastSetupSettlementVertex);
    if (!check.ok) throw new Error(check.reason);

    const edge = this.grid.edges.get(edgeId);
    edge.road = { playerId, color: player.color };
    player.roadsRemaining--;
    player.roadsBuilt.push(edgeId);

    this.logEvent({
      type: 'BUILD_ROAD',
      messageKey: 'LOG_BUILT_ROAD',
      args: { playerName: player.name }
    });

    // Advance snake draft
    this.advanceSetupTurn();
    return { edgeId };
  }

  advanceSetupTurn() {
    this.setupStep = 'settlement';
    this.lastSetupSettlementVertex = null;

    if (this.phase === GAME_PHASES.SETUP_ROUND_1) {
      if (this.currentTurnPlayerIndex < this.players.length - 1) {
        this.currentTurnPlayerIndex++;
      } else {
        // Switch to Round 2, same player (last player) goes first
        this.phase = GAME_PHASES.SETUP_ROUND_2;
      }
    } else if (this.phase === GAME_PHASES.SETUP_ROUND_2) {
      if (this.currentTurnPlayerIndex > 0) {
        this.currentTurnPlayerIndex--;
      } else {
        // Setup complete, start normal turn 1
        this.phase = GAME_PHASES.TURN_ROLL;
        this.currentTurnPlayerIndex = 0;
        this.hasRolledDice = false;
        this.devCardPlayedThisTurn = false;
        this.logEvent({
          type: 'SETUP_COMPLETED',
          messageKey: 'LOG_SETUP_COMPLETED',
          args: { startingPlayer: this.getCurrentPlayer().name }
        });
      }
    }
  }

  /* =========================================================
   * NORMAL TURN ACTIONS
   * ========================================================= */

  rollDice(playerId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ROLL) throw new Error('NOT_IN_ROLL_PHASE');

    const d1 = this.alchemistDice ? this.alchemistDice[0] : Math.floor(Math.random() * 6) + 1;
    const d2 = this.alchemistDice ? this.alchemistDice[1] : Math.floor(Math.random() * 6) + 1;
    this.alchemistDice = null;
    this.dice = [d1, d2];
    const rollSum = d1 + d2;
    this.hasRolledDice = true;
    this.clearAqueductRoll();
    this.eventDie = null;
    this.pendingProgressCardColor = null;
    this.pendingProgressDraws = [];
    this.lastBarbarianResult = null;
    this.postBarbarianPhase = null;

    if (this.isCitiesKnights()) {
      this.eventDie = EVENT_DIE_FACES[Math.floor(Math.random() * EVENT_DIE_FACES.length)];
      if (this.eventDie === 'barbarian') {
        this.barbarianPosition = Math.min(BARBARIAN_TRACK_MAX, this.barbarianPosition + 1);
        this.logEvent({
          type: 'BARBARIAN_ADVANCED',
          messageKey: 'LOG_BARBARIAN_ADVANCED',
          args: { position: this.barbarianPosition }
        });
      } else {
        this.pendingProgressCardColor = this.eventDie;
      }
    }

    this.logEvent({
      type: 'DICE_ROLLED',
      messageKey: 'LOG_DICE_ROLLED',
      args: { playerName: player.name, d1, d2, sum: rollSum, eventDie: this.eventDie }
    });

    let production = {};
    const robber = rollSum === 7;

    if (robber) {
      this.queueDiscardsForSeven();
    } else {
      production = this.produceForRoll(rollSum);
      if (this.isCitiesKnights()) {
        this.applyAqueductBenefit(production);
      }
      this.logProductionEvents(production, rollSum);
    }

    if (this.pendingProgressCardColor) {
      this.distributeProgressCardDraws(this.pendingProgressCardColor, d1);
    }

    if (this.isCitiesKnights() && this.barbarianPosition >= BARBARIAN_TRACK_MAX) {
      this.postBarbarianPhase = robber
        ? (this.pendingDiscards.size > 0 ? GAME_PHASES.TURN_DISCARD : GAME_PHASES.TURN_ROBBER)
        : GAME_PHASES.TURN_ACTION;
      const attack = this.resolveBarbarianAttack();
      return {
        dice: this.dice,
        eventDie: this.eventDie,
        sum: rollSum,
        produces: production,
        robber,
        barbarian: attack,
        progressDraws: this.pendingProgressDraws
      };
    }

    if (robber) {
      this.enterRobberFlow();
    } else {
      this.phase = GAME_PHASES.TURN_ACTION;
    }

    return {
      dice: this.dice,
      eventDie: this.eventDie,
      sum: rollSum,
      produces: production,
      robber,
      barbarian: this.lastBarbarianResult,
      progressDraws: this.pendingProgressDraws
    };
  }

  queueDiscardsForSeven() {
    this.pendingDiscards.clear();
    for (const p of this.players) {
      if (this.countTotalCards(p) > this.getDiscardThreshold(p)) {
        this.pendingDiscards.add(p.id);
      }
    }
  }

  enterRobberFlow() {
    if (this.pendingDiscards.size > 0) {
      this.phase = GAME_PHASES.TURN_DISCARD;
      this.discardDeadline = Date.now() + DISCARD_TIMEOUT_MS;
      this.logEvent({
        type: 'DISCARD_REQUIRED',
        messageKey: 'LOG_DISCARD_REQUIRED',
        args: { playerIds: Array.from(this.pendingDiscards) }
      });
    } else {
      this.phase = GAME_PHASES.TURN_ROBBER;
      this.discardDeadline = null;
    }
  }

  produceForRoll(rollSum) {
    const production = {};
    for (const p of this.players) production[p.id] = {};

    for (const hex of this.grid.hexes.values()) {
      if (hex.token === rollSum && hex.id !== this.grid.robberHexId && hex.resource !== RESOURCE_TYPES.DESERT) {
        for (const vertex of this.grid.vertices.values()) {
          if (vertex.hexes.includes(hex.id) && vertex.building) {
            const bPlayer = this.players.find(p => p.id === vertex.building.playerId);
            if (bPlayer) {
              this.applyHexProduction(bPlayer, hex.resource, vertex.building.type, production);
            }
          }
        }
      }
    }
    return production;
  }

  logProductionEvents(production, rollSum) {
    let anyProduced = false;
    for (const p of this.players) {
      const pProd = production[p.id];
      const resTypes = Object.keys(pProd).filter(r => pProd[r] > 0);
      if (resTypes.length > 0) {
        anyProduced = true;
        for (const res of resTypes) {
          this.logEvent({
            type: 'RESOURCE_PRODUCED',
            messageKey: 'LOG_RESOURCE_PRODUCED',
            args: {
              playerName: p.name,
              amount: pProd[res],
              resource: res
            }
          });
        }
      }
    }
    if (!anyProduced) {
      this.logEvent({
        type: 'NO_RESOURCE_PRODUCED',
        messageKey: 'LOG_NO_RESOURCE_PRODUCED',
        args: { sum: rollSum }
      });
    }
  }

  hasAqueduct(player) {
    return this.isCitiesKnights() && (player?.cityImprovements?.science || 0) >= AQUEDUCT_UNLOCK_LEVEL;
  }

  clearAqueductRoll() {
    this.pendingAqueductClaims = this.pendingAqueductClaims || new Set();
    this.claimedAqueductThisRoll = this.claimedAqueductThisRoll || new Set();
    this.pendingAqueductClaims.clear();
    this.claimedAqueductThisRoll.clear();
  }

  countProductionCards(pProd = {}) {
    return Object.values(pProd).reduce((sum, n) => sum + (Number(n) || 0), 0);
  }

  armAqueductEligibility(production = {}) {
    this.pendingAqueductClaims = this.pendingAqueductClaims || new Set();
    this.claimedAqueductThisRoll = this.claimedAqueductThisRoll || new Set();
    this.pendingAqueductClaims.clear();
    if (!this.isCitiesKnights()) return;
    for (const player of this.players) {
      if (!this.hasAqueduct(player)) continue;
      if (this.claimedAqueductThisRoll.has(player.id)) continue;
      const producedCount = this.countProductionCards(production[player.id]);
      if (producedCount === 0) this.pendingAqueductClaims.add(player.id);
    }
  }

  grantAqueductResource(playerId, resource, production = null) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    player.resources[resource] = (player.resources[resource] || 0) + 1;
    if (production) {
      if (!production[player.id]) production[player.id] = {};
      production[player.id][resource] = (production[player.id][resource] || 0) + 1;
    }
    this.pendingAqueductClaims.delete(player.id);
    this.claimedAqueductThisRoll.add(player.id);
    this.logEvent({
      type: 'AQUEDUCT_RESOURCE',
      messageKey: 'LOG_AQUEDUCT_RESOURCE',
      args: { playerName: player.name, resource }
    });
    return resource;
  }

  /**
   * Arms pending Aqueduct claims for blank non-7 production.
   * Does NOT auto-grant: humans use claimAqueductResource / the chooser;
   * bots and timeouts resolve via BotAI.resolvePendingAqueductClaims.
   * Optional `choices` map still grants immediately (tests / explicit callers).
   */
  applyAqueductBenefit(production, choices = {}) {
    this.armAqueductEligibility(production);
    const results = {};
    for (const playerId of Array.from(this.pendingAqueductClaims)) {
      const chosenRes = choices[playerId];
      if (!chosenRes || !RESOURCE_VALUES.includes(chosenRes)) continue;
      results[playerId] = this.grantAqueductResource(playerId, chosenRes, production);
    }
    return results;
  }

  claimAqueductResource(playerId, resource) {
    if (!RESOURCE_VALUES.includes(resource)) throw new Error('INVALID_RESOURCE');
    if (!this.isCitiesKnights()) throw new Error('NOT_CITIES_KNIGHTS_MODE');
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    if (!this.hasAqueduct(player)) throw new Error('AQUEDUCT_NOT_UNLOCKED');
    if (this.claimedAqueductThisRoll?.has(playerId)) throw new Error('AQUEDUCT_ALREADY_CLAIMED');
    const rollSum = (this.dice?.[0] || 0) + (this.dice?.[1] || 0);
    const qualifyingRoll = this.hasRolledDice && rollSum !== 7;
    if (!qualifyingRoll || !this.pendingAqueductClaims?.has(playerId)) {
      throw new Error('AQUEDUCT_NOT_ELIGIBLE');
    }
    const granted = this.grantAqueductResource(playerId, resource);
    return { resource: granted };
  }

  distributeProgressCardDraws(track, redDie) {
    const eligible = this.getProgressCardEligiblePlayers(track, redDie);
    this.pendingProgressDraws = eligible.map(p => {
      const drawn = this.drawProgressCard(p, track);
      return { playerId: p.id, track, drawn: Boolean(drawn), cardType: drawn };
    });
    if (eligible.length) {
      this.logEvent({
        type: 'PROGRESS_CARD_CHECK',
        messageKey: 'LOG_PROGRESS_CARD_CHECK',
        args: { track, redDie, playerIds: eligible.map(p => p.id) }
      });
    }
  }

  drawProgressCard(player, track) {
    const deck = this.progressDecks?.[track];
    if (!deck || deck.length === 0) return null;
    const card = deck.pop();
    const type = card.type || card;
    const isVp = ['constitution', 'printer'].includes(type);
    player.progressCards.push({
      id: card.id || `prog_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type,
      track,
      played: isVp,
      revealed: isVp,
      boughtTurn: this.turnNumber
    });
    if (isVp) {
      this.recalculateVictoryPoints();
    }
    if (this.countUnplayedProgressCards(player) > PROGRESS_CARD_HAND_LIMIT) {
      this.pendingProgressDiscard.add(player.id);
    }
    return type;
  }

  discardProgressCard(playerId, cardId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    if (!this.pendingProgressDiscard.has(playerId)) throw new Error('NO_PROGRESS_DISCARD_NEEDED');
    const idx = player.progressCards.findIndex(c => c.id === cardId && !c.played);
    if (idx === -1) throw new Error('CARD_NOT_FOUND');
    player.progressCards.splice(idx, 1);
    if (this.countUnplayedProgressCards(player) <= PROGRESS_CARD_HAND_LIMIT) {
      this.pendingProgressDiscard.delete(playerId);
    }
    return { remaining: this.countUnplayedProgressCards(player) };
  }

  applyHexProduction(player, hexResource, buildingType, production) {
    const isCity = buildingType === 'city' || buildingType === 'metropolis';
    const commodity = this.isCitiesKnights() ? RESOURCE_TO_COMMODITY[hexResource] : null;

    if (isCity && commodity) {
      player.resources[hexResource] = (player.resources[hexResource] || 0) + 1;
      player.commodities[commodity] = (player.commodities[commodity] || 0) + 1;
      production[player.id][hexResource] = (production[player.id][hexResource] || 0) + 1;
      production[player.id][commodity] = (production[player.id][commodity] || 0) + 1;
      return;
    }

    const amount = isCity ? 2 : 1;
    player.resources[hexResource] = (player.resources[hexResource] || 0) + amount;
    production[player.id][hexResource] = (production[player.id][hexResource] || 0) + amount;
  }

  discardCards(playerId, discarded) {
    if (this.phase !== GAME_PHASES.TURN_DISCARD) throw new Error('NOT_IN_DISCARD_PHASE');
    if (!this.pendingDiscards.has(playerId)) throw new Error('NO_DISCARD_NEEDED');
    if (!discarded || typeof discarded !== 'object') throw new Error('INVALID_DISCARD_DATA');

    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    const totalBefore = this.countTotalCards(player);
    const requiredDiscard = Math.floor(totalBefore / 2);

    let discardedCount = 0;
    for (const [cardType, count] of Object.entries(discarded)) {
      if (!count) continue;
      const isCommodity = COMMODITY_VALUES.includes(cardType);
      if (isCommodity && !this.isCitiesKnights()) {
        throw new Error(`INVALID_RESOURCE_${cardType}`);
      }
      if (!RESOURCE_VALUES.includes(cardType) && !isCommodity) {
        throw new Error(`INVALID_RESOURCE_${cardType}`);
      }
      if (!Number.isInteger(count) || count < 0) throw new Error('DISCARD_COUNT_MUST_BE_NON_NEGATIVE_INTEGER');
      const owned = COMMODITY_VALUES.includes(cardType)
        ? (player.commodities[cardType] || 0)
        : (player.resources[cardType] || 0);
      if (owned < count) throw new Error('NOT_ENOUGH_CARDS_OF_TYPE');
      discardedCount += count;
    }

    if (discardedCount !== requiredDiscard) {
      throw new Error(`MUST_DISCARD_EXACTLY_${requiredDiscard}`);
    }

    for (const [cardType, count] of Object.entries(discarded)) {
      if (!count) continue;
      if (COMMODITY_VALUES.includes(cardType)) {
        player.commodities[cardType] -= count;
      } else {
        player.resources[cardType] -= count;
      }
    }

    this.pendingDiscards.delete(playerId);
    this.logEvent({
      type: 'PLAYER_DISCARDED',
      messageKey: 'LOG_PLAYER_DISCARDED',
      args: { playerName: player.name, count: discardedCount }
    });

    if (this.pendingDiscards.size === 0) {
      this.phase = GAME_PHASES.TURN_ROBBER;
      this.discardDeadline = null;
    }

    return { remainingPending: Array.from(this.pendingDiscards) };
  }

  // Discard half of the player's cards automatically, largest stacks first.
  // Used when the discard timer expires. Reuses discardCards for validation.
  autoDiscardCards(playerId) {
    if (this.phase !== GAME_PHASES.TURN_DISCARD) throw new Error('NOT_IN_DISCARD_PHASE');
    if (!this.pendingDiscards.has(playerId)) throw new Error('NO_DISCARD_NEEDED');
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');

    const need = Math.floor(this.countTotalCards(player) / 2);
    const discarded = this.isCitiesKnights()
      ? { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0, cloth: 0, coin: 0, paper: 0 }
      : { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    let left = need;
    while (left > 0) {
      let maxKey = null;
      let maxCount = -1;
      const pickMax = (entries) => {
        for (const [key, count] of Object.entries(entries)) {
          const remaining = count - (discarded[key] || 0);
          if (remaining > maxCount && remaining > 0) {
            maxCount = remaining;
            maxKey = key;
          }
        }
      };
      pickMax(player.resources || {});
      if (this.isCitiesKnights()) pickMax(player.commodities || {});
      if (!maxKey) break;
      discarded[maxKey]++;
      left--;
    }

    this.discardCards(playerId, discarded);
    return { playerId, discarded, auto: true };
  }

  moveRobber(playerId, hexId, targetPlayerId = null) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ROBBER) throw new Error('NOT_IN_ROBBER_PHASE');
    if (hexId === this.grid.robberHexId) throw new Error('MUST_MOVE_ROBBER_TO_NEW_HEX');
    if (!this.grid.hexes.has(hexId)) throw new Error('INVALID_HEX');

    this.grid.robberHexId = hexId;
    let stolenResource = null;

    // Steal from target player if adjacent to hex
    if (targetPlayerId && targetPlayerId !== playerId) {
      const target = this.players.find(p => p.id === targetPlayerId);
      if (target) {
        const isAdjacent = this.playerBuildingTouchesHex(target, hexId);
        if (isAdjacent && this.countTotalCards(target) > 0) {
          stolenResource = this.stealRandomCard(player, target);
        }
      }
    }

    this.phase = this.hasRolledDice ? GAME_PHASES.TURN_ACTION : GAME_PHASES.TURN_ROLL;
    this.logEvent(this.buildRobberMovedLog(player.name, hexId));

    return { hexId, stolenFrom: targetPlayerId, stolenResource };
  }

  stealRandomCard(thief, target) {
    const stolen = this.stealRandomResource(target);
    if (!stolen) return null;
    this.adjustPlayerCard(thief, stolen, 1);
    this.logEvent({
      type: 'ROBBER_STOLE',
      messageKey: 'LOG_ROBBER_STOLE',
      args: { robberName: thief.name, victimName: target.name }
    });
    return stolen;
  }

  /* =========================================================
   * BUILDING & DEV CARDS IN ACTION PHASE
   * ========================================================= */

  buildRoad(playerId, edgeId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');

    const check = this.canBuildRoad(playerId, edgeId);
    if (!check.ok) throw new Error(check.reason);

    if (this.freeRoadsRemaining > 0) {
      this.freeRoadsRemaining--;
    } else {
      this.deductResources(player, COSTS.ROAD);
    }

    const edge = this.grid.edges.get(edgeId);
    edge.road = { playerId, color: player.color };
    player.roadsRemaining--;
    player.roadsBuilt.push(edgeId);

    this.recalculateLongestRoad();
    this.recalculateVictoryPoints();
    this.checkVictory();

    this.logEvent({
      type: 'BUILD_ROAD',
      messageKey: 'LOG_BUILT_ROAD',
      args: { playerName: player.name }
    });

    return { edgeId, remainingFreeRoads: this.freeRoadsRemaining };
  }

  buildSettlement(playerId, vertexId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');

    const check = this.canBuildSettlement(playerId, vertexId);
    if (!check.ok) throw new Error(check.reason);

    this.deductResources(player, COSTS.SETTLEMENT);

    const vertex = this.grid.vertices.get(vertexId);
    vertex.building = { type: 'settlement', playerId, color: player.color };
    player.settlementsRemaining--;
    player.settlementsBuilt.push(vertexId);

    this.recalculateLongestRoad();
    this.recalculateVictoryPoints();
    this.checkVictory();

    this.logEvent({
      type: 'BUILD_SETTLEMENT',
      messageKey: 'LOG_BUILT_SETTLEMENT',
      args: { playerName: player.name }
    });

    return { vertexId };
  }

  buildCity(playerId, vertexId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');

    const check = this.canBuildCity(playerId, vertexId);
    if (!check.ok) throw new Error(check.reason);

    const cityCost = player.medicineActive ? COSTS.MEDICINE_CITY : COSTS.CITY;
    this.deductResources(player, cityCost);
    player.medicineActive = false;

    const vertex = this.grid.vertices.get(vertexId);
    vertex.building = { type: 'city', playerId, color: player.color, hasWall: false };
    player.settlementsRemaining++;
    player.citiesRemaining--;

    // Update player arrays
    const sIndex = player.settlementsBuilt.indexOf(vertexId);
    if (sIndex !== -1) player.settlementsBuilt.splice(sIndex, 1);
    player.citiesBuilt.push(vertexId);

    this.recalculateVictoryPoints();
    this.checkVictory();

    this.logEvent({
      type: 'BUILD_CITY',
      messageKey: 'LOG_BUILT_CITY',
      args: { playerName: player.name }
    });

    return { vertexId };
  }

  getPlayerWallCount(player) {
    return this.getBuiltCityWallCount(player);
  }

  buildCityWall(playerId, vertexId) {
    const player = this.assertCkAction(playerId);
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex?.building) throw new Error('NO_BUILDING_ON_VERTEX');
    if (vertex.building.type !== 'city') throw new Error('WALLS_ONLY_ON_CITIES');
    if (vertex.building.playerId !== playerId) throw new Error('NOT_YOUR_CITY');
    if (vertex.building.hasWall) throw new Error('CITY_ALREADY_HAS_WALL');
    if ((player.cityWalls || 0) <= 0) throw new Error('NO_WALLS_REMAINING');
    if (!this.hasResources(player, COSTS.CITY_WALL)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.deductResources(player, COSTS.CITY_WALL);
    vertex.building.hasWall = true;
    player.cityWalls--;

    this.logEvent({
      type: 'CITY_WALL_BUILT',
      messageKey: 'LOG_CITY_WALL_BUILT',
      args: { playerName: player.name }
    });
    return { vertexId, wallsRemaining: player.cityWalls };
  }

  improveCityTrack(playerId, track) {
    if (!this.isCitiesKnights()) throw new Error('NOT_CITIES_KNIGHTS_MODE');
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');
    if (!IMPROVEMENT_TRACKS[track]) throw new Error('INVALID_IMPROVEMENT_TRACK');
    if (!player.citiesBuilt.length) throw new Error('NEED_CITY_TO_IMPROVE');

    const currentLevel = player.cityImprovements[track] || 0;
    if (currentLevel >= 6) throw new Error('IMPROVEMENT_MAX_LEVEL');

    let cost = currentLevel + 1;
    if (player.craneDiscount) {
      cost = Math.max(0, cost - 1);
      player.craneDiscount = false;
    }
    const commodity = IMPROVEMENT_TRACKS[track];
    if ((player.commodities[commodity] || 0) < cost) throw new Error('NOT_ENOUGH_COMMODITIES');

    player.commodities[commodity] -= cost;
    player.cityImprovements[track] = currentLevel + 1;
    const newLevel = player.cityImprovements[track];

    this.logEvent({
      type: 'CITY_IMPROVED',
      messageKey: 'LOG_CITY_IMPROVED',
      args: { playerName: player.name, track, level: newLevel }
    });

    if (newLevel === 3 || newLevel === 6) {
      this.drawProgressCard(player, track);
    }

    this.checkMetropolisAward(playerId, track, newLevel);

    return { track, level: newLevel, cost };
  }

  checkMetropolisAward(playerId, track, newLevel) {
    if (newLevel < 4) return;
    const currentHolder = this.metropolises[track];

    if (!currentHolder) {
      this.beginMetropolisChoice(playerId, track);
      return;
    }

    if (currentHolder.playerId === playerId) return;
    if (newLevel !== 5) return;

    const holderPlayer = this.players.find(p => p.id === currentHolder.playerId);
    const holderLevel = holderPlayer?.cityImprovements?.[track] || 0;
    if (holderLevel >= 5) return;

    const holderVertex = this.grid.vertices.get(currentHolder.vertexId);
    if (holderVertex?.building?.type === 'metropolis' && holderVertex.building.metropolisTrack === track) {
      holderVertex.building.type = 'city';
      holderVertex.building.hasMetropolis = false;
      holderVertex.building.metropolisTrack = null;
    }
    if (holderPlayer?.metropolis) holderPlayer.metropolis[track] = false;
    this.metropolises[track] = null;
    this.beginMetropolisChoice(playerId, track);
  }

  beginMetropolisChoice(playerId, track) {
    this.pendingMetropolisChoice = { playerId, track };
    this.previousPhase = this.phase;
    this.phase = GAME_PHASES.TURN_CHOOSE_METROPOLIS;
  }

  chooseMetropolis(playerId, vertexId) {
    if (this.phase !== GAME_PHASES.TURN_CHOOSE_METROPOLIS) throw new Error('NOT_IN_METROPOLIS_PHASE');
    if (!this.pendingMetropolisChoice || this.pendingMetropolisChoice.playerId !== playerId) {
      throw new Error('NOT_YOUR_CHOICE');
    }

    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex?.building || (vertex.building.type !== 'city' && vertex.building.type !== 'metropolis') || vertex.building.playerId !== playerId) {
      throw new Error('MUST_CHOOSE_YOUR_CITY: MUST_CHOOSE_OWN_CITY');
    }

    const track = this.pendingMetropolisChoice.track;
    vertex.building.type = 'metropolis';
    vertex.building.hasMetropolis = true;
    vertex.building.metropolisTrack = track;
    this.metropolises[track] = { playerId, vertexId };

    const player = this.players.find(p => p.id === playerId);
    if (player?.metropolis) player.metropolis[track] = true;

    this.pendingMetropolisChoice = null;
    this.phase = this.previousPhase || GAME_PHASES.TURN_ACTION;
    this.previousPhase = null;

    this.recalculateVictoryPoints();
    this.checkVictory();

    this.logEvent({
      type: 'METROPOLIS_AWARDED',
      messageKey: 'LOG_METROPOLIS',
      args: { playerName: player?.name, track }
    });

    return { track, vertexId };
  }

  getFirstVulnerableCityId(player) {
    return (player.citiesBuilt || []).find(id => {
      const b = this.grid.vertices.get(id)?.building;
      return b && b.type === 'city' && !b.hasMetropolis;
    }) || null;
  }

  hasVulnerableCity(player) {
    return Boolean(this.getFirstVulnerableCityId(player));
  }

  assertCkAction(playerId) {
    if (!this.isCitiesKnights()) throw new Error('NOT_CITIES_KNIGHTS_MODE');
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');
    return player;
  }

  getKnightRecord(player, vertexId) {
    return (player.knightsPlaced || []).find(k => k.vertexId === vertexId) || null;
  }

  returnKnightToSupply(owner, knight) {
    if (!knight) return;
    owner.knightsAvailable[knight.rank] = (owner.knightsAvailable[knight.rank] || 0) + 1;
    owner.knightsPlaced = owner.knightsPlaced.filter(k => k !== knight);
    const vertex = this.grid.vertices.get(knight.vertexId);
    if (vertex && vertex.knight === knight) vertex.knight = null;
  }

  listKnightRelocations(playerId, fromVertexId, extraIgnore = []) {
    const from = this.grid.vertices.get(fromVertexId);
    if (!from) return [];
    const options = [];
    for (const adjId of from.adjacentVertices) {
      const dest = this.grid.vertices.get(adjId);
      if (!dest || dest.building || dest.knight) continue;
      if (!this.verticesSharePlayerRoad(fromVertexId, adjId, playerId)) continue;
      options.push(adjId);
    }
    return options;
  }

  findKnightRelocation(playerId, fromVertexId, extraIgnore = []) {
    return this.listKnightRelocations(playerId, fromVertexId, extraIgnore)[0] || null;
  }

  placeKnight(playerId, vertexId) {
    const player = this.assertCkAction(playerId);
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex) throw new Error('INVALID_VERTEX');
    if (vertex.building || vertex.knight) throw new Error('VERTEX_OCCUPIED');
    if (!this.vertexHasPlayerRoad(vertex, playerId)) throw new Error('MUST_CONNECT_TO_ROAD');
    if ((player.knightsAvailable.basic || 0) <= 0) throw new Error('NO_KNIGHTS_AVAILABLE');
    if (!this.hasResources(player, COSTS.KNIGHT)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.deductResources(player, COSTS.KNIGHT);
    player.knightsAvailable.basic--;
    const knight = {
      playerId,
      vertexId,
      rank: 'basic',
      active: false,
      strength: KNIGHT_RANKS.basic.strength,
      hiredTurn: this.turnNumber,
      lastActionTurn: this.turnNumber
    };
    vertex.knight = knight;
    player.knightsPlaced.push(knight);

    this.logEvent({
      type: 'KNIGHT_PLACED',
      messageKey: 'LOG_KNIGHT_PLACED',
      args: { playerName: player.name }
    });
    return { vertexId, knight };
  }

  activateKnight(playerId, vertexId) {
    const player = this.assertCkAction(playerId);
    const knight = this.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    if (knight.hiredTurn === this.turnNumber) throw new Error('KNIGHT_CANNOT_ACT_ON_HIRED_TURN');
    if (knight.lastActionTurn === this.turnNumber) throw new Error('KNIGHT_ALREADY_ACTED_THIS_TURN');
    if (knight.active) throw new Error('KNIGHT_ALREADY_ACTIVE');
    if (!this.hasResources(player, COSTS.ACTIVATE_KNIGHT)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.deductResources(player, COSTS.ACTIVATE_KNIGHT);
    knight.active = true;
    knight.lastActionTurn = this.turnNumber;

    this.logEvent({
      type: 'KNIGHT_ACTIVATED',
      messageKey: 'LOG_KNIGHT_ACTIVATED',
      args: { playerName: player.name }
    });
    return { vertexId, knight };
  }

  promoteKnight(playerId, vertexId, options = {}) {
    const player = this.assertCkAction(playerId);
    const knight = this.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    if (!options.free) {
      if (knight.hiredTurn === this.turnNumber) throw new Error('KNIGHT_CANNOT_ACT_ON_HIRED_TURN');
      if (knight.lastActionTurn === this.turnNumber) throw new Error('KNIGHT_ALREADY_ACTED_THIS_TURN');
    }
    const current = KNIGHT_RANKS[knight.rank];
    if (!current?.next) throw new Error('KNIGHT_MAX_RANK');
    const nextRank = current.next;
    const next = KNIGHT_RANKS[nextRank];
    if ((player.cityImprovements.politics || 0) < next.politicsRequired) {
      throw new Error('POLITICS_LEVEL_TOO_LOW');
    }
    if ((player.knightsAvailable[nextRank] || 0) <= 0) throw new Error('NO_KNIGHTS_AVAILABLE');
    if (!this.hasResources(player, COSTS.PROMOTE_KNIGHT) && !options.free) throw new Error('NOT_ENOUGH_RESOURCES');

    if (!options.free) this.deductResources(player, COSTS.PROMOTE_KNIGHT);
    player.knightsAvailable[knight.rank] = (player.knightsAvailable[knight.rank] || 0) + 1;
    player.knightsAvailable[nextRank]--;
    knight.rank = nextRank;
    knight.strength = next.strength;
    knight.lastActionTurn = this.turnNumber;

    this.logEvent({
      type: 'KNIGHT_PROMOTED',
      messageKey: 'LOG_KNIGHT_PROMOTED',
      args: { playerName: player.name, rank: nextRank }
    });
    return { vertexId, knight };
  }

  moveKnight(playerId, fromVertexId, toVertexId) {
    const player = this.assertCkAction(playerId);
    const knight = this.getKnightRecord(player, fromVertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    if (knight.hiredTurn === this.turnNumber) throw new Error('KNIGHT_CANNOT_ACT_ON_HIRED_TURN');
    if (knight.lastActionTurn === this.turnNumber) throw new Error('KNIGHT_ALREADY_ACTED_THIS_TURN');
    if (!knight.active) throw new Error('KNIGHT_NOT_ACTIVE');
    if (fromVertexId === toVertexId) throw new Error('INVALID_KNIGHT_MOVE');
    if (!this.verticesSharePlayerRoad(fromVertexId, toVertexId, playerId)) {
      throw new Error('MUST_MOVE_ALONG_OWN_ROAD');
    }

    const dest = this.grid.vertices.get(toVertexId);
    if (!dest) throw new Error('INVALID_VERTEX');
    if (dest.building) throw new Error('VERTEX_OCCUPIED');

    let displaced = null;
    if (dest.knight) {
      if (dest.knight.playerId === playerId) throw new Error('VERTEX_OCCUPIED');
      if (dest.knight.strength >= knight.strength) throw new Error('CANNOT_DISPLACE_EQUAL_OR_STRONGER');
      displaced = this.displaceKnight(dest.knight, toVertexId, fromVertexId);
    }

    const from = this.grid.vertices.get(fromVertexId);
    if (from) from.knight = null;
    knight.vertexId = toVertexId;
    knight.active = false;
    knight.lastActionTurn = this.turnNumber;
    dest.knight = knight;

    this.logEvent({
      type: 'KNIGHT_MOVED',
      messageKey: 'LOG_KNIGHT_MOVED',
      args: { playerName: player.name }
    });
    return { fromVertexId, toVertexId, knight, displaced };
  }

  displaceKnight(victimKnight, fromVertexId, attackerFromId) {
    const owner = this.players.find(p => p.id === victimKnight.playerId);
    const vacated = this.grid.vertices.get(fromVertexId);
    if (vacated && vacated.knight === victimKnight) vacated.knight = null;

    victimKnight.active = false;
    victimKnight.vertexId = null;

    const options = owner
      ? this.listKnightRelocations(owner.id, fromVertexId, [attackerFromId])
      : [];

    if (!owner || options.length === 0) {
      if (owner) this.returnKnightToSupply(owner, victimKnight);
      return { playerId: victimKnight.playerId, vertexId: null, removed: true, pending: false, options: [] };
    }

    this.pendingKnightRelocation = {
      playerId: owner.id,
      options,
      fromVertexId,
      attackerFromId
    };
    this.previousPhase = this.phase;
    this.phase = GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE;
    return { playerId: owner.id, vertexId: null, removed: false, pending: true, options };
  }

  relocateDisplacedKnight(playerId, vertexId) {
    if (this.phase !== GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) throw new Error('NOT_IN_KNIGHT_RELOCATE_PHASE');
    const pending = this.pendingKnightRelocation;
    if (!pending || pending.playerId !== playerId) throw new Error('NOT_YOUR_CHOICE');
    if (!pending.options.includes(vertexId)) throw new Error('INVALID_RELOCATION');

    const owner = this.players.find(p => p.id === playerId);
    const knight = owner?.knightsPlaced.find(k => k.vertexId == null);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');

    const dest = this.grid.vertices.get(vertexId);
    if (!dest || dest.building || dest.knight) throw new Error('VERTEX_OCCUPIED');

    knight.vertexId = vertexId;
    knight.active = false;
    dest.knight = knight;

    this.pendingKnightRelocation = null;
    this.phase = this.previousPhase || GAME_PHASES.TURN_ACTION;
    this.previousPhase = null;

    this.logEvent({
      type: 'KNIGHT_RELOCATED',
      messageKey: 'LOG_KNIGHT_RELOCATED',
      args: { playerName: owner.name }
    });
    return { vertexId };
  }

  autoResolveKnightRelocation() {
    const pending = this.pendingKnightRelocation;
    if (!pending || this.phase !== GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) return;
    if (pending.options && pending.options[0]) {
      this.relocateDisplacedKnight(pending.playerId, pending.options[0]);
      return;
    }
    const owner = this.players.find(p => p.id === pending.playerId);
    const knight = owner?.knightsPlaced.find(k => k.vertexId == null);
    if (owner && knight) this.returnKnightToSupply(owner, knight);
    this.pendingKnightRelocation = null;
    this.phase = this.previousPhase || GAME_PHASES.TURN_ACTION;
    this.previousPhase = null;
  }

  chaseRobber(playerId, vertexId, hexId, targetPlayerId = null) {
    const player = this.assertCkAction(playerId);
    const knight = this.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    if (knight.hiredTurn === this.turnNumber) throw new Error('KNIGHT_CANNOT_ACT_ON_HIRED_TURN');
    if (knight.lastActionTurn === this.turnNumber) throw new Error('KNIGHT_ALREADY_ACTED_THIS_TURN');
    if (!knight.active) throw new Error('KNIGHT_NOT_ACTIVE');
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex || !vertex.hexes.includes(this.grid.robberHexId)) {
      throw new Error('KNIGHT_NOT_ADJACENT_TO_ROBBER');
    }
    if (hexId === this.grid.robberHexId) throw new Error('MUST_MOVE_ROBBER_TO_NEW_HEX');
    if (!this.grid.hexes.has(hexId)) throw new Error('INVALID_HEX');

    this.grid.robberHexId = hexId;
    let stolenResource = null;
    if (targetPlayerId && targetPlayerId !== playerId) {
      const target = this.players.find(p => p.id === targetPlayerId);
      const isAdjacent = target && this.playerBuildingTouchesHex(target, hexId);
      if (isAdjacent && this.countTotalCards(target) > 0) {
        stolenResource = this.stealRandomCard(player, target);
      }
    }
    knight.active = false;
    knight.lastActionTurn = this.turnNumber;

    this.logEvent({
      ...this.buildRobberMovedLog(player.name, hexId),
      type: 'KNIGHT_CHASED_ROBBER'
    });
    return { vertexId, hexId, stolenFrom: targetPlayerId, stolenResource };
  }

  resolveBarbarianAttack() {
    this.phase = GAME_PHASES.TURN_BARBARIAN_RESOLVE;
    const totalCities = this.players.reduce((sum, p) => sum + p.citiesBuilt.length, 0);
    const strengths = this.players.map(p => ({
      player: p,
      strength: this.getActiveKnightStrength(p)
    }));
    const totalActiveKnights = strengths.reduce((sum, row) => sum + row.strength, 0);
    const victory = totalActiveKnights >= totalCities;

    let result;
    if (victory) {
      const maxStrength = Math.max(0, ...strengths.map(row => row.strength));
      const leaders = strengths.filter(row => row.strength === maxStrength && maxStrength > 0);
      if (leaders.length === 1) {
        leaders[0].player.defenderCards = (leaders[0].player.defenderCards || 0) + 1;
        this.defenderOfCatan = leaders[0].player.id;
        this.recalculateVictoryPoints();
        this.logEvent({
          type: 'BARBARIAN_VICTORY',
          messageKey: 'LOG_BARBARIAN_VICTORY',
          args: { playerName: leaders[0].player.name }
        });
      } else if (leaders.length > 1) {
        this.pendingBarbarianTieDraws = new Set(leaders.map(l => l.player.id));
        this.logEvent({
          type: 'BARBARIAN_VICTORY_TIE',
          messageKey: 'LOG_BARBARIAN_VICTORY_TIE',
          args: {}
        });
      }
      this.pendingBarbarianDowngrades.clear();
      result = {
        id: `barb-${this.turnNumber}-${this.eventLog.length}`,
        outcome: 'victory',
        defenderOfCatan: this.defenderOfCatan,
        totalActiveKnights,
        totalCities,
        pendingTieDraws: Array.from(this.pendingBarbarianTieDraws)
      };
    } else {
      const cityOwners = strengths.filter(row => this.hasVulnerableCity(row.player));
      const minStrength = cityOwners.length
        ? Math.min(...cityOwners.map(row => row.strength))
        : 0;
      this.pendingBarbarianDowngrades = new Set(
        cityOwners.filter(row => row.strength === minStrength).map(row => row.player.id)
      );
      this.logEvent({
        type: 'BARBARIAN_DEFEAT',
        messageKey: 'LOG_BARBARIAN_DEFEAT',
        args: { playerIds: Array.from(this.pendingBarbarianDowngrades) }
      });
      result = {
        id: `barb-${this.turnNumber}-${this.eventLog.length}`,
        outcome: 'defeat',
        pendingDowngrades: Array.from(this.pendingBarbarianDowngrades),
        totalActiveKnights,
        totalCities
      };
    }

    for (const p of this.players) {
      for (const k of p.knightsPlaced) k.active = false;
    }
    this.barbarianPosition = 0;
    this.lastBarbarianResult = result;

    if (result.outcome === 'defeat' && this.pendingBarbarianDowngrades.size > 0) {
      this.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    } else if (result.outcome === 'victory' && this.pendingBarbarianTieDraws.size > 0) {
      this.phase = GAME_PHASES.TURN_BARBARIAN_REWARD;
    } else {
      this.continueAfterBarbarian();
    }
    this.checkVictory();
    return result;
  }

  continueAfterBarbarian() {
    const next = this.postBarbarianPhase || GAME_PHASES.TURN_ACTION;
    this.postBarbarianPhase = null;
    if (next === GAME_PHASES.TURN_DISCARD || next === GAME_PHASES.TURN_ROBBER) {
      this.enterRobberFlow();
    } else {
      this.phase = next;
    }
  }

  downgradeCity(playerId, vertexId) {
    if (this.phase !== GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) throw new Error('NOT_IN_BARBARIAN_DOWNGRADE');
    if (!this.pendingBarbarianDowngrades.has(playerId)) throw new Error('NO_DOWNGRADE_NEEDED');
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    const vertex = this.grid.vertices.get(vertexId);
    if (vertex?.building?.type === 'metropolis' || vertex?.building?.hasMetropolis) {
      throw new Error('CANNOT_DOWNGRADE_METROPOLIS: METROPOLIS_PROTECTED');
    }
    if (!vertex?.building || vertex.building.type !== 'city' || vertex.building.playerId !== playerId) {
      throw new Error('MUST_DOWNGRADE_OWN_CITY');
    }

    if (vertex.building.hasWall) {
      vertex.building.hasWall = false;
      player.cityWalls = (player.cityWalls || 0) + 1;
    }
    const cityIndex = player.citiesBuilt.indexOf(vertexId);
    if (cityIndex !== -1) player.citiesBuilt.splice(cityIndex, 1);
    player.citiesRemaining++;

    if (player.settlementsRemaining > 0) {
      vertex.building.type = 'settlement';
      player.settlementsBuilt.push(vertexId);
      player.settlementsRemaining--;
    } else {
      vertex.building.type = 'settlement';
      vertex.building.isCityOnSide = true;
      player.settlementsBuilt.push(vertexId);
    }

    this.pendingBarbarianDowngrades.delete(playerId);
    this.recalculateVictoryPoints();
    this.logEvent({
      type: 'CITY_DOWNGRADED',
      messageKey: 'LOG_CITY_DOWNGRADED',
      args: { playerName: player.name }
    });

    if (this.pendingBarbarianDowngrades.size === 0) {
      this.continueAfterBarbarian();
    }
    return { vertexId, remaining: Array.from(this.pendingBarbarianDowngrades) };
  }

  chooseBarbarianReward(playerId, deck) {
    if (this.phase !== GAME_PHASES.TURN_BARBARIAN_REWARD) {
      throw new Error('NOT_IN_BARBARIAN_REWARD_PHASE');
    }
    if (!this.pendingBarbarianTieDraws || !this.pendingBarbarianTieDraws.has(playerId)) {
      throw new Error('NO_BARBARIAN_REWARD_PENDING');
    }
    const validDecks = ['trade', 'politics', 'science'];
    if (!validDecks.includes(deck)) {
      throw new Error('INVALID_PROGRESS_DECK');
    }
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');

    const cardType = this.drawProgressCard(player, deck);
    this.pendingBarbarianTieDraws.delete(playerId);

    this.logEvent({
      type: 'BARBARIAN_REWARD_CHOSEN',
      messageKey: 'LOG_BARBARIAN_REWARD_CHOSEN',
      args: { playerName: player.name, deck }
    });

    if (this.pendingBarbarianTieDraws.size === 0) {
      this.continueAfterBarbarian();
    }

    return { deck, cardType, remaining: Array.from(this.pendingBarbarianTieDraws) };
  }

  claimBarbarianReward(playerId, deck) {
    return this.chooseBarbarianReward(playerId, deck);
  }

  claimBarbarianProgressCard(playerId, deck) {
    return this.chooseBarbarianReward(playerId, deck);
  }

  buildCityWall(playerId, vertexId, options = {}) {
    const player = this.assertCkAction(playerId);
    const vertex = this.grid.vertices.get(vertexId);
    if (!vertex?.building) throw new Error('NO_BUILDING_ON_VERTEX');
    if (vertex.building.type !== 'city') throw new Error('WALLS_ONLY_ON_CITIES');
    if (vertex.building.playerId !== playerId) throw new Error('NOT_YOUR_CITY');
    if (vertex.building.hasWall) throw new Error('CITY_ALREADY_HAS_WALL');
    if ((player.cityWalls || 0) <= 0) throw new Error('NO_WALLS_REMAINING');
    if (!options.free) {
      if (!this.hasResources(player, COSTS.CITY_WALL)) throw new Error('NOT_ENOUGH_RESOURCES');
      this.deductResources(player, COSTS.CITY_WALL);
    }
    vertex.building.hasWall = true;
    player.cityWalls--;
    this.logEvent({
      type: 'CITY_WALL_BUILT',
      messageKey: 'LOG_CITY_WALL_BUILT',
      args: { playerName: player.name }
    });
    return { vertexId, wallsRemaining: player.cityWalls };
  }

  buyDevCard(playerId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');
    if (this.isCitiesKnights()) throw new Error('DEV_CARDS_DISABLED_IN_CK');

    const check = this.canBuyDevCard(playerId);
    if (!check.ok) throw new Error(check.reason);

    this.deductResources(player, COSTS.DEV_CARD);
    const cardType = this.devCardDeck.pop();
    const cardObj = {
      id: `dev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: cardType,
      boughtTurn: this.turnNumber,
      played: false
    };
    player.devCards.push(cardObj);

    this.recalculateVictoryPoints();
    this.checkVictory();

    this.logEvent({
      type: 'BOUGHT_DEV_CARD',
      messageKey: 'LOG_BOUGHT_DEV_CARD',
      args: { playerName: player.name }
    });

    return { cardType };
  }

  playDevCard(playerId, cardId, options = {}) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ROLL && this.phase !== GAME_PHASES.TURN_ACTION) {
      throw new Error('NOT_IN_VALID_PHASE_FOR_DEV_CARD');
    }
    if (this.devCardPlayedThisTurn) throw new Error('ALREADY_PLAYED_DEV_CARD_THIS_TURN');

    const card = player.devCards.find(c => c.id === cardId && !c.played);
    if (!card) throw new Error('CARD_NOT_FOUND');

    // Cannot play card on turn it was bought, unless it's a victory point
    if (card.boughtTurn === this.turnNumber && card.type !== DEV_CARD_TYPES.VICTORY_POINT) {
      throw new Error('CANNOT_PLAY_CARD_TURN_BOUGHT');
    }

    card.played = true;
    this.devCardPlayedThisTurn = true;

    const validResources = [RESOURCE_TYPES.WOOD, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.ORE];

    if (card.type === DEV_CARD_TYPES.KNIGHT) {
      player.playedKnights++;
      this.recalculateLargestArmy();
      this.recalculateVictoryPoints();
      this.checkVictory();
      // Enforce moving robber
      this.phase = GAME_PHASES.TURN_ROBBER;
      this.logEvent({
        type: 'PLAYED_KNIGHT',
        messageKey: 'LOG_PLAYED_KNIGHT',
        args: { playerName: player.name, totalKnights: player.playedKnights }
      });
    } else if (card.type === DEV_CARD_TYPES.ROAD_BUILDING) {
      this.freeRoadsRemaining = Math.min(2, player.roadsRemaining);
      this.logEvent({
        type: 'PLAYED_ROAD_BUILDING',
        messageKey: 'LOG_PLAYED_ROAD_BUILDING',
        args: { playerName: player.name }
      });
    } else if (card.type === DEV_CARD_TYPES.YEAR_OF_PLENTY) {
      const { res1, res2 } = options;
      if (!res1 || !res2 || !validResources.includes(res1) || !validResources.includes(res2)) {
        throw new Error('SPECIFY_TWO_VALID_RESOURCES');
      }
      player.resources[res1] = (player.resources[res1] || 0) + 1;
      player.resources[res2] = (player.resources[res2] || 0) + 1;
      this.logEvent({
        type: 'PLAYED_YEAR_OF_PLENTY',
        messageKey: 'LOG_PLAYED_YEAR_OF_PLENTY',
        args: { playerName: player.name, res1, res2 }
      });
    } else if (card.type === DEV_CARD_TYPES.MONOPOLY) {
      const { resource } = options;
      if (!resource || !validResources.includes(resource)) {
        throw new Error('SPECIFY_VALID_RESOURCE');
      }
      let stolenTotal = 0;
      for (const other of this.players) {
        if (other.id !== playerId && (other.resources[resource] || 0) > 0) {
          const count = other.resources[resource];
          other.resources[resource] = 0;
          stolenTotal += count;
        }
      }
      player.resources[resource] = (player.resources[resource] || 0) + stolenTotal;
      this.logEvent({
        type: 'PLAYED_MONOPOLY',
        messageKey: 'LOG_PLAYED_MONOPOLY',
        args: { playerName: player.name, resource, count: stolenTotal }
      });
    }

    this.checkVictory();
    return { cardType: card.type };
  }

  playProgressCard(playerId, cardId, options = {}) {
    if (!this.isCitiesKnights()) throw new Error('NOT_CITIES_KNIGHTS_MODE');
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');

    const card = player.progressCards.find(c => c.id === cardId && !c.played);
    if (!card) throw new Error('CARD_NOT_FOUND');
    if (card.type === 'alchemist') {
      if (this.phase !== GAME_PHASES.TURN_ROLL || this.hasRolledDice) {
        throw new Error('ALCHEMIST_MUST_BE_PLAYED_BEFORE_ROLL');
      }
    } else if (this.phase !== GAME_PHASES.TURN_ACTION) {
      throw new Error('NOT_IN_ACTION_PHASE');
    }

    let result = { cardType: card.type };
    switch (card.type) {
      case 'resource_monopoly': {
        const resource = options.resource;
        if (!resource || !RESOURCE_VALUES.includes(resource)) throw new Error('SPECIFY_VALID_RESOURCE');
        let stolen = 0;
        for (const other of this.players) {
          if (other.id === playerId) continue;
          const take = Math.min(2, other.resources[resource] || 0);
          if (take > 0) {
            other.resources[resource] -= take;
            stolen += take;
          }
        }
        player.resources[resource] = (player.resources[resource] || 0) + stolen;
        result.stolen = stolen;
        break;
      }
      case 'trade_monopoly': {
        const resource = options.resource;
        if (!resource || !RESOURCE_VALUES.includes(resource)) throw new Error('SPECIFY_VALID_RESOURCE');
        let stolen = 0;
        for (const other of this.players) {
          if (other.id === playerId) continue;
          const take = Math.min(1, other.resources[resource] || 0);
          if (take > 0) {
            other.resources[resource] -= take;
            stolen += take;
          }
        }
        player.resources[resource] = (player.resources[resource] || 0) + stolen;
        result.stolen = stolen;
        result.resource = resource;
        break;
      }
      case 'merchant_fleet':
        player.merchantFleetActive = true;
        break;
      case 'merchant': {
        const hexId = options.hexId;
        if (!this.grid.hexes.has(hexId)) throw new Error('INVALID_HEX');
        if (!this.playerBuildingTouchesHex(player, hexId)) throw new Error('HEX_NOT_ADJACENT_TO_BUILDING');
        this.merchantHolder = playerId;
        this.merchantHexId = hexId;
        this.recalculateVictoryPoints();
        this.checkVictory();
        result.hexId = hexId;
        break;
      }
      case 'master_merchant': {
        const target = this.players.find(p => p.id === options.targetPlayerId);
        if (!target || target.id === playerId) throw new Error('INVALID_TARGET');
        if ((target.victoryPoints || 0) <= (player.victoryPoints || 0)) {
          throw new Error('TARGET_NOT_AHEAD_IN_VP');
        }
        const steal = Array.isArray(options.steal) ? options.steal.slice(0, 2) : [];
        if (options.peek || steal.length !== 2) {
          if (!options.peek && steal.length) throw new Error('STEAL_TWO_CARDS');
          result.peek = true;
          result.targetPlayerId = target.id;
          result.revealedHand = {
            resources: { ...target.resources },
            commodities: { ...target.commodities }
          };
          break;
        }
        const taken = [];
        for (const type of steal) {
          if (this.getPlayerCardCount(target, type) < 1) throw new Error('TARGET_MISSING_CARDS');
          this.adjustPlayerCard(target, type, -1);
          this.adjustPlayerCard(player, type, 1);
          taken.push(type);
        }
        result.targetPlayerId = target.id;
        result.stolen = taken;
        result.revealedHand = {
          resources: { ...target.resources },
          commodities: { ...target.commodities }
        };
        break;
      }
      case 'commercial_harbor': {
        const resource = options.resource;
        const commodities = options.commodities || {};
        if (!resource || !RESOURCE_VALUES.includes(resource)) throw new Error('SPECIFY_VALID_RESOURCE');
        const exchanges = [];
        for (const other of this.players) {
          if (other.id === playerId) continue;
          let commodity = commodities[other.id];
          if (!commodity) {
            for (const com of COMMODITY_VALUES) {
              if (this.getPlayerCardCount(other, com) > 0) {
                commodity = com;
                break;
              }
            }
          }
          if (!COMMODITY_VALUES.includes(commodity)) continue;
          if (this.getPlayerCardCount(player, resource) < 1) break;
          if (this.getPlayerCardCount(other, commodity) < 1) continue;
          this.adjustPlayerCard(player, resource, -1);
          this.adjustPlayerCard(other, resource, 1);
          this.adjustPlayerCard(other, commodity, -1);
          this.adjustPlayerCard(player, commodity, 1);
          exchanges.push({ playerId: other.id, commodity });
        }
        result.exchanges = exchanges;
        if (exchanges.length > 0) {
          this.logEvent({
            type: 'COMMERCIAL_HARBOR_TRADE',
            messageKey: 'LOG_COMMERCIAL_HARBOR_TRADE',
            args: { playerName: player.name, count: exchanges.length, resource }
          });
        }
        break;
      }
      case 'bishop': {
        const hexId = options.hexId;
        if (!this.grid.hexes.has(hexId)) throw new Error('INVALID_HEX');
        if (hexId === this.grid.robberHexId) throw new Error('MUST_MOVE_ROBBER_TO_NEW_HEX');
        this.grid.robberHexId = hexId;
        const stolenFrom = [];
        for (const adjPlayer of this.getPlayersAdjacentToHex(hexId)) {
          if (adjPlayer.id === playerId) continue;
          const stolen = this.stealRandomResource(adjPlayer);
          if (stolen) {
            this.adjustPlayerCard(player, stolen, 1);
            stolenFrom.push({ playerId: adjPlayer.id, type: stolen });
          }
        }
        result.hexId = hexId;
        result.stolenFrom = stolenFrom;
        break;
      }
      case 'constitution':
        card.played = true;
        card.revealed = true;
        this.recalculateVictoryPoints();
        this.checkVictory();
        break;
      case 'deserter': {
        const targetVertex = this.grid.vertices.get(options.vertexId);
        if (!targetVertex?.knight || targetVertex.knight.playerId === playerId) {
          throw new Error('INVALID_TARGET');
        }
        const removedKnight = targetVertex.knight;
        const target = this.players.find(p => p.id === removedKnight.playerId);
        if (!target) throw new Error('INVALID_TARGET');
        const removedStrength = KNIGHT_RANKS[removedKnight.rank]?.strength || removedKnight.strength || 1;
        let placeRank = options.placeRank || null;
        if (placeRank) {
          const str = KNIGHT_RANKS[placeRank]?.strength;
          if (!str || str > removedStrength || !(player.knightsAvailable[placeRank] > 0)) {
            throw new Error('INVALID_RANK');
          }
        } else {
          for (const rank of ['mighty', 'strong', 'basic']) {
            if (KNIGHT_RANKS[rank].strength <= removedStrength && (player.knightsAvailable[rank] || 0) > 0) {
              placeRank = rank;
              break;
            }
          }
        }
        if (!placeRank) throw new Error('NO_KNIGHTS_AVAILABLE');

        const saved = targetVertex.knight;
        targetVertex.knight = null;
        const legalIds = this.listLegalKnightPlacementVertices(playerId);
        targetVertex.knight = saved;
        let placeId = options.placeVertexId;
        if (placeId && !legalIds.includes(placeId)) throw new Error('INVALID_PLACEMENT');
        if (!placeId) placeId = legalIds[0] || null;

        this.returnKnightToSupply(target, removedKnight);
        if (placeId) {
          const dest = this.grid.vertices.get(placeId);
          player.knightsAvailable[placeRank]--;
          const knight = {
            playerId,
            vertexId: placeId,
            rank: placeRank,
            active: false,
            strength: KNIGHT_RANKS[placeRank].strength,
            hiredTurn: this.turnNumber,
            lastActionTurn: this.turnNumber
          };
          dest.knight = knight;
          player.knightsPlaced.push(knight);
        }
        result.removedFrom = options.vertexId;
        result.targetPlayerId = target.id;
        result.placedVertexId = placeId;
        result.placedRank = placeId ? placeRank : null;
        break;
      }
      case 'diplomat': {
        const edgeId = options.edgeId;
        const edge = this.grid.edges.get(edgeId);
        if (!edge?.road) throw new Error('INVALID_TARGET');
        if (!this.isOpenRoad(edgeId)) throw new Error('ROAD_NOT_OPEN');
        const wasOwn = edge.road.playerId === playerId;
        const snapshot = edge.road ? { playerId: edge.road.playerId, color: edge.road.color } : null;
        this.removeRoadSegment(edgeId);
        result.removedEdgeId = edgeId;
        if (wasOwn && options.newEdgeId) {
          const prevFree = this.freeRoadsRemaining;
          try {
            this.freeRoadsRemaining = (this.freeRoadsRemaining || 0) + 1;
            this.buildRoad(playerId, options.newEdgeId);
            result.newEdgeId = options.newEdgeId;
          } catch (err) {
            this.freeRoadsRemaining = prevFree;
            const owner = this.players.find(p => p.id === snapshot.playerId);
            edge.road = { ...snapshot };
            if (owner) {
              owner.roadsRemaining = Math.max(0, (owner.roadsRemaining || 0) - 1);
              if (!owner.roadsBuilt.includes(edgeId)) owner.roadsBuilt.push(edgeId);
            }
            this.recalculateLongestRoad();
            this.recalculateVictoryPoints();
            throw err;
          }
        }
        break;
      }
      case 'intrigue': {
        const targetVertex = this.grid.vertices.get(options.vertexId);
        const foe = targetVertex?.knight;
        if (!foe || foe.playerId === playerId) throw new Error('INVALID_TARGET');
        const connectedToPlayerRoad = (targetVertex.adjacentEdges || []).some(edgeId => {
          const edge = this.grid.edges.get(edgeId);
          return edge?.road?.playerId === playerId;
        });
        if (!connectedToPlayerRoad) throw new Error('KNIGHT_NOT_CONNECTED_TO_ROAD');
        const displaced = this.displaceKnight(foe, options.vertexId, null);
        result.displaced = displaced;
        break;
      }
      case 'warlord':
        for (const knight of player.knightsPlaced || []) {
          knight.active = true;
        }
        break;
      case 'saboteur': {
        this.recalculateVictoryPoints();
        const myVp = player.victoryPoints || 0;
        const maxVp = Math.max(0, ...this.players.map(p => p.victoryPoints || 0));
        const leaders = this.players.filter(p => (p.victoryPoints || 0) === maxVp);
        if (leaders.length === 1 && leaders[0].id === playerId) {
          throw new Error('SABOTEUR_MUST_NOT_BE_UNIQUE_LEADER');
        }
        const victims = [];
        for (const other of this.players) {
          if (other.id === playerId) continue;
          if ((other.victoryPoints || 0) < myVp) continue;
          const discarded = this.forceDiscardHalfFromLargestStacks(other);
          victims.push({ playerId: other.id, discarded });
        }
        result.victims = victims;
        break;
      }
      case 'wedding': {
        this.recalculateVictoryPoints();
        const myVp = player.victoryPoints || 0;
        const targets = this.players.filter(other => other.id !== playerId && (other.victoryPoints || 0) > myVp);
        if (!targets.length) {
          throw new Error('NO_PLAYERS_WITH_MORE_VP');
        }
        const gifts = [];
        for (const target of targets) {
          const totalCards = this.countTotalCards(target);
          const takeCount = Math.min(2, totalCards);
          if (takeCount <= 0) continue;

          let givenCards = [];
          if (options.gifts && Array.isArray(options.gifts[target.id])) {
            const requested = options.gifts[target.id].slice(0, takeCount);
            for (const cType of requested) {
              if (this.getPlayerCardCount(target, cType) > 0) {
                givenCards.push(cType);
                this.adjustPlayerCard(target, cType, -1);
              }
            }
          }
          while (givenCards.length < takeCount) {
            let maxKey = null;
            let maxCount = -1;
            const consider = (bag) => {
              for (const [key, count] of Object.entries(bag || {})) {
                if (count > maxCount && count > 0) {
                  maxCount = count;
                  maxKey = key;
                }
              }
            };
            consider(target.resources);
            consider(target.commodities);
            if (!maxKey) break;
            this.adjustPlayerCard(target, maxKey, -1);
            givenCards.push(maxKey);
          }

          for (const cardType of givenCards) {
            this.adjustPlayerCard(player, cardType, 1);
          }
          gifts.push({ playerId: target.id, targetName: target.name, cards: givenCards });
          this.logEvent({
            type: 'WEDDING_GIFT',
            messageKey: 'LOG_WEDDING_GIFT',
            args: { targetName: target.name, playerName: player.name, count: givenCards.length }
          });
        }
        result.gifts = gifts;
        break;
      }
      case 'spy': {
        const target = this.players.find(p => p.id === options.targetPlayerId);
        if (!target || target.id === playerId) throw new Error('INVALID_TARGET');
        const unplayedTargetCards = target.progressCards.filter(c => !c.played);
        if (!unplayedTargetCards.length) {
          throw new Error('TARGET_HAS_NO_PROGRESS_CARDS');
        }
        if (options.peek) {
          result.peek = true;
          result.targetPlayerId = target.id;
          result.targetProgressCards = unplayedTargetCards.map(c => ({ id: c.id, type: c.type }));
          break;
        }
        let stolenCard;
        if (options.stealCardId) {
          stolenCard = unplayedTargetCards.find(c => c.id === options.stealCardId);
          if (!stolenCard) throw new Error('CARD_NOT_FOUND_IN_TARGET_HAND');
        } else {
          stolenCard = unplayedTargetCards[0];
        }
        const stolenIdx = target.progressCards.findIndex(c => c.id === stolenCard.id);
        target.progressCards.splice(stolenIdx, 1);
        if (this.pendingProgressDiscard && this.countUnplayedProgressCards(target) <= PROGRESS_CARD_HAND_LIMIT) {
          this.pendingProgressDiscard.delete(target.id);
        }

        const isVp = ['constitution', 'printer'].includes(stolenCard.type);
        const cardObj = {
          ...stolenCard,
          boughtTurn: this.turnNumber,
          played: isVp,
          revealed: isVp
        };
        player.progressCards.push(cardObj);
        if (isVp) {
          this.recalculateVictoryPoints();
          this.checkVictory();
        }
        if (this.countUnplayedProgressCards(player) > PROGRESS_CARD_HAND_LIMIT) {
          this.pendingProgressDiscard.add(player.id);
        }
        result.targetPlayerId = target.id;
        result.stolenCard = { id: cardObj.id, type: cardObj.type };
        result.targetProgressCards = target.progressCards.filter(c => !c.played).map(c => ({ id: c.id, type: c.type }));
        break;
      }
      case 'alchemist': {
        const d1 = Number(options.d1);
        const d2 = Number(options.d2);
        if (!Number.isInteger(d1) || !Number.isInteger(d2) || d1 < 1 || d1 > 6 || d2 < 1 || d2 > 6) {
          throw new Error('INVALID_DICE_VALUES');
        }
        this.alchemistDice = [d1, d2];
        result.dice = [d1, d2];
        break;
      }
      case 'crane':
        player.craneDiscount = true;
        break;
      case 'engineer':
        this.buildCityWall(playerId, options.vertexId, { free: true });
        result.vertexId = options.vertexId;
        break;
      case 'inventor': {
        const hex1 = this.grid.hexes.get(options.hexId1);
        const hex2 = this.grid.hexes.get(options.hexId2);
        if (!hex1 || !hex2 || hex1.id === hex2.id) throw new Error('INVALID_HEX');
        const forbidden = [2, 6, 8, 12];
        if (forbidden.includes(hex1.token) || forbidden.includes(hex2.token)) {
          throw new Error('CANNOT_SWAP_RESTRICTED_TOKENS');
        }
        const tmp = hex1.token;
        hex1.token = hex2.token;
        hex2.token = tmp;
        result.hexId1 = hex1.id;
        result.hexId2 = hex2.id;
        break;
      }
      case 'irrigation':
      case 'mining': {
        const resource = card.type === 'irrigation' ? 'wheat' : 'ore';
        const seen = new Set();
        for (const v of this.grid.vertices.values()) {
          if (v.building?.playerId !== playerId) continue;
          for (const hexId of v.hexes || []) {
            if (seen.has(hexId)) continue;
            if (this.grid.hexes.get(hexId)?.resource === resource) seen.add(hexId);
          }
        }
        const gained = seen.size * 2;
        player.resources[resource] = (player.resources[resource] || 0) + gained;
        result.gained = gained;
        break;
      }
      case 'medicine':
        player.medicineActive = true;
        break;
      case 'printer':
        card.played = true;
        card.revealed = true;
        this.recalculateVictoryPoints();
        this.checkVictory();
        break;
      case 'smith': {
        const verts = Array.isArray(options.knightVertices) ? options.knightVertices : [];
        if (verts.length < 1 || verts.length > 2 || (verts.length === 2 && verts[0] === verts[1])) {
          throw new Error('SMITH_NEEDS_ONE_OR_TWO_KNIGHTS');
        }
        for (const vertexId of verts) {
          this.promoteKnight(playerId, vertexId, { free: true });
        }
        result.knightVertices = verts;
        break;
      }
      case 'road_building':
        this.freeRoadsRemaining = Math.min(2, player.roadsRemaining);
        result.freeRoads = this.freeRoadsRemaining;
        break;
      default:
        throw new Error('UNKNOWN_PROGRESS_CARD');
    }

    if (result.peek) {
      return result;
    }

    card.played = true;
    if (this.pendingProgressDiscard && this.countUnplayedProgressCards(player) <= PROGRESS_CARD_HAND_LIMIT) {
      this.pendingProgressDiscard.delete(player.id);
    }
    if (card.type === 'bishop' && result.hexId) {
      this.logEvent(this.buildRobberMovedLog(player.name, result.hexId));
    }
    this.logEvent({
      type: 'PROGRESS_CARD_PLAYED',
      messageKey: 'LOG_PROGRESS_CARD_PLAYED',
      args: { playerName: player.name, card: card.type }
    });
    return result;
  }

  /* =========================================================
   * TRADING
   * ========================================================= */

  tradeWithBank(playerId, giveRes, receiveRes, ratio = 4) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');

    if (!this.isTradableType(giveRes) || !this.isTradableType(receiveRes)) {
      throw new Error('INVALID_RESOURCE');
    }
    if (giveRes === receiveRes) {
      throw new Error('CANNOT_TRADE_SAME_RESOURCE');
    }

    // Determine player's best available trade ratio for giveRes
    let bestRatio = 4;
    if (player.merchantFleetActive) {
      bestRatio = 2;
    } else if ((player.cityImprovements?.trade || 0) >= 5) {
      bestRatio = 2;
    } else if (this.merchantHolder === playerId && this.merchantHexId) {
      const hex = this.grid.hexes.get(this.merchantHexId);
      if (hex && hex.resource === giveRes) bestRatio = 2;
    }
    if (bestRatio > 2) {
      for (const vKey of player.settlementsBuilt.concat(player.citiesBuilt)) {
        const v = this.grid.vertices.get(vKey);
        if (v && v.harbor) {
          if (v.harbor.type === giveRes && v.harbor.ratio === 2) {
            bestRatio = 2;
            break;
          }
          if (v.harbor.type === 'generic' && v.harbor.ratio === 3) {
            bestRatio = Math.min(bestRatio, 3);
          }
        }
      }
    }

    if (ratio < bestRatio) throw new Error('INVALID_TRADE_RATIO');
    if (this.getPlayerCardCount(player, giveRes) < bestRatio) throw new Error('NOT_ENOUGH_RESOURCES');

    this.adjustPlayerCard(player, giveRes, -bestRatio);
    this.adjustPlayerCard(player, receiveRes, 1);

    this.logEvent({
      type: 'BANK_TRADE',
      messageKey: 'LOG_BANK_TRADE',
      args: { playerName: player.name, give: giveRes, receive: receiveRes, ratio: bestRatio }
    });

    return { give: giveRes, receive: receiveRes, ratio: bestRatio };
  }

  proposeTrade(playerId, give, want) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');
    if (!give || !want || typeof give !== 'object' || typeof want !== 'object') {
      throw new Error('INVALID_TRADE_FORMAT');
    }

    let totalGive = 0;
    for (const [res, amount] of Object.entries(give)) {
      if (!this.isTradableType(res)) throw new Error(`INVALID_RESOURCE_${res}`);
      if (!Number.isInteger(amount) || amount < 0) throw new Error('AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER');
      if (this.getPlayerCardCount(player, res) < amount) throw new Error('NOT_ENOUGH_RESOURCES_TO_GIVE');
      totalGive += amount;
    }

    let totalWant = 0;
    for (const [res, amount] of Object.entries(want)) {
      if (!this.isTradableType(res)) throw new Error(`INVALID_RESOURCE_${res}`);
      if (!Number.isInteger(amount) || amount < 0) throw new Error('AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER');
      totalWant += amount;
    }

    if (totalGive <= 0 || totalWant <= 0) {
      throw new Error('TRADE_MUST_OFFER_AND_REQUEST_RESOURCES');
    }

    for (const res of Object.keys(give)) {
      if (give[res] > 0 && want[res] > 0) {
        throw new Error('CANNOT_TRADE_SAME_RESOURCE');
      }
    }

    this.activeTrade = {
      fromPlayerId: playerId,
      give,
      want,
      acceptedBy: new Set(),
      declinedBy: new Set()
    };

    this.logEvent({
      type: 'TRADE_PROPOSED',
      messageKey: 'LOG_TRADE_PROPOSED',
      args: { playerName: player.name, give, want }
    });

    return this.activeTrade;
  }

  respondToTrade(playerId, accept) {
    if (!this.activeTrade) throw new Error('NO_ACTIVE_TRADE');
    if (this.activeTrade.fromPlayerId === playerId) throw new Error('CANNOT_RESPOND_TO_OWN_TRADE');

    const responder = this.players.find(p => p.id === playerId);
    if (!responder) throw new Error('PLAYER_NOT_FOUND');
    if (accept) {
      // Check responder has what the current player wants
      for (const [res, amount] of Object.entries(this.activeTrade.want)) {
        if (this.getPlayerCardCount(responder, res) < amount) throw new Error('NOT_ENOUGH_RESOURCES');
      }
      this.activeTrade.acceptedBy.add(playerId);
      if (this.activeTrade.declinedBy) this.activeTrade.declinedBy.delete(playerId);
      return { trade: this.activeTrade, accepted: true, playerId };
    } else {
      this.activeTrade.acceptedBy.delete(playerId);
      if (!this.activeTrade.declinedBy) this.activeTrade.declinedBy = new Set();
      this.activeTrade.declinedBy.add(playerId);

      const fromPlayer = this.players.find(p => p.id === this.activeTrade.fromPlayerId);
      this.lastTradeEvent = {
        id: `trade_declined_${Date.now()}`,
        type: 'declined',
        playerId,
        playerName: responder.name,
        fromPlayerId: this.activeTrade.fromPlayerId
      };
      this.logEvent({
        type: 'TRADE_DECLINED',
        messageKey: 'LOG_TRADE_DECLINED',
        args: { playerName: responder.name, initiator: fromPlayer?.name || 'Player' }
      });
      return { trade: this.activeTrade, accepted: false, playerId, declined: true };
    }
  }

  confirmTrade(playerId, targetPlayerId) {
    if (!this.activeTrade) throw new Error('NO_ACTIVE_TRADE');
    if (this.activeTrade.fromPlayerId !== playerId) throw new Error('NOT_YOUR_TRADE');
    if (!this.activeTrade.acceptedBy.has(targetPlayerId)) throw new Error('PLAYER_DID_NOT_ACCEPT');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');

    const initiator = this.players.find(p => p.id === playerId);
    const partner = this.players.find(p => p.id === targetPlayerId);
    if (!initiator || !partner) throw new Error('PLAYER_NOT_FOUND');

    // Final checks
    for (const [res, amt] of Object.entries(this.activeTrade.give)) {
      if (this.getPlayerCardCount(initiator, res) < amt) throw new Error('INITIATOR_MISSING_RESOURCES');
    }
    for (const [res, amt] of Object.entries(this.activeTrade.want)) {
      if (this.getPlayerCardCount(partner, res) < amt) throw new Error('PARTNER_MISSING_RESOURCES');
    }

    // Execute exchange
    for (const [res, amt] of Object.entries(this.activeTrade.give)) {
      this.adjustPlayerCard(initiator, res, -amt);
      this.adjustPlayerCard(partner, res, amt);
    }
    for (const [res, amt] of Object.entries(this.activeTrade.want)) {
      this.adjustPlayerCard(partner, res, -amt);
      this.adjustPlayerCard(initiator, res, amt);
    }

    const tradeRecord = { ...this.activeTrade, partnerId: targetPlayerId };
    this.activeTrade = null;

    this.logEvent({
      type: 'TRADE_COMPLETED',
      messageKey: 'LOG_TRADE_COMPLETED',
      args: { initiator: initiator.name, partner: partner.name }
    });

    return tradeRecord;
  }

  cancelTrade(playerId) {
    if (!this.activeTrade) return false;
    if (this.activeTrade.fromPlayerId !== playerId) throw new Error('NOT_YOUR_TRADE');
    this.activeTrade = null;
    return true;
  }

  /* =========================================================
   * TURN TRANSITION & VICTORY
   * ========================================================= */

  endTurn(playerId) {
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');

    if (this.isCitiesKnights()) {
      if (this.pendingProgressDiscard?.has(playerId) || this.countUnplayedProgressCards(player) > PROGRESS_CARD_HAND_LIMIT) {
        if (this.pendingProgressDiscard) {
          this.pendingProgressDiscard.add(playerId);
        }
        throw new Error('MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN');
      }
    }

    this.activeTrade = null;
    this.freeRoadsRemaining = 0;
    this.hasRolledDice = false;
    this.devCardPlayedThisTurn = false;
    this.clearAqueductRoll();
    player.merchantFleetActive = false;
    player.craneDiscount = false;
    player.medicineActive = false;
    player.hasProposedTradeThisTurn = false;
    this.alchemistDice = null;

    // Check victory
    if (this.checkVictory()) {
      return { gameOver: true, winner: player };
    }

    // Pass turn to next player
    this.currentTurnPlayerIndex = (this.currentTurnPlayerIndex + 1) % this.players.length;
    if (this.currentTurnPlayerIndex === 0) {
      this.turnNumber++;
    }

    this.phase = GAME_PHASES.TURN_ROLL;
    const nextPlayer = this.getCurrentPlayer();

    // Check if new player already has winning VP on their turn start
    if (this.checkVictory()) {
      return { gameOver: true, winner: nextPlayer };
    }

    this.logEvent({
      type: 'TURN_CHANGED',
      messageKey: 'LOG_TURN_CHANGED',
      args: { playerName: nextPlayer.name, turnNumber: this.turnNumber }
    });

    return { gameOver: false, nextPlayer };
  }

  /* =========================================================
   * POINTS & ACHIEVEMENTS CALCULATION
   * ========================================================= */

  recalculateLongestRoad() {
    const minLen = 5;
    const lengths = new Map();
    for (const player of this.players) {
      lengths.set(player.id, this.calculatePlayerLongestRoad(player.id));
    }

    let holder = this.longestRoadHolder ? { ...this.longestRoadHolder } : null;
    if (holder && !this.players.find(p => p.id === holder.playerId)) {
      holder = null;
    }

    if (holder) {
      const holderLen = lengths.get(holder.playerId) || 0;
      if (holderLen < minLen) {
        // Holder lost it; check if any contender qualifies with >= minLen
        let maxOther = minLen - 1;
        let leaders = [];
        for (const player of this.players) {
          if (player.id === holder.playerId) continue;
          const l = lengths.get(player.id) || 0;
          if (l > maxOther) {
            maxOther = l;
            leaders = [player.id];
          } else if (l === maxOther && l >= minLen) {
            leaders.push(player.id);
          }
        }
        if (leaders.length === 1) {
          holder = { playerId: leaders[0], length: maxOther };
        } else {
          holder = null; // Either tie or nobody >= 5
        }
      } else {
        holder.length = holderLen;
        // Only transfer if another player strictly exceeds holder length
        let maxLen = holderLen;
        let newLeader = null;
        for (const player of this.players) {
          if (player.id === holder.playerId) continue;
          const l = lengths.get(player.id) || 0;
          if (l > maxLen) {
            maxLen = l;
            newLeader = player.id;
          }
        }
        if (newLeader) {
          holder = { playerId: newLeader, length: maxLen };
        }
      }
    } else {
      // No current holder; find unique leader with >= minLen
      let maxLen = minLen - 1;
      let leaders = [];
      for (const player of this.players) {
        const l = lengths.get(player.id) || 0;
        if (l > maxLen) {
          maxLen = l;
          leaders = [player.id];
        } else if (l === maxLen && l >= minLen) {
          leaders.push(player.id);
        }
      }
      if (leaders.length === 1) {
        holder = { playerId: leaders[0], length: maxLen };
      } else {
        holder = null;
      }
    }

    const previousHolderId = this.longestRoadHolder ? this.longestRoadHolder.playerId : null;
    const newHolderId = holder ? holder.playerId : null;

    if (newHolderId !== previousHolderId) {
      this.longestRoadHolder = holder;
      if (holder) {
        const holderPlayer = this.players.find(p => p.id === holder.playerId);
        this.logEvent({
          type: 'LONGEST_ROAD',
          messageKey: 'LOG_LONGEST_ROAD',
          args: { playerName: holderPlayer.name, length: holder.length }
        });
      }
    } else if (holder && this.longestRoadHolder) {
      this.longestRoadHolder.length = holder.length;
    }
  }

  calculatePlayerLongestRoad(playerId) {
    const playerRoads = this.grid ? Array.from(this.grid.edges.values()).filter(e => e.road && e.road.playerId === playerId) : [];
    if (playerRoads.length === 0) return 0;

    let maxLength = 0;
    const visitedEdges = new Set();

    const dfs = (vertexId, currentLength) => {
      maxLength = Math.max(maxLength, currentLength);
      const vertex = this.grid.vertices.get(vertexId);
      if (!vertex) return;

      // Opponent settlement/city or knight blocks road passing through unless it's the start
      if (currentLength > 0 && ((vertex.building && vertex.building.playerId !== playerId) || (vertex.knight && vertex.knight.playerId !== playerId))) {
        return;
      }

      for (const eId of vertex.adjacentEdges) {
        if (!visitedEdges.has(eId)) {
          const edge = this.grid.edges.get(eId);
          if (edge && edge.road && edge.road.playerId === playerId) {
            visitedEdges.add(eId);
            const nextVertexId = edge.v1 === vertexId ? edge.v2 : edge.v1;
            dfs(nextVertexId, currentLength + 1);
            visitedEdges.delete(eId);
          }
        }
      }
    };

    for (const road of playerRoads) {
      visitedEdges.add(road.id);
      dfs(road.v1, 1);
      dfs(road.v2, 1);
      visitedEdges.delete(road.id);
    }

    return maxLength;
  }

  recalculateLargestArmy() {
    const minCount = 3;
    let holder = this.largestArmyHolder ? { ...this.largestArmyHolder } : null;
    if (holder && !this.players.find(p => p.id === holder.playerId)) {
      holder = null;
    }

    if (holder) {
      const holderPlayer = this.players.find(p => p.id === holder.playerId);
      const holderCount = holderPlayer ? holderPlayer.playedKnights : 0;
      if (holderCount < minCount) {
        let maxOther = minCount - 1;
        let leaders = [];
        for (const player of this.players) {
          if (player.id === holder.playerId) continue;
          if (player.playedKnights > maxOther) {
            maxOther = player.playedKnights;
            leaders = [player.id];
          } else if (player.playedKnights === maxOther && player.playedKnights >= minCount) {
            leaders.push(player.id);
          }
        }
        if (leaders.length === 1) {
          holder = { playerId: leaders[0], count: maxOther };
        } else {
          holder = null;
        }
      } else {
        holder.count = holderCount;
        let maxCount = holderCount;
        let newLeader = null;
        for (const player of this.players) {
          if (player.id === holder.playerId) continue;
          if (player.playedKnights > maxCount) {
            maxCount = player.playedKnights;
            newLeader = player.id;
          }
        }
        if (newLeader) {
          holder = { playerId: newLeader, count: maxCount };
        }
      }
    } else {
      let maxCount = minCount - 1;
      let leaders = [];
      for (const player of this.players) {
        if (player.playedKnights > maxCount) {
          maxCount = player.playedKnights;
          leaders = [player.id];
        } else if (player.playedKnights === maxCount && player.playedKnights >= minCount) {
          leaders.push(player.id);
        }
      }
      if (leaders.length === 1) {
        holder = { playerId: leaders[0], count: maxCount };
      } else {
        holder = null;
      }
    }

    const previousHolderId = this.largestArmyHolder ? this.largestArmyHolder.playerId : null;
    const newHolderId = holder ? holder.playerId : null;

    if (newHolderId !== previousHolderId) {
      this.largestArmyHolder = holder;
      if (holder) {
        const holderPlayer = this.players.find(p => p.id === holder.playerId);
        this.logEvent({
          type: 'LARGEST_ARMY',
          messageKey: 'LOG_LARGEST_ARMY',
          args: { playerName: holderPlayer.name, count: holder.count }
        });
      }
    } else if (holder && this.largestArmyHolder) {
      this.largestArmyHolder.count = holder.count;
    }
  }

  checkVictory() {
    this.recalculateVictoryPoints();
    const curPlayer = this.getCurrentPlayer();
    if (curPlayer && curPlayer.victoryPoints >= this.vpTarget) {
      this.phase = GAME_PHASES.GAME_OVER;
      this.logEvent({
        type: 'VICTORY',
        messageKey: 'LOG_VICTORY',
        args: { winnerName: curPlayer.name, points: curPlayer.victoryPoints }
      });
      return true;
    }
    return false;
  }

  recalculateVictoryPoints() {
    for (const player of this.players) {
      let publicPoints = 0;
      let hiddenPoints = 0;

      // 1 VP per settlement
      publicPoints += player.settlementsBuilt.length;
      // 2 VP per city
      publicPoints += player.citiesBuilt.length * 2;

      // Longest road = 2 VP
      if (this.longestRoadHolder && this.longestRoadHolder.playerId === player.id) {
        publicPoints += 2;
      }

      // Largest army = 2 VP
      if (this.largestArmyHolder && this.largestArmyHolder.playerId === player.id) {
        publicPoints += 2;
      }

      if (player.defenderCards) {
        publicPoints += player.defenderCards;
      } else if (this.defenderOfCatan === player.id) {
        publicPoints += 1;
      }

      if (this.merchantHolder === player.id) {
        publicPoints += 1;
      }

      for (const track of ['trade', 'politics', 'science']) {
        if (player.metropolis?.[track]) publicPoints += 2;
      }

      for (const card of player.progressCards || []) {
        if (card.played && (card.type === 'constitution' || card.type === 'printer')) {
          publicPoints += 1;
        }
      }

      // Dev card victory points (1 each)
      for (const card of player.devCards) {
        if (card.type === DEV_CARD_TYPES.VICTORY_POINT) {
          hiddenPoints += 1;
        }
      }

      player.publicVictoryPoints = publicPoints;
      player.victoryPoints = publicPoints + hiddenPoints;
    }
  }

  getBankStock() {
    const isCk = this.isCitiesKnights();
    const resourceMax = this.players.length <= 4 ? 19 : 24;
    const commodityMax = 12;

    const resources = {};
    for (const r of RESOURCE_VALUES) {
      const held = this.players.reduce((sum, p) => sum + (p.resources?.[r] || 0), 0);
      resources[r] = Math.max(0, resourceMax - held);
    }

    const commodities = {};
    if (isCk) {
      for (const c of COMMODITY_VALUES) {
        const held = this.players.reduce((sum, p) => sum + (p.commodities?.[c] || 0), 0);
        commodities[c] = Math.max(0, commodityMax - held);
      }
    }

    const decks = {};
    if (isCk) {
      decks.trade = this.progressDecks?.trade?.length || 0;
      decks.politics = this.progressDecks?.politics?.length || 0;
      decks.science = this.progressDecks?.science?.length || 0;
    } else {
      decks.devCards = this.devCardDeck?.length || 0;
    }

    return {
      resources,
      commodities,
      decks
    };
  }

  getKnightsOverview() {
    if (!this.isCitiesKnights()) return null;
    const totalCities = this.players.reduce((sum, p) => sum + (p.citiesBuilt?.length || 0), 0);
    const activeStrength = this.players.reduce((sum, p) => sum + this.getActiveKnightStrength(p), 0);

    const playersBreakdown = this.players.map(p => {
      const placed = p.knightsPlaced || [];
      const activeCount = placed.filter(k => k.active).length;
      const inactiveCount = placed.length - activeCount;
      const ranks = {
        basic: { total: 0, active: 0, inactive: 0 },
        strong: { total: 0, active: 0, inactive: 0 },
        mighty: { total: 0, active: 0, inactive: 0 }
      };
      for (const k of placed) {
        if (ranks[k.rank]) {
          ranks[k.rank].total++;
          if (k.active) ranks[k.rank].active++;
          else ranks[k.rank].inactive++;
        }
      }
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        totalPlaced: placed.length,
        activeCount,
        inactiveCount,
        activeStrength: this.getActiveKnightStrength(p),
        ranks,
        availableSupply: p.knightsAvailable || { basic: 0, strong: 0, mighty: 0 }
      };
    });

    return {
      totalCities,
      totalActiveStrength: activeStrength,
      barbarianPosition: this.barbarianPosition,
      isDefenseReady: activeStrength >= totalCities,
      defenseMargin: activeStrength - totalCities,
      players: playersBreakdown
    };
  }

  /* =========================================================
   * SERIALIZATION (WITH FOG-OF-WAR FOR OPPONENT CARDS)
   * ========================================================= */

  getStateForPlayer(playerId) {
    return {
      roomId: this.roomId,
      mode: this.mode,
      vpTarget: this.vpTarget,
      phase: this.phase,
      currentTurnPlayerIndex: this.currentTurnPlayerIndex,
      currentPlayerId: this.players[this.currentTurnPlayerIndex]?.id ?? null,
      setupStep: this.setupStep,
      lastSetupSettlementVertex: this.lastSetupSettlementVertex,
      turnNumber: this.turnNumber,
      dice: this.dice,
      eventDie: this.eventDie,
      barbarianPosition: this.barbarianPosition,
      defenderOfCatan: this.defenderOfCatan,
      hasRolledDice: this.hasRolledDice,
      grid: this.grid ? this.grid.toJSON() : null,
      bank: this.getBankStock(),
      knightsOverview: this.getKnightsOverview(),
      pendingDiscards: Array.from(this.pendingDiscards),
      discardDeadline: this.discardDeadline,
      pendingBarbarianDowngrades: Array.from(this.pendingBarbarianDowngrades),
      pendingBarbarianTieDraws: Array.from(this.pendingBarbarianTieDraws),
      lastBarbarianResult: this.lastBarbarianResult,
      merchantHolder: this.merchantHolder,
      merchantHexId: this.merchantHexId,
      pendingProgressDiscard: Array.from(this.pendingProgressDiscard),
      metropolises: this.metropolises,
      pendingMetropolisChoice: this.pendingMetropolisChoice,
      pendingKnightRelocation: this.pendingKnightRelocation,
      pendingProgressDraws: this.pendingProgressDraws,
      pendingAqueductClaims: Array.from(this.pendingAqueductClaims || []),
      activeTrade: this.activeTrade ? {
        ...this.activeTrade,
        acceptedBy: Array.from(this.activeTrade.acceptedBy),
        declinedBy: Array.from(this.activeTrade.declinedBy || [])
      } : null,
      lastTradeEvent: this.lastTradeEvent || null,
      freeRoadsRemaining: this.freeRoadsRemaining,
      longestRoadHolder: this.longestRoadHolder,
      largestArmyHolder: this.largestArmyHolder,
      devCardsRemaining: this.devCardDeck.length,
      eventLog: this.eventLog.slice(-100),
      players: this.players.map(p => {
        const isSelf = p.id === playerId;
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          isBot: p.isBot,
          botDifficulty: p.botDifficulty,
          // Fog-of-war: opponents see resource totals and commodity totals separately.
          // Hand size = resources.total + commodities.total. Never fold commodities into resources.total.
          resources: isSelf ? p.resources : { total: this.countResources(p) },
          commodities: isSelf ? p.commodities : { total: this.countCommodities(p) },
          cityImprovements: p.cityImprovements,
          merchantFleetActive: isSelf ? p.merchantFleetActive : undefined,
          knightsAvailable: isSelf ? p.knightsAvailable : undefined,
          knightsPlaced: p.knightsPlaced,
          cityWalls: p.cityWalls,
          discardThreshold: this.getDiscardThreshold(p),
          metropolis: p.metropolis,
          progressCards: isSelf
            ? p.progressCards
            : {
              count: (p.progressCards || []).length,
              revealed: (p.progressCards || [])
                .filter(c => c.revealed || (c.played && ['constitution', 'printer'].includes(c.type)))
                .map(c => ({ id: c.id, type: c.type, revealed: true, played: true }))
            },
          devCards: isSelf ? p.devCards : { count: p.devCards.filter(c => !c.played).length },
          playedKnights: p.playedKnights,
          settlementsRemaining: p.settlementsRemaining,
          citiesRemaining: p.citiesRemaining,
          roadsRemaining: p.roadsRemaining,
          settlementsBuilt: p.settlementsBuilt,
          citiesBuilt: p.citiesBuilt,
          roadsBuilt: p.roadsBuilt,
          defenderCards: p.defenderCards || 0,
          roadLength: this.calculatePlayerLongestRoad(p.id),
          longestRoadLength: this.calculatePlayerLongestRoad(p.id),
          victoryPoints: isSelf ? p.victoryPoints : p.publicVictoryPoints,
          publicVictoryPoints: p.publicVictoryPoints
        };
      })
    };
  }
}
