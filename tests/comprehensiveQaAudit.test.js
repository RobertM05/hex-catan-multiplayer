/**
 * comprehensiveQaAudit.test.js
 * Exhaustive QA audit and exploratory test suite covering:
 * 1. Base Game Dev Cards (Knight, Monopoly, Year of Plenty, Road Building, Victory Points)
 * 2. Cities & Knights Progress Cards across all 3 decks (Trade, Politics, Science)
 * 3. Building Types & Units (Settlements, Cities, City Walls, Knights, Metropolises)
 * 4. Trading Systems (Player-to-player, Bot evaluation, Fog-of-war privacy)
 * 5. Turn lifecycle, timer synchronization, and road inspection integration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameEngine,
  GAME_PHASES,
  GAME_MODES,
  COSTS,
  DEV_CARD_TYPES,
  PROGRESS_CARD_DECKS,
  KNIGHT_RANKS,
  COMMODITY_TYPES
} from '../server/game/GameEngine.js';
import { RESOURCE_TYPES } from '../server/game/HexGrid.js';
import { BotAI } from '../server/game/BotAI.js';
import { calculateTimerState, getDiscardRemainingSeconds } from '../public/js/turnTimer.js';
import { getConnectedRoadNetwork, getLongestContinuousPath } from '../public/js/roadInspection.js';

function makeBaseEngine() {
  const engine = new GameEngine({ roomId: 'test-base', mode: GAME_MODES.BASE, vpTarget: 10 });
  engine.addPlayer({ id: 'p1', name: 'Alice', color: '#ff0000' });
  engine.addPlayer({ id: 'p2', name: 'Bob', color: '#00ff00' });
  engine.startGame('standard');
  engine.turnNumber = 2;
  engine.phase = GAME_PHASES.TURN_ACTION;
  return engine;
}

function makeCkEngine() {
  const engine = new GameEngine({ roomId: 'test-ck', mode: GAME_MODES.CITIES_KNIGHTS, vpTarget: 13 });
  engine.addPlayer({ id: 'p1', name: 'Alice', color: '#ff0000' });
  engine.addPlayer({ id: 'p2', name: 'Bob', color: '#00ff00' });
  engine.startGame('standard');
  engine.turnNumber = 2;
  engine.phase = GAME_PHASES.TURN_ACTION;
  return engine;
}

describe('QA Audit: Base Game Dev Cards', () => {
  it('Knight card moves robber, steals resource, updates largest army, and enforces robber phase', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    // Give p2 a settlement touching hex0 and wood
    const hex0 = Array.from(engine.grid.hexes.values()).find(h => h.id !== engine.grid.robberHexId);
    const vert0 = Array.from(engine.grid.vertices.values()).find(v => v.hexes.includes(hex0.id));
    vert0.building = { type: 'settlement', playerId: 'p2', color: p2.color };
    p2.settlementsBuilt.push(vert0.id);
    p2.resources.wood = 3;

    const cardId = 'k_1';
    p1.devCards.push({ id: cardId, type: DEV_CARD_TYPES.KNIGHT, boughtTurn: 1, played: false });

    engine.playDevCard('p1', cardId);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER, 'Playing knight must transition to TURN_ROBBER');
    assert.equal(p1.playedKnights, 1);

    // Move robber to hex 0 and steal from p2
    const robRes = engine.moveRobber('p1', hex0.id, 'p2');
    assert.equal(engine.grid.robberHexId, hex0.id);
    assert.equal(robRes.stolenResource, 'wood');
    assert.equal(p1.resources.wood, 1);
    assert.equal(p2.resources.wood, 2);
    // Since hasRolledDice is false, moveRobber returns to TURN_ROLL
    assert.equal(engine.phase, GAME_PHASES.TURN_ROLL, 'Knight played before roll returns phase to TURN_ROLL');
  });

  it('Largest Army requires strictly greater knights (min 3) to take from holder', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    p1.playedKnights = 3;
    engine.recalculateLargestArmy();
    assert.equal(engine.largestArmyHolder.playerId, 'p1');
    assert.equal(engine.largestArmyHolder.count, 3);

    p2.playedKnights = 3;
    engine.recalculateLargestArmy();
    assert.equal(engine.largestArmyHolder.playerId, 'p1', 'Tie does not transfer Largest Army');

    p2.playedKnights = 4;
    engine.recalculateLargestArmy();
    assert.equal(engine.largestArmyHolder.playerId, 'p2', 'Strictly greater takes Largest Army');
    assert.equal(engine.largestArmyHolder.count, 4);
  });

  it('Monopoly steals all cards of chosen resource from other players', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const p2 = engine.players[1];
    p2.resources.wood = 5;
    p1.resources.wood = 1;
    const cardId = 'mono_1';
    p1.devCards.push({ id: cardId, type: DEV_CARD_TYPES.MONOPOLY, boughtTurn: 1, played: false });

    engine.playDevCard('p1', cardId, { resource: 'wood' });
    assert.equal(p2.resources.wood, 0);
    assert.equal(p1.resources.wood, 6);
  });

  it('Monopoly rejects invalid resource names', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const cardId = 'mono_1';
    p1.devCards.push({ id: cardId, type: DEV_CARD_TYPES.MONOPOLY, boughtTurn: 1, played: false });

    assert.throws(() => engine.playDevCard('p1', cardId, { resource: 'gold' }), /SPECIFY_VALID_RESOURCE/);
  });

  it('Year of Plenty grants 2 chosen resources and rejects invalid types', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const cardId = 'yop_1';
    p1.devCards.push({ id: cardId, type: DEV_CARD_TYPES.YEAR_OF_PLENTY, boughtTurn: 1, played: false });

    engine.playDevCard('p1', cardId, { res1: 'ore', res2: 'wheat' });
    assert.equal(p1.resources.ore, 1);
    assert.equal(p1.resources.wheat, 1);

    engine.devCardPlayedThisTurn = false;
    const cardId2 = 'yop_2';
    p1.devCards.push({ id: cardId2, type: DEV_CARD_TYPES.YEAR_OF_PLENTY, boughtTurn: 1, played: false });
    assert.throws(() => engine.playDevCard('p1', cardId2, { res1: 'ore', res2: 'cloth' }), /SPECIFY_TWO_VALID_RESOURCES/);
  });

  it('Victory Point cards remain hidden from opponents during active gameplay', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    p1.settlementsBuilt = ['v1', 'v2']; // 2 public VP
    p1.devCards.push({ id: 'vp_1', type: DEV_CARD_TYPES.VICTORY_POINT, boughtTurn: 1, played: false });
    engine.recalculateVictoryPoints();

    assert.equal(p1.victoryPoints, 3);
    assert.equal(p1.publicVictoryPoints, 2);

    const p2State = engine.getStateForPlayer('p2');
    const p1InP2State = p2State.players.find(p => p.id === 'p1');
    assert.equal(p1InP2State.victoryPoints, 2, 'Opponents must only see public VP during play');
    assert.equal(p1InP2State.devCards.count, 1, 'Opponents must only see unplayed card count');
  });

  it('Cannot play a dev card on the turn it was purchased', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    p1.devCards.push({ id: 'k1', type: DEV_CARD_TYPES.KNIGHT, boughtTurn: engine.turnNumber, played: false });

    assert.throws(() => engine.playDevCard('p1', 'k1'), /CANNOT_PLAY_CARD_TURN_BOUGHT/);
  });
});

describe('QA Audit: Cities & Knights Progress Cards', () => {
  it('Commercial Harbor exchanges resource for commodity with participating opponents', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const p2 = engine.players[1];
    p1.resources.wood = 2;
    p2.commodities.cloth = 1;

    const card = { id: 'prog_ch', type: 'commercial_harbor', track: 'trade', played: false, boughtTurn: 1 };
    p1.progressCards.push(card);

    const res = engine.playProgressCard('p1', card.id, {
      resource: 'wood',
      commodities: { p2: 'cloth' }
    });

    assert.equal(res.exchanges.length, 1);
    assert.equal(p1.resources.wood, 1);
    assert.equal(p2.resources.wood, 1);
    assert.equal(p1.commodities.cloth, 1);
    assert.equal(p2.commodities.cloth, 0);
  });

  it('Alchemist sets pre-roll dice values within 1-6', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ROLL;
    const p1 = engine.players[0];
    const card = { id: 'prog_alch', type: 'alchemist', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(card);

    engine.playProgressCard('p1', card.id, { d1: 3, d2: 4 });
    assert.deepEqual(engine.alchemistDice, [3, 4]);

    const rollRes = engine.rollDice('p1');
    assert.equal(rollRes.sum, 7);
    assert.deepEqual(rollRes.dice, [3, 4]);
  });

  it('Crane discounts city improvement by 1 commodity', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const city = Array.from(engine.grid.vertices.values())[0];
    city.building = { type: 'city', playerId: 'p1', color: p1.color };
    p1.citiesBuilt.push(city.id);

    // Level 1 normal cost: 1 cloth. Level 2 normal cost: 2 cloth.
    p1.cityImprovements.trade = 1;
    p1.commodities.cloth = 1; // normally needs 2 cloth for level 2

    const card = { id: 'prog_crane', type: 'crane', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(card);

    engine.playProgressCard('p1', card.id);
    assert.equal(p1.craneDiscount, true);

    engine.improveCityTrack('p1', 'trade');
    assert.equal(p1.cityImprovements.trade, 2);
    assert.equal(p1.commodities.cloth, 0);
    assert.equal(p1.craneDiscount, false);
  });

  it('Inventor swaps number tokens between non-restricted hexes (excluding 2, 6, 8, 12)', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const hexes = Array.from(engine.grid.hexes.values()).filter(h => h.token && ![2, 6, 8, 12].includes(h.token));
    assert.ok(hexes.length >= 2);

    const h1 = hexes[0];
    const h2 = hexes[1];
    const t1 = h1.token;
    const t2 = h2.token;

    const card = { id: 'prog_inv', type: 'inventor', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(card);

    engine.playProgressCard('p1', card.id, { hexId1: h1.id, hexId2: h2.id });
    assert.equal(h1.token, t2);
    assert.equal(h2.token, t1);
  });

  it('Irrigation and Mining grant 2 resources per city-adjacent resource hex', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];

    // Clear initial setup buildings so only the test cities are counted
    for (const v of engine.grid.vertices.values()) {
      if (v.building?.playerId === 'p1') v.building = null;
    }
    p1.citiesBuilt = [];
    p1.settlementsBuilt = [];

    const wheatHex = Array.from(engine.grid.hexes.values()).find(h => h.resource === RESOURCE_TYPES.WHEAT);
    const vWheat = Array.from(engine.grid.vertices.values()).find(v => 
      !v.building && 
      v.hexes.includes(wheatHex.id) && 
      v.hexes.filter(hId => engine.grid.hexes.get(hId)?.resource === RESOURCE_TYPES.WHEAT).length === 1
    );
    vWheat.building = { type: 'city', playerId: 'p1', color: p1.color };
    p1.citiesBuilt.push(vWheat.id);

    const irrCard = { id: 'prog_irr', type: 'irrigation', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(irrCard);

    const wheatBefore = p1.resources.wheat || 0;
    engine.playProgressCard('p1', irrCard.id);
    assert.equal(p1.resources.wheat, wheatBefore + 2);

    // Clear previous wheat city so only the ore city is evaluated for mining
    vWheat.building = null;
    p1.citiesBuilt = [];

    const oreHex = Array.from(engine.grid.hexes.values()).find(h => h.resource === RESOURCE_TYPES.ORE);
    const vOre = Array.from(engine.grid.vertices.values()).find(v => 
      !v.building && 
      v.hexes.includes(oreHex.id) && 
      v.hexes.filter(hId => engine.grid.hexes.get(hId)?.resource === RESOURCE_TYPES.ORE).length === 1
    );
    vOre.building = { type: 'city', playerId: 'p1', color: p1.color };
    p1.citiesBuilt.push(vOre.id);

    const mineCard = { id: 'prog_mine', type: 'mining', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(mineCard);

    const oreBefore = p1.resources.ore || 0;
    engine.playProgressCard('p1', mineCard.id);
    assert.equal(p1.resources.ore, oreBefore + 2);
  });

  it('Irrigation and Mining do not grant for settlements', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const wheatHex = Array.from(engine.grid.hexes.values()).find(h => h.resource === RESOURCE_TYPES.WHEAT);
    const vWheat = Array.from(engine.grid.vertices.values()).find(v => v.hexes.includes(wheatHex.id) && !v.building);
    vWheat.building = { type: 'settlement', playerId: 'p1', color: p1.color };
    p1.settlementsBuilt.push(vWheat.id);

    const irrCard = { id: 'prog_irr_s', type: 'irrigation', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(irrCard);
    const wheatBefore = p1.resources.wheat || 0;
    engine.playProgressCard('p1', irrCard.id);
    assert.equal(p1.resources.wheat, wheatBefore);

    const oreHex = Array.from(engine.grid.hexes.values()).find(h => h.resource === RESOURCE_TYPES.ORE);
    const vOre = Array.from(engine.grid.vertices.values()).find(v => v.hexes.includes(oreHex.id) && !v.building);
    vOre.building = { type: 'settlement', playerId: 'p1', color: p1.color };
    p1.settlementsBuilt.push(vOre.id);

    const mineCard = { id: 'prog_mine_s', type: 'mining', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(mineCard);
    const oreBefore = p1.resources.ore || 0;
    engine.playProgressCard('p1', mineCard.id);
    assert.equal(p1.resources.ore, oreBefore);
  });

  it('Medicine allows upgrading settlement to city for 2 ore + 1 wheat', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const vertex = Array.from(engine.grid.vertices.values())[0];
    vertex.building = { type: 'settlement', playerId: 'p1', color: p1.color };
    p1.settlementsBuilt.push(vertex.id);

    p1.resources = { wood: 0, brick: 0, wool: 0, wheat: 1, ore: 2 };
    const card = { id: 'prog_med', type: 'medicine', track: 'science', played: false, boughtTurn: 1 };
    p1.progressCards.push(card);

    engine.playProgressCard('p1', card.id);
    assert.equal(p1.medicineActive, true);

    engine.buildCity('p1', vertex.id);
    assert.equal(vertex.building.type, 'city');
    assert.equal(p1.resources.wheat, 0);
    assert.equal(p1.resources.ore, 0);
  });

  it('Warlord activates all knights on the board without wheat cost', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const k1 = { playerId: 'p1', vertexId: 'v1', rank: 'basic', active: false, strength: 1, hiredTurn: 1, lastActionTurn: 1 };
    const k2 = { playerId: 'p1', vertexId: 'v2', rank: 'strong', active: false, strength: 2, hiredTurn: 1, lastActionTurn: 1 };
    p1.knightsPlaced = [k1, k2];

    const card = { id: 'prog_war', type: 'warlord', track: 'politics', played: false, boughtTurn: 1 };
    p1.progressCards.push(card);

    engine.playProgressCard('p1', card.id);
    assert.equal(k1.active, true);
    assert.equal(k2.active, true);
  });

  it('Progress card hand limit enforces discard before turn end when holding > 4 unplayed cards', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    for (let i = 0; i < 5; i++) {
      p1.progressCards.push({ id: `c_${i}`, type: 'crane', track: 'science', played: false, boughtTurn: 1 });
    }

    assert.throws(() => engine.endTurn('p1'), /MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN/);
    assert.equal(engine.pendingProgressDiscard.has('p1'), true);

    engine.discardProgressCard('p1', 'c_0');
    assert.equal(engine.countUnplayedProgressCards(p1), 4);
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
  });
});

describe('QA Audit: Buildings & Knight Units', () => {
  it('City Walls cost 2 brick, cap at 3, and expand discard threshold (+2 per wall)', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const v1 = Array.from(engine.grid.vertices.values())[0];
    v1.building = { type: 'city', playerId: 'p1', color: p1.color, hasWall: false };
    p1.citiesBuilt.push(v1.id);

    assert.equal(engine.getDiscardThreshold(p1), 7);
    assert.equal(p1.cityWalls, 3);

    p1.resources.brick = 2;
    engine.buildCityWall('p1', v1.id);
    assert.equal(v1.building.hasWall, true);
    assert.equal(p1.cityWalls, 2);
    assert.equal(engine.getDiscardThreshold(p1), 9);
  });

  it('Knight placement obeys road connectivity and initial basic rank', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const v1 = Array.from(engine.grid.vertices.values())[0];
    const edge = engine.grid.edges.get(v1.adjacentEdges[0]);
    edge.road = { playerId: 'p1', color: p1.color };
    p1.roadsBuilt.push(edge.id);

    p1.resources = { ore: 1, wool: 1, wood: 0, brick: 0, wheat: 0 };
    engine.placeKnight('p1', v1.id);

    assert.ok(v1.knight);
    assert.equal(v1.knight.rank, 'basic');
    assert.equal(v1.knight.strength, 1);
    assert.equal(v1.knight.active, false);
    assert.equal(p1.knightsAvailable.basic, 1);
  });

  it('Knight activation costs 1 wheat and is legal on the hired turn', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const v1 = Array.from(engine.grid.vertices.values())[0];
    v1.knight = { playerId: 'p1', vertexId: v1.id, rank: 'basic', active: false, strength: 1, hiredTurn: engine.turnNumber, lastActionTurn: null };
    p1.knightsPlaced.push(v1.knight);
    p1.resources.wheat = 1;

    engine.activateKnight('p1', v1.id);
    assert.equal(v1.knight.active, true);
    assert.equal(p1.resources.wheat, 0);
    assert.equal(v1.knight.lastActionTurn, engine.turnNumber);
  });

  it('Knight Basic→Strong has no politics gate; Mighty needs Fortress (Politics 3)', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const v1 = Array.from(engine.grid.vertices.values())[0];
    v1.knight = { playerId: 'p1', vertexId: v1.id, rank: 'basic', active: false, strength: 1, hiredTurn: 1, lastActionTurn: 1 };
    p1.knightsPlaced.push(v1.knight);
    p1.resources = { ore: 2, wool: 2 };
    p1.cityImprovements.politics = 0;

    engine.promoteKnight('p1', v1.id);
    assert.equal(v1.knight.rank, 'strong');
    assert.equal(v1.knight.strength, 2);

    engine.turnNumber++;
    p1.cityImprovements.politics = 2;
    assert.throws(() => engine.promoteKnight('p1', v1.id), /POLITICS_LEVEL_TOO_LOW/);

    p1.cityImprovements.politics = 3;
    engine.promoteKnight('p1', v1.id);
    assert.equal(v1.knight.rank, 'mighty');
    assert.equal(v1.knight.strength, 3);
  });
});

describe('QA Audit: Trading Systems & Bot AI', () => {
  it('Player-to-player trade proposal, accept, and confirm lifecycle', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const p2 = engine.players[1];

    p1.resources.wood = 2;
    p2.resources.brick = 2;

    engine.proposeTrade('p1', { wood: 1 }, { brick: 1 });
    assert.ok(engine.activeTrade);
    assert.equal(engine.activeTrade.fromPlayerId, 'p1');

    engine.respondToTrade('p2', true);
    assert.ok(engine.activeTrade.acceptedBy.has('p2'));

    engine.confirmTrade('p1', 'p2');
    assert.equal(p1.resources.wood, 1);
    assert.equal(p1.resources.brick, 1);
    assert.equal(p2.resources.wood, 1);
    assert.equal(p2.resources.brick, 1);
    assert.equal(engine.activeTrade, null);
  });

  it('BotAI rejects trades to near-winning opponents (kingmaking rejection)', () => {
    const engine = makeBaseEngine();
    const bot = engine.players[1];
    bot.resources.brick = 2;

    const nearWinner = engine.players[0];
    nearWinner.victoryPoints = 8; // vpTarget = 10 -> within 2 VP

    const trade = {
      fromPlayerId: nearWinner.id,
      give: { wood: 1 },
      want: { brick: 1 }
    };

    const willAccept = BotAI.canBotAcceptTrade(engine, bot, trade);
    assert.equal(willAccept, false, 'Bot must reject trade proposals from near-winning players');
  });

  it('BotAI rejects 1:2 rip-off proposals', () => {
    const engine = makeBaseEngine();
    const bot = engine.players[1];
    bot.resources.wood = 2;
    bot.resources.brick = 2;

    const proposer = engine.players[0];
    proposer.victoryPoints = 2;

    const trade = {
      fromPlayerId: proposer.id,
      give: { ore: 1 },
      want: { wood: 1, brick: 1 } // 1:2 rip-off
    };

    const willAccept = BotAI.canBotAcceptTrade(engine, bot, trade);
    assert.equal(willAccept, false, 'Bot must reject offering 2 cards for 1 card');
  });
});

describe('QA Audit: UI Component Logic & Edge Cases', () => {
  it('Turn timer state computes warning and critical colors accurately', () => {
    const normal = calculateTimerState({ remaining: 60, duration: 90 });
    assert.equal(normal.colorClass, 'timer-normal');
    assert.equal(normal.isLowTime, false);

    const warning = calculateTimerState({ remaining: 35, duration: 90 });
    assert.equal(warning.colorClass, 'timer-warning');

    const critical = calculateTimerState({ remaining: 10, duration: 90 });
    assert.equal(critical.colorClass, 'timer-critical');

    const lowTime = calculateTimerState({ remaining: 4, duration: 90 });
    assert.equal(lowTime.isLowTime, true);
  });

  it('getDiscardRemainingSeconds calculates positive seconds until future deadline', () => {
    const now = Date.now();
    const future = now + 12400; // 12.4s
    const rem = getDiscardRemainingSeconds(future, now);
    assert.equal(rem, 13); // ceil(12.4)
  });

  it('Road network inspection calculates contiguous network and simple longest path', () => {
    const engine = makeBaseEngine();
    const p1 = engine.players[0];
    const v0 = Array.from(engine.grid.vertices.values())[0];
    const e0 = engine.grid.edges.get(v0.adjacentEdges[0]);
    const v1Id = e0.v1 === v0.id ? e0.v2 : e0.v1;
    const v1 = engine.grid.vertices.get(v1Id);
    const e1Id = v1.adjacentEdges.find(id => id !== e0.id);
    const e1 = engine.grid.edges.get(e1Id);

    e0.road = { playerId: 'p1', color: p1.color };
    e1.road = { playerId: 'p1', color: p1.color };

    const network = getConnectedRoadNetwork(engine.grid, e0.id);
    assert.equal(network.length, 2);
    assert.ok(network.includes(e0.id));
    assert.ok(network.includes(e1.id));

    const longestPath = getLongestContinuousPath(engine.grid, e0.id);
    assert.equal(longestPath.length, 2);
  });
});
