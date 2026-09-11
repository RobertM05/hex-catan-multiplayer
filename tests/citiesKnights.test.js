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
    assert.equal(oppState.players[0].resources.total, 5);
    assert.equal(oppState.players[0].commodities.cloth, undefined);
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
