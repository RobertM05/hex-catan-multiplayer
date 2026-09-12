/**
 * HexGrid.js
 * Procedural hexagonal grid generator for Catan-style gameplay.
 * Pointy-topped hexes with axial coordinates (q, r).
 * Automatically calculates shared vertices and edges with adjacency graph.
 */

export const RESOURCE_TYPES = {
  WOOD: 'wood',
  BRICK: 'brick',
  WOOL: 'wool',
  WHEAT: 'wheat',
  ORE: 'ore',
  DESERT: 'desert'
};

export const HARBOR_TYPES = {
  GENERIC: 'generic', // 3:1
  WOOD: 'wood',       // 2:1
  BRICK: 'brick',     // 2:1
  WOOL: 'wool',       // 2:1
  WHEAT: 'wheat',     // 2:1
  ORE: 'ore'          // 2:1
};

export class HexGrid {
  constructor(options = {}) {
    this.playerCount = options.playerCount || 4;
    this.mapSize = options.mapSize || (this.playerCount <= 4 ? 'standard' : this.playerCount <= 6 ? 'extended' : 'large');
    this.hexRadius = options.hexRadius || 60; // visual size units

    this.hexes = new Map();     // hexId -> Hex object
    this.vertices = new Map();  // vertexId -> Vertex object
    this.edges = new Map();     // edgeId -> Edge object
    this.robberHexId = null;

    this.generate();
  }

  generate() {
    this.generateHexCoordinates();
    this.assignResourcesAndTokens();
    this.buildGraph();
    this.assignHarbors();
  }

  generateHexCoordinates() {
    this.hexes.clear();

    if (this.mapSize === 'standard') {
      // Radius 2 pointy-top: 19 hexes
      const R = 2;
      for (let q = -R; q <= R; q++) {
        const r1 = Math.max(-R, -q - R);
        const r2 = Math.min(R, -q + R);
        for (let r = r1; r <= r2; r++) {
          const id = `hex_${q}_${r}`;
          this.hexes.set(id, {
            id,
            q,
            r,
            s: -q - r,
            center: this.axialToPixel(q, r),
            resource: null,
            token: null
          });
        }
      }
    } else if (this.mapSize === 'extended') {
      // Official 5-6 player layout: 7 horizontal rows (3, 4, 5, 6, 5, 4, 3 = 30 hexes)
      const rowLayout = [
        { r: -3, qStart: 0, count: 3 },  // Row 1: 3 hexes
        { r: -2, qStart: -1, count: 4 }, // Row 2: 4 hexes
        { r: -1, qStart: -2, count: 5 }, // Row 3: 5 hexes
        { r: 0,  qStart: -3, count: 6 }, // Row 4 (center): 6 hexes
        { r: 1,  qStart: -3, count: 5 }, // Row 5: 5 hexes
        { r: 2,  qStart: -3, count: 4 }, // Row 6: 4 hexes
        { r: 3,  qStart: -3, count: 3 }  // Row 7: 3 hexes
      ];

      for (const { r, qStart, count } of rowLayout) {
        for (let i = 0; i < count; i++) {
          const q = qStart + i;
          const id = `hex_${q}_${r}`;
          this.hexes.set(id, {
            id,
            q,
            r,
            s: -q - r,
            center: this.axialToPixel(q, r),
            resource: null,
            token: null
          });
        }
      }
    } else {
      // 7-8 players: 42 hexes
      const R = 4;
      for (let q = -R; q <= R; q++) {
        const r1 = Math.max(-R, -q - R);
        const r2 = Math.min(R, -q + R);
        for (let r = r1; r <= r2; r++) {
          if (this.hexes.size >= 42) break;
          const id = `hex_${q}_${r}`;
          this.hexes.set(id, {
            id,
            q,
            r,
            s: -q - r,
            center: this.axialToPixel(q, r),
            resource: null,
            token: null
          });
        }
      }
    }
  }

  axialToPixel(q, r) {
    const size = this.hexRadius;
    const x = size * Math.sqrt(3) * (q + r / 2);
    const y = size * (3 / 2) * r;
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }

  assignResourcesAndTokens() {
    const hexCount = this.hexes.size;
    let resourcePool = [];
    let tokenPool = [];

    if (hexCount <= 19) {
      resourcePool = [
        RESOURCE_TYPES.DESERT,
        RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD,
        RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK,
        RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL,
        RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT,
        RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE
      ];
      tokenPool = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
    } else if (hexCount <= 30) {
      // 30 hexes: 2 deserts, 28 resources
      resourcePool = [
        RESOURCE_TYPES.DESERT, RESOURCE_TYPES.DESERT,
        RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD,
        RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK,
        RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL,
        RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT,
        RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE
      ];
      tokenPool = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12];
    } else {
      // 42+ hexes
      const multiplier = Math.ceil(hexCount / 19);
      for (let i = 0; i < multiplier; i++) {
        resourcePool.push(
          RESOURCE_TYPES.DESERT,
          RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD, RESOURCE_TYPES.WOOD,
          RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.BRICK,
          RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WOOL,
          RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.WHEAT,
          RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE, RESOURCE_TYPES.ORE
        );
        tokenPool.push(2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12);
      }
      resourcePool = resourcePool.slice(0, hexCount);
      tokenPool = tokenPool.slice(0, hexCount - 2);
    }

    // Shuffle arrays
    this.shuffle(resourcePool);
    this.shuffle(tokenPool);

    // Assign to hexes, keeping 6 and 8 from being adjacent if possible
    const hexList = Array.from(this.hexes.values());
    let tokenIndex = 0;

    for (let i = 0; i < hexList.length; i++) {
      const hex = hexList[i];
      const res = resourcePool[i] || RESOURCE_TYPES.WOOD;
      hex.resource = res;
      if (res === RESOURCE_TYPES.DESERT) {
        hex.token = null;
        if (!this.robberHexId) {
          this.robberHexId = hex.id;
        }
      } else {
        hex.token = tokenPool[tokenIndex++] || 6;
      }
    }

    if (!this.robberHexId && hexList.length > 0) {
      this.robberHexId = hexList[0].id;
    }

    // Enforce official Red Number Rule (no adjacent 6 and 8)
    this.resolveRedNumberAdjacencies();
  }

  buildGraph() {
    this.vertices.clear();
    this.edges.clear();

    const getVertexKey = (x, y) => `v_${Math.round(x)}_${Math.round(y)}`;
    const getEdgeKey = (v1, v2) => {
      const sorted = [v1, v2].sort();
      return `e_${sorted[0]}_${sorted[1]}`;
    };

    // Calculate 6 corners for each pointy-top hex
    for (const hex of this.hexes.values()) {
      const { x, y } = hex.center;
      const cornerVertices = [];

      for (let i = 0; i < 6; i++) {
        // Pointy-top corners at angles: 30, 90, 150, 210, 270, 330 deg
        const angle = (Math.PI / 180) * (30 + i * 60);
        const vx = x + this.hexRadius * Math.cos(angle);
        const vy = y + this.hexRadius * Math.sin(angle);
        const vKey = getVertexKey(vx, vy);

        if (!this.vertices.has(vKey)) {
          this.vertices.set(vKey, {
            id: vKey,
            x: Math.round(vx * 10) / 10,
            y: Math.round(vy * 10) / 10,
            hexes: [],
            adjacentVertices: new Set(),
            adjacentEdges: new Set(),
            building: null, // { type: 'settlement'|'city', playerId, color }
            knight: null, // { playerId, rank, active, strength, vertexId }
            harbor: null
          });
        }

        const vertex = this.vertices.get(vKey);
        if (!vertex.hexes.includes(hex.id)) {
          vertex.hexes.push(hex.id);
        }
        cornerVertices.push(vKey);
      }

      // Create edges between consecutive corners (0-1, 1-2, 2-3, 3-4, 4-5, 5-0)
      for (let i = 0; i < 6; i++) {
        const v1Key = cornerVertices[i];
        const v2Key = cornerVertices[(i + 1) % 6];
        const eKey = getEdgeKey(v1Key, v2Key);

        if (!this.edges.has(eKey)) {
          const v1 = this.vertices.get(v1Key);
          const v2 = this.vertices.get(v2Key);
          this.edges.set(eKey, {
            id: eKey,
            v1: v1Key,
            v2: v2Key,
            x1: v1.x,
            y1: v1.y,
            x2: v2.x,
            y2: v2.y,
            midpoint: {
              x: Math.round(((v1.x + v2.x) / 2) * 10) / 10,
              y: Math.round(((v1.y + v2.y) / 2) * 10) / 10
            },
            hexes: [],
            adjacentEdges: new Set(),
            road: null // { playerId, color }
          });
        }

        const edge = this.edges.get(eKey);
        if (!edge.hexes.includes(hex.id)) {
          edge.hexes.push(hex.id);
        }

        // Connect vertices
        this.vertices.get(v1Key).adjacentVertices.add(v2Key);
        this.vertices.get(v1Key).adjacentEdges.add(eKey);
        this.vertices.get(v2Key).adjacentVertices.add(v1Key);
        this.vertices.get(v2Key).adjacentEdges.add(eKey);
      }
    }

    // Connect adjacent edges (edges sharing a vertex)
    for (const edge of this.edges.values()) {
      const v1 = this.vertices.get(edge.v1);
      const v2 = this.vertices.get(edge.v2);
      for (const eId of v1.adjacentEdges) {
        if (eId !== edge.id) edge.adjacentEdges.add(eId);
      }
      for (const eId of v2.adjacentEdges) {
        if (eId !== edge.id) edge.adjacentEdges.add(eId);
      }
    }

    // Convert Sets to Arrays for serialization
    for (const vertex of this.vertices.values()) {
      vertex.adjacentVertices = Array.from(vertex.adjacentVertices);
      vertex.adjacentEdges = Array.from(vertex.adjacentEdges);
    }
    for (const edge of this.edges.values()) {
      edge.adjacentEdges = Array.from(edge.adjacentEdges);
    }
  }

  areHexesAdjacent(h1, h2) {
    if (!h1 || !h2 || h1.id === h2.id) return false;
    const dq = h1.q - h2.q;
    const dr = h1.r - h2.r;
    return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) === 1;
  }

  hasAdjacentRedNumbers() {
    const redHexes = Array.from(this.hexes.values()).filter(h => h.token === 6 || h.token === 8);
    for (let i = 0; i < redHexes.length; i++) {
      for (let j = i + 1; j < redHexes.length; j++) {
        if (this.areHexesAdjacent(redHexes[i], redHexes[j])) {
          return true;
        }
      }
    }
    return false;
  }

  resolveRedNumberAdjacencies() {
    const hexList = Array.from(this.hexes.values()).filter(h => h.token !== null);
    const maxAttempts = 500;
    let attempts = 0;

    while (this.hasAdjacentRedNumbers() && attempts < maxAttempts) {
      attempts++;
      const redHexes = hexList.filter(h => h.token === 6 || h.token === 8);
      let conflictHex = null;

      for (let i = 0; i < redHexes.length; i++) {
        for (let j = i + 1; j < redHexes.length; j++) {
          if (this.areHexesAdjacent(redHexes[i], redHexes[j])) {
            conflictHex = redHexes[j];
            break;
          }
        }
        if (conflictHex) break;
      }

      if (!conflictHex) break;

      // Find non-red hexes
      const nonRedHexes = hexList.filter(h => h.token !== 6 && h.token !== 8);
      this.shuffle(nonRedHexes);

      let swapped = false;
      for (const candidate of nonRedHexes) {
        const otherReds = redHexes.filter(r => r.id !== conflictHex.id);
        const wouldCauseConflict = otherReds.some(r => this.areHexesAdjacent(candidate, r));
        if (!wouldCauseConflict) {
          const temp = conflictHex.token;
          conflictHex.token = candidate.token;
          candidate.token = temp;
          swapped = true;
          break;
        }
      }

      if (!swapped && nonRedHexes.length > 0) {
        const randomCandidate = nonRedHexes[Math.floor(Math.random() * nonRedHexes.length)];
        const temp = conflictHex.token;
        conflictHex.token = randomCandidate.token;
        randomCandidate.token = temp;
      }
    }

    return !this.hasAdjacentRedNumbers();
  }

  assignHarbors() {
    // Coastal edges have only 1 hex touching them; sort in perimeter order by polar angle
    const coastalEdges = Array.from(this.edges.values())
      .filter(e => e.hexes.length === 1)
      .sort((a, b) => Math.atan2(a.midpoint.y, a.midpoint.x) - Math.atan2(b.midpoint.y, b.midpoint.x));
    
    // Official Catan harbor distributions:
    // Standard (9 harbors): 4 generic 3:1, 1 each of Wood, Brick, Wool, Wheat, Ore
    // Extended (11 harbors): 5 generic 3:1, 1 Wood, 1 Brick, 2 Wool, 1 Wheat, 1 Ore
    const harborTypes = [
      { type: HARBOR_TYPES.GENERIC, ratio: 3 },
      { type: HARBOR_TYPES.WOOD, ratio: 2 },
      { type: HARBOR_TYPES.BRICK, ratio: 2 },
      { type: HARBOR_TYPES.GENERIC, ratio: 3 },
      { type: HARBOR_TYPES.WOOL, ratio: 2 },
      { type: HARBOR_TYPES.WHEAT, ratio: 2 },
      { type: HARBOR_TYPES.GENERIC, ratio: 3 },
      { type: HARBOR_TYPES.ORE, ratio: 2 },
      { type: HARBOR_TYPES.GENERIC, ratio: 3 }
    ];

    if (this.mapSize === 'extended') {
      harborTypes.push(
        { type: HARBOR_TYPES.WOOL, ratio: 2 },
        { type: HARBOR_TYPES.GENERIC, ratio: 3 }
      );
    }

    const count = harborTypes.length;
    const step = coastalEdges.length / count;
    for (let i = 0; i < count; i++) {
      const edgeIndex = Math.floor(i * step);
      let edge = coastalEdges[edgeIndex];

      // Avoid vertex sharing between adjacent harbors
      let offset = 0;
      while (edge && offset < coastalEdges.length) {
        const v1 = this.vertices.get(edge.v1);
        const v2 = this.vertices.get(edge.v2);
        if (v1 && !v1.harbor && v2 && !v2.harbor) {
          break;
        }
        offset++;
        const nextIndex = (edgeIndex + offset) % coastalEdges.length;
        edge = coastalEdges[nextIndex];
      }

      if (!edge) continue;

      const harborInfo = harborTypes[i];
      const v1 = this.vertices.get(edge.v1);
      const v2 = this.vertices.get(edge.v2);

      if (v1 && !v1.harbor) {
        v1.harbor = { ...harborInfo, edgeId: edge.id };
      }
      if (v2 && !v2.harbor) {
        v2.harbor = { ...harborInfo, edgeId: edge.id };
      }
      edge.harbor = { ...harborInfo };
    }
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  toJSON() {
    return {
      mapSize: this.mapSize,
      hexRadius: this.hexRadius,
      robberHexId: this.robberHexId,
      hexes: Object.fromEntries(this.hexes),
      vertices: Object.fromEntries(this.vertices),
      edges: Object.fromEntries(this.edges)
    };
  }

  static fromJSON(data) {
    const grid = new HexGrid({ mapSize: data.mapSize, hexRadius: data.hexRadius });
    grid.robberHexId = data.robberHexId;
    grid.hexes = new Map(Object.entries(data.hexes));
    grid.vertices = new Map(Object.entries(data.vertices));
    grid.edges = new Map(Object.entries(data.edges));
    return grid;
  }
}
