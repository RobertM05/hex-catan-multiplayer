/**
 * BotAI.js
 * Intelligent heuristic-driven bot player for Catan.
 * Can participate in setup, dice rolling, discarding, robber movement, building, and trading.
 */

import { GAME_PHASES, GAME_MODES, COSTS, DEV_CARD_TYPES, IMPROVEMENT_TRACKS, COMMODITY_VALUES } from './GameEngine.js';
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
      const settlementVId = engine.lastSetupSettlementVertex
        || (botPlayer.citiesBuilt?.length ? botPlayer.citiesBuilt[botPlayer.citiesBuilt.length - 1] : null)
        || (botPlayer.settlementsBuilt.length > 0 ? botPlayer.settlementsBuilt[botPlayer.settlementsBuilt.length - 1] : null);
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

    if (bestHexId) {
      const victims = engine.getRobberStealVictims(bestHexId, botPlayer.id);
      bestTargetPlayerId = victims[0]?.id ?? null;
    }

    return { action: 'move_robber', hexId: bestHexId, targetPlayerId: bestTargetPlayerId };
  }

  static decideTurnAction(engine, botPlayer) {
    if (engine.phase !== GAME_PHASES.TURN_SPECIAL_BUILDING && engine.activeTrade && engine.activeTrade.fromPlayerId === botPlayer.id) {
      if (engine.activeTrade.acceptedBy && engine.activeTrade.acceptedBy.size > 0) {
        return { action: 'confirm_trade', targetPlayerId: Array.from(engine.activeTrade.acceptedBy)[0] };
      }
      return { action: 'cancel_trade' };
    }

    if (engine.mode === GAME_MODES.CITIES_KNIGHTS || engine.isCitiesKnights?.()) {
      const ck = this.decideCkTurnAction(engine, botPlayer);
      if (ck) {
        const sbpBlocked = engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING
          && ['play_progress_card', 'move_knight', 'chase_robber', 'bank_trade', 'propose_trade'].includes(ck.action);
        if (!sbpBlocked) return ck;
      }
    }

    const grid = engine.grid;

    // 1. Play unplayed knight card if robber is on one of bot's hexes
    if (engine.phase !== GAME_PHASES.TURN_SPECIAL_BUILDING && !engine.devCardPlayedThisTurn) {
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

    if (engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
      return { action: 'end_turn' };
    }

    // 5.5 Propose fair 1:1 trade with other players if missing 1 card for a build goal
    const playerTrade = this.decidePlayerTrade(engine, botPlayer);
    if (playerTrade) {
      return playerTrade;
    }

    // 6. Goal-oriented bank trading (considering 2:1 and 3:1 harbors and Trade Level 5)
    const validTradeResources = ['wood', 'brick', 'wool', 'wheat', 'ore'];

    // Prioritized build goals: City -> Settlement -> Road
    const goals = [];
    if (botPlayer.citiesRemaining > 0 && botPlayer.settlementsBuilt?.length > 0) {
      goals.push({ ore: 3, wheat: 2 });
    }
    if (botPlayer.settlementsRemaining > 0) {
      goals.push({ wood: 1, brick: 1, wool: 1, wheat: 1 });
    }
    if (botPlayer.roadsRemaining > 0) {
      goals.push({ wood: 1, brick: 1 });
    }

    const tradeCandidates = ['wood', 'brick', 'wool', 'wheat', 'ore'];
    if (this.isCk(engine)) {
      tradeCandidates.push('cloth', 'coin', 'paper');
    }

    for (const goal of goals) {
      const deficits = {};
      let totalDeficit = 0;
      for (const [res, needed] of Object.entries(goal)) {
        const have = botPlayer.resources[res] || 0;
        if (have < needed) {
          deficits[res] = needed - have;
          totalDeficit += deficits[res];
        }
      }

      if (totalDeficit > 0 && totalDeficit <= 2) {
        for (const give of tradeCandidates) {
          const ratio = this.getBestBankTradeRatio(engine, botPlayer, give);
          const count = engine.getPlayerCardCount(botPlayer, give);
          const neededForGoal = goal[give] || 0;
          if (count >= ratio && count - ratio >= neededForGoal) {
            const receive = Object.keys(deficits)[0];
            if (receive && receive !== give) {
              return { action: 'bank_trade', give, receive, ratio };
            }
          }
        }
      }
    }

    // Fallback: trade surplus cards to gain any resource currently at 0
    for (const res of validTradeResources) {
      const ratio = this.getBestBankTradeRatio(engine, botPlayer, res);
      const count = botPlayer.resources[res] || 0;
      if (count >= ratio) {
        const needed = validTradeResources.find(r => r !== res && (botPlayer.resources[r] || 0) === 0);
        if (needed) {
          try {
            return { action: 'bank_trade', give: res, receive: needed, ratio };
          } catch (e) {}
        }
      }
    }

    // Nothing left to build or trade -> End turn
    return { action: 'end_turn' };
  }

  static canBotAcceptTrade(engine, botPlayer, activeTrade) {
    if (!activeTrade || activeTrade.fromPlayerId === botPlayer.id) return false;

    const proposer = engine.players.find(p => p.id === activeTrade.fromPlayerId);
    const vpTarget = engine.vpTarget || 10;
    // Kingmaking protection: reject trading to a leader who is within 2 VP of victory
    if (proposer && (proposer.victoryPoints || 0) >= vpTarget - 2) {
      return false;
    }

    const COMMODITY_KEYS = ['cloth', 'coin', 'paper'];
    const getCardValue = (type) => (COMMODITY_KEYS.includes(type) ? 2.5 : 1.0);

    for (const [res, amt] of Object.entries(activeTrade.want || {})) {
      if (amt > 0 && engine.getPlayerCardCount(botPlayer, res) < amt) {
        return false;
      }
    }

    let giveValue = 0;
    let giveTotal = 0;
    for (const [res, amt] of Object.entries(activeTrade.give || {})) {
      if (amt > 0) {
        giveTotal += amt;
        giveValue += amt * getCardValue(res);
      }
    }

    let wantValue = 0;
    let wantTotal = 0;
    for (const [res, amt] of Object.entries(activeTrade.want || {})) {
      if (amt > 0) {
        wantTotal += amt;
        wantValue += amt * getCardValue(res);
      }
    }

    if (giveTotal <= 0 || wantTotal <= 0) return false;
    // Reject 1:2 rip-offs (proposer must offer at least as many cards as asked)
    if (giveTotal < wantTotal) return false;
    // Reject commodity milking (value offered must be at least value demanded)
    if (giveValue < wantValue) return false;

    // Bot only gives away cards if it has a comfortable surplus or if the trade is strictly profitable
    const hasSurplus = Object.entries(activeTrade.want).every(([res, amt]) =>
      amt <= 0 || engine.getPlayerCardCount(botPlayer, res) >= amt + 1
    );
    const isProfitable = giveValue > wantValue;

    return isProfitable || hasSurplus;
  }

  static decidePlayerTrade(engine, botPlayer) {
    if (botPlayer.hasProposedTradeThisTurn) return null;
    if (engine.activeTrade) return null;

    // Prioritized build goals: City -> Settlement -> Road
    const goals = [];
    if (botPlayer.citiesRemaining > 0 && (botPlayer.settlementsBuilt?.length > 0 || botPlayer.settlements?.length > 0)) {
      goals.push({ ore: 3, wheat: 2 });
    }
    if (botPlayer.settlementsRemaining > 0) {
      goals.push({ wood: 1, brick: 1, wool: 1, wheat: 1 });
    }
    if (botPlayer.roadsRemaining > 0) {
      goals.push({ wood: 1, brick: 1 });
    }

    const COMMODITY_KEYS = ['cloth', 'coin', 'paper'];
    const getCardValue = (type) => (COMMODITY_KEYS.includes(type) ? 2.5 : 1.0);

    const tradeCandidates = ['wood', 'brick', 'wool', 'wheat', 'ore'];
    if (this.isCk(engine)) {
      tradeCandidates.push('cloth', 'coin', 'paper');
    }

    for (const goal of goals) {
      const deficits = {};
      let totalDeficit = 0;
      for (const [res, needed] of Object.entries(goal)) {
        const have = engine.getPlayerCardCount(botPlayer, res);
        if (have < needed) {
          deficits[res] = needed - have;
          totalDeficit += deficits[res];
        }
      }

      // Propose player trade if exactly 1 card away from completing the build goal
      if (totalDeficit === 1) {
        const wantRes = Object.keys(deficits)[0];
        let bestGive = null;
        let maxSurplus = 0;

        for (const give of tradeCandidates) {
          if (give === wantRes) continue;
          const count = engine.getPlayerCardCount(botPlayer, give);
          const neededForGoal = goal[give] || 0;
          const surplus = count - neededForGoal;

          // Fair trade constraint: do not offer lower tier for higher tier (e.g. resource for commodity)
          if (getCardValue(give) < getCardValue(wantRes)) continue;

          if (surplus >= 1 && surplus > maxSurplus) {
            maxSurplus = surplus;
            bestGive = give;
          }
        }

        if (bestGive) {
          return {
            action: 'propose_trade',
            give: { [bestGive]: 1 },
            want: { [wantRes]: 1 }
          };
        }
      }
    }

    return null;
  }

  static getBestBankTradeRatio(engine, botPlayer, giveRes) {
    let bestRatio = 4;
    if (botPlayer.merchantFleetActive) {
      bestRatio = 2;
    } else if ((botPlayer.cityImprovements?.trade || 0) >= 5) {
      bestRatio = 2;
    } else if (engine.merchantHolder === botPlayer.id && engine.merchantHexId) {
      const hex = engine.grid?.hexes?.get(engine.merchantHexId);
      if (hex && hex.resource === giveRes) bestRatio = 2;
    }
    if (bestRatio > 2) {
      for (const vKey of (botPlayer.settlementsBuilt || []).concat(botPlayer.citiesBuilt || [])) {
        const v = engine.grid?.vertices?.get(vKey);
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
    return bestRatio;
  }

  static isCk(engine) {
    return engine.mode === GAME_MODES.CITIES_KNIGHTS || engine.isCitiesKnights?.();
  }

  static findValidKnightVertices(engine, botPlayer) {
    const ids = [];
    for (const [vId, vertex] of engine.grid.vertices) {
      if (vertex.building || vertex.knight) continue;
      if (!engine.vertexHasPlayerRoad(vertex, botPlayer.id)) continue;
      ids.push(vId);
    }
    return ids;
  }

  static findCityWithoutWall(engine, botPlayer) {
    for (const vid of botPlayer.citiesBuilt || []) {
      const v = engine.grid.vertices.get(vid);
      if (v?.building?.type === 'city' && !v.building.hasWall) return vid;
    }
    return null;
  }

  static cityResourceScore(engine, vertexId) {
    return this.getVertexScore(engine.grid, vertexId);
  }

  static chooseCityToDowngrade(engine, playerId) {
    const player = engine.players.find(p => p.id === playerId);
    if (!player?.citiesBuilt?.length) return null;
    let worst = null;
    let worstScore = Infinity;
    for (const vid of player.citiesBuilt) {
      const vertex = engine.grid.vertices.get(vid);
      if (vertex?.building?.hasMetropolis || vertex?.building?.type === 'metropolis') continue;
      const score = this.cityResourceScore(engine, vid);
      if (score < worstScore) {
        worstScore = score;
        worst = vid;
      }
    }
    return worst;
  }

  static chooseBarbarianRewardDeck(botPlayer) {
    const imps = botPlayer?.cityImprovements || {};
    const tracks = [
      { deck: 'trade', level: imps.trade || 0 },
      { deck: 'politics', level: imps.politics || 0 },
      { deck: 'science', level: imps.science || 0 }
    ];
    tracks.sort((a, b) => b.level - a.level);
    return tracks[0].deck;
  }

  static chooseCityForMetropolis(engine, playerId) {
    const player = engine.players.find(p => p.id === playerId);
    if (!player?.citiesBuilt?.length) return null;
    let best = null;
    let bestScore = -1;
    for (const vid of player.citiesBuilt) {
      const v = engine.grid.vertices.get(vid);
      if (!v?.building || v.building.playerId !== playerId || v.building.type !== 'city' || v.building.hasMetropolis) continue;
      const score = this.cityResourceScore(engine, vid);
      if (score > bestScore) {
        bestScore = score;
        best = vid;
      }
    }
    return best;
  }

  static chooseBestImprovementTrack(engine, me) {
    if (!me.citiesBuilt?.length) return null;
    const tracks = ['trade', 'politics', 'science'];
    const affordable = [];
    for (const track of tracks) {
      const level = me.cityImprovements?.[track] || 0;
      if (level >= 5) continue;
      let cost = level + 1;
      if (me.craneDiscount) cost = Math.max(0, cost - 1);
      const commodity = IMPROVEMENT_TRACKS[track];
      if ((me.commodities?.[commodity] || 0) >= cost) affordable.push({ track, level, cost });
    }
    if (!affordable.length) return null;
    const difficulty = me.botDifficulty || 'medium';
    if (difficulty === 'easy') {
      return affordable[Math.floor(Math.random() * affordable.length)].track;
    }
    let best = affordable[0];
    let bestScore = -Infinity;
    for (const opt of affordable) {
      const contested = engine.players.reduce((sum, p) => {
        if (p.id === me.id) return sum;
        return sum + (p.cityImprovements?.[opt.track] || 0);
      }, 0);
      const score = opt.level * 3 - contested + (opt.track === 'politics' && (me.knightsPlaced || []).length ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    return best.track;
  }

  static progressCardValue(type) {
    const order = {
      constitution: 100, printer: 100, alchemist: 80, warlord: 70, smith: 65,
      merchant: 60, merchant_fleet: 55, crane: 50, medicine: 45, wedding: 42, master_merchant: 40,
      spy: 38, road_building: 36, bishop: 35, engineer: 30, inventor: 25, saboteur: 22, intrigue: 20, deserter: 18,
      diplomat: 15, irrigation: 12, mining: 12, commercial_harbor: 10, resource_monopoly: 8, trade_monopoly: 8
    };
    return order[type] || 5;
  }

  static decideProgressDiscard(botPlayer) {
    const cards = (botPlayer.progressCards || []).filter(c => !c.played);
    if (!cards.length) return null;
    cards.sort((a, b) => this.progressCardValue(a.type) - this.progressCardValue(b.type));
    return cards[0].id;
  }

  /**
   * Split a dice sum 2–12 into two faces in 1..6.
   */
  static splitAlchemistDice(sum) {
    const target = Math.min(12, Math.max(2, Number(sum) || 7));
    const d1 = Math.min(6, Math.max(1, Math.floor(target / 2)));
    const d2 = target - d1;
    return { d1, d2 };
  }

  static alchemistYieldForSum(engine, me, sum) {
    let totalYield = 0;
    const robberId = engine.grid?.robberHexId;
    const citySet = new Set(me.citiesBuilt || []);
    for (const vid of [...(me.settlementsBuilt || []), ...(me.citiesBuilt || [])]) {
      const v = engine.grid.vertices.get(vid);
      const multiplier = citySet.has(vid) || v?.building?.type === 'city' ? 2 : 1;
      for (const hid of v?.hexes || []) {
        if (hid === robberId) continue;
        const hex = engine.grid.hexes.get(hid);
        if (!hex || hex.token !== sum || hex.resource === RESOURCE_TYPES.DESERT) continue;
        totalYield += multiplier;
      }
    }
    return totalYield;
  }

  static chooseAlchemistDice(engine, me) {
    const tieRank = (sum) => (sum === 6 || sum === 8 ? 2 : (sum === 5 || sum === 9 ? 1 : 0));
    let bestSum = 6;
    let bestYield = -1;
    let bestRank = -1;
    for (let sum = 2; sum <= 12; sum++) {
      if (sum === 7) continue;
      const y = this.alchemistYieldForSum(engine, me, sum);
      const rank = tieRank(sum);
      if (y > bestYield || (y === bestYield && rank > bestRank)) {
        bestYield = y;
        bestRank = rank;
        bestSum = sum;
      }
    }
    if (bestYield <= 0) bestSum = 7;
    return this.splitAlchemistDice(bestSum);
  }

  static decideProgressCardPlay(engine, me) {
    const cards = (me.progressCards || []).filter(c =>
      !c.played && !c.revealed && c.boughtTurn !== engine.turnNumber
    );
    const vp = cards.find(c => c.type === 'constitution' || c.type === 'printer');
    if (vp && engine.phase === GAME_PHASES.TURN_ACTION) {
      return { action: 'play_progress_card', cardId: vp.id, options: {} };
    }
    if (engine.phase === GAME_PHASES.TURN_ROLL) {
      const alchemist = cards.find(c => c.type === 'alchemist');
      if (alchemist) {
        const { d1, d2 } = this.chooseAlchemistDice(engine, me);
        return { action: 'play_progress_card', cardId: alchemist.id, options: { d1, d2 } };
      }
      return null;
    }
    if (engine.phase !== GAME_PHASES.TURN_ACTION) return null;

    const inactive = (me.knightsPlaced || []).filter(k => !k.active);
    const warlord = cards.find(c => c.type === 'warlord');
    if (warlord && inactive.length >= 2) {
      return { action: 'play_progress_card', cardId: warlord.id, options: {} };
    }
    const fleet = cards.find(c => c.type === 'merchant_fleet');
    if (fleet && engine.countTotalCards(me) >= 7) {
      return { action: 'play_progress_card', cardId: fleet.id, options: {} };
    }
    const crane = cards.find(c => c.type === 'crane');
    if (crane && this.chooseBestImprovementTrack(engine, me)) {
      return { action: 'play_progress_card', cardId: crane.id, options: {} };
    }
    const wedding = cards.find(c => c.type === 'wedding');
    if (wedding) {
      const richer = engine.players.some(p => p.id !== me.id && (p.victoryPoints || 0) > (me.victoryPoints || 0));
      if (richer) {
        return { action: 'play_progress_card', cardId: wedding.id, options: {} };
      }
    }
    const spy = cards.find(c => c.type === 'spy');
    if (spy) {
      const target = engine.players.find(p => p.id !== me.id && engine.countUnplayedProgressCards(p) > 0);
      if (target) {
        return { action: 'play_progress_card', cardId: spy.id, options: { targetPlayerId: target.id } };
      }
    }
    const rb = cards.find(c => c.type === 'road_building');
    if (rb && (me.roadsRemaining || 0) >= 2) {
      return { action: 'play_progress_card', cardId: rb.id, options: {} };
    }
    const tm = cards.find(c => c.type === 'trade_monopoly');
    if (tm) {
      const stealCount = (type) => engine.players.reduce(
        (n, p) => (p.id === me.id ? n : n + Math.min(1, p.commodities?.[type] || 0)),
        0
      );
      const commodity = [...COMMODITY_VALUES].sort((a, b) => {
        const stealDiff = stealCount(b) - stealCount(a);
        if (stealDiff !== 0) return stealDiff;
        return (me.commodities?.[a] || 0) - (me.commodities?.[b] || 0);
      })[0];
      return { action: 'play_progress_card', cardId: tm.id, options: { commodity } };
    }
    const master = cards.find(c => c.type === 'master_merchant');
    if (master) {
      const leader = engine.players
        .filter(p => p.id !== me.id)
        .sort((a, b) => (b.victoryPoints || 0) - (a.victoryPoints || 0))[0];
      if (leader && (leader.victoryPoints || 0) > (me.victoryPoints || 0) && engine.countTotalCards(leader) >= 2) {
        const steal = [];
        for (const [res, n] of Object.entries(leader.resources || {})) {
          for (let i = 0; i < n && steal.length < 2; i++) steal.push(res);
        }
        for (const [com, n] of Object.entries(leader.commodities || {})) {
          for (let i = 0; i < n && steal.length < 2; i++) steal.push(com);
        }
        if (steal.length === 2) {
          return {
            action: 'play_progress_card',
            cardId: master.id,
            options: { targetPlayerId: leader.id, steal }
          };
        }
      }
    }
    return null;
  }

  static decideCkTurnAction(engine, me) {
    const progress = this.decideProgressCardPlay(engine, me);
    if (progress) return progress;

    if (engine.barbarianPosition >= 5) {
      const inactive = (me.knightsPlaced || []).filter(k => !k.active && k.hiredTurn !== engine.turnNumber && k.lastActionTurn !== engine.turnNumber);
      if (inactive.length && (me.resources.wheat || 0) >= 1) {
        return { action: 'activate_knight', vertexId: inactive[0].vertexId };
      }
    }

    const robberHex = engine.grid.robberHexId;
    const robberInPlay = engine.isRobberInPlay?.() ?? (!engine.isCitiesKnights?.() || engine.barbariansHaveAttacked);
    if (robberInPlay) {
      for (const knight of me.knightsPlaced || []) {
        if (!knight.active || knight.hiredTurn === engine.turnNumber || knight.lastActionTurn === engine.turnNumber) continue;
        const v = engine.grid.vertices.get(knight.vertexId);
        if (v?.hexes?.includes(robberHex)) {
          const dest = Array.from(engine.grid.hexes.keys()).find(id => id !== robberHex);
          if (dest) return { action: 'chase_robber', vertexId: knight.vertexId, hexId: dest };
        }
      }
    }

    if ((me.knightsPlaced || []).length === 0 && (me.resources.ore || 0) >= 1 && (me.resources.wool || 0) >= 1) {
      const valid = this.findValidKnightVertices(engine, me);
      if (valid.length) return { action: 'place_knight', vertexId: valid[0] };
    }

    const politics = me.cityImprovements?.politics || 0;
    for (const knight of me.knightsPlaced || []) {
      if (knight.hiredTurn === engine.turnNumber || knight.lastActionTurn === engine.turnNumber) continue;
      const nextReq = knight.rank === 'basic' ? 1 : knight.rank === 'strong' ? 2 : 99;
      if (politics >= nextReq && knight.rank !== 'mighty'
        && (me.resources.wool || 0) >= 1 && (me.resources.ore || 0) >= 1) {
        const nextRank = knight.rank === 'basic' ? 'strong' : 'mighty';
        if ((me.knightsAvailable?.[nextRank] || 0) > 0) {
          return { action: 'promote_knight', vertexId: knight.vertexId };
        }
      }
    }

    const track = this.chooseBestImprovementTrack(engine, me);
    if (track) return { action: 'improve_city', track };

    if (engine.countTotalCards(me) >= 6 && (me.cityWalls || 0) > 0 && (me.resources.brick || 0) >= 2) {
      const city = this.findCityWithoutWall(engine, me);
      if (city) return { action: 'build_city_wall', vertexId: city };
    }

    if ((me.resources.ore || 0) >= 1 && (me.resources.wool || 0) >= 1) {
      const valid = this.findValidKnightVertices(engine, me);
      if (valid.length && (me.knightsAvailable?.basic || 0) > 0) {
        return { action: 'place_knight', vertexId: valid[0] };
      }
    }

    return null;
  }

  static applyTurnAction(engine, botPlayer, action) {
    const ensureNoPendingProgressDiscard = () => {
      if (engine.pendingProgressDiscard?.has(botPlayer.id) || (engine.isCitiesKnights?.() && engine.countUnplayedProgressCards?.(botPlayer) > 4)) {
        while (engine.pendingProgressDiscard?.has(botPlayer.id) || (engine.isCitiesKnights?.() && engine.countUnplayedProgressCards?.(botPlayer) > 4)) {
          const cardId = this.decideProgressDiscard(botPlayer);
          if (!cardId) break;
          engine.discardProgressCard(botPlayer.id, cardId);
        }
      }
    };

    if (!action) {
      botPlayer.hasProposedTradeThisTurn = false;
      ensureNoPendingProgressDiscard();
      engine.endTurn(botPlayer.id);
      return;
    }
    switch (action.action) {
      case 'propose_trade':
        botPlayer.hasProposedTradeThisTurn = true;
        engine.proposeTrade(botPlayer.id, action.give, action.want);
        for (const other of engine.players) {
          if (other.id !== botPlayer.id && other.isBot && this.canBotAcceptTrade(engine, other, engine.activeTrade)) {
            try { engine.respondToTrade(other.id, true); } catch (e) {}
            break;
          }
        }
        break;
      case 'confirm_trade':
        engine.confirmTrade(botPlayer.id, action.targetPlayerId);
        break;
      case 'cancel_trade':
        engine.cancelTrade(botPlayer.id);
        break;
      case 'end_turn':
        botPlayer.hasProposedTradeThisTurn = false;
        ensureNoPendingProgressDiscard();
        engine.endTurn(botPlayer.id);
        break;
      case 'build_city':
        engine.buildCity(botPlayer.id, action.vertexId);
        break;
      case 'build_settlement':
        engine.buildSettlement(botPlayer.id, action.vertexId);
        break;
      case 'build_road':
        engine.buildRoad(botPlayer.id, action.edgeId);
        break;
      case 'buy_dev_card':
        engine.buyDevCard(botPlayer.id);
        break;
      case 'bank_trade':
        engine.tradeWithBank(botPlayer.id, action.give, action.receive, action.ratio);
        break;
      case 'play_dev_card':
        engine.playDevCard(botPlayer.id, action.cardId);
        break;
      case 'play_progress_card':
        engine.playProgressCard(botPlayer.id, action.cardId, action.options || {});
        break;
      case 'place_knight':
        engine.placeKnight(botPlayer.id, action.vertexId);
        break;
      case 'activate_knight':
        engine.activateKnight(botPlayer.id, action.vertexId);
        break;
      case 'promote_knight':
        engine.promoteKnight(botPlayer.id, action.vertexId);
        break;
      case 'build_city_wall':
        engine.buildCityWall(botPlayer.id, action.vertexId);
        break;
      case 'improve_city':
        engine.improveCityTrack(botPlayer.id, action.track);
        break;
      case 'chase_robber':
        engine.chaseRobber(botPlayer.id, action.vertexId, action.hexId, action.targetPlayerId);
        break;
      default:
        botPlayer.hasProposedTradeThisTurn = false;
        ensureNoPendingProgressDiscard();
        engine.endTurn(botPlayer.id);
    }
  }

  static playCurrentBotStep(engine) {
    if (engine.phase === GAME_PHASES.GAME_OVER) return false;

    if (engine.pendingProgressDiscard?.size) {
      for (const pId of Array.from(engine.pendingProgressDiscard)) {
        const p = engine.players.find(x => x.id === pId);
        if (!p) continue;
        while (engine.pendingProgressDiscard.has(pId)) {
          const cardId = this.decideProgressDiscard(p);
          if (!cardId) break;
          engine.discardProgressCard(pId, cardId);
        }
      }
    }

    if (engine.phase === GAME_PHASES.TURN_DISCARD) {
      for (const pId of Array.from(engine.pendingDiscards)) {
        const p = engine.players.find(x => x.id === pId);
        if (!p) continue;
        const dis = this.decideDiscard(engine, p);
        engine.discardCards(pId, dis.discarded);
      }
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_BARBARIAN_DOWNGRADE) {
      for (const pId of Array.from(engine.pendingBarbarianDowngrades)) {
        const city = this.chooseCityToDowngrade(engine, pId);
        if (city) engine.downgradeCity(pId, city);
      }
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_BARBARIAN_REWARD) {
      for (const pId of Array.from(engine.pendingBarbarianTieDraws || [])) {
        const p = engine.players.find(x => x.id === pId);
        if (!p) continue;
        const deck = this.chooseBarbarianRewardDeck(p);
        engine.chooseBarbarianReward(pId, deck);
      }
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
      const chooser = engine.pendingMetropolisChoice?.playerId || engine.getCurrentPlayer()?.id;
      const city = this.chooseCityForMetropolis(engine, chooser);
      if (city) engine.chooseMetropolis(chooser, city);
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE) {
      engine.autoResolveKnightRelocation();
      return true;
    }

    const cur = engine.getCurrentPlayer();
    if (!cur) return false;

    if (engine.phase === GAME_PHASES.SETUP_ROUND_1 || engine.phase === GAME_PHASES.SETUP_ROUND_2) {
      const setup = this.decideSetupAction(engine, cur);
      if (setup?.action === 'place_setup_settlement') engine.placeSetupSettlement(cur.id, setup.vertexId);
      else if (setup?.action === 'place_setup_road') engine.placeSetupRoad(cur.id, setup.edgeId);
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_ROLL) {
      cur.hasProposedTradeThisTurn = false;
      const alchemist = this.decideProgressCardPlay(engine, cur);
      if (alchemist) engine.playProgressCard(cur.id, alchemist.cardId, alchemist.options);
      engine.rollDice(cur.id);
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_ROBBER) {
      const rob = this.decideRobberMove(engine, cur);
      engine.moveRobber(cur.id, rob.hexId, rob.targetPlayerId);
      return true;
    }

    if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
      if (engine.phase === GAME_PHASES.TURN_ACTION && engine.activeTrade && engine.activeTrade.fromPlayerId === cur.id) {
        if (engine.activeTrade.acceptedBy && engine.activeTrade.acceptedBy.size > 0) {
          const target = Array.from(engine.activeTrade.acceptedBy)[0];
          engine.confirmTrade(cur.id, target);
          return true;
        } else {
          engine.cancelTrade(cur.id);
          return true;
        }
      }

      const action = this.decideTurnAction(engine, cur);
      try {
        this.applyTurnAction(engine, cur, action);
      } catch {
        if (engine.phase === GAME_PHASES.TURN_ACTION || engine.phase === GAME_PHASES.TURN_SPECIAL_BUILDING) {
          try { engine.endTurn(cur.id); } catch { /* ignore */ }
        }
      }
      return true;
    }

    return false;
  }
}
