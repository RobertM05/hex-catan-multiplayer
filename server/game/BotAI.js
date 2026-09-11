/**
 * BotAI.js
 * Intelligent heuristic-driven bot player for Catan.
 * Can participate in setup, dice rolling, discarding, robber movement, building, and trading.
 */

import { GAME_PHASES, COSTS, DEV_CARD_TYPES } from './GameEngine.js';
import { RESOURCE_TYPES } from './HexGrid.js';

export class BotAI {
  static getVertexScore(grid, vertexId) {
    const vertex = grid.vertices.get(vertexId);
    if (!vertex) return -1;

    let score = 0;
    const resources = new Set();

    const TOKEN_PIPS = {
      2: 1, 12: 1,
      3: 2, 11: 2,
      4: 3, 10: 3,
      5: 4, 9: 4,
      6: 5, 8: 5
    };

    for (const hexId of vertex.hexes) {
      const hex = grid.hexes.get(hexId);
      if (hex && hex.resource && hex.resource !== RESOURCE_TYPES.DESERT) {
        resources.add(hex.resource);
        score += (TOKEN_PIPS[hex.token] || 0) * 2;
      }
    }

    // Bonus for resource diversity
    score += resources.size * 3;

    // Bonus for harbor
    if (vertex.harbor) {
      score += vertex.harbor.ratio === 2 ? 3 : 2;
    }

    return score;
  }

  static decideSetupAction(engine, botPlayer) {
    const grid = engine.grid;

    if (engine.setupStep === 'settlement') {
      // Find valid vertices and rank them
      let bestVertexId = null;
      let highestScore = -1;

      for (const [vId] of grid.vertices) {
        const check = engine.canBuildSettlement(botPlayer.id, vId, true);
        if (check.ok) {
          if (!bestVertexId) bestVertexId = vId;
          const score = this.getVertexScore(grid, vId);
          if (score > highestScore) {
            highestScore = score;
            bestVertexId = vId;
          }
        }
      }

      if (bestVertexId) {
        return { action: 'place_setup_settlement', vertexId: bestVertexId };
      }
    } else if (engine.setupStep === 'road') {
      // Find valid edge connecting to the settlement just placed
      const settlementVId = engine.lastSetupSettlementVertex || (botPlayer.settlementsBuilt.length > 0 ? botPlayer.settlementsBuilt[botPlayer.settlementsBuilt.length - 1] : null);
      if (settlementVId) {
        const vertex = grid.vertices.get(settlementVId);
        let bestEdgeId = null;
        let bestScore = -1;

        if (vertex) {
          for (const eId of vertex.adjacentEdges) {
            const check = engine.canBuildRoad(botPlayer.id, eId, true, settlementVId);
            if (check.ok) {
              if (!bestEdgeId) bestEdgeId = eId;
              const edge = grid.edges.get(eId);
              const otherVId = edge.v1 === settlementVId ? edge.v2 : edge.v1;
              const otherScore = this.getVertexScore(grid, otherVId);
              if (otherScore > bestScore) {
                bestScore = otherScore;
                bestEdgeId = eId;
              }
            }
          }
        }

        if (bestEdgeId) {
          return { action: 'place_setup_road', edgeId: bestEdgeId };
        }
      }
    }

    return null;
  }

  static decideDiscard(engine, botPlayer) {
    const total = engine.countTotalCards(botPlayer);
    const needed = Math.floor(total / 2);
    const discarded = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0, cloth: 0, coin: 0, paper: 0 };
    let leftToDiscard = needed;

    while (leftToDiscard > 0) {
      let maxKey = null;
      let maxCount = -1;

      for (const [res, count] of Object.entries(botPlayer.resources || {})) {
        const remaining = count - (discarded[res] || 0);
        if (remaining > maxCount && remaining > 0) {
          maxCount = remaining;
          maxKey = res;
        }
      }
      for (const [com, count] of Object.entries(botPlayer.commodities || {})) {
        const remaining = count - (discarded[com] || 0);
        if (remaining > maxCount && remaining > 0) {
          maxCount = remaining;
          maxKey = com;
        }
      }

      if (!maxKey) break;
      discarded[maxKey]++;
      leftToDiscard--;
    }

    return { action: 'discard_cards', discarded };
  }

  static decideRobberMove(engine, botPlayer) {
    const grid = engine.grid;
    let bestHexId = null;
    let bestTargetPlayerId = null;
    let maxHexImpact = -1;

    for (const [hexId, hex] of grid.hexes) {
      if (hexId === grid.robberHexId || hex.resource === RESOURCE_TYPES.DESERT) continue;

      let botBuildingHere = false;
      let opponentBuildings = [];

      for (const vKey of grid.vertices.keys()) {
        const v = grid.vertices.get(vKey);
        if (v.hexes.includes(hexId) && v.building) {
          if (v.building.playerId === botPlayer.id) {
            botBuildingHere = true;
            break;
          } else {
            opponentBuildings.push(v.building.playerId);
          }
        }
      }

      if (botBuildingHere) continue; // Don't block own hex

      if (opponentBuildings.length > 0) {
        const pipScore = (hex.token === 6 || hex.token === 8) ? 5 : (hex.token === 5 || hex.token === 9) ? 4 : 2;
        const impact = pipScore * opponentBuildings.length;

        if (impact > maxHexImpact) {
          maxHexImpact = impact;
          bestHexId = hexId;
          bestTargetPlayerId = opponentBuildings[0];
        }
      }
    }

    if (!bestHexId) {
      // Pick any hex other than current robber
      for (const hexId of grid.hexes.keys()) {
        if (hexId !== grid.robberHexId) {
          bestHexId = hexId;
          break;
        }
      }
    }

    return { action: 'move_robber', hexId: bestHexId, targetPlayerId: bestTargetPlayerId };
  }

  static decideTurnAction(engine, botPlayer) {
    const grid = engine.grid;

    // 1. Play unplayed knight card if robber is on one of bot's hexes
    if (!engine.devCardPlayedThisTurn) {
      const knightCard = botPlayer.devCards.find(c => c.type === DEV_CARD_TYPES.KNIGHT && !c.played && c.boughtTurn < engine.turnNumber);
      if (knightCard) {
        // Check if robber blocks bot
        const botBlocked = Array.from(grid.vertices.values()).some(v =>
          v.hexes.includes(grid.robberHexId) && v.building && v.building.playerId === botPlayer.id
        );
        if (botBlocked) {
          return { action: 'play_dev_card', cardId: knightCard.id };
        }
      }
    }

    // 2. Try building a City (high priority)
    if (botPlayer.citiesRemaining > 0) {
      for (const vId of botPlayer.settlementsBuilt) {
        if (engine.canBuildCity(botPlayer.id, vId).ok) {
          return { action: 'build_city', vertexId: vId };
        }
      }
    }

    // 3. Try building a Settlement
    if (botPlayer.settlementsRemaining > 0) {
      for (const [vId] of grid.vertices) {
        if (engine.canBuildSettlement(botPlayer.id, vId).ok) {
          return { action: 'build_settlement', vertexId: vId };
        }
      }
    }

    // 4. Try building a Road if free roads remain or has resources
    if (botPlayer.roadsRemaining > 0 && (engine.freeRoadsRemaining > 0 || engine.hasResources(botPlayer, COSTS.ROAD))) {
      for (const [eId] of grid.edges) {
        if (engine.canBuildRoad(botPlayer.id, eId).ok) {
          return { action: 'build_road', edgeId: eId };
        }
      }
    }

    // 5. Try buying a Dev Card
    if (engine.canBuyDevCard(botPlayer.id).ok) {
      return { action: 'buy_dev_card' };
    }

    // 6. Bank trade with best available ratio (considering 2:1 and 3:1 harbors)
    const validTradeResources = ['wood', 'brick', 'wool', 'wheat', 'ore'];
    for (const res of validTradeResources) {
      const count = botPlayer.resources[res] || 0;
      let bestRatio = 4;
      for (const vKey of botPlayer.settlementsBuilt.concat(botPlayer.citiesBuilt)) {
        const v = grid.vertices.get(vKey);
        if (v && v.harbor) {
          if (v.harbor.type === res && v.harbor.ratio === 2) {
            bestRatio = 2;
            break;
          }
          if (v.harbor.type === 'generic' && v.harbor.ratio === 3) {
            bestRatio = Math.min(bestRatio, 3);
          }
        }
      }

      if (count >= bestRatio) {
        const needed = validTradeResources.find(r => r !== res && (botPlayer.resources[r] || 0) === 0);
        if (needed) {
          try {
            return { action: 'bank_trade', give: res, receive: needed, ratio: bestRatio };
          } catch (e) {}
        }
      }
    }

    // Nothing left to build or trade -> End turn
    return { action: 'end_turn' };
  }
}
