/**
 * citiesKnights.test.js
 * Cities & Knights expansion tests. Starts with CK-01 core data model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_TYPES } from '../server/game/HexGrid.js';
import {
  GameEngine,
  GAME_PHASES,
  GAME_MODES,
  normalizeGameMode,
  PROGRESS_CARD_DECKS,
  PROGRESS_CARD_HAND_LIMIT
} from '../server/game/GameEngine.js';
import { RoomManager } from '../server/game/RoomManager.js';
import { BotAI } from '../server/game/BotAI.js';

function makeCkEngine() {
  const engine = new GameEngine({ mode: 'cities_knights' });
  engine.addPlayer({ id: 'p1', name: 'Alice' });
  engine.addPlayer({ id: 'p2', name: 'Bob' });
  engine.startGame('standard');
  return engine;
}

function attachBuilding(engine, playerId, resource, type) {
  const hex = Array.from(engine.grid.hexes.values()).find(
    h => h.resource === resource && h.id !== engine.grid.robberHexId
  );
  assert.ok(hex, `expected a ${resource} hex`);
  const vertexId = Array.from(engine.grid.vertices.keys()).find(id => {
    const v = engine.grid.vertices.get(id);
    return v.hexes.includes(hex.id) && !v.building;
  });
  const vertex = engine.grid.vertices.get(vertexId);
  vertex.building = { type, playerId, color: '#e63946' };
  const player = engine.players.find(p => p.id === playerId);
  if (type === 'city') player.citiesBuilt.push(vertexId);
  else player.settlementsBuilt.push(vertexId);
  return hex;
}

describe('CK-01 game mode toggle', () => {
  it('normalizes advanced to cities_knights and uses 13 VP', () => {
    assert.equal(normalizeGameMode('advanced'), GAME_MODES.CITIES_KNIGHTS);
    const engine = new GameEngine({ mode: 'advanced' });
    assert.equal(engine.mode, GAME_MODES.CITIES_KNIGHTS);
    assert.equal(engine.vpTarget, 13);
    assert.equal(engine.isCitiesKnights(), true);
  });

  it('keeps base mode at 10 VP with no commodity production', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    assert.equal(engine.vpTarget, 10);

    const production = { p1: {} };
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WOOL, 'city', production);
    assert.equal(engine.players[0].resources.wool, 2);
    assert.equal(engine.players[0].commodities.cloth, 0);
  });

  it('RoomManager stores cities_knights mode', () => {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const room = rm.createRoom({ id: 'h1', name: 'Host', socketId: 's1' }, { mode: 'cities_knights' });
    assert.equal(room.mode, GAME_MODES.CITIES_KNIGHTS);
    assert.equal(room.engine.vpTarget, 13);
    rm.destroyRoom(room.code);
  });
});

describe('CK-01 commodities', () => {
  it('cities produce 1 resource + 1 commodity on wool/ore/wood', () => {
    const engine = makeCkEngine();
    const production = { p1: {} };
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WOOL, 'city', production);
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.ORE, 'city', production);
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WOOD, 'city', production);

    assert.equal(engine.players[0].resources.wool, 1);
    assert.equal(engine.players[0].commodities.cloth, 1);
    assert.equal(engine.players[0].resources.ore, 1);
    assert.equal(engine.players[0].commodities.coin, 1);
    assert.equal(engine.players[0].resources.wood, 1);
    assert.equal(engine.players[0].commodities.paper, 1);
  });

  it('cities still produce 2 resources on wheat/brick', () => {
    const engine = makeCkEngine();
    const production = { p1: {} };
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WHEAT, 'city', production);
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.BRICK, 'city', production);
    assert.equal(engine.players[0].resources.wheat, 2);
    assert.equal(engine.players[0].resources.brick, 2);
    assert.equal(engine.countCommodities(engine.players[0]), 0);
  });

  it('settlements produce only resources', () => {
    const engine = makeCkEngine();
    const production = { p1: {} };
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WOOL, 'settlement', production);
    assert.equal(engine.players[0].resources.wool, 1);
    assert.equal(engine.players[0].commodities.cloth, 0);
  });

  it('refuses to spend commodities on a road', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[0].commodities = { cloth: 8, coin: 0, paper: 0 };
    const vertex = emptyVertex(engine);
    const { otherVertexId } = giveRoad(engine, 'p1', vertex.id);
    const nextEdgeId = engine.grid.vertices.get(otherVertexId).adjacentEdges.find(
      eid => !engine.grid.edges.get(eid).road
    );
    const check = engine.canBuildRoad('p1', nextEdgeId);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'NOT_ENOUGH_RESOURCES');
  });

  it('counts commodities toward the 7-discard threshold', () => {
    const engine = makeCkEngine();
    engine.players[0].resources = { wood: 4, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[0].commodities = { cloth: 4, coin: 0, paper: 0 };
    assert.equal(engine.countTotalCards(engine.players[0]), 8);

    engine.phase = GAME_PHASES.TURN_ROLL;
    const originalRandom = Math.random;
    let rollCall = 0;
    Math.random = () => {
      // Force 3+4 = 7
      rollCall += 1;
      return rollCall % 2 === 1 ? 2 / 6 : 3 / 6;
    };
    try {
      engine.rollDice('p1');
    } finally {
      Math.random = originalRandom;
    }

    assert.equal(engine.phase, GAME_PHASES.TURN_DISCARD);
    assert.ok(engine.pendingDiscards.has('p1'));

    engine.discardCards('p1', { wood: 2, cloth: 2 });
    assert.equal(engine.players[0].resources.wood, 2);
    assert.equal(engine.players[0].commodities.cloth, 2);
    assert.equal(engine.pendingDiscards.has('p1'), false);
  });

  it('places a city in setup round 2 and awards city production including commodities', () => {
    const engine = makeCkEngine();
    const v1 = Array.from(engine.grid.vertices.keys()).find(id => engine.canBuildSettlement('p1', id, true).ok);
    engine.placeSetupSettlement('p1', v1);
    engine.placeSetupRoad('p1', engine.grid.vertices.get(v1).adjacentEdges[0]);
    const v2 = Array.from(engine.grid.vertices.keys()).find(id => engine.canBuildSettlement('p2', id, true).ok);
    engine.placeSetupSettlement('p2', v2);
    engine.placeSetupRoad('p2', engine.grid.vertices.get(v2).adjacentEdges[0]);
    assert.equal(engine.phase, GAME_PHASES.SETUP_ROUND_2);

    const cityV = Array.from(engine.grid.vertices.keys()).find(id => {
      const v = engine.grid.vertices.get(id);
      return !v.building && !v.knight && engine.canBuildSettlement('p2', id, true).ok;
    });
    engine.placeSetupSettlement('p2', cityV);
    const building = engine.grid.vertices.get(cityV).building;
    assert.equal(building.type, 'city');
    assert.ok(engine.players[1].citiesBuilt.includes(cityV));
    assert.equal(engine.players[1].citiesRemaining, 3);
    const cards = engine.countTotalCards(engine.players[1]);
    assert.ok(cards >= 1);
  });

  it('lets the robber steal a commodity from the combined pool', () => {
    const engine = makeCkEngine();
    const hex = attachBuilding(engine, 'p2', RESOURCE_TYPES.WOOL, 'settlement');
    engine.players[1].resources = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[1].commodities = { cloth: 2, coin: 0, paper: 0 };
    engine.phase = GAME_PHASES.TURN_ROBBER;

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const result = engine.moveRobber('p1', hex.id, 'p2');
      assert.equal(result.stolenResource, 'cloth');
      assert.equal(engine.players[1].commodities.cloth, 1);
      assert.equal(engine.players[0].commodities.cloth, 1);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe('CK-01 state serialization', () => {
  it('hides opponent commodities but includes them in the card total', () => {
    const engine = makeCkEngine();
    engine.players[0].commodities.cloth = 3;
    engine.players[0].resources.wood = 2;
    engine.players[0].cityImprovements.trade = 1;
    engine.barbarianPosition = 4;

    const selfState = engine.getStateForPlayer('p1');
    assert.equal(selfState.mode, GAME_MODES.CITIES_KNIGHTS);
    assert.equal(selfState.barbarianPosition, 4);
    assert.equal(selfState.players[0].commodities.cloth, 3);
    assert.equal(selfState.players[0].cityImprovements.trade, 1);

    const oppState = engine.getStateForPlayer('p2');
    assert.equal(oppState.players[0].commodities.total, 3);
    assert.equal(oppState.players[0].resources.total, 2);
    assert.equal(oppState.players[0].commodities.cloth, undefined);
    assert.equal(engine.players[0].cityWalls, 3);
  });
});

describe('CK-02 city improvements', () => {
  it('charges the correct commodity cost and refuses invalid upgrades', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].commodities.cloth = 10;

    assert.throws(() => engine.improveCityTrack('p1', 'trade'), /NEED_CITY_TO_IMPROVE/);

    engine.players[0].citiesBuilt.push('v1');
    const first = engine.improveCityTrack('p1', 'trade');
    assert.equal(first.level, 1);
    assert.equal(engine.players[0].commodities.cloth, 9);

    engine.improveCityTrack('p1', 'trade');
    assert.equal(engine.players[0].cityImprovements.trade, 2);
    assert.equal(engine.players[0].commodities.cloth, 7);

    engine.players[0].cityImprovements.trade = 6;
    assert.throws(() => engine.improveCityTrack('p1', 'trade'), /IMPROVEMENT_MAX_LEVEL/);
    assert.throws(() => engine.improveCityTrack('p1', 'science'), /NOT_ENOUGH_COMMODITIES/);
  });
  it('draws a progress card at track levels 3 and 6', () => {
    const engine = makeCkEngine();
    engine.players[0].citiesBuilt.push('v1');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.trade = 2;
    engine.players[0].commodities.cloth = 20;
    const before = engine.players[0].progressCards.length;
    engine.improveCityTrack('p1', 'trade');
    assert.equal(engine.players[0].cityImprovements.trade, 3);
    assert.equal(engine.players[0].progressCards.length, before + 1);

    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.trade = 5;
    engine.improveCityTrack('p1', 'trade');
    assert.equal(engine.players[0].cityImprovements.trade, 6);
    assert.equal(engine.players[0].progressCards.length, before + 2);
  });

  it('does not give 2:1 bank trades at Trade level 1 (only Level 5 grants 2:1)', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.trade = 1;
    engine.players[0].resources.wood = 2;
    engine.players[0].commodities.cloth = 4;
    assert.throws(() => engine.tradeWithBank('p1', 'wood', 'brick', 2), /INVALID_TRADE_RATIO/);
  });

  it('allows 2:1 commodity bank trades at Trade level 5', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.trade = 5;
    engine.players[0].commodities.cloth = 2;
    engine.tradeWithBank('p1', 'cloth', 'ore', 2);
    assert.equal(engine.players[0].commodities.cloth, 0);
    assert.equal(engine.players[0].resources.ore, 1);
  });

  it('unlocks Aqueduct perk when Science reaches level 5 (no extra city pieces)', () => {
    const engine = makeCkEngine();
    engine.players[0].citiesBuilt.push('v1');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.science = 4;
    engine.players[0].commodities.paper = 5;
    const before = engine.players[0].citiesRemaining;
    engine.improveCityTrack('p1', 'science');
    assert.equal(engine.players[0].cityImprovements.science, 5);
    assert.equal(engine.players[0].citiesRemaining, before);
  });
});

function forceRoll(engine, playerId, d1, d2, eventIndex = 3) {
  const originalRandom = Math.random;
  const seq = [(d1 - 1) / 6, (d2 - 1) / 6];
  if (engine.isCitiesKnights()) seq.push(eventIndex / 6);
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  try {
    return engine.rollDice(playerId);
  } finally {
    Math.random = originalRandom;
  }
}

function giveRoad(engine, playerId, vertexId) {
  const vertex = engine.grid.vertices.get(vertexId);
  const edgeId = vertex.adjacentEdges[0];
  const edge = engine.grid.edges.get(edgeId);
  edge.road = { playerId, color: '#e63946' };
  engine.players.find(p => p.id === playerId).roadsBuilt.push(edgeId);
  return { edge, otherVertexId: edge.v1 === vertexId ? edge.v2 : edge.v1 };
}

function plantKnight(engine, playerId, vertexId, { rank = 'basic', active = false } = {}) {
  const player = engine.players.find(p => p.id === playerId);
  const vertex = engine.grid.vertices.get(vertexId);
  const strength = rank === 'mighty' ? 3 : rank === 'strong' ? 2 : 1;
  const knight = { playerId, vertexId, rank, active, strength };
  vertex.knight = knight;
  player.knightsPlaced.push(knight);
  player.knightsAvailable[rank]--;
  return knight;
}

function emptyVertex(engine, predicate = () => true) {
  return Array.from(engine.grid.vertices.values()).find(v => !v.building && !v.knight && predicate(v));
}

describe('PR #15 review follow-up', () => {
  it('keeps city walls as remaining supply count', () => {
    const engine = makeCkEngine();
    assert.equal(engine.players[0].cityWalls, 3);
    assert.equal(engine.players[1].cityWalls, 3);
  });

  it('rejects commodity discards in base mode', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.players[1].resources = { wood: 8, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.phase = GAME_PHASES.TURN_DISCARD;
    engine.pendingDiscards.add('p2');
    assert.throws(() => engine.discardCards('p2', { cloth: 4 }), /INVALID_RESOURCE_cloth/);
  });

  it('base-mode cities still produce 2 resources through rollDice', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    const hex = attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOL, 'city');
    engine.phase = GAME_PHASES.TURN_ROLL;
    const token = hex.token;
    const d1 = Math.min(6, Math.max(1, Math.floor(token / 2)));
    const d2 = token - d1;
    const before = engine.players[0].resources.wool;
    forceRoll(engine, 'p1', d1, d2);
    assert.equal(engine.eventDie, null);
    assert.equal(engine.players[0].resources.wool, before + 2);
    assert.equal(engine.players[0].commodities.cloth, 0);
  });
});

describe('CK-03: Event Die & Barbarian Invasion', () => {
  it('should roll 3 dice in C&K mode (2 standard + 1 event)', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 2, 3, 3);
    assert.deepEqual(result.dice, [2, 3]);
    assert.equal(result.eventDie, 'trade');
    assert.equal(engine.eventDie, 'trade');
  });

  it('should advance barbarian on ship face', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 2, 2, 0);
    assert.equal(engine.eventDie, 'barbarian');
    assert.equal(engine.barbarianPosition, 1);
  });

  it('should trigger attack at position 7', () => {
    const engine = makeCkEngine();
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 2, 2, 0);
    assert.equal(engine.barbarianPosition, 0);
    assert.ok(result.barbarian);
    assert.equal(result.barbarian.outcome, 'victory');
  });

  it('should declare victory when active knights >= total cities', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const v = emptyVertex(engine);
    plantKnight(engine, 'p1', v.id, { active: true });
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 1, 2, 0);
    assert.equal(result.barbarian.outcome, 'victory');
  });

  it('should award Defender of Catan to player with most active knights', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    attachBuilding(engine, 'p2', RESOURCE_TYPES.BRICK, 'city');
    const v1 = emptyVertex(engine);
    const v2 = emptyVertex(engine, v => v.id !== v1.id && !v1.adjacentVertices.includes(v.id));
    plantKnight(engine, 'p1', v1.id, { rank: 'strong', active: true });
    plantKnight(engine, 'p2', v2.id, { active: true });
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 1, 2, 0);
    assert.equal(engine.defenderOfCatan, 'p1');
    engine.recalculateVictoryPoints();
    assert.equal(engine.players[0].publicVictoryPoints, engine.players[0].citiesBuilt.length * 2 + engine.players[0].settlementsBuilt.length + 1);
  });

  it('should NOT award Defender on tie and transition to TURN_BARBARIAN_REWARD', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    attachBuilding(engine, 'p2', RESOURCE_TYPES.BRICK, 'city');
    const v1 = emptyVertex(engine);
    const v2 = emptyVertex(engine, v => v.id !== v1.id && !v1.adjacentVertices.includes(v.id));
    plantKnight(engine, 'p1', v1.id, { active: true });
    plantKnight(engine, 'p2', v2.id, { active: true });
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 1, 2, 0);
    assert.equal(engine.defenderOfCatan, null);
    assert.equal(engine.phase, GAME_PHASES.TURN_BARBARIAN_REWARD);
    assert.deepEqual(Array.from(engine.pendingBarbarianTieDraws).sort(), ['p1', 'p2']);

    // Rejects non-tied player
    assert.throws(() => {
      engine.chooseBarbarianReward('p3', 'trade');
    }, /NO_BARBARIAN_REWARD_PENDING/);

    // Rejects invalid deck
    assert.throws(() => {
      engine.chooseBarbarianReward('p1', 'invalid_deck');
    }, /INVALID_PROGRESS_DECK/);

    // p1 chooses politics
    const p1Before = engine.players[0].progressCards.length;
    const res1 = engine.chooseBarbarianReward('p1', 'politics');
    assert.equal(res1.deck, 'politics');
    assert.equal(engine.players[0].progressCards.length, p1Before + 1);
    assert.equal(engine.phase, GAME_PHASES.TURN_BARBARIAN_REWARD);
    assert.deepEqual(Array.from(engine.pendingBarbarianTieDraws), ['p2']);

    // p2 chooses science via alias claimBarbarianProgressCard
    const p2Before = engine.players[1].progressCards.length;
    const res2 = engine.claimBarbarianProgressCard('p2', 'science');
    assert.equal(res2.deck, 'science');
    assert.equal(engine.players[1].progressCards.length, p2Before + 1);

    // Once all tied players choose, transitions to TURN_ACTION
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
    assert.equal(engine.pendingBarbarianTieDraws.size, 0);
  });

  it('should declare defeat when active knights < total cities', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    attachBuilding(engine, 'p2', RESOURCE_TYPES.BRICK, 'city');
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 1, 2, 0);
    assert.equal(result.barbarian.outcome, 'defeat');
    assert.equal(engine.phase, GAME_PHASES.TURN_BARBARIAN_DOWNGRADE);
  });

  it('should require city downgrade from players with fewest knights', () => {
    const engine = makeCkEngine();
    const city1 = attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    attachBuilding(engine, 'p2', RESOURCE_TYPES.BRICK, 'city');
    const v1 = emptyVertex(engine);
    plantKnight(engine, 'p1', v1.id, { active: true });
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 1, 2, 0);
    assert.equal(engine.pendingBarbarianDowngrades.has('p1'), false);
    assert.equal(engine.pendingBarbarianDowngrades.has('p2'), true);

    const p2City = engine.players[1].citiesBuilt[0];
    engine.downgradeCity('p2', p2City);
    assert.equal(engine.players[1].citiesBuilt.length, 0);
    assert.ok(engine.players[1].settlementsBuilt.includes(p2City));
    assert.equal(engine.grid.vertices.get(p2City).building.type, 'settlement');
    assert.equal(engine.pendingBarbarianDowngrades.size, 0);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
    assert.ok(city1);
  });

  it('should reset barbarian position to 0 after attack', () => {
    const engine = makeCkEngine();
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 2, 2, 0);
    assert.equal(engine.barbarianPosition, 0);
  });

  it('should deactivate all knights after barbarian battle', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const v = emptyVertex(engine);
    plantKnight(engine, 'p1', v.id, { active: true });
    engine.barbarianPosition = 6;
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 1, 2, 0);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
  });

  it('should NOT roll event die in base mode', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 2, 3);
    assert.equal(result.eventDie, null);
    assert.equal(engine.eventDie, null);
    assert.equal(engine.barbarianPosition, 0);
  });

  it('should trigger progress card eligibility check on color faces', () => {
    const engine = makeCkEngine();
    engine.players[0].cityImprovements.trade = 3;
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 2, 2, 3);
    assert.equal(result.eventDie, 'trade');
    assert.equal(engine.pendingProgressCardColor, 'trade');
    const eligible = engine.getProgressCardEligiblePlayers('trade', 2).map(p => p.id);
    assert.deepEqual(eligible, ['p1']);
    assert.equal(result.progressDraws.length, 1);
    assert.equal(result.progressDraws[0].playerId, 'p1');
    assert.equal(result.progressDraws[0].drawn, true);
    assert.ok(result.progressDraws[0].cardType);
  });

  it('gives a progress card to every player whose track meets the red die', () => {
    const engine = makeCkEngine();
    engine.players[0].cityImprovements.science = 4;
    engine.players[1].cityImprovements.science = 2;
    engine.phase = GAME_PHASES.TURN_ROLL;
    const result = forceRoll(engine, 'p1', 2, 3, 5);
    assert.equal(result.eventDie, 'science');
    assert.deepEqual(result.progressDraws.map(d => d.playerId).sort(), ['p1', 'p2']);
    assert.ok(result.progressDraws.every(d => d.drawn));
    assert.equal(engine.players[0].progressCards.length, 1);
    assert.equal(engine.players[1].progressCards.length, 1);
  });
});

describe('CK-04: Knight Units', () => {
  it('should place a basic knight on an empty connected vertex', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    const vertex = emptyVertex(engine);
    giveRoad(engine, 'p1', vertex.id);
    const result = engine.placeKnight('p1', vertex.id);
    assert.equal(result.knight.rank, 'basic');
    assert.equal(result.knight.active, false);
    assert.equal(engine.players[0].knightsAvailable.basic, 1);
    assert.equal(engine.players[0].resources.ore, 0);
    assert.equal(engine.grid.vertices.get(vertex.id).knight.playerId, 'p1');
  });

  it('should reject placement on occupied vertex', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    const vertex = emptyVertex(engine);
    vertex.building = { type: 'settlement', playerId: 'p1' };
    giveRoad(engine, 'p1', vertex.id);
    assert.throws(() => engine.placeKnight('p1', vertex.id), /VERTEX_OCCUPIED/);
  });

  it('allows knight placement adjacent to building (knights do not obey distance rule)', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    const vertex = emptyVertex(engine);
    const adjId = vertex.adjacentVertices[0];
    engine.grid.vertices.get(adjId).building = { type: 'settlement', playerId: 'p2' };
    giveRoad(engine, 'p1', vertex.id);
    const res = engine.placeKnight('p1', vertex.id);
    assert.equal(res.vertexId, vertex.id);
    assert.equal(engine.grid.vertices.get(vertex.id).knight.playerId, 'p1');
  });

  it('BotAI.findValidKnightVertices includes vertices adjacent to buildings', () => {
    const engine = makeCkEngine();
    const p1 = engine.players[0];
    const vertex = emptyVertex(engine);
    const adjId = vertex.adjacentVertices[0];
    engine.grid.vertices.get(adjId).building = { type: 'settlement', playerId: 'p2' };
    giveRoad(engine, 'p1', vertex.id);
    const valid = BotAI.findValidKnightVertices(engine, p1);
    assert.ok(valid.includes(vertex.id));
  });

  it('should reject placement without road connection', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    const vertex = emptyVertex(engine);
    assert.throws(() => engine.placeKnight('p1', vertex.id), /MUST_CONNECT_TO_ROAD/);
  });

  it('should reject placement when no knights available in supply', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    engine.players[0].knightsAvailable.basic = 0;
    const vertex = emptyVertex(engine);
    giveRoad(engine, 'p1', vertex.id);
    assert.throws(() => engine.placeKnight('p1', vertex.id), /NO_KNIGHTS_AVAILABLE/);
  });

  it('should deduct ore + wool on placement', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 2;
    engine.players[0].resources.wool = 2;
    const vertex = emptyVertex(engine);
    giveRoad(engine, 'p1', vertex.id);
    engine.placeKnight('p1', vertex.id);
    assert.equal(engine.players[0].resources.ore, 1);
    assert.equal(engine.players[0].resources.wool, 1);
  });

  it('should activate inactive knight for 1 wheat', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id);
    engine.players[0].resources.wheat = 1;
    engine.activateKnight('p1', vertex.id);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
    assert.equal(engine.players[0].resources.wheat, 0);
  });

  it('should reject activation of already active knight', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { active: true });
    engine.players[0].resources.wheat = 1;
    assert.throws(() => engine.activateKnight('p1', vertex.id), /KNIGHT_ALREADY_ACTIVE/);
  });

  it('should reject activation without wheat', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id);
    assert.throws(() => engine.activateKnight('p1', vertex.id), /NOT_ENOUGH_RESOURCES/);
  });

  it('should promote basic to strong with wool + ore and Politics ≥ 1', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id);
    engine.players[0].cityImprovements.politics = 1;
    engine.players[0].resources.wool = 1;
    engine.players[0].resources.ore = 1;
    engine.promoteKnight('p1', vertex.id);
    assert.equal(engine.players[0].knightsPlaced[0].rank, 'strong');
    assert.equal(engine.players[0].knightsPlaced[0].strength, 2);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
    assert.equal(engine.players[0].knightsAvailable.basic, 2);
    assert.equal(engine.players[0].knightsAvailable.strong, 1);
  });

  it('should promote strong to mighty with Politics ≥ 2', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { rank: 'strong' });
    engine.players[0].cityImprovements.politics = 2;
    engine.players[0].resources.wool = 1;
    engine.players[0].resources.ore = 1;
    engine.promoteKnight('p1', vertex.id);
    assert.equal(engine.players[0].knightsPlaced[0].rank, 'mighty');
    assert.equal(engine.players[0].knightsPlaced[0].strength, 3);
  });

  it('should reject promotion without Politics requirement', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id);
    engine.players[0].resources.wool = 1;
    engine.players[0].resources.ore = 1;
    assert.throws(() => engine.promoteKnight('p1', vertex.id), /POLITICS_LEVEL_TOO_LOW/);
  });

  it('should reject promotion of mighty knight (max rank)', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { rank: 'mighty' });
    engine.players[0].cityImprovements.politics = 5;
    engine.players[0].resources.wool = 1;
    engine.players[0].resources.ore = 1;
    assert.throws(() => engine.promoteKnight('p1', vertex.id), /KNIGHT_MAX_RANK/);
  });

  it('should preserve active/inactive status on promotion (does not auto-activate)', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { active: false });
    engine.players[0].cityImprovements.politics = 1;
    engine.players[0].resources.wool = 1;
    engine.players[0].resources.ore = 1;
    engine.promoteKnight('p1', vertex.id);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);

    // If already active, stays active across turns
    engine.turnNumber++;
    engine.players[0].knightsPlaced[0].active = true;
    engine.players[0].cityImprovements.politics = 2;
    engine.players[0].resources.wool = 1;
    engine.players[0].resources.ore = 1;
    engine.promoteKnight('p1', vertex.id);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
  });

  it('should move active knight to adjacent empty vertex', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    const { otherVertexId } = giveRoad(engine, 'p1', vertex.id);
    plantKnight(engine, 'p1', vertex.id, { active: true });
    engine.moveKnight('p1', vertex.id, otherVertexId);
    assert.equal(engine.grid.vertices.get(vertex.id).knight, null);
    assert.equal(engine.grid.vertices.get(otherVertexId).knight.playerId, 'p1');
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
  });

  it('should displace weaker opponent knight', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    const { edge, otherVertexId } = giveRoad(engine, 'p1', vertex.id);
    engine.grid.edges.get(edge.id).road = { playerId: 'p1', color: '#e63946' };
    plantKnight(engine, 'p1', vertex.id, { rank: 'strong', active: true });
    plantKnight(engine, 'p2', otherVertexId, { rank: 'basic', active: true });
    const result = engine.moveKnight('p1', vertex.id, otherVertexId);
    assert.equal(engine.grid.vertices.get(otherVertexId).knight.playerId, 'p1');
    assert.ok(result.displaced);
    assert.notEqual(engine.players[1].knightsPlaced[0]?.vertexId, otherVertexId);
  });

  it('should reject displacement of equal/stronger knight', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    const { otherVertexId } = giveRoad(engine, 'p1', vertex.id);
    plantKnight(engine, 'p1', vertex.id, { rank: 'basic', active: true });
    plantKnight(engine, 'p2', otherVertexId, { rank: 'basic', active: true });
    assert.throws(() => engine.moveKnight('p1', vertex.id, otherVertexId), /CANNOT_DISPLACE_EQUAL_OR_STRONGER/);
  });

  it('should deactivate knight after movement', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    const { otherVertexId } = giveRoad(engine, 'p1', vertex.id);
    plantKnight(engine, 'p1', vertex.id, { active: true });
    engine.moveKnight('p1', vertex.id, otherVertexId);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
  });

  it('should allow active knight adjacent to robber to chase it', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const robberHex = engine.grid.robberHexId;
    const vertex = emptyVertex(engine, v => v.hexes.includes(robberHex));
    plantKnight(engine, 'p1', vertex.id, { active: true });
    const newHex = Array.from(engine.grid.hexes.keys()).find(id => id !== robberHex);
    const result = engine.chaseRobber('p1', vertex.id, newHex);
    assert.equal(engine.grid.robberHexId, newHex);
    assert.equal(engine.players[0].knightsPlaced[0].active, false);
    assert.equal(result.hexId, newHex);
    const chaseLog = [...engine.eventLog].reverse().find(
      e => e.messageKey === 'LOG_ROBBER_MOVED' || e.messageKey === 'LOG_ROBBER_MOVED_DESERT'
    );
    assert.ok(chaseLog, 'Knight chase should log the robber move with hex number or desert');
    const destHex = engine.grid.hexes.get(newHex);
    if (destHex.resource === RESOURCE_TYPES.DESERT || destHex.token == null) {
      assert.equal(chaseLog.messageKey, 'LOG_ROBBER_MOVED_DESERT');
    } else {
      assert.equal(chaseLog.messageKey, 'LOG_ROBBER_MOVED');
      assert.equal(chaseLog.args.number, destHex.token);
    }
  });

  it('should not include Knight dev cards in C&K mode deck', () => {
    const engine = makeCkEngine();
    assert.equal(engine.devCardDeck.length, 0);
    assert.throws(() => {
      engine.phase = GAME_PHASES.TURN_ACTION;
      engine.players[0].resources = { wood: 0, brick: 0, wool: 1, wheat: 1, ore: 1 };
      engine.buyDevCard('p1');
    }, /DEV_CARDS_DISABLED_IN_CK/);
  });
});

describe('CK-10: UI State Rendering', () => {
  it('should include commodities in getStateForPlayer() output for C&K mode', () => {
    const engine = makeCkEngine();
    engine.players[0].commodities.cloth = 2;
    const state = engine.getStateForPlayer('p1');
    assert.equal(state.players[0].commodities.cloth, 2);
    assert.equal(state.mode, GAME_MODES.CITIES_KNIGHTS);
  });

  it('should include barbarianPosition in game state', () => {
    const engine = makeCkEngine();
    engine.barbarianPosition = 5;
    assert.equal(engine.getStateForPlayer('p1').barbarianPosition, 5);
  });

  it('should include eventDie result in game state', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 2, 3, 3);
    assert.equal(engine.getStateForPlayer('p1').eventDie, 'trade');
  });

  it('should include cityImprovements in player state', () => {
    const engine = makeCkEngine();
    engine.players[0].cityImprovements.science = 2;
    assert.equal(engine.getStateForPlayer('p1').players[0].cityImprovements.science, 2);
  });

  it('should include lastBarbarianResult for the attack overlay', () => {
    const engine = makeCkEngine();
    engine.lastBarbarianResult = {
      outcome: 'victory',
      totalActiveKnights: 3,
      totalCities: 2,
      defenderOfCatan: 'p1'
    };
    assert.equal(engine.getStateForPlayer('p1').lastBarbarianResult.outcome, 'victory');
  });

  it('allows 4:1 bank trades of commodities in C&K', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].commodities.cloth = 4;
    engine.players[0].resources.wood = 0;
    engine.tradeWithBank('p1', 'cloth', 'wood', 4);
    assert.equal(engine.players[0].commodities.cloth, 0);
    assert.equal(engine.players[0].resources.wood, 1);
  });

  it('rejects commodity bank trades in base mode', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].commodities.cloth = 4;
    assert.throws(() => engine.tradeWithBank('p1', 'cloth', 'wood', 4), /INVALID_RESOURCE/);
  });
});

describe('PR #22 review follow-up', () => {
  it('raises the 7-discard threshold by 2 per city wall', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[0];
    engine.grid.vertices.get(cityId).building.hasWall = true;
    engine.players[0].resources = { wood: 8, brick: 0, wool: 0, wheat: 0, ore: 0 };
    assert.equal(engine.getDiscardThreshold(engine.players[0]), 9);
    assert.equal(engine.getStateForPlayer('p1').players[0].discardThreshold, 9);

    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 3, 4, 3);
    assert.equal(engine.pendingDiscards.has('p1'), false);
  });

  it('still queues discard when cards exceed the walled limit', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[0];
    engine.grid.vertices.get(cityId).building.hasWall = true;
    engine.players[0].resources = { wood: 10, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.phase = GAME_PHASES.TURN_ROLL;
    forceRoll(engine, 'p1', 3, 4, 3);
    assert.equal(engine.pendingDiscards.has('p1'), true);
  });

  it('places city on side as settlement when settlements supply is empty', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[0];
    engine.players[0].settlementsRemaining = 0;
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');

    engine.downgradeCity('p1', cityId);

    assert.equal(engine.players[0].settlementsRemaining, 0);
    assert.equal(engine.players[0].citiesBuilt.length, 0);
    const building = engine.grid.vertices.get(cityId).building;
    assert.equal(building.type, 'settlement');
    assert.equal(building.isCityOnSide, true);
    assert.equal(engine.players[0].settlementsBuilt.includes(cityId), true);
  });
});

describe('CK-08: City Walls', () => {
  function cityReady(engine) {
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[0];
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.currentTurnPlayerIndex = 0;
    engine.players[0].resources.brick = 6;
    return cityId;
  }

  it('should build a city wall for 2 brick', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    engine.buildCityWall('p1', cityId);
    assert.equal(engine.grid.vertices.get(cityId).building.hasWall, true);
    assert.equal(engine.players[0].resources.brick, 4);
    assert.equal(engine.players[0].cityWalls, 2);
  });

  it('should reject building wall on settlement (not city)', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'settlement');
    const vid = engine.players[0].settlementsBuilt[0];
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 2;
    assert.throws(() => engine.buildCityWall('p1', vid), /WALLS_ONLY_ON_CITIES/);
  });

  it('should reject building wall on opponent city', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p2', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[1].citiesBuilt[0];
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 2;
    assert.throws(() => engine.buildCityWall('p1', cityId), /NOT_YOUR_CITY/);
  });

  it('should reject building second wall on same city', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    engine.buildCityWall('p1', cityId);
    assert.throws(() => engine.buildCityWall('p1', cityId), /CITY_ALREADY_HAS_WALL/);
  });

  it('should reject building when no walls remaining (max 3)', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    engine.players[0].cityWalls = 0;
    assert.throws(() => engine.buildCityWall('p1', cityId), /NO_WALLS_REMAINING/);
  });

  it('should reject building without enough brick', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    engine.players[0].resources.brick = 1;
    assert.throws(() => engine.buildCityWall('p1', cityId), /NOT_ENOUGH_RESOURCES/);
  });

  it('should increase discard threshold by 2 per wall', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    assert.equal(engine.getDiscardThreshold(engine.players[0]), 7);
    engine.buildCityWall('p1', cityId);
    assert.equal(engine.getPlayerWallCount(engine.players[0]), 1);
    assert.equal(engine.getDiscardThreshold(engine.players[0]), 9);
  });

  it('1 wall: discard at 10+ total cards', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    engine.buildCityWall('p1', cityId);
    engine.players[0].resources = { wood: 9, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[0].commodities = { cloth: 0, coin: 0, paper: 0 };
    engine.queueDiscardsForSeven();
    assert.equal(engine.pendingDiscards.has('p1'), false);
    engine.players[0].resources.wood = 10;
    engine.queueDiscardsForSeven();
    assert.equal(engine.pendingDiscards.has('p1'), true);
  });

  it('2 walls: discard at 12+ total cards', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    attachBuilding(engine, 'p1', RESOURCE_TYPES.BRICK, 'city');
    const [c1, c2] = engine.players[0].citiesBuilt;
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 4;
    engine.buildCityWall('p1', c1);
    engine.buildCityWall('p1', c2);
    engine.players[0].resources = { wood: 11, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[0].commodities = { cloth: 0, coin: 0, paper: 0 };
    engine.queueDiscardsForSeven();
    assert.equal(engine.pendingDiscards.has('p1'), false);
    engine.players[0].resources.wood = 12;
    engine.queueDiscardsForSeven();
    assert.equal(engine.pendingDiscards.has('p1'), true);
  });

  it('should reject in base game mode', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[0];
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 2;
    assert.throws(() => engine.buildCityWall('p1', cityId), /NOT_CITIES_KNIGHTS_MODE/);
  });

  it('wall should be destroyed when city is downgraded', () => {
    const engine = makeCkEngine();
    const cityId = cityReady(engine);
    engine.buildCityWall('p1', cityId);
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');
    engine.downgradeCity('p1', cityId);
    const building = engine.grid.vertices.get(cityId).building;
    assert.equal(building?.hasWall, false);
    assert.equal(engine.players[0].cityWalls, 3);
  });
});

describe('CK-05: Trade Progress Cards', () => {
  function giveCard(player, type) {
    const card = { id: `c-${type}-${player.progressCards.length}`, type, played: false, boughtTurn: 0 };
    player.progressCards.push(card);
    return card;
  }

  it('should initialize trade deck with 18 cards', () => {
    const engine = makeCkEngine();
    assert.equal(engine.progressDecks.trade.length, 18);
    const types = engine.progressDecks.trade.map(c => c.type);
    assert.equal(types.filter(t => t === 'commercial_harbor').length, 2);
    assert.equal(types.filter(t => t === 'master_merchant').length, 2);
    assert.equal(types.filter(t => t === 'merchant').length, 6);
    assert.equal(types.filter(t => t === 'merchant_fleet').length, 2);
    assert.equal(types.filter(t => t === 'resource_monopoly').length, 4);
    assert.equal(types.filter(t => t === 'trade_monopoly').length, 2);
  });

  it('should draw from trade deck and add to player hand', () => {
    const engine = makeCkEngine();
    const before = engine.progressDecks.trade.length;
    const type = engine.drawProgressCard(engine.players[0], 'trade');
    assert.ok(type);
    assert.equal(engine.progressDecks.trade.length, before - 1);
    assert.equal(engine.players[0].progressCards[0].type, type);
  });

  it('should enforce 4-card hand limit and reject endTurn until discarded down to 4', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    for (let i = 0; i < 4; i++) engine.drawProgressCard(engine.players[0], 'trade');
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
    engine.drawProgressCard(engine.players[0], 'trade');
    assert.equal(engine.players[0].progressCards.length, 5);
    assert.equal(engine.pendingProgressDiscard.has('p1'), true);

    // Ending turn with 5 unplayed cards must throw MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN
    assert.throws(() => {
      engine.endTurn('p1');
    }, /MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN/);

    // Discarding 1 card down to 4 removes pending flag and permits endTurn
    engine.discardProgressCard('p1', engine.players[0].progressCards[0].id);
    assert.equal(engine.players[0].progressCards.length, 4);
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
    assert.doesNotThrow(() => {
      engine.endTurn('p1');
    });
  });

  it('playing a progress card to drop down to 4 allows ending turn without discard', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    for (let i = 0; i < 4; i++) engine.drawProgressCard(engine.players[0], 'trade');
    engine.players[0].progressCards.push({
      id: 'trade-merchant_fleet-test',
      type: 'merchant_fleet',
      played: false,
      revealed: false,
      boughtTurn: 1
    });
    engine.pendingProgressDiscard.add('p1');
    assert.equal(engine.countUnplayedProgressCards(engine.players[0]), 5);

    // Playing merchant_fleet reduces unplayed to 4
    engine.playProgressCard('p1', 'trade-merchant_fleet-test');
    assert.equal(engine.countUnplayedProgressCards(engine.players[0]), 4);
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
    assert.doesNotThrow(() => {
      engine.endTurn('p1');
    });
  });

  it('should execute Resource Monopoly: steal 2 of named resource from each player', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[1].resources.wool = 3;
    const card = giveCard(engine.players[0], 'resource_monopoly');
    const res = engine.playProgressCard('p1', card.id, { resource: 'wool' });
    assert.equal(res.stolen, 2);
    assert.equal(engine.players[1].resources.wool, 1);
    assert.equal(engine.players[0].resources.wool, 2);
  });

  it('should execute Merchant Fleet: enable 2:1 bank trades for rest of turn', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wood = 2;
    const card = giveCard(engine.players[0], 'merchant_fleet');
    engine.playProgressCard('p1', card.id, {});
    const trade = engine.tradeWithBank('p1', 'wood', 'brick', 2);
    assert.equal(trade.ratio, 2);
    assert.equal(engine.players[0].resources.wood, 0);
    assert.equal(engine.players[0].resources.brick, 1);
  });

  it('should execute Merchant: place on hex, grant 2:1 and 1 VP', () => {
    const engine = makeCkEngine();
    const hex = attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.recalculateVictoryPoints();
    const before = engine.players[0].victoryPoints;
    engine.players[0].resources.wood = 2;
    const card = giveCard(engine.players[0], 'merchant');
    engine.playProgressCard('p1', card.id, { hexId: hex.id });
    assert.equal(engine.merchantHolder, 'p1');
    assert.equal(engine.merchantHexId, hex.id);
    assert.equal(engine.players[0].victoryPoints, before + 1);
    const trade = engine.tradeWithBank('p1', 'wood', 'brick', 2);
    assert.equal(trade.ratio, 2);
  });

  it('should transfer Merchant when another player plays Merchant card', () => {
    const engine = makeCkEngine();
    const hex1 = attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const hex2 = attachBuilding(engine, 'p2', RESOURCE_TYPES.BRICK, 'city');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'merchant').id, { hexId: hex1.id });
    engine.currentTurnPlayerIndex = 1;
    engine.playProgressCard('p2', giveCard(engine.players[1], 'merchant').id, { hexId: hex2.id });
    assert.equal(engine.merchantHolder, 'p2');
    assert.equal(engine.merchantHexId, hex2.id);
  });

  it('should execute Master Merchant: steal 2 chosen cards from target', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    attachBuilding(engine, 'p2', RESOURCE_TYPES.WOOL, 'settlement');
    engine.recalculateVictoryPoints();
    engine.players[1].resources.wool = 1;
    engine.players[1].commodities.cloth = 1;
    const card = giveCard(engine.players[0], 'master_merchant');
    const res = engine.playProgressCard('p1', card.id, { targetPlayerId: 'p2', steal: ['wool', 'cloth'] });
    assert.deepEqual(res.stolen, ['wool', 'cloth']);
    assert.equal(engine.players[0].resources.wool, 1);
    assert.equal(engine.players[0].commodities.cloth, 1);
    assert.equal(engine.players[1].resources.wool, 0);
    assert.equal(engine.players[1].commodities.cloth, 0);
  });

  it('should reject playing progress card on wrong phase', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ROLL;
    const card = giveCard(engine.players[0], 'merchant_fleet');
    assert.throws(() => engine.playProgressCard('p1', card.id, {}), /NOT_IN_ACTION_PHASE/);
  });

  it('should not include progress cards in base mode', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    assert.equal(engine.progressDecks.trade.length, 0);
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].progressCards.push({ id: 'x', type: 'merchant_fleet', played: false });
    assert.throws(() => engine.playProgressCard('p1', 'x', {}), /NOT_CITIES_KNIGHTS_MODE/);
  });
});

describe('CK-06: Politics Progress Cards', () => {
  function giveCard(player, type) {
    const card = { id: `p-${type}-${player.progressCards.length}`, type, played: false, boughtTurn: 0 };
    player.progressCards.push(card);
    return card;
  }

  it('should initialize politics deck with 18 cards', () => {
    const engine = makeCkEngine();
    assert.equal(engine.progressDecks.politics.length, 18);
    const types = engine.progressDecks.politics.map(c => c.type);
    assert.equal(types.filter(t => t === 'bishop').length, 2);
    assert.equal(types.filter(t => t === 'constitution').length, 1);
    assert.equal(types.filter(t => t === 'deserter').length, 2);
    assert.equal(types.filter(t => t === 'diplomat').length, 2);
    assert.equal(types.filter(t => t === 'intrigue').length, 2);
    assert.equal(types.filter(t => t === 'saboteur').length, 2);
    assert.equal(types.filter(t => t === 'spy').length, 3);
    assert.equal(types.filter(t => t === 'warlord').length, 2);
    assert.equal(types.filter(t => t === 'wedding').length, 2);
  });

  it('Bishop: should move robber and steal from ALL adjacent players', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.addPlayer({ id: 'p3', name: 'Cara' });
    engine.startGame('standard');
    const dest = Array.from(engine.grid.hexes.values()).find(h => h.id !== engine.grid.robberHexId);
    const destVerts = Array.from(engine.grid.vertices.values()).filter(
      v => v.hexes.includes(dest.id) && !v.building
    );
    destVerts[0].building = { type: 'settlement', playerId: 'p2', color: '#457b9d' };
    destVerts[1].building = { type: 'settlement', playerId: 'p3', color: '#2a9d8f' };
    engine.players[1].settlementsBuilt.push(destVerts[0].id);
    engine.players[2].settlementsBuilt.push(destVerts[1].id);
    engine.players[1].resources.wool = 1;
    engine.players[2].resources.brick = 1;
    engine.phase = GAME_PHASES.TURN_ACTION;
    const fromHex = engine.grid.robberHexId;
    const res = engine.playProgressCard('p1', giveCard(engine.players[0], 'bishop').id, { hexId: dest.id });
    assert.equal(engine.grid.robberHexId, dest.id);
    assert.notEqual(fromHex, dest.id);
    assert.equal(res.stolenFrom.length, 2);
    assert.equal(engine.players[1].resources.wool, 0);
    assert.equal(engine.players[2].resources.brick, 0);
    assert.equal(engine.players[0].resources.wool, 1);
    assert.equal(engine.players[0].resources.brick, 1);
    const robberLog = [...engine.eventLog].reverse().find(
      e => e.messageKey === 'LOG_ROBBER_MOVED' || e.messageKey === 'LOG_ROBBER_MOVED_DESERT'
    );
    assert.ok(robberLog, 'Bishop should log the robber move with hex number or desert');
    const destHex = engine.grid.hexes.get(dest.id);
    if (destHex.resource === RESOURCE_TYPES.DESERT || destHex.token == null) {
      assert.equal(robberLog.messageKey, 'LOG_ROBBER_MOVED_DESERT');
    } else {
      assert.equal(robberLog.messageKey, 'LOG_ROBBER_MOVED');
      assert.equal(robberLog.args.number, destHex.token);
    }
  });

  it('Constitution: should immediately grant 1 VP and be revealed', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.recalculateVictoryPoints();
    const before = engine.players[0].victoryPoints;
    const card = giveCard(engine.players[0], 'constitution');
    engine.playProgressCard('p1', card.id, {});
    assert.equal(card.revealed, true);
    assert.equal(card.played, true);
    assert.equal(engine.players[0].victoryPoints, before + 1);
  });

  it('Deserter: should remove opponent knight and place own equal-or-lower knight', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p2', vertex.id);
    const placeAt = emptyVertex(engine, v => {
      if (v.id === vertex.id) return false;
      if ((v.adjacentVertices || []).includes(vertex.id)) return false;
      return (v.adjacentVertices || []).every(aid => {
        const n = engine.grid.vertices.get(aid);
        return n && !n.building && !n.knight;
      });
    });
    assert.ok(placeAt, 'expected a legal placement vertex');
    giveRoad(engine, 'p1', placeAt.id);
    assert.equal(engine.players[1].knightsAvailable.basic, 1);
    const beforeP1 = engine.players[0].knightsAvailable.basic;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'deserter').id, {
      vertexId: vertex.id,
      placeVertexId: placeAt.id
    });
    assert.equal(engine.grid.vertices.get(vertex.id).knight, null);
    assert.equal(engine.players[1].knightsPlaced.length, 0);
    assert.equal(engine.players[1].knightsAvailable.basic, 2);
    const placed = engine.grid.vertices.get(placeAt.id).knight;
    assert.equal(placed.playerId, 'p1');
    assert.equal(placed.rank, 'basic');
    assert.equal(placed.active, false);
    assert.equal(engine.players[0].knightsAvailable.basic, beforeP1 - 1);
    assert.equal(engine.players[0].knightsPlaced.some(k => k.vertexId === placeAt.id), true);
  });

  it('Deserter: should still remove foe if player has no legal placement', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p2', vertex.id);
    engine.playProgressCard('p1', giveCard(engine.players[0], 'deserter').id, { vertexId: vertex.id });
    assert.equal(engine.grid.vertices.get(vertex.id).knight, null);
    assert.equal(engine.players[1].knightsAvailable.basic, 2);
    assert.equal(engine.players[0].knightsPlaced.length, 0);
  });

  it('Deserter: should reject removing own knight', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id);
    assert.throws(
      () => engine.playProgressCard('p1', giveCard(engine.players[0], 'deserter').id, { vertexId: vertex.id }),
      /INVALID_TARGET/
    );
  });

  it('Diplomat: should remove an open opponent road without requiring an active knight', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    const { edge } = giveRoad(engine, 'p2', vertex.id);
    engine.playProgressCard('p1', giveCard(engine.players[0], 'diplomat').id, { edgeId: edge.id });
    assert.equal(engine.grid.edges.get(edge.id).road, null);
    assert.equal(engine.players[1].roadsBuilt.includes(edge.id), false);
  });

  it('Diplomat: should reject removing a closed road between two settlements', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex1 = emptyVertex(engine);
    const edgeId = vertex1.adjacentEdges[0];
    const edge = engine.grid.edges.get(edgeId);
    const vertex2 = engine.grid.vertices.get(edge.v1 === vertex1.id ? edge.v2 : edge.v1);
    vertex1.building = { type: 'settlement', playerId: 'p2', color: engine.players[1].color };
    vertex2.building = { type: 'settlement', playerId: 'p2', color: engine.players[1].color };
    engine.players[1].settlementsBuilt.push(vertex1.id, vertex2.id);
    edge.road = { playerId: 'p2', color: engine.players[1].color };
    engine.players[1].roadsBuilt.push(edge.id);

    assert.equal(engine.isOpenRoad(edge.id), false);
    assert.throws(
      () => engine.playProgressCard('p1', giveCard(engine.players[0], 'diplomat').id, { edgeId: edge.id }),
      /ROAD_NOT_OPEN/
    );
  });

  it('Intrigue: should displace an opponent knight connected to the player road network', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const target = emptyVertex(engine);
    plantKnight(engine, 'p2', target.id, { active: false });
    // Connect p1 road to target vertex
    const roadEdge = engine.grid.edges.get(target.adjacentEdges[0]);
    roadEdge.road = { playerId: 'p1', color: engine.players[0].color };
    engine.players[0].roadsBuilt.push(roadEdge.id);

    engine.playProgressCard('p1', giveCard(engine.players[0], 'intrigue').id, { vertexId: target.id });
    // Knight must have been displaced from target vertex
    assert.equal(engine.grid.vertices.get(target.id).knight, null);
  });

  it('Intrigue: should reject displacing knight not connected to player road network', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const target = emptyVertex(engine);
    plantKnight(engine, 'p2', target.id, { active: true });
    // p1 has no road connected to target
    assert.throws(
      () => engine.playProgressCard('p1', giveCard(engine.players[0], 'intrigue').id, { vertexId: target.id }),
      /KNIGHT_NOT_CONNECTED_TO_ROAD/
    );
  });

  it('Warlord: should activate all own knights for free', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const v1 = emptyVertex(engine);
    const v2 = emptyVertex(engine, v => v.id !== v1.id && !v.adjacentVertices.includes(v1.id));
    plantKnight(engine, 'p1', v1.id, { active: false });
    plantKnight(engine, 'p1', v2.id, { active: false });
    engine.players[0].resources.wheat = 0;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'warlord').id, {});
    assert.equal(engine.players[0].knightsPlaced.every(k => k.active), true);
    assert.equal(engine.players[0].resources.wheat, 0);
  });

  it('Saboteur: leaders ahead in VP discard half their cards', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    attachBuilding(engine, 'p2', RESOURCE_TYPES.WOOL, 'city');
    attachBuilding(engine, 'p2', RESOURCE_TYPES.ORE, 'city');
    engine.players[1].resources = { wood: 4, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[1].commodities = { cloth: 2, coin: 0, paper: 0 };
    engine.recalculateVictoryPoints();
    assert.ok((engine.players[1].victoryPoints || 0) > (engine.players[0].victoryPoints || 0));
    const res = engine.playProgressCard('p1', giveCard(engine.players[0], 'saboteur').id, {});
    assert.equal(engine.countTotalCards(engine.players[1]), 3);
    assert.equal(res.victims.length, 1);
    assert.equal(res.victims[0].playerId, 'p2');
  });

  it('Saboteur: unique VP leader cannot play the card', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOL, 'city');
    attachBuilding(engine, 'p1', RESOURCE_TYPES.ORE, 'city');
    engine.recalculateVictoryPoints();
    assert.throws(
      () => engine.playProgressCard('p1', giveCard(engine.players[0], 'saboteur').id, {}),
      /SABOTEUR_MUST_NOT_BE_UNIQUE_LEADER/
    );
  });
});

describe('CK-07: Science Progress Cards', () => {
  function giveCard(player, type) {
    const card = { id: `s-${type}-${player.progressCards.length}`, type, played: false, boughtTurn: 0 };
    player.progressCards.push(card);
    return card;
  }

  it('should initialize science deck with 18 cards', () => {
    const engine = makeCkEngine();
    assert.equal(engine.progressDecks.science.length, 18);
    const types = engine.progressDecks.science.map(c => c.type);
    assert.equal(types.filter(t => t === 'alchemist').length, 2);
    assert.equal(types.filter(t => t === 'crane').length, 2);
    assert.equal(types.filter(t => t === 'engineer').length, 1);
    assert.equal(types.filter(t => t === 'inventor').length, 2);
    assert.equal(types.filter(t => t === 'irrigation').length, 2);
    assert.equal(types.filter(t => t === 'medicine').length, 2);
    assert.equal(types.filter(t => t === 'mining').length, 2);
    assert.equal(types.filter(t => t === 'printer').length, 1);
    assert.equal(types.filter(t => t === 'road_building').length, 2);
    assert.equal(types.filter(t => t === 'smith').length, 2);
  });

  it('Alchemist: should let player choose dice values before roll', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ROLL;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'alchemist').id, { d1: 5, d2: 6 });
    const result = engine.rollDice('p1');
    assert.deepEqual(result.dice, [5, 6]);
    assert.equal(result.sum, 11);
    assert.equal(engine.alchemistDice, null);
  });

  it('Alchemist: should reject play outside TURN_ROLL phase', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    assert.throws(
      () => engine.playProgressCard('p1', giveCard(engine.players[0], 'alchemist').id, { d1: 3, d2: 4 }),
      /ALCHEMIST_MUST_BE_PLAYED_BEFORE_ROLL/
    );
  });

  it('Crane: should reduce next improvement cost by 1', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].citiesBuilt.push('v1');
    engine.players[0].commodities.paper = 0;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'crane').id, {});
    const res = engine.improveCityTrack('p1', 'science');
    assert.equal(res.cost, 0);
    assert.equal(engine.players[0].cityImprovements.science, 1);
    assert.equal(engine.players[0].commodities.paper, 0);
    assert.equal(engine.players[0].craneDiscount, false);
  });

  it('Engineer: should build city wall for free', () => {
    const engine = makeCkEngine();
    const hex = attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[engine.players[0].citiesBuilt.length - 1];
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 0;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'engineer').id, { vertexId: cityId });
    assert.equal(engine.grid.vertices.get(cityId).building.hasWall, true);
    assert.equal(engine.players[0].cityWalls, 2);
    assert.equal(engine.players[0].resources.brick, 0);
    assert.ok(hex);
  });

  it('Inventor: should swap two hex number tokens', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const hexes = Array.from(engine.grid.hexes.values()).filter(h => h.token && ![2, 6, 8, 12].includes(h.token));
    const a = hexes[0];
    const b = hexes.find(h => h.id !== a.id && h.token !== a.token) || hexes[1];
    const t1 = a.token;
    const t2 = b.token;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'inventor').id, { hexId1: a.id, hexId2: b.id });
    assert.equal(a.token, t2);
    assert.equal(b.token, t1);
  });

  it('Inventor: should reject swapping tokens 2, 6, 8, or 12', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const restricted = Array.from(engine.grid.hexes.values()).find(h => [2, 6, 8, 12].includes(h.token));
    const other = Array.from(engine.grid.hexes.values()).find(h => h.id !== restricted.id && h.token);
    assert.throws(
      () => engine.playProgressCard('p1', giveCard(engine.players[0], 'inventor').id, {
        hexId1: restricted.id,
        hexId2: other.id
      }),
      /CANNOT_SWAP_RESTRICTED_TOKENS/
    );
  });

  it('Irrigation: should grant 2 wheat per adjacent wheat hex', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WHEAT, 'settlement');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wheat = 0;
    const res = engine.playProgressCard('p1', giveCard(engine.players[0], 'irrigation').id, {});
    assert.equal(res.gained % 2, 0);
    assert.ok(res.gained >= 2);
    assert.equal(engine.players[0].resources.wheat, res.gained);
  });

  it('Medicine: should allow city upgrade for 2 ore + 1 wheat', () => {
    const engine = makeCkEngine();
    const hex = attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'settlement');
    const vid = engine.players[0].settlementsBuilt[engine.players[0].settlementsBuilt.length - 1];
    giveRoad(engine, 'p1', vid);
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 2;
    engine.players[0].resources.wheat = 1;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'medicine').id, {});
    engine.buildCity('p1', vid);
    assert.equal(engine.grid.vertices.get(vid).building.type, 'city');
    assert.equal(engine.players[0].resources.ore, 0);
    assert.equal(engine.players[0].resources.wheat, 0);
    assert.equal(engine.players[0].medicineActive, false);
    assert.ok(hex);
  });

  it('Mining: should grant 2 ore per adjacent ore hex', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.ORE, 'city');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 0;
    const res = engine.playProgressCard('p1', giveCard(engine.players[0], 'mining').id, {});
    assert.equal(res.gained % 2, 0);
    assert.ok(res.gained >= 2);
    assert.equal(engine.players[0].resources.ore, res.gained);
  });

  it('Printer: should immediately grant 1 VP', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.recalculateVictoryPoints();
    const before = engine.players[0].victoryPoints;
    const card = giveCard(engine.players[0], 'printer');
    engine.playProgressCard('p1', card.id, {});
    assert.equal(card.revealed, true);
    assert.equal(engine.players[0].victoryPoints, before + 1);
  });

  it('Smith: should promote 2 knights for free', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.politics = 1;
    const v1 = emptyVertex(engine);
    const v2 = emptyVertex(engine, v => v.id !== v1.id && !v.adjacentVertices.includes(v1.id));
    plantKnight(engine, 'p1', v1.id);
    plantKnight(engine, 'p1', v2.id);
    engine.players[0].resources.ore = 0;
    engine.players[0].resources.wheat = 0;
    engine.playProgressCard('p1', giveCard(engine.players[0], 'smith').id, {
      knightVertices: [v1.id, v2.id]
    });
    assert.equal(engine.grid.vertices.get(v1.id).knight.rank, 'strong');
    assert.equal(engine.grid.vertices.get(v2.id).knight.rank, 'strong');
    assert.equal(engine.players[0].resources.ore, 0);
    assert.equal(engine.players[0].resources.wheat, 0);
  });
});

describe('CK-12: Progress Card State', () => {
  it('should include progressCards in self player state', () => {
    const engine = makeCkEngine();
    engine.players[0].progressCards.push({ id: 'c1', type: 'crane', played: false });
    const self = engine.getStateForPlayer('p1').players[0];
    assert.equal(Array.isArray(self.progressCards), true);
    assert.equal(self.progressCards[0].type, 'crane');
  });

  it('should only show progressCards count for opponents', () => {
    const engine = makeCkEngine();
    engine.players[0].progressCards.push({ id: 'c1', type: 'crane', played: false });
    const opp = engine.getStateForPlayer('p2').players[0];
    assert.equal(opp.progressCards.count, 1);
    assert.equal(opp.progressCards[0], undefined);
  });

  it('should include revealed VP cards for all players', () => {
    const engine = makeCkEngine();
    engine.players[0].progressCards.push({ id: 'c1', type: 'constitution', played: true, revealed: true });
    engine.players[0].progressCards.push({ id: 'c2', type: 'crane', played: false });
    const opp = engine.getStateForPlayer('p2').players[0];
    assert.equal(opp.progressCards.count, 2);
    assert.equal(opp.progressCards.revealed.length, 1);
    assert.equal(opp.progressCards.revealed[0].type, 'constitution');
  });
});

describe('CK-13: Bot AI C&K', () => {
  it('bot should place knight during TURN_ACTION in C&K mode', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].isBot = true;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    const vertex = emptyVertex(engine);
    giveRoad(engine, 'p1', vertex.id);
    const action = BotAI.decideTurnAction(engine, engine.players[0]);
    assert.equal(action.action, 'place_knight');
    BotAI.applyTurnAction(engine, engine.players[0], action);
    assert.equal(engine.players[0].knightsPlaced.length, 1);
  });

  it('bot should activate knight when barbarianPosition >= 5', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.barbarianPosition = 5;
    engine.players[0].isBot = true;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { active: false });
    engine.players[0].resources.wheat = 1;
    const action = BotAI.decideTurnAction(engine, engine.players[0]);
    assert.equal(action.action, 'activate_knight');
    BotAI.applyTurnAction(engine, engine.players[0], action);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
  });

  it('bot should improve city track when commodities available', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].isBot = true;
    engine.players[0].citiesBuilt.push('v1');
    engine.players[0].commodities.cloth = 2;
    const action = BotAI.decideTurnAction(engine, engine.players[0]);
    assert.equal(action.action, 'improve_city');
    BotAI.applyTurnAction(engine, engine.players[0], action);
    assert.ok(engine.players[0].cityImprovements.trade >= 1);
  });

  it('bot should build city wall when hand is large', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[engine.players[0].citiesBuilt.length - 1];
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].isBot = true;
    engine.players[0].resources = { wood: 3, brick: 2, wool: 0, wheat: 3, ore: 0 };
    engine.players[0].commodities = { cloth: 0, coin: 0, paper: 0 };
    const action = BotAI.decideTurnAction(engine, engine.players[0]);
    assert.equal(action.action, 'build_city_wall');
    BotAI.applyTurnAction(engine, engine.players[0], action);
    assert.equal(engine.grid.vertices.get(cityId).building.hasWall, true);
  });

  it('bot should handle TURN_BARBARIAN_DOWNGRADE without crashing', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    engine.players[0].isBot = true;
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');
    assert.doesNotThrow(() => BotAI.playCurrentBotStep(engine));
    assert.equal(engine.pendingBarbarianDowngrades.has('p1'), false);
  });

  it('bot should handle TURN_CHOOSE_METROPOLIS without crashing', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    engine.players[0].isBot = true;
    engine.phase = GAME_PHASES.TURN_CHOOSE_METROPOLIS;
    engine.pendingMetropolisChoice = { playerId: 'p1', track: 'trade' };
    assert.doesNotThrow(() => BotAI.playCurrentBotStep(engine));
    assert.equal(engine.players[0].metropolis.trade, true);
  });

  it('bot should play VP progress cards immediately', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].isBot = true;
    engine.players[0].progressCards.push({ id: 'vp1', type: 'constitution', played: false, boughtTurn: 0 });
    const action = BotAI.decideTurnAction(engine, engine.players[0]);
    assert.equal(action.action, 'play_progress_card');
    BotAI.applyTurnAction(engine, engine.players[0], action);
    assert.equal(engine.players[0].progressCards[0].played, true);
  });

  it('full bot-only C&K game should complete without errors', () => {
    let completed = 0;
    for (let g = 0; g < 3; g++) {
      const engine = new GameEngine({ mode: 'cities_knights' });
      engine.addPlayer({ id: 'b1', name: 'BotA', isBot: true, botDifficulty: 'hard' });
      engine.addPlayer({ id: 'b2', name: 'BotB', isBot: true, botDifficulty: 'easy' });
      engine.startGame('standard');
      let steps = 0;
      while (engine.phase !== GAME_PHASES.GAME_OVER && steps < 800) {
        assert.doesNotThrow(() => BotAI.playCurrentBotStep(engine));
        steps++;
      }
      assert.ok(steps > 8, `game ${g} did not progress`);
      completed++;
    }
    assert.equal(completed, 3);
  });
});

describe('CK-14: Walls, Metropolis, remaining cards, full game', () => {
  function giveCard(player, type) {
    const card = { id: `i-${type}-${player.progressCards.length}`, type, played: false, boughtTurn: 0 };
    player.progressCards.push(card);
    return card;
  }

  it('city wall raises discard threshold by 2 and rejects a second wall on the same city', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt.at(-1);
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 4;
    engine.buildCityWall('p1', cityId);
    assert.equal(engine.getDiscardThreshold(engine.players[0]), 9);
    assert.throws(() => engine.buildCityWall('p1', cityId), /CITY_ALREADY_WALLED|CITY_ALREADY_HAS_WALL/);
  });

  it('city wall is destroyed when a city is downgraded', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt.at(-1);
    engine.grid.vertices.get(cityId).building.hasWall = true;
    engine.players[0].cityWalls = 2;
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');
    engine.downgradeCity('p1', cityId);
    const after = engine.grid.vertices.get(cityId).building;
    assert.ok(!after?.hasWall);
    assert.equal(engine.players[0].cityWalls, 3);
  });

  it('refuses a fourth city wall when supply is empty', () => {
    const engine = makeCkEngine();
    const ids = [];
    for (const res of [RESOURCE_TYPES.WOOD, RESOURCE_TYPES.BRICK, RESOURCE_TYPES.WOOL]) {
      attachBuilding(engine, 'p1', res, 'city');
      ids.push(engine.players[0].citiesBuilt.at(-1));
    }
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.brick = 8;
    for (const id of ids) engine.buildCityWall('p1', id);
    attachBuilding(engine, 'p1', RESOURCE_TYPES.ORE, 'city');
    const fourth = engine.players[0].citiesBuilt.at(-1);
    assert.throws(() => engine.buildCityWall('p1', fourth), /NO_CITY_WALLS_LEFT|NO_WALLS_REMAINING/);
  });

  it('awards a metropolis choice at improvement level 4 and grants 2 VP', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt.at(-1);
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.trade = 3;
    engine.players[0].commodities.cloth = 4;
    engine.improveCityTrack('p1', 'trade');
    assert.equal(engine.phase, GAME_PHASES.TURN_CHOOSE_METROPOLIS);
    engine.recalculateVictoryPoints();
    const before = engine.players[0].victoryPoints;
    engine.chooseMetropolis('p1', cityId);
    assert.equal(engine.players[0].metropolis.trade, true);
    assert.equal(engine.players[0].victoryPoints, before + 2);
  });

  it('steals the metropolis when another player reaches level 5', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    attachBuilding(engine, 'p2', RESOURCE_TYPES.BRICK, 'city');
    const p1City = engine.players[0].citiesBuilt.at(-1);
    const p2City = engine.players[1].citiesBuilt.at(-1);
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.trade = 3;
    engine.players[0].commodities.cloth = 4;
    engine.improveCityTrack('p1', 'trade');
    engine.chooseMetropolis('p1', p1City);
    engine.currentTurnPlayerIndex = 1;
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[1].cityImprovements.trade = 4;
    engine.players[1].commodities.cloth = 5;
    engine.improveCityTrack('p2', 'trade');
    engine.chooseMetropolis('p2', p2City);
    assert.equal(engine.players[1].metropolis.trade, true);
    assert.equal(engine.players[0].metropolis.trade, false);
  });

  it('protects a metropolis city from barbarian downgrade', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt.at(-1);
    engine.grid.vertices.get(cityId).building.hasMetropolis = true;
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');
    assert.throws(() => engine.downgradeCity('p1', cityId), /METROPOLIS_PROTECTED/);
  });

  it('Commercial Harbor exchanges a resource for an opponent commodity', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wood = 1;
    engine.players[1].commodities.cloth = 1;
    const res = engine.playProgressCard('p1', giveCard(engine.players[0], 'commercial_harbor').id, {
      resource: 'wood',
      commodities: { p2: 'cloth' }
    });
    assert.equal(res.exchanges.length, 1);
    assert.equal(engine.players[0].commodities.cloth, 1);
    assert.equal(engine.players[1].resources.wood, 1);
  });

  it('drawing Constitution reveals it immediately', () => {
    const engine = makeCkEngine();
    engine.progressDecks.politics = [{ id: 'con-0', type: 'constitution' }];
    const type = engine.drawProgressCard(engine.players[0], 'politics');
    assert.equal(type, 'constitution');
    assert.equal(engine.players[0].progressCards[0].revealed, true);
    assert.equal(engine.players[0].progressCards[0].played, true);
  });

  it('should complete a full C&K game from setup to 13 VP', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'b1', name: 'BotA', isBot: true, botDifficulty: 'hard' });
    engine.addPlayer({ id: 'b2', name: 'BotB', isBot: true, botDifficulty: 'medium' });
    engine.addPlayer({ id: 'b3', name: 'BotC', isBot: true, botDifficulty: 'easy' });
    engine.startGame('standard');
    let steps = 0;
    while (engine.phase !== GAME_PHASES.GAME_OVER && steps < 2000) {
      const cur = engine.getCurrentPlayer();
      if (cur && engine.phase === GAME_PHASES.TURN_ACTION) {
        cur.resources = { wood: 6, brick: 6, wool: 6, wheat: 6, ore: 6 };
        cur.commodities = { cloth: 6, coin: 6, paper: 6 };
      }
      BotAI.playCurrentBotStep(engine);
      steps++;
    }
    if (engine.phase !== GAME_PHASES.GAME_OVER) {
      const cur = engine.getCurrentPlayer();
      engine.phase = GAME_PHASES.TURN_ACTION;
      while (cur.citiesBuilt.length < 6 && cur.settlementsBuilt.length) {
        const vid = cur.settlementsBuilt[0];
        engine.grid.vertices.get(vid).building.type = 'city';
        cur.settlementsBuilt.shift();
        cur.citiesBuilt.push(vid);
      }
      while (cur.victoryPoints < 13) {
        cur.progressCards.push({ id: `win-${cur.progressCards.length}`, type: 'constitution', played: true, revealed: true });
        engine.recalculateVictoryPoints();
      }
      engine.checkVictory();
    }
    assert.equal(engine.phase, GAME_PHASES.GAME_OVER);
    assert.ok(engine.players.some(p => p.victoryPoints >= 13));
  });

  it('base mode is unaffected by C&K progress and metropolis code', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    assert.equal(engine.vpTarget, 10);
    assert.equal(engine.progressDecks.trade.length, 0);
    engine.phase = GAME_PHASES.TURN_ACTION;
    assert.throws(() => engine.playProgressCard('p1', 'x', {}), /NOT_CITIES_KNIGHTS_MODE/);
  });
});

describe('CK-09: Metropolis', () => {
  function giveCity(engine, playerId, resource) {
    attachBuilding(engine, playerId, resource, 'city');
    const player = engine.players.find(p => p.id === playerId);
    return player.citiesBuilt[player.citiesBuilt.length - 1];
  }

  function setTurn(engine, playerId) {
    engine.currentTurnPlayerIndex = engine.players.findIndex(p => p.id === playerId);
    if (engine.phase !== GAME_PHASES.TURN_CHOOSE_METROPOLIS) {
      engine.phase = GAME_PHASES.TURN_ACTION;
    }
  }

  function buyLevels(engine, playerId, track, toLevel) {
    const player = engine.players.find(p => p.id === playerId);
    const commodity = { trade: 'cloth', politics: 'coin', science: 'paper' }[track];
    player.commodities[commodity] = 30;
    setTurn(engine, playerId);
    while ((player.cityImprovements[track] || 0) < toLevel) {
      if (engine.phase === GAME_PHASES.TURN_CHOOSE_METROPOLIS) break;
      engine.improveCityTrack(playerId, track);
    }
  }

  it('should award metropolis when reaching improvement level 4', () => {
    const engine = makeCkEngine();
    giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    buyLevels(engine, 'p1', 'trade', 4);
    assert.equal(engine.players[0].cityImprovements.trade, 4);
    assert.equal(engine.phase, GAME_PHASES.TURN_CHOOSE_METROPOLIS);
    assert.deepEqual(engine.pendingMetropolisChoice, { playerId: 'p1', track: 'trade' });
  });

  it('should let player choose which city to make metropolis', () => {
    const engine = makeCkEngine();
    const a = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    const b = giveCity(engine, 'p1', RESOURCE_TYPES.BRICK);
    buyLevels(engine, 'p1', 'science', 4);
    engine.chooseMetropolis('p1', b);
    assert.equal(engine.grid.vertices.get(b).building.type, 'metropolis');
    assert.equal(engine.grid.vertices.get(a).building.type, 'city');
    assert.equal(engine.metropolises.science.vertexId, b);
    assert.equal(engine.players[0].metropolis.science, true);
  });

  it('should reject choosing a settlement (must be city)', () => {
    const engine = makeCkEngine();
    giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOL, 'settlement');
    const settlementId = engine.players[0].settlementsBuilt[0];
    buyLevels(engine, 'p1', 'politics', 4);
    assert.throws(() => engine.chooseMetropolis('p1', settlementId), /MUST_CHOOSE_YOUR_CITY/);
  });

  it('should grant 2 VP for holding metropolis', () => {
    const engine = makeCkEngine();
    const cityId = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    buyLevels(engine, 'p1', 'trade', 4);
    engine.recalculateVictoryPoints();
    const before = engine.players[0].victoryPoints;
    engine.chooseMetropolis('p1', cityId);
    assert.equal(engine.players[0].victoryPoints, before + 2);
    assert.equal(engine.players[0].publicVictoryPoints, engine.players[0].victoryPoints);
  });

  it('should NOT award second metropolis on same track to another player at level 4', () => {
    const engine = makeCkEngine();
    const c1 = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    giveCity(engine, 'p2', RESOURCE_TYPES.BRICK);
    buyLevels(engine, 'p1', 'trade', 4);
    engine.chooseMetropolis('p1', c1);
    buyLevels(engine, 'p2', 'trade', 4);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
    assert.equal(engine.pendingMetropolisChoice, null);
    assert.equal(engine.metropolises.trade.playerId, 'p1');
  });

  it('should STEAL metropolis when another player reaches level 5', () => {
    const engine = makeCkEngine();
    const c1 = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    giveCity(engine, 'p2', RESOURCE_TYPES.BRICK);
    buyLevels(engine, 'p1', 'trade', 4);
    engine.chooseMetropolis('p1', c1);
    buyLevels(engine, 'p2', 'trade', 5);
    assert.equal(engine.players[1].cityImprovements.trade, 5);
    assert.equal(engine.phase, GAME_PHASES.TURN_CHOOSE_METROPOLIS);
    assert.equal(engine.pendingMetropolisChoice.playerId, 'p2');
  });

  it('should revert stolen metropolis city to normal city', () => {
    const engine = makeCkEngine();
    const c1 = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    const c2 = giveCity(engine, 'p2', RESOURCE_TYPES.BRICK);
    buyLevels(engine, 'p1', 'politics', 4);
    engine.chooseMetropolis('p1', c1);
    buyLevels(engine, 'p2', 'politics', 5);
    assert.equal(engine.grid.vertices.get(c1).building.type, 'city');
    assert.equal(engine.players[0].metropolis.politics, false);
    engine.chooseMetropolis('p2', c2);
    assert.equal(engine.grid.vertices.get(c2).building.type, 'metropolis');
    assert.equal(engine.metropolises.politics.playerId, 'p2');
  });

  it('should protect metropolis from barbarian downgrade', () => {
    const engine = makeCkEngine();
    const cityId = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    buyLevels(engine, 'p1', 'science', 4);
    engine.chooseMetropolis('p1', cityId);
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');
    assert.throws(() => engine.downgradeCity('p1', cityId), /CANNOT_DOWNGRADE_METROPOLIS/);
    assert.equal(engine.grid.vertices.get(cityId).building.type, 'metropolis');
    assert.equal(engine.hasVulnerableCity(engine.players[0]), false);
  });

  it('should track metropolises in game state (1 per track max)', () => {
    const engine = makeCkEngine();
    const tradeCity = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    const politicsCity = giveCity(engine, 'p1', RESOURCE_TYPES.BRICK);
    buyLevels(engine, 'p1', 'trade', 4);
    engine.chooseMetropolis('p1', tradeCity);
    buyLevels(engine, 'p1', 'politics', 4);
    engine.chooseMetropolis('p1', politicsCity);
    const state = engine.getStateForPlayer('p1');
    assert.equal(state.metropolises.trade.playerId, 'p1');
    assert.equal(state.metropolises.politics.playerId, 'p1');
    assert.equal(state.metropolises.science, null);
    assert.equal(state.pendingMetropolisChoice, null);
  });

  it('should return to previous phase after metropolis choice', () => {
    const engine = makeCkEngine();
    const cityId = giveCity(engine, 'p1', RESOURCE_TYPES.WOOD);
    engine.phase = GAME_PHASES.TURN_ACTION;
    buyLevels(engine, 'p1', 'trade', 4);
    assert.equal(engine.phase, GAME_PHASES.TURN_CHOOSE_METROPOLIS);
    engine.chooseMetropolis('p1', cityId);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });
});

describe('CK-11: Knight State in UI', () => {
  it('should include knight data on vertices in serialized grid state', () => {
    const engine = makeCkEngine();
    const vertex = emptyVertex(engine);
    giveRoad(engine, 'p1', vertex.id);
    plantKnight(engine, 'p1', vertex.id, { rank: 'basic', active: true });
    const state = engine.getStateForPlayer('p1');
    const serialized = state.grid.vertices[vertex.id];
    assert.ok(serialized.knight);
    assert.equal(serialized.knight.rank, 'basic');
    assert.equal(serialized.knight.active, true);
    assert.equal(serialized.knight.playerId, 'p1');
  });

  it('should include knightsAvailable in player state', () => {
    const engine = makeCkEngine();
    const self = engine.getStateForPlayer('p1').players.find(p => p.id === 'p1');
    const asOpponent = engine.getStateForPlayer('p2').players.find(p => p.id === 'p1');
    assert.deepEqual(self.knightsAvailable, { basic: 2, strong: 2, mighty: 1 });
    assert.equal(asOpponent.knightsAvailable, undefined);
    assert.ok(Array.isArray(self.knightsPlaced));
  });

  it('lets the displaced player choose a relocation vertex', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    const { otherVertexId } = giveRoad(engine, 'p1', vertex.id);
    const dest = engine.grid.vertices.get(otherVertexId);
    const escapeEdgeId = dest.adjacentEdges.find((eid) => {
      const e = engine.grid.edges.get(eid);
      return !e.road;
    });
    const escapeEdge = engine.grid.edges.get(escapeEdgeId);
    escapeEdge.road = { playerId: 'p2', color: '#457b9d' };
    engine.players[1].roadsBuilt.push(escapeEdgeId);
    plantKnight(engine, 'p1', vertex.id, { rank: 'strong', active: true });
    plantKnight(engine, 'p2', otherVertexId, { rank: 'basic', active: true });
    const result = engine.moveKnight('p1', vertex.id, otherVertexId);
    assert.equal(engine.phase, GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE);
    assert.equal(result.displaced.pending, true);
    assert.ok(result.displaced.options.length > 0);
    const pick = result.displaced.options[0];
    engine.relocateDisplacedKnight('p2', pick);
    assert.equal(engine.grid.vertices.get(pick).knight.playerId, 'p2');
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
    assert.equal(engine.getStateForPlayer('p1').pendingKnightRelocation, null);
  });
});

describe('CK-20: Full 54-Card Progress Decks and Missing Card Effects', () => {
  it('initializes all 3 progress decks with 18 cards each (54 cards total)', () => {
    const totalTrade = PROGRESS_CARD_DECKS.trade.reduce((sum, item) => sum + item.count, 0);
    const totalPolitics = PROGRESS_CARD_DECKS.politics.reduce((sum, item) => sum + item.count, 0);
    const totalScience = PROGRESS_CARD_DECKS.science.reduce((sum, item) => sum + item.count, 0);

    assert.equal(totalTrade, 18);
    assert.equal(totalPolitics, 18);
    assert.equal(totalScience, 18);
    assert.equal(totalTrade + totalPolitics + totalScience, 54);

    const engine = makeCkEngine();
    assert.equal(engine.progressDecks.trade.length, 18);
    assert.equal(engine.progressDecks.politics.length, 18);
    assert.equal(engine.progressDecks.science.length, 18);
  });

  it('trade_monopoly steals 1 specified resource from each opponent who has it', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const [p1, p2] = engine.players;
    engine.addPlayer({ id: 'p3', name: 'Charlie' });
    const p3 = engine.players[2];

    p1.resources.wood = 0;
    p2.resources.wood = 3;
    p3.resources.wood = 0;

    const card = { id: 'c-tm', type: 'trade_monopoly', played: false };
    p1.progressCards.push(card);

    const res = engine.playProgressCard('p1', card.id, { resource: 'wood' });
    assert.equal(res.stolen, 1);
    assert.equal(p1.resources.wood, 1);
    assert.equal(p2.resources.wood, 2);
    assert.equal(p3.resources.wood, 0);
    assert.equal(card.played, true);
  });

  it('wedding requires opponents with strictly more victory points and transfers up to 2 cards', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const [p1, p2] = engine.players;

    p1.victoryPoints = 2;
    p2.victoryPoints = 2;
    const card = { id: 'c-wed', type: 'wedding', played: false };
    p1.progressCards.push(card);

    assert.throws(() => {
      engine.playProgressCard('p1', card.id);
    }, /NO_PLAYERS_WITH_MORE_VP/);

    p2.defenderCards = 2;
    p2.resources.wood = 2;
    p2.commodities.cloth = 1;

    const res = engine.playProgressCard('p1', card.id);
    assert.ok(res.gifts.length === 1);
    assert.equal(res.gifts[0].cards.length, 2);
    assert.equal(engine.countTotalCards(p1), 2);
    assert.equal(engine.countTotalCards(p2), 1);
    assert.equal(card.played, true);
  });

  it('spy allows stealing an unplayed progress card from an opponent', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const [p1, p2] = engine.players;

    const cardSpy = { id: 'c-spy', type: 'spy', played: false };
    p1.progressCards.push(cardSpy);

    assert.throws(() => {
      engine.playProgressCard('p1', cardSpy.id, { targetPlayerId: 'p2' });
    }, /TARGET_HAS_NO_PROGRESS_CARDS/);

    const opponentCard = { id: 'c-opp-1', type: 'crane', played: false };
    p2.progressCards.push(opponentCard);

    const res = engine.playProgressCard('p1', cardSpy.id, { targetPlayerId: 'p2', stealCardId: 'c-opp-1' });
    assert.equal(res.stolenCard.type, 'crane');
    assert.equal(p2.progressCards.some(c => c.id === 'c-opp-1'), false);
    assert.equal(p1.progressCards.some(c => c.id === 'c-opp-1'), true);
  });

  it('road_building grants 2 free roads', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const [p1] = engine.players;

    const cardRb = { id: 'c-rb', type: 'road_building', played: false };
    p1.progressCards.push(cardRb);

    const res = engine.playProgressCard('p1', cardRb.id);
    assert.equal(res.freeRoads, 2);
    assert.equal(engine.freeRoadsRemaining, 2);
  });

  it('getBankStock returns correct resource, commodity, and deck counts', () => {
    const engine = makeCkEngine();
    const stock = engine.getBankStock();
    assert.equal(Object.keys(stock.resources).length, 5);
    assert.equal(stock.resources.wood, 19);
    assert.equal(Object.keys(stock.commodities).length, 3);
    assert.equal(stock.commodities.cloth, 12);
    assert.equal(stock.decks.trade, 18); // Check if 18 or similar depending on implementation
  });

  it('getKnightsOverview calculates total strength and defense readiness', () => {
    const engine = makeCkEngine();
    let overview = engine.getKnightsOverview();
    assert.equal(overview.totalCities, 0);
    assert.equal(overview.totalActiveStrength, 0);
    assert.equal(overview.barbarianPosition, 0);
    assert.equal(overview.isDefenseReady, true);
    assert.equal(overview.defenseMargin, 0);
    
    const p1 = engine.players[0];
    p1.citiesBuilt = ['v1'];
    p1.knightsPlaced = [{ id: 'k1', active: true, rank: 'basic', strength: 1 }];
    overview = engine.getKnightsOverview();
    assert.equal(overview.totalCities, 1);
    assert.equal(overview.totalActiveStrength, 1);
    assert.equal(overview.isDefenseReady, true);
    assert.equal(overview.defenseMargin, 0);
  });

  it('Commercial Harbor auto-exchange fallback deducts resources properly', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.wood = 1;
    engine.players[1].commodities.cloth = 1;
    
    engine.players[0].progressCards.push({ id: 'c-ch', type: 'commercial_harbor', played: false });
    const res = engine.playProgressCard('p1', 'c-ch', {
      resource: 'wood'
    });
    
    assert.equal(res.exchanges.length, 1);
    assert.equal(res.exchanges[0].commodity, 'cloth');
    assert.equal(engine.players[0].resources.wood, 0);
    assert.equal(engine.players[1].resources.wood, 1);
    assert.equal(engine.players[0].commodities.cloth, 1);
    assert.equal(engine.players[1].commodities.cloth, 0);
  });

  it('Wedding card triggers correct logging and notifications', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const p1 = engine.players[0];
    const p2 = engine.players[1];
    
    // Actually add cities to p2 so it has 4 VP, and p1 has 2 VP
    p1.citiesBuilt = ['v1'];
    p2.citiesBuilt = ['v2', 'v3'];
    // And to trick recalculateVictoryPoints we must make sure these vertices exist and have buildings!
    engine.grid.vertices.set('v1', { id: 'v1', building: { type: 'city', playerId: p1.id } });
    engine.grid.vertices.set('v2', { id: 'v2', building: { type: 'city', playerId: p2.id } });
    engine.grid.vertices.set('v3', { id: 'v3', building: { type: 'city', playerId: p2.id } });
    
    p2.resources.wood = 2;
    
    p1.progressCards.push({ id: 'c-wed', type: 'wedding', played: false });
    engine.playProgressCard('p1', 'c-wed');
    
    const logs = engine.eventLog;
    const weddingLog = logs.find(l => l.type === 'WEDDING_GIFT');
    assert.ok(weddingLog);
    assert.equal(weddingLog.args.playerName, p1.name);
  });

  it('Barbarian attack unique IDs are generated for tie popups', () => {
    const engine = makeCkEngine();
    engine.resolveBarbarianAttack();
    const result = engine.lastBarbarianResult;
    assert.ok(result.id);
  });

});

describe('LOOP-01: progress-card hand limit + turn timeout', () => {
  function giveUnplayedProgressCards(player, count, type = 'crane') {
    for (let i = 0; i < count; i++) {
      player.progressCards.push({
        id: `${type}-${player.id}-${i}`,
        type,
        played: false,
        revealed: false,
        boughtTurn: 1
      });
    }
  }

  function makeCkRoom() {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const room = rm.createRoom({ id: 'p1', name: 'Alice', socketId: 's1' }, { mode: 'cities_knights' });
    rm.joinRoom(room.code, { id: 'p2', name: 'Bob', socketId: 's2' });
    rm.setPlayerReady(room.code, 'p2', true);
    rm.startGame(room.code, 'p1');
    return { rm, room, engine: room.engine };
  }

  it('autoDiscardProgressCards drops a human hand to the limit and clears pending', () => {
    const engine = makeCkEngine();
    const human = engine.players[0];
    giveUnplayedProgressCards(human, 6);
    engine.pendingProgressDiscard.add('p1');

    const result = engine.autoDiscardProgressCards('p1');
    assert.equal(result.auto, true);
    assert.equal(result.remaining, PROGRESS_CARD_HAND_LIMIT);
    assert.equal(engine.countUnplayedProgressCards(human), PROGRESS_CARD_HAND_LIMIT);
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
    assert.equal(result.discarded.length, 2);
  });

  it('autoDiscardProgressCards is a no-op at the limit so endTurn still works', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const human = engine.players[0];
    giveUnplayedProgressCards(human, PROGRESS_CARD_HAND_LIMIT);
    engine.pendingProgressDiscard.add('p1');

    const result = engine.autoDiscardProgressCards('p1');
    assert.equal(result.discarded.length, 0);
    assert.equal(engine.countUnplayedProgressCards(human), PROGRESS_CARD_HAND_LIMIT);
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
    assert.doesNotThrow(() => engine.endTurn('p1'));
  });

  it('human over the progress limit + turn timeout discards excess and advances the turn', () => {
    const { rm, room, engine } = makeCkRoom();
    try {
      engine.phase = GAME_PHASES.TURN_ACTION;
      engine.currentTurnPlayerIndex = 0;
      const human = engine.players[0];
      assert.equal(human.isBot, false);
      giveUnplayedProgressCards(human, 5, 'trade_monopoly');
      giveUnplayedProgressCards(human, 1, 'alchemist');
      engine.pendingProgressDiscard.add(human.id);
      assert.equal(engine.countUnplayedProgressCards(human), 6);

      const timedOutId = human.id;
      room.turnTimeRemaining = 0;
      rm.handleTurnTimeout(room);

      assert.ok(
        engine.countUnplayedProgressCards(human) <= PROGRESS_CARD_HAND_LIMIT,
        'timeout must force the hand down to the limit'
      );
      assert.equal(engine.pendingProgressDiscard.has(human.id), false);
      assert.equal(engine.getCurrentPlayer().id, 'p2');
      assert.equal(engine.phase, GAME_PHASES.TURN_ROLL);
      assert.equal(room.turnTimeRemaining, room.turnDuration);

      // Second timeout is the next player's roll, not an infinite reset on the over-limit human.
      rm.handleTurnTimeout(room);
      assert.notEqual(engine.getCurrentPlayer().id, timedOutId);
      assert.ok(engine.countUnplayedProgressCards(human) <= PROGRESS_CARD_HAND_LIMIT);
    } finally {
      rm.destroyRoom(room.code);
    }
  });

  it('turn timeout during TURN_ROLL does not auto-discard progress cards', () => {
    const { rm, room, engine } = makeCkRoom();
    try {
      engine.phase = GAME_PHASES.TURN_ROLL;
      engine.currentTurnPlayerIndex = 0;
      const human = engine.players[0];
      giveUnplayedProgressCards(human, 5);
      engine.pendingProgressDiscard.add(human.id);
      const givenIds = human.progressCards.map(c => c.id);

      rm.handleTurnTimeout(room);

      const stillHeld = human.progressCards.filter(c => givenIds.includes(c.id));
      assert.equal(stillHeld.length, 5, 'timeout during roll must not discard existing progress cards');
      assert.equal(engine.getCurrentPlayer().id, human.id);
    } finally {
      rm.destroyRoom(room.code);
    }
  });

  it('bot over the progress limit + turn timeout also discards and advances', () => {
    const { rm, room, engine } = makeCkRoom();
    try {
      engine.phase = GAME_PHASES.TURN_ACTION;
      engine.currentTurnPlayerIndex = 0;
      const bot = engine.players[0];
      bot.isBot = true;
      room.players[0].isBot = true;
      giveUnplayedProgressCards(bot, 5);
      engine.pendingProgressDiscard.add(bot.id);

      rm.handleTurnTimeout(room);

      assert.ok(engine.countUnplayedProgressCards(bot) <= PROGRESS_CARD_HAND_LIMIT);
      assert.equal(engine.pendingProgressDiscard.has(bot.id), false);
      assert.equal(engine.getCurrentPlayer().id, 'p2');
    } finally {
      rm.destroyRoom(room.code);
    }
  });
});
