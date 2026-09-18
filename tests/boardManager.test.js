/**
 * tests/boardManager.test.js
 * Comprehensive unit tests for BoardManager (ARCH-01).
 * Tests grid creation, coordinate math, distance rule, road connectivity,
 * longest road traversal (branching, cycles, interruptions), cloning, and serialization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BoardManager } from '../server/game/BoardManager.js';
import { GameEngine } from '../server/game/GameEngine.js';
import { HexGrid, RESOURCE_TYPES, HARBOR_TYPES } from '../server/game/HexGrid.js';

describe('BoardManager - Grid Creation', () => {
  it('generates standard grid (19 hexes, 54 vertices, 72 edges, 9 harbors)', () => {
    const board = BoardManager.generateStandardGrid({ playerCount: 4 });

    assert.equal(board.mapSize, 'standard');
    assert.equal(board.hexes.size, 19, 'Standard board must have 19 hexes');
    assert.equal(board.vertices.size, 54, 'Standard board must have 54 vertices');
    assert.equal(board.edges.size, 72, 'Standard board must have 72 edges');
    assert.equal(board.harbors.length, 9, 'Standard board must have 9 harbors');
    assert.equal(board.harbours.length, 9, 'Harbours alias must match harbors');
    assert.ok(board.robberHexId, 'Robber must be placed on standard grid');

    const robberHex = board.getHex(board.robberHexId);
    assert.equal(robberHex.resource, RESOURCE_TYPES.DESERT, 'Robber must start on desert hex');
  });

  it('generates extended grid (30 hexes, 80 vertices, 109 edges, 11 harbors)', () => {
    const board = BoardManager.generateExtendedGrid({ playerCount: 6 });

    assert.equal(board.mapSize, 'extended');
    assert.equal(board.hexes.size, 30, 'Extended board must have 30 hexes');
    assert.equal(board.vertices.size, 80, 'Extended board must have 80 vertices');
    assert.equal(board.edges.size, 109, 'Extended board must have 109 edges');
    assert.equal(board.harbors.length, 11, 'Extended board must have 11 harbors');
    assert.ok(board.robberHexId, 'Robber must be placed on extended grid');
  });

  it('supports constructor options and instance initialization', () => {
    const board1 = new BoardManager({ mapSize: 'standard', playerCount: 4 });
    assert.equal(board1.hexes.size, 19);

    const board2 = new BoardManager({ mapSize: 'extended', playerCount: 6 });
    assert.equal(board2.hexes.size, 30);

    const board3 = new BoardManager();
    assert.equal(board3.grid, null);
    board3.initGrid({ mapSize: 'standard' });
    assert.equal(board3.hexes.size, 19);

    const grid = new HexGrid({ mapSize: 'standard' });
    const board4 = new BoardManager(grid);
    assert.equal(board4.grid, grid);
    assert.equal(board4.hexes.size, 19);
  });

  it('ensures no adjacent red numbers (6 and 8) on generated board', () => {
    for (let testRun = 0; testRun < 10; testRun++) {
      const board = BoardManager.generateStandardGrid();
      const redHexes = Array.from(board.hexes.values()).filter(h => h.token === 6 || h.token === 8);
      for (let i = 0; i < redHexes.length; i++) {
        for (let j = i + 1; j < redHexes.length; j++) {
          assert.equal(
            board.areHexesAdjacent(redHexes[i], redHexes[j]),
            false,
            `Red numbers at ${redHexes[i].id} and ${redHexes[j].id} must not be adjacent`
          );
        }
      }
    }
  });

  it('distributes correct harbor types without collisions', () => {
    const board = BoardManager.generateStandardGrid();
    const harbors = board.harbors;
    assert.equal(harbors.length, 9);

    const generic = harbors.filter(h => h.type === HARBOR_TYPES.GENERIC);
    assert.equal(generic.length, 4, 'Standard board must have 4 generic 3:1 harbors');
    for (const res of [RESOURCE_TYPES.WOOD, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.WOOL, RESOURCE_TYPES.WHEAT, RESOURCE_TYPES.ORE]) {
      const resHarbors = harbors.filter(h => h.type === res);
      assert.equal(resHarbors.length, 1, `Must have exactly 1 2:1 harbor for ${res}`);
    }

    // No two harbors should share a vertex
    const usedVertices = new Set();
    for (const h of harbors) {
      for (const vId of h.vertices) {
        assert.equal(usedVertices.has(vId), false, `Harbor vertex ${vId} must not be shared`);
        usedVertices.add(vId);
      }
    }
  });
});

describe('BoardManager - Coordinate Conversions & Lookups', () => {
  it('performs axialToPixel and pixelToAxial round-trip coordinate conversions', () => {
    const board = BoardManager.generateStandardGrid({ hexRadius: 60 });
    const testCoords = [
      { q: 0, r: 0 },
      { q: 1, r: -1 },
      { q: -2, r: 1 },
      { q: 2, r: 0 },
      { q: -1, r: 2 }
    ];

    for (const { q, r } of testCoords) {
      const pixel = board.axialToPixel(q, r);
      assert.ok(typeof pixel.x === 'number' && typeof pixel.y === 'number');

      const axial = board.pixelToAxial(pixel.x, pixel.y);
      assert.equal(axial.q, q, `axial.q should match ${q}`);
      assert.equal(axial.r, r, `axial.r should match ${r}`);
    }
  });

  it('looks up hexes, vertices, and edges by ID', () => {
    const board = BoardManager.generateStandardGrid();
    const hex = board.getHex('hex_0_0');
    assert.ok(hex);
    assert.equal(hex.q, 0);
    assert.equal(hex.r, 0);

    const firstVertexId = Array.from(board.vertices.keys())[0];
    const vertex = board.getVertex(firstVertexId);
    assert.ok(vertex);
    assert.equal(vertex.id, firstVertexId);

    const firstEdgeId = Array.from(board.edges.keys())[0];
    const edge = board.getEdge(firstEdgeId);
    assert.ok(edge);
    assert.equal(edge.id, firstEdgeId);
  });

  it('retrieves adjacent vertices and adjacent edges', () => {
    const board = BoardManager.generateStandardGrid();
    const vertex = Array.from(board.vertices.values()).find(v => v.adjacentVertices.length === 3);
    assert.ok(vertex);

    const adjVertices = board.getAdjacentVertices(vertex.id);
    assert.equal(adjVertices.length, 3);
    for (const adj of adjVertices) {
      assert.ok(adj.id);
      assert.ok(vertex.adjacentVertices.includes(adj.id));
    }

    const adjEdges = board.getAdjacentEdges(vertex.id);
    assert.equal(adjEdges.length, 3);
    for (const e of adjEdges) {
      assert.ok(e.id);
      assert.ok(e.v1 === vertex.id || e.v2 === vertex.id);
    }
  });

  it('finds edge by its endpoint vertices regardless of order', () => {
    const board = BoardManager.generateStandardGrid();
    const edge = Array.from(board.edges.values())[0];

    const found1 = board.findEdgeByVertices(edge.v1, edge.v2);
    const found2 = board.findEdgeByVertices(edge.v2, edge.v1);

    assert.equal(found1?.id, edge.id);
    assert.equal(found2?.id, edge.id);
  });

  it('finds vertex by pixel coordinates within tolerance', () => {
    const board = BoardManager.generateStandardGrid();
    const vertex = Array.from(board.vertices.values())[0];

    const foundExact = board.findVertexByCoords(vertex.x, vertex.y);
    assert.equal(foundExact?.id, vertex.id);

    const foundSlightOffset = board.findVertexByCoords(vertex.x + 0.5, vertex.y - 0.5, 1);
    assert.equal(foundSlightOffset?.id, vertex.id);

    const notFound = board.findVertexByCoords(9999, 9999);
    assert.equal(notFound, null);
  });

  it('identifies adjacent hexes and gets neighbor hexes', () => {
    const board = BoardManager.generateStandardGrid();
    const centerHex = board.getHex('hex_0_0');
    assert.ok(centerHex);

    const neighbors = board.getNeighborHexes(centerHex);
    assert.equal(neighbors.length, 6, 'Center hex of radius 2 grid has 6 neighbors');

    for (const neighbor of neighbors) {
      assert.ok(board.areHexesAdjacent(centerHex, neighbor));
    }
  });
});

describe('BoardManager - Distance Rule & Settlement Placement', () => {
  it('allows settlement on empty vertex during setup', () => {
    const board = BoardManager.generateStandardGrid();
    const vertex = Array.from(board.vertices.values())[0];

    const check = board.canPlaceSettlement(vertex.id, { playerId: 'p1', isSetup: true });
    assert.equal(check.ok, true);

    const checkFlexibleSignature = board.canPlaceSettlement('p1', vertex.id, true);
    assert.equal(checkFlexibleSignature.ok, true);
  });

  it('enforces distance rule: settlement cannot be placed within 1 edge of another', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values()).find(v => v.adjacentVertices.length === 3);
    assert.ok(v1);

    // Place settlement at v1
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });

    // Try placing at v1 again -> VERTEX_OCCUPIED
    const occupiedCheck = board.canPlaceSettlement(v1.id, { playerId: 'p2', isSetup: true });
    assert.equal(occupiedCheck.ok, false);
    assert.equal(occupiedCheck.reason, 'VERTEX_OCCUPIED');

    // Try placing at each of v1's adjacent vertices (distance = 1 edge) -> DISTANCE_RULE_VIOLATION
    for (const adjVId of v1.adjacentVertices) {
      assert.equal(board.violatesDistanceRule(adjVId), true);
      const adjCheck = board.canPlaceSettlement(adjVId, { playerId: 'p2', isSetup: true });
      assert.equal(adjCheck.ok, false);
      assert.equal(adjCheck.reason, 'DISTANCE_RULE_VIOLATION');
    }

    // Find a vertex at distance 2 edges (adjacent to adjV, but not v1 or adjacent to v1)
    let dist2Vertex = null;
    for (const adjVId of v1.adjacentVertices) {
      const adjV = board.getVertex(adjVId);
      for (const candidateId of adjV.adjacentVertices) {
        if (candidateId !== v1.id && !v1.adjacentVertices.includes(candidateId)) {
          dist2Vertex = board.getVertex(candidateId);
          break;
        }
      }
      if (dist2Vertex) break;
    }

    assert.ok(dist2Vertex, 'Should find a vertex at distance 2 edges');
    assert.equal(board.violatesDistanceRule(dist2Vertex.id), false);
    const dist2Check = board.canPlaceSettlement(dist2Vertex.id, { playerId: 'p2', isSetup: true });
    assert.equal(dist2Check.ok, true, 'Settlement at distance 2 edges must be legal');
  });

  it('supports ignoreVertexIds in distance rule check', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values()).find(v => v.adjacentVertices.length === 3);
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });

    const adjVId = v1.adjacentVertices[0];
    assert.equal(board.violatesDistanceRule(adjVId), true);
    assert.equal(board.violatesDistanceRule(adjVId, [v1.id]), false);

    const checkWithIgnore = board.canPlaceSettlement(adjVId, {
      playerId: 'p2',
      isSetup: true,
      ignoreVertexIds: [v1.id]
    });
    assert.equal(checkWithIgnore.ok, true);
  });

  it('requires road connectivity for normal (non-setup) settlement placement', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values())[0];

    // Non-setup without friendly road -> MUST_CONNECT_TO_ROAD
    const noRoadCheck = board.canPlaceSettlement(v1.id, { playerId: 'p1', isSetup: false });
    assert.equal(noRoadCheck.ok, false);
    assert.equal(noRoadCheck.reason, 'MUST_CONNECT_TO_ROAD');

    // Place friendly road on adjacent edge
    const adjEdgeId = v1.adjacentEdges[0];
    board.placeRoad(adjEdgeId, { playerId: 'p1', color: 'red' });

    // Now settlement placement should succeed
    const withRoadCheck = board.canPlaceSettlement(v1.id, { playerId: 'p1', isSetup: false });
    assert.equal(withRoadCheck.ok, true);

    // Opponent still cannot place settlement here (no opponent road)
    const opponentCheck = board.canPlaceSettlement(v1.id, { playerId: 'p2', isSetup: false });
    assert.equal(opponentCheck.ok, false);
    assert.equal(opponentCheck.reason, 'MUST_CONNECT_TO_ROAD');
  });

  it('validates city upgrade (canPlaceCity / placeCity)', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values())[0];

    // Empty vertex -> MUST_UPGRADE_SETTLEMENT
    assert.equal(board.canPlaceCity(v1.id, { playerId: 'p1' }).ok, false);

    // Place settlement for p1
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });

    // p2 cannot upgrade p1's settlement -> MUST_UPGRADE_OWN_SETTLEMENT
    const p2Check = board.canPlaceCity(v1.id, { playerId: 'p2' });
    assert.equal(p2Check.ok, false);
    assert.equal(p2Check.reason, 'MUST_UPGRADE_OWN_SETTLEMENT');

    // p1 can upgrade
    const p1Check = board.canPlaceCity(v1.id, { playerId: 'p1' });
    assert.equal(p1Check.ok, true);

    // Place city
    board.placeCity(v1.id, { playerId: 'p1', color: 'red' });
    assert.equal(board.getVertex(v1.id).building.type, 'city');
  });
});

describe('BoardManager - Road Placement & Connectivity Rules', () => {
  it('enforces setup road connectivity to the setup settlement vertex', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values())[0];
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });

    const touchingEdgeId = v1.adjacentEdges[0];
    const nonTouchingEdge = Array.from(board.edges.values()).find(
      e => e.v1 !== v1.id && e.v2 !== v1.id
    );

    // Touching edge is legal
    const touchingCheck = board.canPlaceRoad(touchingEdgeId, {
      playerId: 'p1',
      isSetup: true,
      setupSettlementVertexId: v1.id
    });
    assert.equal(touchingCheck.ok, true);

    // Non-touching edge fails
    const nonTouchingCheck = board.canPlaceRoad(nonTouchingEdge.id, {
      playerId: 'p1',
      isSetup: true,
      setupSettlementVertexId: v1.id
    });
    assert.equal(nonTouchingCheck.ok, false);
    assert.equal(nonTouchingCheck.reason, 'MUST_CONNECT_TO_SETUP_SETTLEMENT');
  });

  it('rejects road placement on already occupied edges', () => {
    const board = BoardManager.generateStandardGrid();
    const edge = Array.from(board.edges.values())[0];
    board.placeRoad(edge.id, { playerId: 'p1', color: 'red' });

    const check = board.canPlaceRoad(edge.id, { playerId: 'p1', isSetup: false });
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'EDGE_OCCUPIED');
  });

  it('requires normal road to connect to friendly building or existing road', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values()).find(v => v.adjacentEdges.length === 3);
    const edgeA = v1.adjacentEdges[0];
    const edgeB = v1.adjacentEdges[1];

    // Isolated edge -> MUST_CONNECT_TO_NETWORK
    const isolatedCheck = board.canPlaceRoad(edgeA, { playerId: 'p1', isSetup: false });
    assert.equal(isolatedCheck.ok, false);
    assert.equal(isolatedCheck.reason, 'MUST_CONNECT_TO_NETWORK');

    // Place building at v1 -> now edgeA connects to building!
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });
    const buildingConnectCheck = board.canPlaceRoad(edgeA, { playerId: 'p1', isSetup: false });
    assert.equal(buildingConnectCheck.ok, true);

    // Place road on edgeA
    board.placeRoad(edgeA, { playerId: 'p1', color: 'red' });

    // Now edgeB connects to friendly road on edgeA via shared vertex v1!
    const roadConnectCheck = board.canPlaceRoad(edgeB, { playerId: 'p1', isSetup: false });
    assert.equal(roadConnectCheck.ok, true);
  });

  it('blocks road connection if opponent building occupies shared vertex', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values()).find(v => v.adjacentEdges.length === 3);
    const edgeA = v1.adjacentEdges[0];
    const edgeB = v1.adjacentEdges[1];

    // Player 1 owns road on edgeA
    board.placeRoad(edgeA, { playerId: 'p1', color: 'red' });

    // Player 2 builds settlement on v1 (the intersection between edgeA and edgeB)
    board.placeSettlement(v1.id, { playerId: 'p2', color: 'blue' });

    // Player 1 tries to extend road to edgeB through opponent's settlement -> BLOCKED!
    const blockedCheck = board.canPlaceRoad(edgeB, { playerId: 'p1', isSetup: false });
    assert.equal(blockedCheck.ok, false);
    assert.equal(blockedCheck.reason, 'MUST_CONNECT_TO_NETWORK');
  });
});

describe('BoardManager - Longest Road Graph Traversal (DFS)', () => {
  it('returns 0 when player has no roads', () => {
    const board = BoardManager.generateStandardGrid();
    assert.equal(board.calculateLongestRoad('p1'), 0);
  });

  it('calculates linear road length accurately', () => {
    const board = BoardManager.generateStandardGrid();
    // Build a line of 3 consecutive edges
    const v0 = Array.from(board.vertices.values()).find(v => v.adjacentEdges.length === 3);
    const e1 = board.getEdge(v0.adjacentEdges[0]);
    board.placeRoad(e1.id, { playerId: 'p1', color: 'red' });
    assert.equal(board.calculateLongestRoad('p1'), 1);

    const v1 = e1.v1 === v0.id ? e1.v2 : e1.v1;
    const v1Vertex = board.getVertex(v1);
    const e2Id = v1Vertex.adjacentEdges.find(id => id !== e1.id);
    const e2 = board.getEdge(e2Id);
    board.placeRoad(e2.id, { playerId: 'p1', color: 'red' });
    assert.equal(board.calculateLongestRoad('p1'), 2);

    const v2 = e2.v1 === v1 ? e2.v2 : e2.v1;
    const v2Vertex = board.getVertex(v2);
    const e3Id = v2Vertex.adjacentEdges.find(id => id !== e2.id && id !== e1.id);
    const e3 = board.getEdge(e3Id);
    board.placeRoad(e3.id, { playerId: 'p1', color: 'red' });
    assert.equal(board.calculateLongestRoad('p1'), 3);
  });

  it('handles branching roads (Y-fork) by taking the single longest continuous branch', () => {
    const board = BoardManager.generateStandardGrid();
    // Find vertex with degree 3
    const center = Array.from(board.vertices.values()).find(v => v.adjacentEdges.length === 3);
    const [e1Id, e2Id, e3Id] = center.adjacentEdges;

    // Stem: e1
    board.placeRoad(e1Id, { playerId: 'p1', color: 'red' });

    // Branch A: e2 + one extension
    board.placeRoad(e2Id, { playerId: 'p1', color: 'red' });
    const e2 = board.getEdge(e2Id);
    const vA = e2.v1 === center.id ? e2.v2 : e2.v1;
    const eAExtId = board.getVertex(vA).adjacentEdges.find(id => id !== e2Id);
    board.placeRoad(eAExtId, { playerId: 'p1', color: 'red' });

    // Branch B: e3 (length 1 from fork)
    board.placeRoad(e3Id, { playerId: 'p1', color: 'red' });

    // Stem (1) + Fork A (2) = 3
    // Fork A (2) + Fork B (1) through center = 3
    // Total roads placed = 4, but longest simple path cannot traverse both branches simultaneously -> 3
    assert.equal(board.calculateLongestRoad('p1'), 3);
  });

function getConsecutiveHexEdges(board, hexId) {
  const hex = board.getHex(hexId);
  const edges = Array.from(board.edges.values()).filter(e => e.hexes.includes(hex.id));
  const orderedEdges = [edges[0]];
  let currentVertex = edges[0].v2;

  while (orderedEdges.length < edges.length) {
    const nextEdge = edges.find(
      e => !orderedEdges.includes(e) && (e.v1 === currentVertex || e.v2 === currentVertex)
    );
    if (!nextEdge) break;
    orderedEdges.push(nextEdge);
    currentVertex = nextEdge.v1 === currentVertex ? nextEdge.v2 : nextEdge.v1;
  }
  return orderedEdges;
}

  it('calculates longest road traversing cycles and closed loops', () => {
    const board = BoardManager.generateStandardGrid();
    const hexEdges = getConsecutiveHexEdges(board, 'hex_0_0');
    assert.equal(hexEdges.length, 6, 'A pointy-top hex must have 6 perimeter edges');

    // Build 5 of 6 edges (open line of 5)
    for (let i = 0; i < 5; i++) {
      board.placeRoad(hexEdges[i].id, { playerId: 'p1', color: 'red' });
    }
    assert.equal(board.calculateLongestRoad('p1'), 5);

    // Complete the closed cycle (all 6 edges)
    board.placeRoad(hexEdges[5].id, { playerId: 'p1', color: 'red' });
    // In a 6-edge loop, longest simple path is 6 (traversing all 6 edges without repeating any edge)
    assert.equal(board.calculateLongestRoad('p1'), 6);
  });

  it('calculates cycle with attached tail (lasso graph)', () => {
    const board = BoardManager.generateStandardGrid();
    const hexEdges = getConsecutiveHexEdges(board, 'hex_0_0');

    // Place full 6-edge cycle
    for (const edge of hexEdges) {
      board.placeRoad(edge.id, { playerId: 'p1', color: 'red' });
    }

    // Find an edge radiating out from one of the hex vertices (a tail)
    let tailEdge = null;
    for (const edge of hexEdges) {
      const v1 = board.getVertex(edge.v1);
      const ext = v1.adjacentEdges.find(id => !hexEdges.some(he => he.id === id));
      if (ext) {
        tailEdge = board.getEdge(ext);
        break;
      }
    }
    assert.ok(tailEdge, 'Must find radiating tail edge');
    board.placeRoad(tailEdge.id, { playerId: 'p1', color: 'red' });

    // Path starting at end of tail can enter cycle and traverse all 6 edges -> 1 + 6 = 7
    assert.equal(board.calculateLongestRoad('p1'), 7);
  });

  it('reduces longest road when interrupted by opponent settlement', () => {
    const board = BoardManager.generateStandardGrid();
    const hexEdges = getConsecutiveHexEdges(board, 'hex_0_0');

    // Place 5 consecutive roads around the hex
    for (let i = 0; i < 5; i++) {
      board.placeRoad(hexEdges[i].id, { playerId: 'p1', color: 'red' });
    }
    assert.equal(board.calculateLongestRoad('p1'), 5);

    // Find the vertex between edge 1 and edge 2
    const e1 = hexEdges[1];
    const e2 = hexEdges[2];
    const sharedVId = (e1.v1 === e2.v1 || e1.v1 === e2.v2) ? e1.v1 : e1.v2;

    // Opponent builds settlement at this shared vertex
    board.placeSettlement(sharedVId, { playerId: 'p2', color: 'blue' });

    // The road is now split into two pieces (length 2 and length 3)
    assert.equal(board.calculateLongestRoad('p1'), 3);
  });

  it('correctly separates road networks between multiple players', () => {
    const board = BoardManager.generateStandardGrid();
    const hexEdges = getConsecutiveHexEdges(board, 'hex_0_0');

    // Alice builds 3 consecutive roads
    board.placeRoad(hexEdges[0].id, { playerId: 'p1', color: 'red' });
    board.placeRoad(hexEdges[1].id, { playerId: 'p1', color: 'red' });
    board.placeRoad(hexEdges[2].id, { playerId: 'p1', color: 'red' });

    // Bob builds 2 consecutive roads
    board.placeRoad(hexEdges[3].id, { playerId: 'p2', color: 'blue' });
    board.placeRoad(hexEdges[4].id, { playerId: 'p2', color: 'blue' });

    assert.equal(board.calculateLongestRoad('p1'), 3);
    assert.equal(board.calculateLongestRoad('p2'), 2);
  });
});

describe('BoardManager - Serialization and Cloning', () => {
  it('serializes board state to JSON-compatible plain object', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values())[0];
    const e1 = Array.from(board.edges.values())[0];

    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });
    board.placeRoad(e1.id, { playerId: 'p1', color: 'red' });

    const serialized = board.serialize();
    assert.ok(serialized);
    assert.equal(serialized.mapSize, 'standard');
    assert.equal(typeof serialized.hexes, 'object');
    assert.equal(typeof serialized.vertices, 'object');
    assert.equal(typeof serialized.edges, 'object');
    assert.equal(serialized.vertices[v1.id].building.playerId, 'p1');
    assert.equal(serialized.edges[e1.id].road.playerId, 'p1');

    // JSON.stringify / parse round trip
    const jsonStr = JSON.stringify(serialized);
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.mapSize, 'standard');
  });

  it('deserializes board state accurately via BoardManager.deserialize', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values())[0];
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });

    const serialized = board.serialize();
    const restored = BoardManager.deserialize(serialized);

    assert.equal(restored.mapSize, 'standard');
    assert.equal(restored.hexes.size, 19);
    assert.equal(restored.vertices.size, 54);
    assert.equal(restored.edges.size, 72);
    assert.equal(restored.getVertex(v1.id).building.playerId, 'p1');
  });

  it('clones board deeply without mutating the original board', () => {
    const board = BoardManager.generateStandardGrid();
    const v1 = Array.from(board.vertices.values())[0];
    const e1 = Array.from(board.edges.values())[0];
    board.placeSettlement(v1.id, { playerId: 'p1', color: 'red' });
    board.placeRoad(e1.id, { playerId: 'p1', color: 'red' });

    const cloned = board.clone();

    // Verify initial clone state
    assert.equal(cloned.getVertex(v1.id).building.playerId, 'p1');
    assert.equal(cloned.getEdge(e1.id).road.playerId, 'p1');
    assert.equal(cloned.calculateLongestRoad('p1'), board.calculateLongestRoad('p1'));

    // Mutate clone: upgrade settlement to city, add new road
    cloned.placeCity(v1.id, { playerId: 'p1', color: 'red' });
    const e2 = Array.from(cloned.edges.values())[1];
    cloned.placeRoad(e2.id, { playerId: 'p1', color: 'red' });

    // Original must remain unaffected!
    assert.equal(board.getVertex(v1.id).building.type, 'settlement', 'Original settlement must not be modified');
    assert.equal(cloned.getVertex(v1.id).building.type, 'city', 'Clone must be updated');
    assert.equal(board.getEdge(e2.id).road, null, 'Original edge must not have road');
    assert.ok(cloned.getEdge(e2.id).road, 'Clone edge must have road');
  });
});

describe('BoardManager - GameEngine Integration & Delegation', () => {
  it('instantiates BoardManager on GameEngine constructor', () => {
    const engine = new GameEngine();
    assert.ok(engine.board instanceof BoardManager, 'engine.board must be a BoardManager instance');
    assert.equal(engine.grid, null);
  });

  it('delegates grid access and generation seamlessly', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    assert.ok(engine.board.grid);
    assert.equal(engine.grid, engine.board.grid);
    assert.equal(engine.grid.hexes.size, 19);

    // Test delegation of generateStandardGrid & generateExtendedGrid
    const extBoard = engine.generateExtendedGrid({ playerCount: 6 });
    assert.equal(extBoard.hexes.size, 30);
    assert.equal(engine.grid.hexes.size, 30);
  });

  it('delegates canPlaceSettlement and canPlaceRoad on GameEngine', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const v1 = Array.from(engine.grid.vertices.keys())[0];
    const settlementCheck = engine.canPlaceSettlement('p1', v1, true);
    assert.equal(settlementCheck.ok, true);

    const edge1 = engine.grid.vertices.get(v1).adjacentEdges[0];
    const roadCheck = engine.canPlaceRoad('p1', edge1, true, v1);
    assert.equal(roadCheck.ok, true);
  });

  it('delegates calculateLongestRoad and calculatePlayerLongestRoad', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const edge = Array.from(engine.grid.edges.values())[0];
    engine.board.placeRoad(edge.id, { playerId: 'p1', color: 'red' });

    assert.equal(engine.calculateLongestRoad('p1'), 1);
    assert.equal(engine.calculatePlayerLongestRoad('p1'), 1);
  });
});
