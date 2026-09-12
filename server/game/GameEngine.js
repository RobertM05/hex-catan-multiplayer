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
  [RESOURCE_TYPES.WHEAT]: COMMODITY_TYPES.PAPER
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
  PROMOTE_KNIGHT: { wheat: 1, ore: 1 }
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
    this.pendingProgressCardColor = null;
    this.pendingProgressDraws = [];
    this.lastBarbarianResult = null;
    this.postBarbarianPhase = null;
    this.progressDecks = { trade: [], politics: [], science: [] };
    this.pendingKnightRelocation = null;
    this.previousPhase = null;

    // Discard tracking for 7-roll
    this.pendingDiscards = new Set(); // playerIds needing to discard
    this.discardDeadline = null; // timestamp by which pending players must discard

    // Trade state
    this.activeTrade = null; // { fromPlayerId, give, want, responses: { [playerId]: boolean } }

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
      devCards: [], // { type, boughtTurn, played }
      playedKnights: 0,
      settlementsRemaining: 5,
      citiesRemaining: 4,
      roadsRemaining: 15,
      roadsBuilt: [],
      settlementsBuilt: [],
      citiesBuilt: [],
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
      }
    }
    this.pendingDiscards.delete(playerId);
    this.pendingBarbarianDowngrades.delete(playerId);

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
          // Check if an opponent's settlement/city blocks this intersection
          const sharedVertexId = (edge.v1 === adjEdge.v1 || edge.v1 === adjEdge.v2) ? edge.v1 : edge.v2;
          const sharedVertex = this.grid.vertices.get(sharedVertexId);
          if (!sharedVertex.building || sharedVertex.building.playerId === playerId) {
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

    if (!this.hasResources(player, COSTS.CITY)) {
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
      if (adjVertex && (adjVertex.building || adjVertex.knight)) return true;
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

    const check = this.canBuildSettlement(playerId, vertexId, true);
    if (!check.ok) throw new Error(check.reason);

    const vertex = this.grid.vertices.get(vertexId);
    vertex.building = { type: 'settlement', playerId, color: player.color };
    player.settlementsRemaining--;
    player.settlementsBuilt.push(vertexId);
    this.lastSetupSettlementVertex = vertexId;
    this.setupStep = 'road';

    // If second round, award bootstrap resources from adjacent hexes
    if (this.phase === GAME_PHASES.SETUP_ROUND_2) {
      const awarded = {};
      for (const hexId of vertex.hexes) {
        const hex = this.grid.hexes.get(hexId);
        if (hex && hex.resource && hex.resource !== RESOURCE_TYPES.DESERT) {
          player.resources[hex.resource] = (player.resources[hex.resource] || 0) + 1;
          awarded[hex.resource] = (awarded[hex.resource] || 0) + 1;
        }
      }
      this.logEvent({
        type: 'BOOTSTRAP_RESOURCES',
        messageKey: 'LOG_BOOTSTRAP_RESOURCES',
        args: { playerName: player.name, resources: awarded }
      });
    }

    this.recalculateVictoryPoints();
    this.logEvent({
      type: 'BUILD_SETTLEMENT',
      messageKey: 'LOG_BUILT_SETTLEMENT',
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

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    this.dice = [d1, d2];
    const rollSum = d1 + d2;
    this.hasRolledDice = true;
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
    const cardType = deck.pop();
    player.progressCards.push({
      id: `prog_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: cardType,
      track,
      boughtTurn: this.turnNumber
    });
    return cardType;
  }

  applyHexProduction(player, hexResource, buildingType, production) {
    const isCity = buildingType === 'city';
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
    this.logEvent({
      type: 'ROBBER_MOVED',
      messageKey: 'LOG_ROBBER_MOVED',
      args: { playerName: player.name, hexId }
    });

    return { hexId, stolenFrom: targetPlayerId, stolenResource };
  }

  stealRandomCard(thief, target) {
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
      thief.commodities[picked.type] = (thief.commodities[picked.type] || 0) + 1;
    } else {
      target.resources[picked.type]--;
      thief.resources[picked.type] = (thief.resources[picked.type] || 0) + 1;
    }
    this.logEvent({
      type: 'ROBBER_STOLE',
      messageKey: 'LOG_ROBBER_STOLE',
      args: { robberName: thief.name, victimName: target.name }
    });
    return picked.type;
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

    this.deductResources(player, COSTS.CITY);

    const vertex = this.grid.vertices.get(vertexId);
    vertex.building = { type: 'city', playerId, color: player.color };
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

  improveCityTrack(playerId, track) {
    if (!this.isCitiesKnights()) throw new Error('NOT_CITIES_KNIGHTS_MODE');
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) throw new Error('NOT_YOUR_TURN');
    if (this.phase !== GAME_PHASES.TURN_ACTION) throw new Error('NOT_IN_ACTION_PHASE');
    if (!IMPROVEMENT_TRACKS[track]) throw new Error('INVALID_IMPROVEMENT_TRACK');
    if (!player.citiesBuilt.length) throw new Error('NEED_CITY_TO_IMPROVE');

    const currentLevel = player.cityImprovements[track] || 0;
    if (currentLevel >= 5) throw new Error('IMPROVEMENT_MAX_LEVEL');

    const cost = currentLevel + 1;
    const commodity = IMPROVEMENT_TRACKS[track];
    if ((player.commodities[commodity] || 0) < cost) throw new Error('NOT_ENOUGH_COMMODITIES');

    player.commodities[commodity] -= cost;
    player.cityImprovements[track] = currentLevel + 1;

    this.logEvent({
      type: 'CITY_IMPROVED',
      messageKey: 'LOG_CITY_IMPROVED',
      args: { playerName: player.name, track, level: player.cityImprovements[track] }
    });

    return { track, level: player.cityImprovements[track], cost };
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
      if (this.violatesDistanceRule(adjId, [fromVertexId, ...extraIgnore])) continue;
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
    if (this.violatesDistanceRule(vertexId)) throw new Error('DISTANCE_RULE_VIOLATION');
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
      strength: KNIGHT_RANKS.basic.strength
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
    if (knight.active) throw new Error('KNIGHT_ALREADY_ACTIVE');
    if (!this.hasResources(player, COSTS.ACTIVATE_KNIGHT)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.deductResources(player, COSTS.ACTIVATE_KNIGHT);
    knight.active = true;

    this.logEvent({
      type: 'KNIGHT_ACTIVATED',
      messageKey: 'LOG_KNIGHT_ACTIVATED',
      args: { playerName: player.name }
    });
    return { vertexId, knight };
  }

  promoteKnight(playerId, vertexId) {
    const player = this.assertCkAction(playerId);
    const knight = this.getKnightRecord(player, vertexId);
    if (!knight) throw new Error('KNIGHT_NOT_FOUND');
    const current = KNIGHT_RANKS[knight.rank];
    if (!current?.next) throw new Error('KNIGHT_MAX_RANK');
    const nextRank = current.next;
    const next = KNIGHT_RANKS[nextRank];
    if ((player.cityImprovements.politics || 0) < next.politicsRequired) {
      throw new Error('POLITICS_LEVEL_TOO_LOW');
    }
    if ((player.knightsAvailable[nextRank] || 0) <= 0) throw new Error('NO_KNIGHTS_AVAILABLE');
    if (!this.hasResources(player, COSTS.PROMOTE_KNIGHT)) throw new Error('NOT_ENOUGH_RESOURCES');

    this.deductResources(player, COSTS.PROMOTE_KNIGHT);
    player.knightsAvailable[knight.rank] = (player.knightsAvailable[knight.rank] || 0) + 1;
    player.knightsAvailable[nextRank]--;
    knight.rank = nextRank;
    knight.strength = next.strength;
    knight.active = true;

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
    } else if (this.violatesDistanceRule(toVertexId, [fromVertexId])) {
      throw new Error('DISTANCE_RULE_VIOLATION');
    }

    const from = this.grid.vertices.get(fromVertexId);
    if (from) from.knight = null;
    knight.vertexId = toVertexId;
    knight.active = false;
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
    if (pending.options[0]) {
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

    this.logEvent({
      type: 'KNIGHT_CHASED_ROBBER',
      messageKey: 'LOG_KNIGHT_CHASED_ROBBER',
      args: { playerName: player.name, hexId }
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
        this.defenderOfCatan = leaders[0].player.id;
        this.recalculateVictoryPoints();
        this.logEvent({
          type: 'BARBARIAN_VICTORY',
          messageKey: 'LOG_BARBARIAN_VICTORY',
          args: { playerName: leaders[0].player.name }
        });
      } else {
        this.logEvent({
          type: 'BARBARIAN_VICTORY_TIE',
          messageKey: 'LOG_BARBARIAN_VICTORY_TIE',
          args: {}
        });
      }
      this.pendingBarbarianDowngrades.clear();
      result = { outcome: 'victory', defenderOfCatan: this.defenderOfCatan, totalActiveKnights, totalCities };
    } else {
      const cityOwners = strengths.filter(row => row.player.citiesBuilt.length > 0);
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
      vertex.building = null;
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
    if (RESOURCE_VALUES.includes(giveRes)) {
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
      acceptedBy: new Set()
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
    } else {
      this.activeTrade.acceptedBy.delete(playerId);
    }

    return { trade: this.activeTrade, accepted: accept, playerId };
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

    this.activeTrade = null;
    this.freeRoadsRemaining = 0;
    this.hasRolledDice = false;
    this.devCardPlayedThisTurn = false;

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

      // Opponent settlement/city blocks road passing through unless it's the start
      if (currentLength > 0 && vertex.building && vertex.building.playerId !== playerId) {
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

      if (this.defenderOfCatan === player.id) {
        publicPoints += 1;
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
      turnNumber: this.turnNumber,
      dice: this.dice,
      eventDie: this.eventDie,
      barbarianPosition: this.barbarianPosition,
      defenderOfCatan: this.defenderOfCatan,
      hasRolledDice: this.hasRolledDice,
      grid: this.grid ? this.grid.toJSON() : null,
      pendingDiscards: Array.from(this.pendingDiscards),
      discardDeadline: this.discardDeadline,
      pendingBarbarianDowngrades: Array.from(this.pendingBarbarianDowngrades),
      lastBarbarianResult: this.lastBarbarianResult,
      pendingKnightRelocation: this.pendingKnightRelocation,
      pendingProgressDraws: this.pendingProgressDraws,
      activeTrade: this.activeTrade ? {
        ...this.activeTrade,
        acceptedBy: Array.from(this.activeTrade.acceptedBy)
      } : null,
      freeRoadsRemaining: this.freeRoadsRemaining,
      longestRoadHolder: this.longestRoadHolder,
      largestArmyHolder: this.largestArmyHolder,
      devCardsRemaining: this.devCardDeck.length,
      eventLog: this.eventLog.slice(-25),
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
          knightsAvailable: isSelf ? p.knightsAvailable : undefined,
          knightsPlaced: p.knightsPlaced,
          cityWalls: p.cityWalls,
          discardThreshold: this.getDiscardThreshold(p),
          metropolis: p.metropolis,
          progressCards: isSelf ? p.progressCards : { count: (p.progressCards || []).length },
          devCards: isSelf ? p.devCards : { count: p.devCards.filter(c => !c.played).length },
          playedKnights: p.playedKnights,
          settlementsRemaining: p.settlementsRemaining,
          citiesRemaining: p.citiesRemaining,
          roadsRemaining: p.roadsRemaining,
          settlementsBuilt: p.settlementsBuilt,
          citiesBuilt: p.citiesBuilt,
          roadsBuilt: p.roadsBuilt,
          victoryPoints: isSelf ? p.victoryPoints : p.publicVictoryPoints,
          publicVictoryPoints: p.publicVictoryPoints
        };
      })
    };
  }
}
