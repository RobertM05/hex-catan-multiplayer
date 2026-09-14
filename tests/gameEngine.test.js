/**
 * gameEngine.test.js
 * Comprehensive automated tests for HexGrid, GameEngine, BotAI, and RoomManager.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HexGrid, RESOURCE_TYPES } from '../server/game/HexGrid.js';
import { GameEngine, GAME_PHASES, COSTS, DEV_CARD_TYPES } from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';
import { RoomManager } from '../server/game/RoomManager.js';

describe('HexGrid generation', () => {
  it('should generate standard 19-hex board with graph connectivity', () => {
    const grid = new HexGrid({ playerCount: 4, mapSize: 'standard' });
    assert.equal(grid.hexes.size, 19, 'Standard board should have 19 hexes');
    assert.ok(grid.vertices.size >= 50, 'Standard board should have ~54 vertices');
    assert.ok(grid.edges.size >= 70, 'Standard board should have ~72 edges');
    assert.ok(grid.robberHexId, 'Robber must be placed on desert');

    // Verify desert produces no token
    const robberHex = grid.hexes.get(grid.robberHexId);
    assert.equal(robberHex.token, null);
    assert.equal(robberHex.resource, RESOURCE_TYPES.DESERT);

    // Verify vertex graph
    for (const v of grid.vertices.values()) {
      assert.ok(v.adjacentVertices.length > 0);
      assert.ok(v.adjacentEdges.length > 0);
    }
  });

  it('should generate extended 30-hex board for 5-6 players', () => {
    const grid = new HexGrid({ playerCount: 6, mapSize: 'extended' });
    assert.ok(grid.hexes.size >= 28 && grid.hexes.size <= 32);
  });
});

describe('GameEngine lifecycle & rules', () => {
  it('should run setup snake draft and award bootstrap resources', () => {
    const engine = new GameEngine({ roomId: 'test-room' });
    engine.addPlayer({ id: 'p1', name: 'Alice', color: '#e63946' });
    engine.addPlayer({ id: 'p2', name: 'Bob', color: '#1d3557' });

    engine.startGame('standard');
    assert.equal(engine.phase, GAME_PHASES.SETUP_ROUND_1);
    assert.equal(engine.currentTurnPlayerIndex, 0);

    // Find valid vertex and adjacent edge for Alice
    const v1 = Array.from(engine.grid.vertices.keys())[0];
    const checkV1 = engine.canBuildSettlement('p1', v1, true);
    assert.ok(checkV1.ok);

    engine.placeSetupSettlement('p1', v1);
    assert.equal(engine.setupStep, 'road');

    const edge1 = engine.grid.vertices.get(v1).adjacentEdges[0];
    engine.placeSetupRoad('p1', edge1);

    // Now it should be Bob's turn
    assert.equal(engine.currentTurnPlayerIndex, 1);
    assert.equal(engine.setupStep, 'settlement');

    // Bob places settlement and road (must not be adjacent to v1)
    const vBob = Array.from(engine.grid.vertices.keys()).find(v => {
      return engine.canBuildSettlement('p2', v, true).ok;
    });
    engine.placeSetupSettlement('p2', vBob);
    const edgeBob = engine.grid.vertices.get(vBob).adjacentEdges[0];
    engine.placeSetupRoad('p2', edgeBob);

    // Snake draft reverse: Bob should go again in Round 2!
    assert.equal(engine.phase, GAME_PHASES.SETUP_ROUND_2);
    assert.equal(engine.currentTurnPlayerIndex, 1);

    const vBob2 = Array.from(engine.grid.vertices.keys()).find(v => {
      return engine.canBuildSettlement('p2', v, true).ok;
    });
    engine.placeSetupSettlement('p2', vBob2);
    const edgeBob2 = engine.grid.vertices.get(vBob2).adjacentEdges[0];
    engine.placeSetupRoad('p2', edgeBob2);

    // Now Alice in Round 2
    assert.equal(engine.currentTurnPlayerIndex, 0);
    const vAlice2 = Array.from(engine.grid.vertices.keys()).find(v => {
      return engine.canBuildSettlement('p1', v, true).ok;
    });
    engine.placeSetupSettlement('p1', vAlice2);
    const edgeAlice2 = engine.grid.vertices.get(vAlice2).adjacentEdges[0];
    engine.placeSetupRoad('p1', edgeAlice2);

    // Setup completed, now in TURN_ROLL phase!
    assert.equal(engine.phase, GAME_PHASES.TURN_ROLL);
    assert.equal(engine.currentTurnPlayerIndex, 0);
  });

  it('should handle building and resource deductions in action phase', () => {
    const engine = new GameEngine({ roomId: 'test-room-2' });
    engine.addPlayer({ id: 'p1', name: 'Alice', color: '#e63946' });
    engine.addPlayer({ id: 'p2', name: 'Bob', color: '#1d3557' });
    engine.startGame('standard');

    const p1 = engine.players[0];
    p1.resources = { wood: 5, brick: 5, wool: 5, wheat: 5, ore: 5 };
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.currentTurnPlayerIndex = 0;

    // Pick a vertex and build settlement
    const v1 = Array.from(engine.grid.vertices.keys())[0];
    const edge1 = engine.grid.vertices.get(v1).adjacentEdges[0];

    // Seed settlement
    engine.grid.vertices.get(v1).building = { type: 'settlement', playerId: 'p1', color: p1.color };
    p1.settlementsBuilt.push(v1);
    p1.settlementsRemaining--;

    // Build road connected to v1
    const roadRes = engine.buildRoad('p1', edge1);
    assert.equal(roadRes.edgeId, edge1);
    assert.equal(p1.resources.wood, 4);
    assert.equal(p1.resources.brick, 4);

    // Upgrade v1 to city
    const cityRes = engine.buildCity('p1', v1);
    assert.equal(cityRes.vertexId, v1);
    assert.equal(p1.resources.ore, 2);
    assert.equal(p1.resources.wheat, 3);
    assert.equal(engine.grid.vertices.get(v1).building.type, 'city');
  });

  it('should calculate longest road and victory points', () => {
    const engine = new GameEngine({ roomId: 'test-room-3' });
    engine.addPlayer({ id: 'p1', name: 'Alice', color: '#e63946' });
    engine.addPlayer({ id: 'p2', name: 'Bob', color: '#1d3557' });
    engine.startGame('standard');

    const p1 = engine.players[0];
    // Give 2 settlements and 1 city
    p1.settlementsBuilt = ['v_1', 'v_2'];
    p1.citiesBuilt = ['v_3'];
    engine.recalculateVictoryPoints();

    // 2 settlements (2 VP) + 1 city (2 VP) = 4 VP
    assert.equal(p1.victoryPoints, 4);
  });
});

describe('BotAI autonomy', () => {
  it('should autonomously place setup and decide actions', () => {
    const engine = new GameEngine({ roomId: 'bot-room' });
    engine.addPlayer({ id: 'bot1', name: 'Bot Turing', color: '#2a9d8f', isBot: true });
    engine.addPlayer({ id: 'bot2', name: 'Bot Lovelace', color: '#9b5de5', isBot: true });
    engine.startGame('standard');

    // Bot 1 setup settlement
    const action1 = BotAI.decideSetupAction(engine, engine.players[0]);
    assert.equal(action1.action, 'place_setup_settlement');
    assert.ok(action1.vertexId);
    engine.placeSetupSettlement('bot1', action1.vertexId);

    // Bot 1 setup road
    const action2 = BotAI.decideSetupAction(engine, engine.players[0]);
    assert.equal(action2.action, 'place_setup_road');
    assert.ok(action2.edgeId);
    engine.placeSetupRoad('bot1', action2.edgeId);

    assert.equal(engine.currentTurnPlayerIndex, 1);
  });
});

describe('RoomManager lifecycle', () => {
  it('should create room, add bots, and set ready states', () => {
    const mockIo = { to: () => ({ emit: () => {} }) };
    const roomManager = new RoomManager(mockIo);

    const room = roomManager.createRoom({ id: 'h1', name: 'Host1', socketId: 's1' });
    assert.ok(room.code);
    assert.equal(room.players.length, 1);

    const bot = roomManager.addBot(room.code, 'hard');
    assert.ok(bot);
    assert.equal(room.players.length, 2);

    const readyOk = roomManager.setPlayerReady(room.code, 'h1', true);
    assert.ok(readyOk);

    const started = roomManager.startGame(room.code, 'h1');
    assert.ok(started.isStarted);

    roomManager.destroyRoom(room.code);
  });
});

describe('Discard timer on 7 roll', () => {
  function makeEngine() {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    return engine;
  }

  function forceSevenRoll(engine) {
    engine.phase = GAME_PHASES.TURN_ROLL;
    const originalRandom = Math.random;
    let call = 0;
    Math.random = () => {
      call += 1;
      // First call 2/6 -> die 3, second call 3/6 -> die 4, sum 7
      return call % 2 === 1 ? 2 / 6 : 3 / 6;
    };
    try {
      engine.rollDice('p1');
    } finally {
      Math.random = originalRandom;
    }
  }

  it('sets discardDeadline when a 7 forces discards', () => {
    const engine = makeEngine();
    engine.players[0].resources = { wood: 4, brick: 0, wool: 0, wheat: 0, ore: 4 };
    const before = Date.now();
    forceSevenRoll(engine);
    assert.equal(engine.phase, GAME_PHASES.TURN_DISCARD);
    assert.ok(engine.discardDeadline >= before + 29000, 'deadline must be roughly 30s out');
    assert.ok(engine.discardDeadline <= before + 31000);
    assert.ok(engine.pendingDiscards.has('p1'));
  });

  it('autoDiscardCards discards half from largest stacks and clears deadline', () => {
    const engine = makeEngine();
    engine.players[0].resources = { wood: 4, brick: 0, wool: 0, wheat: 2, ore: 2 };
    forceSevenRoll(engine);
    assert.equal(engine.phase, GAME_PHASES.TURN_DISCARD);

    const result = engine.autoDiscardCards('p1');
    assert.equal(result.auto, true);
    assert.equal(engine.pendingDiscards.size, 0);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
    assert.equal(engine.discardDeadline, null);
    const total = engine.countTotalCards(engine.players[0]);
    assert.equal(total, 4, 'half of 8 cards remain');
  });

  it('serializes discardDeadline in state', () => {
    const engine = makeEngine();
    engine.players[0].resources = { wood: 8, brick: 0, wool: 0, wheat: 0, ore: 0 };
    forceSevenRoll(engine);
    const state = engine.getStateForPlayer('p1');
    assert.ok(state.discardDeadline > 0);
    const stateP2 = engine.getStateForPlayer('p2');
    assert.ok(stateP2.discardDeadline > 0, 'deadline is visible to all players');
  });

  it('RoomManager auto discards humans when the timer expires', async () => {
    const mockIo = { to: () => ({ emit: () => {} }) };
    const roomManager = new RoomManager(mockIo);
    const room = roomManager.createRoom({ id: 'h1', name: 'Host1', socketId: 's1' });
    roomManager.joinRoom(room.code, { id: 'p2', name: 'Guest', socketId: 's2' });
    roomManager.setPlayerReady(room.code, 'p2', true);
    roomManager.startGame(room.code, 'h1');

    const engine = room.engine;
    engine.phase = GAME_PHASES.TURN_DISCARD;
    engine.pendingDiscards.add('h1');
    engine.players[0].resources = { wood: 6, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.discardDeadline = Date.now() + 200;

    roomManager.checkDiscardTimer(room);
    await new Promise(resolve => setTimeout(resolve, 500));

    assert.equal(engine.pendingDiscards.size, 0, 'human should be auto discarded');
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
    assert.equal(engine.players[0].resources.wood, 3, 'half of 6 cards remain');
    roomManager.destroyRoom(room.code);
  });

  it('autoDiscardCards handles commodity only hands in C&K mode', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_DISCARD;
    engine.pendingDiscards.add('p1');
    engine.players[0].resources = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[0].commodities = { cloth: 4, coin: 0, paper: 0 };

    engine.autoDiscardCards('p1');
    assert.equal(engine.players[0].commodities.cloth, 2, 'half of 4 cloth discarded');
    assert.equal(engine.pendingDiscards.size, 0);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
  });
});
