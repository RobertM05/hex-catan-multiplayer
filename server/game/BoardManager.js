/**
 * BoardManager.js
 * Encapsulates hexagonal board topology, coordinate math, vertex/edge graph indexing,
 * distance rule validation, road network connectivity checks, and longest road graph traversal.
 */

import { HexGrid, RESOURCE_TYPES, HARBOR_TYPES } from './HexGrid.js';

export { HexGrid, RESOURCE_TYPES, HARBOR_TYPES };

export class BoardManager {
  constructor(options = {}) {
    if (options instanceof HexGrid) {
      this.grid = options;
    } else if (options && options.grid instanceof HexGrid) {
      this.grid = options.grid;
    } else if (options && (options.mapSize || options.playerCount)) {
      this.initGrid(options);
    } else {
      this.grid = null;
    }
  }

  // --- Grid Generation ---

  initGrid(options = {}) {
    const playerCount = options.playerCount || 4;
    const mapSize = options.mapSize || (playerCount <= 4 ? 'standard' : playerCount <= 6 ? 'extended' : 'large');
    if (mapSize === 'extended') {
      return this.generateExtendedGrid(options);
    }
    if (mapSize === 'large') {
      return this.generateLargeGrid(options);
    }
    return this.generateStandardGrid(options);
  }

  generateStandardGrid(options = {}) {
    this.grid = new HexGrid({
      playerCount: options.playerCount || 4,
      hexRadius: options.hexRadius || 60,
      mapSize: 'standard',
      ...options
    });
    return this.grid;
  }

  generateExtendedGrid(options = {}) {
    this.grid = new HexGrid({
      playerCount: options.playerCount || 6,
      hexRadius: options.hexRadius || 60,
      mapSize: 'extended',
      ...options
    });
    return this.grid;
  }

  generateLargeGrid(options = {}) {
    this.grid = new HexGrid({
      playerCount: options.playerCount || 8,
      hexRadius: options.hexRadius || 60,
      mapSize: 'large',
      ...options
    });
    return this.grid;
  }

  static generateStandardGrid(options = {}) {
    const manager = new BoardManager();
    manager.generateStandardGrid(options);
    return manager;
  }

  static generateExtendedGrid(options = {}) {
    const manager = new BoardManager();
    manager.generateExtendedGrid(options);
    return manager;
  }

  static generateLargeGrid(options = {}) {
    const manager = new BoardManager();
    manager.generateLargeGrid(options);
    return manager;
  }

  // --- Graph Adjacency Collections & Getters ---

  get hexes() {
    return this.grid ? this.grid.hexes : new Map();
  }

  get vertices() {
    return this.grid ? this.grid.vertices : new Map();
  }

  get edges() {
    return this.grid ? this.grid.edges : new Map();
  }

  get mapSize() {
    return this.grid?.mapSize ?? null;
  }

  get hexRadius() {
    return this.grid?.hexRadius ?? 60;
  }

  get robberHexId() {
    return this.grid?.robberHexId ?? null;
  }

  set robberHexId(hexId) {
    if (this.grid) {
      this.grid.robberHexId = hexId;
    }
  }

  get harbors() {
    if (!this.grid) return [];
    const list = [];
    for (const edge of this.grid.edges.values()) {
      if (edge.harbor) {
        list.push({
          edgeId: edge.id,
          type: edge.harbor.type,
          ratio: edge.harbor.ratio,
          vertices: [edge.v1, edge.v2]
        });
      }
    }
    return list;
  }

  get harbours() {
    return this.harbors;
  }

  // --- Coordinate Conversions & Lookups ---

  getHex(hexId) {
    return this.grid?.hexes?.get(hexId) ?? null;
  }

  getVertex(vertexId) {
    return this.grid?.vertices?.get(vertexId) ?? null;
  }

  getEdge(edgeId) {
    return this.grid?.edges?.get(edgeId) ?? null;
  }

  getAdjacentVertices(vertexId) {
    const vertex = this.getVertex(vertexId);
    if (!vertex) return [];
    return (vertex.adjacentVertices || [])
      .map(id => this.getVertex(id))
      .filter(Boolean);
  }

  getAdjacentEdges(id) {
    const vertex = this.getVertex(id);
    if (vertex) {
      return (vertex.adjacentEdges || [])
        .map(eId => this.getEdge(eId))
        .filter(Boolean);
    }
    const edge = this.getEdge(id);
    if (edge) {
      return (edge.adjacentEdges || [])
        .map(eId => this.getEdge(eId))
        .filter(Boolean);
    }
    return [];
  }

  axialToPixel(q, r) {
    if (this.grid) {
      return this.grid.axialToPixel(q, r);
    }
    const size = this.hexRadius;
    const x = size * Math.sqrt(3) * (q + r / 2);
    const y = size * (3 / 2) * r;
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }

  pixelToAxial(x, y) {
    const size = this.hexRadius;
    const qFrac = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size;
    const rFrac = (2 / 3 * y) / size;
    return this.axialRound(qFrac, rFrac);
  }

  axialRound(q, r) {
    const s = -q - r;
    let qRound = Math.round(q);
    let rRound = Math.round(r);
    let sRound = Math.round(s);

    const qDiff = Math.abs(qRound - q);
    const rDiff = Math.abs(rRound - r);
    const sDiff = Math.abs(sRound - s);

    if (qDiff > rDiff && qDiff > sDiff) {
      qRound = -rRound - sRound;
    } else if (rDiff > sDiff) {
      rRound = -qRound - sRound;
    }
    return { q: qRound, r: rRound };
  }

  getVertexKey(x, y) {
    return `v_${Math.round(x)}_${Math.round(y)}`;
  }

  getEdgeKey(v1, v2) {
    const sorted = [v1, v2].sort();
    return `e_${sorted[0]}_${sorted[1]}`;
  }

  findEdgeByVertices(v1, v2) {
    const key = this.getEdgeKey(v1, v2);
    return this.getEdge(key);
  }

  findVertexByCoords(x, y, tolerance = 1) {
    if (!this.grid) return null;
    for (const v of this.grid.vertices.values()) {
      const dx = v.x - x;
      const dy = v.y - y;
      if (Math.hypot(dx, dy) <= tolerance) {
        return v;
      }
    }
    return null;
  }

  areHexesAdjacent(h1, h2) {
    if (this.grid?.areHexesAdjacent) {
      return this.grid.areHexesAdjacent(h1, h2);
    }
    if (!h1 || !h2 || h1.id === h2.id) return false;
    const dq = h1.q - h2.q;
    const dr = h1.r - h2.r;
    return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) === 1;
  }

  getNeighborHexes(hex) {
    const targetHex = typeof hex === 'string' ? this.getHex(hex) : hex;
    if (!targetHex) return [];
    return Array.from(this.hexes.values()).filter(other => this.areHexesAdjacent(targetHex, other));
  }

  // --- Distance Rule & Settlement Placement ---

  violatesDistanceRule(vertexId, ignoreVertexIds = []) {
    const vertex = this.getVertex(vertexId);
    if (!vertex) return true;
    const ignored = new Set(ignoreVertexIds);
    for (const adjVId of vertex.adjacentVertices || []) {
      if (ignored.has(adjVId)) continue;
      const adjVertex = this.getVertex(adjVId);
      if (adjVertex && adjVertex.building) return true;
    }
    return false;
  }

  canPlaceSettlement(arg1, arg2, arg3) {
    let vertexId;
    let options = {};

    if (typeof arg1 === 'string' && typeof arg2 === 'string') {
      if (this.grid?.vertices?.has(arg1) && !this.grid?.vertices?.has(arg2)) {
        vertexId = arg1;
        options = { playerId: arg2, isSetup: Boolean(arg3) };
      } else if (this.grid?.vertices?.has(arg2) && !this.grid?.vertices?.has(arg1)) {
        vertexId = arg2;
        options = { playerId: arg1, isSetup: Boolean(arg3) };
      } else if (arg2.startsWith('v_') && !arg1.startsWith('v_')) {
        vertexId = arg2;
        options = { playerId: arg1, isSetup: Boolean(arg3) };
      } else {
        vertexId = arg1;
        options = { playerId: arg2, isSetup: Boolean(arg3) };
      }
    } else if (typeof arg1 === 'string') {
      if (this.grid?.vertices?.has(arg1) || arg1.startsWith('v_')) {
        vertexId = arg1;
        if (typeof arg2 === 'object' && arg2 !== null) options = arg2;
      } else if (typeof arg2 === 'string') {
        vertexId = arg2;
        options = { playerId: arg1, isSetup: Boolean(arg3) };
      } else {
        vertexId = arg1;
        if (typeof arg2 === 'object' && arg2 !== null) options = arg2;
      }
    } else {
      vertexId = arg1?.vertexId || arg1;
      if (typeof arg2 === 'object' && arg2 !== null) options = arg2;
    }

    const { playerId = null, isSetup = false, ignoreVertexIds = [] } = options;

    const vertex = this.getVertex(vertexId);
    if (!vertex || vertex.building || vertex.knight) {
      return { ok: false, reason: 'VERTEX_OCCUPIED' };
    }

    if (this.violatesDistanceRule(vertexId, ignoreVertexIds)) {
      return { ok: false, reason: 'DISTANCE_RULE_VIOLATION' };
    }

    if (isSetup) {
      return { ok: true };
    }

    if (playerId) {
      const hasConnectingRoad = (vertex.adjacentEdges || []).some(edgeId => {
        const edge = this.getEdge(edgeId);
        return edge?.road && edge.road.playerId === playerId;
      });

      if (!hasConnectingRoad) {
        return { ok: false, reason: 'MUST_CONNECT_TO_ROAD' };
      }
    }

    return { ok: true };
  }

  canPlaceCity(arg1, arg2) {
    let vertexId;
    let playerId = null;

    if (typeof arg1 === 'string' && typeof arg2 === 'string') {
      if (this.grid?.vertices?.has(arg1) && !this.grid?.vertices?.has(arg2)) {
        vertexId = arg1;
        playerId = arg2;
      } else if (this.grid?.vertices?.has(arg2) && !this.grid?.vertices?.has(arg1)) {
        vertexId = arg2;
        playerId = arg1;
      } else if (arg2.startsWith('v_') && !arg1.startsWith('v_')) {
        vertexId = arg2;
        playerId = arg1;
      } else {
        vertexId = arg1;
        playerId = arg2;
      }
    } else if (typeof arg1 === 'string') {
      vertexId = arg1;
      if (typeof arg2 === 'object' && arg2 !== null) playerId = arg2.playerId || null;
    } else {
      vertexId = arg1?.vertexId || arg1;
      if (typeof arg2 === 'object' && arg2 !== null) playerId = arg2.playerId || null;
    }

    const vertex = this.getVertex(vertexId);
    if (!vertex || !vertex.building || vertex.building.type !== 'settlement') {
      return { ok: false, reason: 'MUST_UPGRADE_SETTLEMENT' };
    }

    if (playerId && vertex.building.playerId !== playerId) {
      return { ok: false, reason: 'MUST_UPGRADE_OWN_SETTLEMENT' };
    }

    return { ok: true };
  }

  // --- Road Network Connectivity & Placement ---

  canPlaceRoad(arg1, arg2, arg3, arg4) {
    let edgeId;
    let options = {};

    if (typeof arg1 === 'string' && typeof arg2 === 'string') {
      if (this.grid?.edges?.has(arg1) && !this.grid?.edges?.has(arg2)) {
        edgeId = arg1;
        options = { playerId: arg2, isSetup: Boolean(arg3), setupSettlementVertexId: arg4 || null };
      } else if (this.grid?.edges?.has(arg2) && !this.grid?.edges?.has(arg1)) {
        edgeId = arg2;
        options = { playerId: arg1, isSetup: Boolean(arg3), setupSettlementVertexId: arg4 || null };
      } else if (arg2.startsWith('e_') && !arg1.startsWith('e_')) {
        edgeId = arg2;
        options = { playerId: arg1, isSetup: Boolean(arg3), setupSettlementVertexId: arg4 || null };
      } else {
        edgeId = arg1;
        options = { playerId: arg2, isSetup: Boolean(arg3), setupSettlementVertexId: arg4 || null };
      }
    } else if (typeof arg1 === 'string' && typeof arg2 === 'object' && arg2 !== null) {
      if (this.grid?.edges?.has(arg1) || arg1.startsWith('e_')) {
        edgeId = arg1;
        options = arg2;
      } else {
        edgeId = arg2.edgeId || arg1;
        options = { playerId: arg1, ...arg2 };
      }
    } else if (typeof arg2 === 'string' && (this.grid?.edges?.has(arg2) || arg2.startsWith('e_'))) {
      edgeId = arg2;
      if (typeof arg3 === 'object' && arg3 !== null) {
        options = { playerId: arg1, ...arg3 };
      } else {
        options = { playerId: arg1, isSetup: Boolean(arg3), setupSettlementVertexId: arg4 || null };
      }
    } else {
      edgeId = arg1?.edgeId || arg1;
      if (typeof arg2 === 'object' && arg2 !== null) options = arg2;
    }

    const { playerId = null, isSetup = false, setupSettlementVertexId = null } = options;

    const edge = this.getEdge(edgeId);
    if (!edge || edge.road) {
      return { ok: false, reason: 'EDGE_OCCUPIED' };
    }

    if (isSetup) {
      if (setupSettlementVertexId) {
        if (edge.v1 === setupSettlementVertexId || edge.v2 === setupSettlementVertexId) {
          return { ok: true };
        }
        return { ok: false, reason: 'MUST_CONNECT_TO_SETUP_SETTLEMENT' };
      }
      return { ok: true };
    }

    if (playerId) {
      let connects = false;
      const v1 = this.getVertex(edge.v1);
      const v2 = this.getVertex(edge.v2);

      if ((v1?.building && v1.building.playerId === playerId) || (v2?.building && v2.building.playerId === playerId)) {
        connects = true;
      }

      if (!connects) {
        for (const adjEdgeId of edge.adjacentEdges || []) {
          const adjEdge = this.getEdge(adjEdgeId);
          if (adjEdge?.road && adjEdge.road.playerId === playerId) {
            const sharedVertexId = (edge.v1 === adjEdge.v1 || edge.v1 === adjEdge.v2) ? edge.v1 : edge.v2;
            const sharedVertex = this.getVertex(sharedVertexId);
            const blockedByBuilding = sharedVertex?.building && sharedVertex.building.playerId !== playerId;
            const blockedByKnight = sharedVertex?.knight && sharedVertex.knight.playerId !== playerId;
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
    }

    return { ok: true };
  }

  // --- Placement State Mutation Helpers ---

  placeSettlement(vertexId, { playerId, color, type = 'settlement' } = {}) {
    const vertex = this.getVertex(vertexId);
    if (!vertex) throw new Error('INVALID_VERTEX');
    vertex.building = { type, playerId, color };
    return vertex;
  }

  placeCity(vertexId, { playerId, color } = {}) {
    const vertex = this.getVertex(vertexId);
    if (!vertex) throw new Error('INVALID_VERTEX');
    vertex.building = {
      type: 'city',
      playerId: playerId || vertex.building?.playerId,
      color: color || vertex.building?.color,
      hasWall: vertex.building?.hasWall || false
    };
    return vertex;
  }

  placeRoad(edgeId, { playerId, color } = {}) {
    const edge = this.getEdge(edgeId);
    if (!edge) throw new Error('INVALID_EDGE');
    edge.road = { playerId, color };
    return edge;
  }

  removeRoad(edgeId) {
    const edge = this.getEdge(edgeId);
    if (!edge?.road) throw new Error('NO_ROAD');
    const road = edge.road;
    edge.road = null;
    return road;
  }

  vertexHasPlayerRoad(vertexOrId, playerId) {
    const vertex = typeof vertexOrId === 'string' ? this.getVertex(vertexOrId) : vertexOrId;
    if (!vertex) return false;
    for (const edgeId of vertex.adjacentEdges || []) {
      const edge = this.getEdge(edgeId);
      if (edge?.road && edge.road.playerId === playerId) return true;
    }
    return false;
  }

  verticesSharePlayerRoad(fromId, toId, playerId) {
    const from = this.getVertex(fromId);
    if (!from) return false;
    for (const edgeId of from.adjacentEdges || []) {
      const edge = this.getEdge(edgeId);
      if (!edge || !edge.road || edge.road.playerId !== playerId) continue;
      if (edge.v1 === toId || edge.v2 === toId) return true;
    }
    return false;
  }

  isOpenRoad(edgeId) {
    const edge = this.getEdge(edgeId);
    if (!edge?.road) return false;
    const ownerId = edge.road.playerId;

    const isEndClosed = (vertexId) => {
      const vertex = this.getVertex(vertexId);
      if (!vertex) return false;
      if (vertex.building && vertex.building.playerId === ownerId) return true;
      for (const adjId of vertex.adjacentEdges || []) {
        if (adjId === edgeId) continue;
        const adj = this.getEdge(adjId);
        if (adj?.road?.playerId === ownerId) return true;
      }
      return false;
    };

    return !isEndClosed(edge.v1) || !isEndClosed(edge.v2);
  }

  playerControlsAdjacentVertex(playerId, vertexId) {
    const vertex = this.getVertex(vertexId);
    if (!vertex) return false;
    for (const adjId of vertex.adjacentVertices || []) {
      const adj = this.getVertex(adjId);
      if (adj?.building?.playerId === playerId) return true;
      if (adj?.knight?.playerId === playerId) return true;
    }
    return this.vertexHasPlayerRoad(vertex, playerId);
  }

  playerBuildingTouchesHex(player, hexId) {
    const ids = (player.settlementsBuilt || []).concat(player.citiesBuilt || []);
    return ids.some((vid) => this.getVertex(vid)?.hexes?.includes(hexId));
  }

  getPlayersAdjacentToHex(hexId, players = []) {
    const seen = new Set();
    const adjacent = [];
    for (const vertex of this.vertices.values()) {
      if (!vertex.hexes?.includes(hexId) || !vertex.building) continue;
      const owner = players.find(p => p.id === vertex.building.playerId);
      if (!owner || seen.has(owner.id)) continue;
      seen.add(owner.id);
      adjacent.push(owner);
    }
    return adjacent;
  }

  // --- Longest Road DFS ---

  calculateLongestRoad(playerId) {
    const playerRoads = this.grid
      ? Array.from(this.grid.edges.values()).filter(e => e.road && e.road.playerId === playerId)
      : [];
    if (playerRoads.length === 0) return 0;

    let maxLength = 0;
    const visitedEdges = new Set();

    const dfs = (vertexId, currentLength) => {
      maxLength = Math.max(maxLength, currentLength);
      const vertex = this.getVertex(vertexId);
      if (!vertex) return;

      // Opponent settlement/city or knight blocks road passing through unless it's the start
      if (
        currentLength > 0 &&
        ((vertex.building && vertex.building.playerId !== playerId) ||
          (vertex.knight && vertex.knight.playerId !== playerId))
      ) {
        return;
      }

      for (const eId of vertex.adjacentEdges || []) {
        if (!visitedEdges.has(eId)) {
          const edge = this.getEdge(eId);
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

  calculatePlayerLongestRoad(playerId) {
    return this.calculateLongestRoad(playerId);
  }

  // --- Serialization & Cloning ---

  serialize() {
    return this.grid ? this.grid.toJSON() : null;
  }

  toJSON() {
    return this.serialize();
  }

  clone() {
    const cloned = new BoardManager();
    if (this.grid) {
      cloned.grid = HexGrid.fromJSON(JSON.parse(JSON.stringify(this.grid.toJSON())));
    }
    return cloned;
  }

  static deserialize(data) {
    const board = new BoardManager();
    if (data) {
      const raw = data.grid || data;
      const gridData = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
      board.grid = HexGrid.fromJSON(gridData);
    }
    return board;
  }

  static fromJSON(data) {
    return BoardManager.deserialize(data);
  }
}
