import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConnectedRoadNetwork,
  calculateContinuousRoadLength,
  formatRoadTooltipData,
  getLongestContinuousPath
} from '../public/js/roadInspection.js';

describe('UX-07: Road Network Inspection & Hover Highlighting', () => {
  function makeTestGrid() {
    // Vertices: v1 --(e1)-- v2 --(e2)-- v3 --(e3)-- v4 --(e4)-- v5 --(e5)-- v6
    // And a branch at v3: v3 --(e6)-- v7 --(e7)-- v8
    const vertices = {
      v1: { id: 'v1', adjacentEdges: ['e1'], adjacentVertices: ['v2'], building: null },
      v2: { id: 'v2', adjacentEdges: ['e1', 'e2'], adjacentVertices: ['v1', 'v3'], building: null },
      v3: { id: 'v3', adjacentEdges: ['e2', 'e3', 'e6'], adjacentVertices: ['v2', 'v4', 'v7'], building: null },
      v4: { id: 'v4', adjacentEdges: ['e3', 'e4'], adjacentVertices: ['v3', 'v5'], building: null },
      v5: { id: 'v5', adjacentEdges: ['e4', 'e5'], adjacentVertices: ['v4', 'v6'], building: null },
      v6: { id: 'v6', adjacentEdges: ['e5'], adjacentVertices: ['v5'], building: null },
      v7: { id: 'v7', adjacentEdges: ['e6', 'e7'], adjacentVertices: ['v3', 'v8'], building: null },
      v8: { id: 'v8', adjacentEdges: ['e7'], adjacentVertices: ['v7'], building: null }
    };

    const edges = {
      e1: { id: 'e1', v1: 'v1', v2: 'v2', road: { playerId: 'p1', color: '#e63946' } },
      e2: { id: 'e2', v1: 'v2', v2: 'v3', road: { playerId: 'p1', color: '#e63946' } },
      e3: { id: 'e3', v1: 'v3', v2: 'v4', road: { playerId: 'p1', color: '#e63946' } },
      e4: { id: 'e4', v1: 'v4', v2: 'v5', road: { playerId: 'p1', color: '#e63946' } },
      e5: { id: 'e5', v1: 'v5', v2: 'v6', road: { playerId: 'p1', color: '#e63946' } },
      e6: { id: 'e6', v1: 'v3', v2: 'v7', road: { playerId: 'p1', color: '#e63946' } },
      e7: { id: 'e7', v1: 'v7', v2: 'v8', road: { playerId: 'p1', color: '#e63946' } }
    };

    return { vertices, edges };
  }

  it('should find all edges in a contiguous road network', () => {
    const grid = makeTestGrid();
    const network = getConnectedRoadNetwork(grid, 'e1');
    assert.equal(network.length, 7);
    assert.ok(network.includes('e1'));
    assert.ok(network.includes('e5'));
    assert.ok(network.includes('e7'));
  });

  it('should calculate longest continuous chain passing through a linear road', () => {
    const grid = makeTestGrid();
    // Path from e1 through e2, e3, e4, e5 has length 5.
    // Branch from e1 through e2, e6, e7 has length 4.
    // Continuous path containing e1 should be 5.
    const res = calculateContinuousRoadLength(grid, 'e1');
    assert.equal(res.continuousLength, 5);
    assert.equal(res.maxNetworkLength, 5);
    assert.equal(res.networkSize, 7);
  });

  it('should calculate continuous road for a branch edge', () => {
    const grid = makeTestGrid();
    // From e7: e7 -> e6 -> e3 -> e4 -> e5 has length 5.
    // Or e7 -> e6 -> e2 -> e1 has length 4.
    // Max containing e7 is 5.
    const res = calculateContinuousRoadLength(grid, 'e7');
    assert.equal(res.continuousLength, 5);
    assert.equal(res.networkSize, 7);
  });

  it('should block road continuity when an opponent settlement is on the intersection', () => {
    const grid = makeTestGrid();
    // Place opponent settlement on v3
    grid.vertices.v3.building = { playerId: 'p2', type: 'settlement' };

    // Now e1 and e2 are on one side of v3, and e3, e4, e5, e6, e7 cannot be reached through v3!
    const netE1 = getConnectedRoadNetwork(grid, 'e1');
    assert.equal(netE1.length, 2);
    assert.ok(netE1.includes('e1'));
    assert.ok(netE1.includes('e2'));
    assert.equal(netE1.includes('e3'), false);

    const lenE1 = calculateContinuousRoadLength(grid, 'e1');
    assert.equal(lenE1.continuousLength, 2);
    assert.equal(lenE1.networkSize, 2);
  });

  it('should not block road continuity when own settlement is on the intersection', () => {
    const grid = makeTestGrid();
    grid.vertices.v3.building = { playerId: 'p1', type: 'settlement' };

    const netE1 = getConnectedRoadNetwork(grid, 'e1');
    assert.equal(netE1.length, 7);

    const lenE1 = calculateContinuousRoadLength(grid, 'e1');
    assert.equal(lenE1.continuousLength, 5);
  });

  it('should highlight only the longest continuous path, not branch spurs', () => {
    const grid = makeTestGrid();
    delete grid.edges.e7;
    grid.vertices.v3.adjacentEdges = ['e2', 'e3', 'e6'];
    grid.vertices.v7.adjacentEdges = ['e6'];

    const pathFromSpur = getLongestContinuousPath(grid, 'e6');
    assert.equal(pathFromSpur.length, 5);
    assert.deepEqual(pathFromSpur.slice().sort(), ['e1', 'e2', 'e3', 'e4', 'e5']);
    assert.equal(pathFromSpur.includes('e6'), false);
    assert.equal(getConnectedRoadNetwork(grid, 'e6').length, 6);
  });

  it('should format tooltip data with Longest Road holder status', () => {
    const grid = makeTestGrid();
    const players = [
      { id: 'p1', name: 'Robert', color: '#e63946', roadsBuilt: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'] }
    ];
    const longestRoadHolder = { playerId: 'p1', length: 5 };

    const data = formatRoadTooltipData({
      grid,
      edgeId: 'e1',
      players,
      longestRoadHolder
    });

    assert.ok(data);
    assert.equal(data.ownerName, 'Robert');
    assert.equal(data.ownerColor, '#e63946');
    assert.equal(data.continuousLength, 5);
    assert.equal(data.networkSize, 7);
    assert.deepEqual(data.highlightEdgeIds.slice().sort(), ['e1', 'e2', 'e3', 'e4', 'e5']);
    assert.equal(data.longestRoadStatus.type, 'holder');
    assert.match(data.longestRoadStatus.text, /Longest Road Holder/);
  });

  it('should format tooltip data with tied status when another player holds and lengths match', () => {
    const grid = makeTestGrid();
    const players = [
      { id: 'p1', name: 'Robert', color: '#e63946', longestRoadLength: 5, roadsBuilt: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'] },
      { id: 'p2', name: 'Snighi', color: '#457b9d', longestRoadLength: 5, roadsBuilt: [] }
    ];
    // p2 holds it with 5, but p1 also has 5
    const longestRoadHolder = { playerId: 'p2', length: 5 };

    const data = formatRoadTooltipData({
      grid,
      edgeId: 'e1',
      players,
      longestRoadHolder
    });

    assert.ok(data);
    assert.equal(data.longestRoadStatus.type, 'tied');
    assert.match(data.longestRoadStatus.text, /Tied/);
  });

  it('should format tooltip data with segments needed to take Longest Road', () => {
    const grid = makeTestGrid();
    // Break road at v3 so p1 has length 2
    grid.vertices.v3.building = { playerId: 'p2', type: 'settlement' };

    const players = [
      { id: 'p1', name: 'Robert', color: '#e63946', longestRoadLength: 2, roadsBuilt: ['e1', 'e2'] },
      { id: 'p2', name: 'Snighi', color: '#457b9d', longestRoadLength: 6, roadsBuilt: [] }
    ];
    const longestRoadHolder = { playerId: 'p2', length: 6 };

    const data = formatRoadTooltipData({
      grid,
      edgeId: 'e1',
      players,
      longestRoadHolder
    });

    assert.ok(data);
    assert.equal(data.longestRoadStatus.type, 'contender');
    // Needs 7 to take it from 6, currently has 2 -> diff is 5
    assert.match(data.longestRoadStatus.text, /5 more/);
  });

  it('should use injected i18n.t for tooltip copy', () => {
    const grid = makeTestGrid();
    const players = [
      { id: 'p1', name: 'Robert', color: '#e63946', roadsBuilt: ['e1'] }
    ];
    const mockI18n = {
      t: (key, params) => {
        if (key === 'TOOLTIP_ROAD_OWNER') return `Owner: ${params.playerName}`;
        if (key === 'TOOLTIP_ROAD_CONTINUOUS') return `Continuous: ${params.length}`;
        if (key === 'TOOLTIP_ROAD_NETWORK') return `Network: ${params.total}`;
        if (key === 'TOOLTIP_LONGEST_ROAD_TIED') return `Tied (${params.length})`;
        if (key === 'TOOLTIP_LONGEST_ROAD_NEED_MORE') return `${params.diff} more`;
        return key;
      }
    };

    const data = formatRoadTooltipData({
      grid,
      edgeId: 'e1',
      players,
      longestRoadHolder: null,
      i18n: mockI18n
    });

    assert.equal(data.ownerText, 'Owner: Robert');
    assert.equal(data.continuousText, 'Continuous: 5');
    assert.equal(data.networkText, 'Network: 7');
    assert.match(data.longestRoadStatus.text, /Tied/);
  });
});
