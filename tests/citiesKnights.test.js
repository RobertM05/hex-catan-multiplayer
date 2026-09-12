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
  normalizeGameMode
} from '../server/game/GameEngine.js';
import { RoomManager } from '../server/game/RoomManager.js';

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
  it('cities produce 1 resource + 1 commodity on wool/ore/wheat', () => {
    const engine = makeCkEngine();
    const production = { p1: {} };
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WOOL, 'city', production);
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.ORE, 'city', production);
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WHEAT, 'city', production);

    assert.equal(engine.players[0].resources.wool, 1);
    assert.equal(engine.players[0].commodities.cloth, 1);
    assert.equal(engine.players[0].resources.ore, 1);
    assert.equal(engine.players[0].commodities.coin, 1);
    assert.equal(engine.players[0].resources.wheat, 1);
    assert.equal(engine.players[0].commodities.paper, 1);
  });

  it('cities still produce 2 resources on wood/brick', () => {
    const engine = makeCkEngine();
    const production = { p1: {} };
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.WOOD, 'city', production);
    engine.applyHexProduction(engine.players[0], RESOURCE_TYPES.BRICK, 'city', production);
    assert.equal(engine.players[0].resources.wood, 2);
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

    engine.players[0].cityImprovements.trade = 5;
    assert.throws(() => engine.improveCityTrack('p1', 'trade'), /IMPROVEMENT_MAX_LEVEL/);
    assert.throws(() => engine.improveCityTrack('p1', 'science'), /NOT_ENOUGH_COMMODITIES/);
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

  it('should NOT award Defender on tie', () => {
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
    assert.equal(result.progressDraws[0].drawn, false);
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

  it('should reject placement violating distance rule', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 1;
    engine.players[0].resources.wool = 1;
    const vertex = emptyVertex(engine);
    const adjId = vertex.adjacentVertices[0];
    engine.grid.vertices.get(adjId).building = { type: 'settlement', playerId: 'p2' };
    giveRoad(engine, 'p1', vertex.id);
    assert.throws(() => engine.placeKnight('p1', vertex.id), /DISTANCE_RULE_VIOLATION/);
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

  it('should promote basic to strong with wheat + ore and Politics ≥ 1', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id);
    engine.players[0].cityImprovements.politics = 1;
    engine.players[0].resources.wheat = 1;
    engine.players[0].resources.ore = 1;
    engine.promoteKnight('p1', vertex.id);
    assert.equal(engine.players[0].knightsPlaced[0].rank, 'strong');
    assert.equal(engine.players[0].knightsPlaced[0].strength, 2);
    assert.equal(engine.players[0].knightsPlaced[0].active, true);
    assert.equal(engine.players[0].knightsAvailable.basic, 2);
    assert.equal(engine.players[0].knightsAvailable.strong, 1);
  });

  it('should promote strong to mighty with Politics ≥ 2', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { rank: 'strong' });
    engine.players[0].cityImprovements.politics = 2;
    engine.players[0].resources.wheat = 1;
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
    engine.players[0].resources.wheat = 1;
    engine.players[0].resources.ore = 1;
    assert.throws(() => engine.promoteKnight('p1', vertex.id), /POLITICS_LEVEL_TOO_LOW/);
  });

  it('should reject promotion of mighty knight (max rank)', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { rank: 'mighty' });
    engine.players[0].cityImprovements.politics = 5;
    engine.players[0].resources.wheat = 1;
    engine.players[0].resources.ore = 1;
    assert.throws(() => engine.promoteKnight('p1', vertex.id), /KNIGHT_MAX_RANK/);
  });

  it('should auto-activate knight on promotion', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    const vertex = emptyVertex(engine);
    plantKnight(engine, 'p1', vertex.id, { active: false });
    engine.players[0].cityImprovements.politics = 1;
    engine.players[0].resources.wheat = 1;
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

  it('does not drive settlementsRemaining negative when supply is empty', () => {
    const engine = makeCkEngine();
    attachBuilding(engine, 'p1', RESOURCE_TYPES.WOOD, 'city');
    const cityId = engine.players[0].citiesBuilt[0];
    engine.players[0].settlementsRemaining = 0;
    engine.phase = GAME_PHASES.TURN_BARBARIAN_DOWNGRADE;
    engine.pendingBarbarianDowngrades.add('p1');

    engine.downgradeCity('p1', cityId);

    assert.equal(engine.players[0].settlementsRemaining, 0);
    assert.equal(engine.players[0].citiesBuilt.length, 0);
    assert.equal(engine.grid.vertices.get(cityId).building, null);
    assert.equal(engine.players[0].settlementsBuilt.includes(cityId), false);
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
