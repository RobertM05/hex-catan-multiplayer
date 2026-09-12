/**
 * roadInspection.js
 * Interactive road network inspection and hover highlighting for Catan.
 * Computes contiguous road networks, continuous longest chain lengths,
 * and Longest Road trophy status for dynamic board tooltips.
 */

export function getEdge(grid, edgeId) {
  if (!grid || !grid.edges) return null;
  return grid.edges instanceof Map ? grid.edges.get(edgeId) : grid.edges[edgeId];
}

export function getVertex(grid, vertexId) {
  if (!grid || !grid.vertices) return null;
  return grid.vertices instanceof Map ? grid.vertices.get(vertexId) : grid.vertices[vertexId];
}

/**
 * Returns all edge IDs belonging to the same player in the contiguous connected
 * road network containing edgeId. Opponent settlements/cities block road continuity.
 */
export function getConnectedRoadNetwork(grid, edgeId) {
  const startEdge = getEdge(grid, edgeId);
  if (!startEdge || !startEdge.road) return [];

  const ownerId = startEdge.road.playerId;
  const visitedEdges = new Set([edgeId]);
  const queue = [edgeId];

  while (queue.length > 0) {
    const curEdgeId = queue.shift();
    const curEdge = getEdge(grid, curEdgeId);
    if (!curEdge) continue;

    for (const vId of [curEdge.v1, curEdge.v2]) {
      const vertex = getVertex(grid, vId);
      if (!vertex) continue;

      // Opponent building or knight blocks road connection through this vertex
      const blockedByBuilding = vertex.building && vertex.building.playerId !== ownerId;
      const blockedByKnight = vertex.knight && vertex.knight.playerId !== ownerId;
      if (blockedByBuilding || blockedByKnight) {
        continue;
      }

      for (const adjEdgeId of vertex.adjacentEdges || []) {
        if (!visitedEdges.has(adjEdgeId)) {
          const adjEdge = getEdge(grid, adjEdgeId);
          if (adjEdge && adjEdge.road && adjEdge.road.playerId === ownerId) {
            visitedEdges.add(adjEdgeId);
            queue.push(adjEdgeId);
          }
        }
      }
    }
  }

  return Array.from(visitedEdges);
}

/**
 * Computes the continuous road chain length passing through edgeId, as well as
 * the maximum continuous chain anywhere in this connected component network.
 */
export function calculateContinuousRoadLength(grid, edgeId) {
  const edge = getEdge(grid, edgeId);
  if (!edge || !edge.road) {
    return { continuousLength: 0, maxNetworkLength: 0, networkSize: 0 };
  }

  const ownerId = edge.road.playerId;
  const componentEdges = getConnectedRoadNetwork(grid, edgeId);
  const networkSize = componentEdges.length;

  if (networkSize <= 1) {
    return { continuousLength: networkSize, maxNetworkLength: networkSize, networkSize };
  }

  // 1. Calculate maxNetworkLength (longest simple path anywhere in this network)
  let maxNetworkLength = 0;
  const visitedForMax = new Set();

  const dfsMax = (vertexId, currentLength) => {
    if (currentLength > maxNetworkLength) maxNetworkLength = currentLength;
    const vertex = getVertex(grid, vertexId);
    if (!vertex) return;
    const blockedByBuilding = vertex.building && vertex.building.playerId !== ownerId;
    const blockedByKnight = vertex.knight && vertex.knight.playerId !== ownerId;
    if (currentLength > 0 && (blockedByBuilding || blockedByKnight)) {
      return;
    }
    for (const adjId of vertex.adjacentEdges || []) {
      if (!visitedForMax.has(adjId)) {
        const adj = getEdge(grid, adjId);
        if (adj && adj.road && adj.road.playerId === ownerId) {
          visitedForMax.add(adjId);
          const nextV = adj.v1 === vertexId ? adj.v2 : adj.v1;
          dfsMax(nextV, currentLength + 1);
          visitedForMax.delete(adjId);
        }
      }
    }
  };

  for (const compEdgeId of componentEdges) {
    const ce = getEdge(grid, compEdgeId);
    if (ce) {
      visitedForMax.add(compEdgeId);
      dfsMax(ce.v1, 1);
      dfsMax(ce.v2, 1);
      visitedForMax.delete(compEdgeId);
    }
  }

  // 2. Calculate continuousLength: max simple path passing through edgeId
  let maxThroughEdge = 1;
  const visitedThrough = new Set([edgeId]);

  const extendV2 = (vertexId, len) => {
    if (len > maxThroughEdge) maxThroughEdge = len;
    const vertex = getVertex(grid, vertexId);
    if (!vertex) return;
    const blockedByBuilding = vertex.building && vertex.building.playerId !== ownerId;
    const blockedByKnight = vertex.knight && vertex.knight.playerId !== ownerId;
    if (blockedByBuilding || blockedByKnight) {
      return;
    }
    for (const adjId of vertex.adjacentEdges || []) {
      if (!visitedThrough.has(adjId)) {
        const adj = getEdge(grid, adjId);
        if (adj && adj.road && adj.road.playerId === ownerId) {
          visitedThrough.add(adjId);
          const nextV = adj.v1 === vertexId ? adj.v2 : adj.v1;
          extendV2(nextV, len + 1);
          visitedThrough.delete(adjId);
        }
      }
    }
  };

  const extendV1 = (vertexId, len) => {
    extendV2(edge.v2, len);

    const vertex = getVertex(grid, vertexId);
    if (!vertex) return;
    const blockedByBuilding = vertex.building && vertex.building.playerId !== ownerId;
    const blockedByKnight = vertex.knight && vertex.knight.playerId !== ownerId;
    if (blockedByBuilding || blockedByKnight) {
      return;
    }
    for (const adjId of vertex.adjacentEdges || []) {
      if (!visitedThrough.has(adjId)) {
        const adj = getEdge(grid, adjId);
        if (adj && adj.road && adj.road.playerId === ownerId) {
          visitedThrough.add(adjId);
          const nextV = adj.v1 === vertexId ? adj.v2 : adj.v1;
          extendV1(nextV, len + 1);
          visitedThrough.delete(adjId);
        }
      }
    }
  };

  extendV1(edge.v1, 1);

  return {
    continuousLength: maxThroughEdge,
    maxNetworkLength,
    networkSize
  };
}

/**
 * Formats full tooltip data for a hovered road segment.
 */
export function formatRoadTooltipData({
  grid,
  edgeId,
  players = [],
  longestRoadHolder = null,
  i18n = null
}) {
  const edge = getEdge(grid, edgeId);
  if (!edge || !edge.road) return null;

  const ownerId = edge.road.playerId;
  const player = players.find(p => p.id === ownerId) || {
    id: ownerId,
    name: ownerId,
    color: edge.road.color || '#e63946',
    roadsBuilt: []
  };

  const { continuousLength, maxNetworkLength, networkSize } = calculateContinuousRoadLength(grid, edgeId);
  const connectedEdgeIds = getConnectedRoadNetwork(grid, edgeId);

  const translate = (key, params) => {
    if (i18n && typeof i18n.t === 'function') {
      return i18n.t(key, params);
    }
    const fallbacks = {
      TOOLTIP_ROAD_OWNER: `Owner: ${params?.playerName || ''}`,
      TOOLTIP_ROAD_CONTINUOUS: `Continuous Road: ${params?.length || 0} segments`,
      TOOLTIP_ROAD_NETWORK: `Network: ${params?.total || 0} segments`,
      TOOLTIP_LONGEST_ROAD_HOLDER: `🏆 Longest Road Holder (${params?.length || 0})`,
      TOOLTIP_LONGEST_ROAD_TIED: `Tied for Longest Road (${params?.length || 0})`,
      TOOLTIP_LONGEST_ROAD_NEED_MORE: `${params?.diff || 0} more to take Longest Road`
    };
    return fallbacks[key] || key;
  };

  let longestRoadStatus = null;
  const isHolder = longestRoadHolder && longestRoadHolder.playerId === ownerId;
  const holderLen = longestRoadHolder ? longestRoadHolder.length : 0;
  const playerBestLen = Math.max(player.longestRoadLength || 0, maxNetworkLength);

  if (isHolder) {
    longestRoadStatus = {
      type: 'holder',
      text: translate('TOOLTIP_LONGEST_ROAD_HOLDER', { length: holderLen })
    };
  } else if (longestRoadHolder) {
    if (playerBestLen === holderLen && playerBestLen >= 5) {
      longestRoadStatus = {
        type: 'tied',
        text: translate('TOOLTIP_LONGEST_ROAD_TIED', { length: playerBestLen })
      };
    } else {
      const targetLen = holderLen + 1;
      const diff = Math.max(1, targetLen - playerBestLen);
      longestRoadStatus = {
        type: 'contender',
        text: translate('TOOLTIP_LONGEST_ROAD_NEED_MORE', { diff, needed: targetLen })
      };
    }
  } else {
    // Nobody holds Longest Road yet (threshold: 5)
    if (playerBestLen >= 5) {
      longestRoadStatus = {
        type: 'tied',
        text: translate('TOOLTIP_LONGEST_ROAD_TIED', { length: playerBestLen })
      };
    } else {
      const diff = 5 - playerBestLen;
      longestRoadStatus = {
        type: 'contender',
        text: translate('TOOLTIP_LONGEST_ROAD_NEED_MORE', { diff, needed: 5 })
      };
    }
  }

  return {
    edgeId,
    ownerId,
    ownerName: player.name,
    ownerColor: player.color || edge.road.color || '#e63946',
    continuousLength,
    maxNetworkLength,
    networkSize,
    totalPlayerRoads: player.roadsBuilt ? player.roadsBuilt.length : networkSize,
    longestRoadStatus,
    connectedEdgeIds,
    ownerText: translate('TOOLTIP_ROAD_OWNER', { playerName: player.name }),
    continuousText: translate('TOOLTIP_ROAD_CONTINUOUS', { length: continuousLength }),
    networkText: translate('TOOLTIP_ROAD_NETWORK', { total: networkSize })
  };
}
