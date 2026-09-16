/**
 * qaAuditAndRules.test.js
 * Comprehensive QA test suite verifying critical rules, edge cases,
 * input validation, and bug fixes for the Catan engine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HexGrid, RESOURCE_TYPES, HARBOR_TYPES } from '../server/game/HexGrid.js';
import { GameEngine, GAME_PHASES, COSTS, DEV_CARD_TYPES } from '../server/game/GameEngine.js';
import { BotAI } from '../server/game/BotAI.js';
import { RoomManager } from '../server/game/RoomManager.js';

describe('HexGrid & Harbor Generation', () => {
  it('should generate 9 spaced harbors with 18 distinct vertices and zero collisions', () => {
    const grid = new HexGrid({ mapSize: 'standard' });
    const harborEdges = Array.from(grid.edges.values()).filter(e => e.harbor);
    const harborVertices = Array.from(grid.vertices.values()).filter(v => v.harbor);

    assert.equal(harborEdges.length, 9, 'Standard board must have exactly 9 harbors');
    assert.equal(harborVertices.length, 18, 'Standard board must have exactly 18 harbor vertices (2 per harbor)');

    // Ensure no two harbor edges share any vertex
    for (let i = 0; i < harborEdges.length; i++) {
      for (let j = i + 1; j < harborEdges.length; j++) {
        const e1 = harborEdges[i];
        const e2 = harborEdges[j];
        const sharesVertex = e1.v1 === e2.v1 || e1.v1 === e2.v2 || e1.v2 === e2.v1 || e1.v2 === e2.v2;
        assert.ok(!sharesVertex, `Harbor edges ${e1.id} and ${e2.id} must not share a vertex`);
      }
    }
  });

  it('should generate valid harbors on extended map without collisions', () => {
    const grid = new HexGrid({ mapSize: 'extended' });
    const harborEdges = Array.from(grid.edges.values()).filter(e => e.harbor);
    assert.equal(harborEdges.length, 11, 'Official extended board must have 11 harbors');
    for (let i = 0; i < harborEdges.length; i++) {
      for (let j = i + 1; j < harborEdges.length; j++) {
        const e1 = harborEdges[i];
        const e2 = harborEdges[j];
        const sharesVertex = e1.v1 === e2.v1 || e1.v1 === e2.v2 || e1.v2 === e2.v1 || e1.v2 === e2.v2;
        assert.ok(!sharesVertex, `Harbors on extended board must not collide`);
      }
    }
  });

  it('should guarantee no adjacent red numbers (6 and 8) on standard and extended maps', () => {
    for (let iter = 0; iter < 50; iter++) {
      const standardGrid = new HexGrid({ mapSize: 'standard' });
      assert.equal(
        standardGrid.hasAdjacentRedNumbers(),
        false,
        `Standard board iteration ${iter} must not have adjacent red numbers (6 and 8)`
      );

      const extendedGrid = new HexGrid({ mapSize: 'extended' });
      assert.equal(
        extendedGrid.hasAdjacentRedNumbers(),
        false,
        `Extended board iteration ${iter} must not have adjacent red numbers (6 and 8)`
      );
    }
  });
});

describe('Robber Discarding & Input Validation', () => {
  it('should enforce >= 8 threshold and exact floor(total / 2) discard amount', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    // 7 cards: no discard required
    engine.players[0].resources = { wood: 7, brick: 0, wool: 0, wheat: 0, ore: 0 };
    // 8 cards: 4 discarded
    engine.players[1].resources = { wood: 8, brick: 0, wool: 0, wheat: 0, ore: 0 };

    engine.phase = GAME_PHASES.TURN_ROLL;
    let rollCall = 0;
    const origRandom = Math.random;
    Math.random = () => {
      rollCall++;
      return rollCall === 1 ? 0.35 : 0.55; // 3 and 4 -> 7
    };

    engine.rollDice('p1');
    Math.random = origRandom;

    assert.equal(engine.phase, GAME_PHASES.TURN_DISCARD);
    assert.ok(!engine.pendingDiscards.has('p1'), 'Player with 7 cards should not discard');
    assert.ok(engine.pendingDiscards.has('p2'), 'Player with 8 cards must discard');

    // Bob tries to discard 3 instead of 4
    assert.throws(() => {
      engine.discardCards('p2', { wood: 3 });
    }, /MUST_DISCARD_EXACTLY_4/);

    // Bob tries to discard negative numbers (exploit test)
    assert.throws(() => {
      engine.discardCards('p2', { wood: 5, brick: -1 });
    }, /DISCARD_COUNT_MUST_BE_NON_NEGATIVE_INTEGER/);

    // Bob tries to discard non-integer
    assert.throws(() => {
      engine.discardCards('p2', { wood: 2.5, brick: 1.5 });
    }, /DISCARD_COUNT_MUST_BE_NON_NEGATIVE_INTEGER/);

    // Bob tries invalid resource name
    assert.throws(() => {
      engine.discardCards('p2', { gold: 4 });
    }, /INVALID_RESOURCE/);

    // Bob discards valid 4 wood
    engine.discardCards('p2', { wood: 4 });
    assert.equal(engine.players[1].resources.wood, 4);
    assert.equal(engine.pendingDiscards.size, 0);
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
  });
});

describe('Knight Card & Dice Roll Phase Transition', () => {
  it('should return to TURN_ROLL when Knight is played before rolling dice', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const p1 = engine.players[0];
    engine.phase = GAME_PHASES.TURN_ROLL;
    engine.turnNumber = 2;
    p1.devCards.push({ id: 'k1', type: DEV_CARD_TYPES.KNIGHT, boughtTurn: 1, played: false });

    // Alice plays Knight before rolling
    engine.playDevCard('p1', 'k1');
    assert.equal(engine.phase, GAME_PHASES.TURN_ROBBER);
    assert.equal(p1.playedKnights, 1);
    assert.equal(engine.hasRolledDice, false);

    // Alice moves robber
    const newHex = Array.from(engine.grid.hexes.keys()).find(h => h !== engine.grid.robberHexId);
    engine.moveRobber('p1', newHex);

    // Critical fix: phase MUST return to TURN_ROLL because dice have not been rolled yet!
    assert.equal(engine.phase, GAME_PHASES.TURN_ROLL);

    // Alice now rolls dice
    const rollResult = engine.rollDice('p1');
    assert.ok(rollResult.sum >= 2 && rollResult.sum <= 12);
    assert.equal(engine.hasRolledDice, true);
  });

  it('logs robber moves with the hex number token, not the hex id', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ROBBER;

    const numbered = Array.from(engine.grid.hexes.values())
      .find(h => h.id !== engine.grid.robberHexId && h.token != null);
    engine.moveRobber('p1', numbered.id);
    const numberedLog = engine.eventLog.filter(e => e.type === 'ROBBER_MOVED').at(-1);
    assert.equal(numberedLog.messageKey, 'LOG_ROBBER_MOVED');
    assert.equal(numberedLog.args.number, numbered.token);
    assert.equal(numberedLog.args.hexId, undefined);

    engine.phase = GAME_PHASES.TURN_ROBBER;
    const desert = Array.from(engine.grid.hexes.values())
      .find(h => h.resource === RESOURCE_TYPES.DESERT);
    engine.moveRobber('p1', desert.id);
    const desertLog = engine.eventLog.filter(e => e.type === 'ROBBER_MOVED').at(-1);
    assert.equal(desertLog.messageKey, 'LOG_ROBBER_MOVED_DESERT');
    assert.equal(desertLog.args.hexId, undefined);
    assert.equal(desertLog.args.number, undefined);
  });

  it('should disallow playing dev cards during setup or discard phases', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    engine.players[0].devCards.push({ id: 'k1', type: DEV_CARD_TYPES.KNIGHT, boughtTurn: 0, played: false });

    assert.equal(engine.phase, GAME_PHASES.SETUP_ROUND_1);
    assert.throws(() => {
      engine.playDevCard('p1', 'k1');
    }, /NOT_IN_VALID_PHASE_FOR_DEV_CARD/);
  });
});

describe('Port Trading Ratios & Validation', () => {
  it('should support 4:1, 3:1 generic, and 2:1 specialized port ratios correctly', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const p1 = engine.players[0];
    p1.resources = { wood: 10, brick: 10, wool: 10, wheat: 10, ore: 10 };
    engine.phase = GAME_PHASES.TURN_ACTION;

    // Reject trading same resource
    assert.throws(() => {
      engine.tradeWithBank('p1', 'wood', 'wood', 4);
    }, /CANNOT_TRADE_SAME_RESOURCE/);

    // Reject invalid resource
    assert.throws(() => {
      engine.tradeWithBank('p1', 'wood', 'diamonds', 4);
    }, /INVALID_RESOURCE/);

    // Default 4:1 trade without port
    engine.tradeWithBank('p1', 'wood', 'ore', 4);
    assert.equal(p1.resources.wood, 6);
    assert.equal(p1.resources.ore, 11);

    // Give Alice a generic 3:1 harbor
    const v1 = Array.from(engine.grid.vertices.keys())[0];
    engine.grid.vertices.get(v1).harbor = { type: HARBOR_TYPES.GENERIC, ratio: 3 };
    p1.settlementsBuilt.push(v1);

    // 3:1 trade works
    engine.tradeWithBank('p1', 'brick', 'wool', 3);
    assert.equal(p1.resources.brick, 7);
    assert.equal(p1.resources.wool, 11);

    // Give Alice a 2:1 wheat harbor
    const v2 = Array.from(engine.grid.vertices.keys())[1];
    engine.grid.vertices.get(v2).harbor = { type: HARBOR_TYPES.WHEAT, ratio: 2 };
    p1.settlementsBuilt.push(v2);

    // 2:1 wheat trade works
    engine.tradeWithBank('p1', 'wheat', 'wood', 2);
    assert.equal(p1.resources.wheat, 8);
    assert.equal(p1.resources.wood, 7);

    // 2:1 trade on non-wheat resource fails with INVALID_TRADE_RATIO
    assert.throws(() => {
      engine.tradeWithBank('p1', 'brick', 'ore', 2);
    }, /INVALID_TRADE_RATIO/);
  });
});

describe('Domestic Trade Security & Validation', () => {
  it('should reject negative amounts, non-integers, empty trades, and same resource', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const p1 = engine.players[0];
    p1.resources = { wood: 5, brick: 5, wool: 0, wheat: 0, ore: 0 };
    engine.phase = GAME_PHASES.TURN_ACTION;

    // Negative give exploit
    assert.throws(() => {
      engine.proposeTrade('p1', { wood: -2 }, { brick: 1 });
    }, /AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER/);

    // Negative want exploit
    assert.throws(() => {
      engine.proposeTrade('p1', { wood: 1 }, { brick: -5 });
    }, /AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER/);

    // Non-integer
    assert.throws(() => {
      engine.proposeTrade('p1', { wood: 1.5 }, { brick: 1 });
    }, /AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER/);

    // Empty trade
    assert.throws(() => {
      engine.proposeTrade('p1', {}, { brick: 1 });
    }, /TRADE_MUST_OFFER_AND_REQUEST_RESOURCES/);

    // Same resource trade
    assert.throws(() => {
      engine.proposeTrade('p1', { wood: 1 }, { wood: 1 });
    }, /CANNOT_TRADE_SAME_RESOURCE/);
  });
});

describe('Longest Road & Largest Army Rules', () => {
  it('should NOT allow ties to steal Longest Road regardless of player order', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    // Both players have 5 roads
    engine.calculatePlayerLongestRoad = () => 5;
    engine.longestRoadHolder = { playerId: 'p1', length: 5 };

    // Reverse player array so Bob is checked before Alice
    engine.players.reverse();
    engine.recalculateLongestRoad();

    // Alice MUST retain Longest Road (Bob cannot steal on a tie)
    assert.equal(engine.longestRoadHolder.playerId, 'p1');
    assert.equal(engine.longestRoadHolder.length, 5);

    // Bob builds 6 roads: Bob strictly exceeds and takes it
    engine.calculatePlayerLongestRoad = (id) => id === 'p2' ? 6 : 5;
    engine.recalculateLongestRoad();
    assert.equal(engine.longestRoadHolder.playerId, 'p2');
    assert.equal(engine.longestRoadHolder.length, 6);
  });

  it('should revoke Longest Road when road drops below 5 segments', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    engine.longestRoadHolder = { playerId: 'p1', length: 6 };

    // Alice is cut to 3 roads, Bob has 4 roads (neither has >= 5)
    engine.calculatePlayerLongestRoad = (id) => id === 'p1' ? 3 : 4;
    engine.recalculateLongestRoad();

    assert.equal(engine.longestRoadHolder, null, 'Longest road must be revoked if no one has >= 5');
    engine.recalculateVictoryPoints();
    assert.equal(engine.players.find(p => p.id === 'p1').publicVictoryPoints, 0);
  });

  it('should set Longest Road aside on tie when holder loses it', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.addPlayer({ id: 'p3', name: 'Charlie' });
    engine.startGame('standard');

    engine.longestRoadHolder = { playerId: 'p1', length: 6 };

    // Alice is cut to 3 roads. Both Bob and Charlie have 5 roads.
    engine.calculatePlayerLongestRoad = (id) => id === 'p1' ? 3 : 5;
    engine.recalculateLongestRoad();

    assert.equal(engine.longestRoadHolder, null, 'Longest road must be set aside on tie when holder loses it');
  });

  it('serializes each player roadLength in getStateForPlayer', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.calculatePlayerLongestRoad = (id) => (id === 'p1' ? 4 : 2);
    const state = engine.getStateForPlayer('p1');
    assert.equal(state.players.find(p => p.id === 'p1').roadLength, 4);
    assert.equal(state.players.find(p => p.id === 'p2').roadLength, 2);
  });

  it('should NOT allow ties to steal Largest Army', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    engine.players[0].playedKnights = 3;
    engine.players[1].playedKnights = 3;
    engine.largestArmyHolder = { playerId: 'p1', count: 3 };

    // Bob checked first
    engine.players.reverse();
    engine.recalculateLargestArmy();

    assert.equal(engine.largestArmyHolder.playerId, 'p1', 'Ties cannot steal Largest Army');
  });
});

describe('Victory Condition Triggers', () => {
  it('should trigger GAME_OVER immediately when 10 VP is reached during turn', () => {
    const engine = new GameEngine({ vpTarget: 10 });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const p1 = engine.players[0];
    p1.resources = { wood: 5, brick: 5, wool: 5, wheat: 5, ore: 10 };
    engine.phase = GAME_PHASES.TURN_ACTION;

    // Give Alice 4 cities (8 VP) + 1 settlement (1 VP) = 9 VP
    p1.citiesBuilt = ['v1', 'v2', 'v3', 'v4'];
    p1.settlementsBuilt = ['v5'];
    engine.recalculateVictoryPoints();
    assert.equal(p1.victoryPoints, 9);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);

    // Build a settlement connected to a road to reach 10 VP
    const v6 = Array.from(engine.grid.vertices.keys()).find(v => {
      const vert = engine.grid.vertices.get(v);
      return !vert.building && !['v1', 'v2', 'v3', 'v4', 'v5'].includes(v);
    });
    const edge = engine.grid.vertices.get(v6).adjacentEdges[0];
    engine.grid.edges.get(edge).road = { playerId: 'p1', color: p1.color };

    engine.buildSettlement('p1', v6);

    // Must be GAME_OVER immediately!
    assert.equal(p1.victoryPoints, 10);
    assert.equal(engine.phase, GAME_PHASES.GAME_OVER);
  });
});

describe('Player Removal & Disconnect Safety', () => {
  it('should safely adjust currentTurnPlayerIndex and clean up awards on player removal', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.addPlayer({ id: 'p3', name: 'Charlie' });
    engine.startGame('standard');

    // Bob turn (index 1)
    engine.currentTurnPlayerIndex = 1;
    assert.equal(engine.getCurrentPlayer().id, 'p2');

    // Alice holds Longest Road
    engine.longestRoadHolder = { playerId: 'p1', length: 5 };

    // Remove Alice (index 0)
    engine.removePlayer('p1');
    assert.equal(engine.players.length, 2);
    // Index should adjust to 0, still pointing to Bob
    assert.equal(engine.currentTurnPlayerIndex, 0);
    assert.equal(engine.getCurrentPlayer().id, 'p2');
    // Longest Road was held by Alice, must be cleaned up and recalculated
    assert.equal(engine.longestRoadHolder, null);

    // If current player (index 1) is removed at the end of array
    engine.currentTurnPlayerIndex = 1; // Charlie
    engine.removePlayer('p3');
    assert.equal(engine.currentTurnPlayerIndex, 0, 'Index must wrap to 0 when last player removed');
    assert.ok(engine.getCurrentPlayer(), 'Current player must not be undefined');
  });

  it('should not crash handleTurnTimeout when player disconnects', () => {
    const mockIo = { to: () => ({ emit: () => {} }) };
    const roomManager = new RoomManager(mockIo);
    const room = roomManager.createRoom({ id: 'p1', name: 'Alice' });
    roomManager.joinRoom(room.code, { id: 'p2', name: 'Bob' });
    roomManager.setPlayerReady(room.code, 'p2', true);
    roomManager.startGame(room.code, 'p1');

    // Disconnect Alice
    room.players[0].socketId = null;

    // Trigger turn timeout - must not throw or crash
    assert.doesNotThrow(() => {
      roomManager.handleTurnTimeout(room);
    });

    roomManager.destroyRoom(room.code);
  });
});

describe('BotAI Port-Aware Trading', () => {
  it('should trade 2:1 or 3:1 at bank when bot owns corresponding harbor', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'bot1', name: 'Bot Turing', isBot: true });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    const bot = engine.players[0];
    // Give bot a 2:1 wheat harbor
    const v1 = Array.from(engine.grid.vertices.keys())[0];
    engine.grid.vertices.get(v1).harbor = { type: HARBOR_TYPES.WHEAT, ratio: 2 };
    bot.settlementsBuilt.push(v1);

    // Bot has 2 wheat, 0 wood
    bot.resources = { wood: 0, brick: 0, wool: 0, wheat: 2, ore: 0 };
    engine.phase = GAME_PHASES.TURN_ACTION;

    const action = BotAI.decideTurnAction(engine, bot);
    assert.equal(action.action, 'bank_trade');
    assert.equal(action.give, 'wheat');
    assert.equal(action.ratio, 2);
  });
});

describe('Dice Roll Production Logging & Transparency', () => {
  it('should log RESOURCE_PRODUCED events when settlements produce on roll', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    // Find a non-desert hex with token
    const producingHex = Array.from(engine.grid.hexes.values()).find(h => h.token && h.resource !== RESOURCE_TYPES.DESERT);
    assert.ok(producingHex, 'Should find producing hex');

    // Put Alice settlement on a vertex touching producingHex
    const targetVertex = Array.from(engine.grid.vertices.values()).find(v => v.hexes.includes(producingHex.id));
    assert.ok(targetVertex);
    targetVertex.building = { type: 'settlement', playerId: 'p1', color: '#e63946' };
    engine.players[0].settlementsBuilt.push(targetVertex.id);

    // Mock dice roll to producingHex.token
    engine.phase = GAME_PHASES.TURN_ROLL;
    const token = producingHex.token;
    const d1 = Math.min(6, Math.max(1, Math.floor(token / 2)));
    const d2 = token - d1;
    let rollCall = 0;
    const origRandom = Math.random;
    Math.random = () => {
      rollCall++;
      return rollCall === 1 ? (d1 - 1) / 6 : (d2 - 1) / 6;
    };

    const res = engine.rollDice('p1');
    Math.random = origRandom;

    assert.equal(res.sum, token);
    const prodLogs = engine.eventLog.filter(e => e.type === 'RESOURCE_PRODUCED');
    assert.ok(prodLogs.length > 0, 'Must have at least one RESOURCE_PRODUCED log');
    assert.equal(prodLogs[0].args.playerName, 'Alice');
    assert.equal(prodLogs[0].args.resource, producingHex.resource);
  });
});

describe('RoomManager Deduplication & Socket Safety', () => {
  it('should not create duplicate players when joinRoom is called for existing player or socket', () => {
    const mockIo = { to: () => ({ emit: () => {} }) };
    const roomManager = new RoomManager(mockIo);
    const room = roomManager.createRoom({ id: 'host1', name: 'Host', socketId: 'sock1' }, { maxPlayers: 4 });

    assert.equal(room.players.length, 1);

    // Host calls joinRoom with same id
    const resSameId = roomManager.joinRoom(room.code, { id: 'host1', name: 'Host Rejoined', socketId: 'sock1' });
    assert.equal(resSameId.reconnected, false);
    assert.equal(room.players.length, 1, 'Must not duplicate player with same ID');

    // Player calls joinRoom with same socketId
    const resSameSock = roomManager.joinRoom(room.code, { id: 'different_id', name: 'Clone', socketId: 'sock1' });
    assert.equal(room.players.length, 1, 'Must not duplicate player with same socket ID');

    roomManager.destroyRoom(room.code);
  });
});

describe('CORE-01: Soft-Lock Prevention & Interrupted Phase Recovery', () => {
  it('should clean up pendingMetropolisChoice and revert phase when chooser disconnects', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'P1' });
    engine.addPlayer({ id: 'p2', name: 'P2' });
    engine.startGame('standard');

    engine.phase = GAME_PHASES.TURN_CHOOSE_METROPOLIS;
    engine.previousPhase = GAME_PHASES.TURN_ACTION;
    engine.pendingMetropolisChoice = { playerId: 'p1', track: 'trade' };

    engine.removePlayer('p1');

    assert.equal(engine.pendingMetropolisChoice, null);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });

  it('should clean up pendingKnightRelocation and revert phase when displaced player disconnects', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'P1' });
    engine.addPlayer({ id: 'p2', name: 'P2' });
    engine.startGame('standard');

    engine.phase = GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE;
    engine.previousPhase = GAME_PHASES.TURN_ACTION;
    engine.pendingKnightRelocation = { playerId: 'p1', fromVertexId: 'v1' };

    engine.removePlayer('p1');

    assert.equal(engine.pendingKnightRelocation, null);
    assert.equal(engine.phase, GAME_PHASES.TURN_ACTION);
  });

  it('should reset setupStep to settlement if active player disconnects after placing settlement', () => {
    const engine = new GameEngine();
    engine.addPlayer({ id: 'p1', name: 'P1' });
    engine.addPlayer({ id: 'p2', name: 'P2' });
    engine.startGame('standard');

    const v = Array.from(engine.grid.vertices.keys())[0];
    engine.placeSetupSettlement('p1', v);
    assert.equal(engine.setupStep, 'road');
    assert.equal(engine.lastSetupSettlementVertex, v);

    engine.removePlayer('p1');

    assert.equal(engine.setupStep, 'settlement');
    assert.equal(engine.lastSetupSettlementVertex, null);
  });

  it('should auto-resolve TURN_CHOOSE_KNIGHT_RELOCATE in BotAI.playCurrentBotStep', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'b1', name: 'Bot1', isBot: true });
    engine.addPlayer({ id: 'b2', name: 'Bot2', isBot: true });
    engine.startGame('standard');

    engine.phase = GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE;
    engine.pendingKnightRelocation = { playerId: 'b1', fromVertexId: 'v1' };

    const acted = BotAI.playCurrentBotStep(engine);
    assert.equal(acted, true);
    assert.equal(engine.pendingKnightRelocation, null);
    assert.notEqual(engine.phase, GAME_PHASES.TURN_CHOOSE_KNIGHT_RELOCATE);
  });
});

describe('CK-16: Official C&K Rules Alignment', () => {
  it('Smith progress card allows promoting 1 single knight', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].cityImprovements.politics = 1;

    const v1 = Array.from(engine.grid.vertices.values()).find(v => !v.building && !v.knight);
    engine.grid.vertices.get(v1.id).knight = {
      playerId: 'p1',
      vertexId: v1.id,
      rank: 'basic',
      active: false,
      strength: 1
    };
    engine.players[0].knightsPlaced.push(engine.grid.vertices.get(v1.id).knight);

    const card = { id: 's1', type: 'smith', played: false, boughtTurn: 0 };
    engine.players[0].progressCards.push(card);

    engine.playProgressCard('p1', 's1', { knightVertices: [v1.id] });
    assert.equal(engine.grid.vertices.get(v1.id).knight.rank, 'strong');
    assert.equal(engine.grid.vertices.get(v1.id).knight.strength, 2);
  });

  it('Saboteur affects players with equal victory points', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.addPlayer({ id: 'p3', name: 'Charlie' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;

    engine.players[0].defenderCards = 2; // p1 has 2 VP
    engine.players[1].defenderCards = 2; // p2 has 2 VP (tied with p1)
    engine.players[2].defenderCards = 1; // p3 has 1 VP (lower than p1)
    engine.recalculateVictoryPoints();

    engine.players[1].resources = { wood: 4, brick: 0, wool: 0, wheat: 0, ore: 0 };
    engine.players[1].commodities = { cloth: 2, coin: 0, paper: 0 }; // 6 cards total

    const card = { id: 'sab1', type: 'saboteur', played: false, boughtTurn: 0 };
    engine.players[0].progressCards.push(card);

    const res = engine.playProgressCard('p1', 'sab1', {});
    assert.equal(res.victims.length, 1);
    assert.equal(res.victims[0].playerId, 'p2');
    assert.equal(engine.countTotalCards(engine.players[1]), 3);
  });

  it('Master Merchant rejects target when target VP <= player VP', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;

    engine.players[0].victoryPoints = 3;
    engine.players[1].victoryPoints = 2; // Bob is behind in VP
    engine.players[1].resources = { wood: 2, brick: 2, wool: 0, wheat: 0, ore: 0 };

    const card = { id: 'mm1', type: 'master_merchant', played: false, boughtTurn: 0 };
    engine.players[0].progressCards.push(card);

    assert.throws(
      () => engine.playProgressCard('p1', 'mm1', { targetPlayerId: 'p2', steal: ['wood', 'brick'] }),
      /TARGET_NOT_AHEAD_IN_VP/
    );
  });

  it('Opponent knight blocks road building through shared intersection', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');
    engine.phase = GAME_PHASES.TURN_ACTION;

    // Find two adjacent edges sharing vertex V
    const v = Array.from(engine.grid.vertices.values()).find(v => v.adjacentEdges.length >= 2);
    const e1 = engine.grid.edges.get(v.adjacentEdges[0]);
    const e2 = engine.grid.edges.get(v.adjacentEdges[1]);

    // Give p1 a road on e1
    e1.road = { playerId: 'p1', color: '#e63946' };
    engine.players[0].roadsBuilt.push(e1.id);

    // Opponent p2 places a knight on shared vertex v
    v.knight = { playerId: 'p2', rank: 'basic', active: true, strength: 1 };

    // p1 has resources for road
    engine.players[0].resources = { wood: 1, brick: 1, wool: 0, wheat: 0, ore: 0 };

    const check = engine.canBuildRoad('p1', e2.id);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'MUST_CONNECT_TO_NETWORK');
  });

  it('Opponent knight breaks Longest Road continuity', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    // Build a simple 3-edge line: e1 (v1-v2), e2 (v2-v3), e3 (v3-v4)
    // Find a chain of 3 edges
    const v1 = Array.from(engine.grid.vertices.values()).find(v => v.adjacentEdges.length >= 2);
    const e1 = engine.grid.edges.get(v1.adjacentEdges[0]);
    const v2Id = e1.v1 === v1.id ? e1.v2 : e1.v1;
    const v2 = engine.grid.vertices.get(v2Id);
    const e2Id = v2.adjacentEdges.find(eid => eid !== e1.id);
    const e2 = engine.grid.edges.get(e2Id);
    const v3Id = e2.v1 === v2.id ? e2.v2 : e2.v1;
    const v3 = engine.grid.vertices.get(v3Id);
    const e3Id = v3.adjacentEdges.find(eid => eid !== e2.id);
    const e3 = engine.grid.edges.get(e3Id);

    e1.road = { playerId: 'p1', color: '#e63946' };
    e2.road = { playerId: 'p1', color: '#e63946' };
    e3.road = { playerId: 'p1', color: '#e63946' };
    engine.players[0].roadsBuilt.push(e1.id, e2.id, e3.id);

    // Initial longest road without knight = 3
    assert.equal(engine.calculatePlayerLongestRoad('p1'), 3);

    // Place opponent knight on intermediate vertex v2
    v2.knight = { playerId: 'p2', rank: 'basic', active: true, strength: 1 };

    // With opponent knight blocking v2, chain e1-e2 is broken; longest continuous is 2 (e2-e3)
    assert.equal(engine.calculatePlayerLongestRoad('p1'), 2);
  });

  it('Multiple defender cards award cumulative Victory Points', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    engine.players[0].defenderCards = 3;
    engine.recalculateVictoryPoints();

    assert.equal(engine.players[0].publicVictoryPoints, 3);
    assert.equal(engine.players[0].victoryPoints, 3);

    const state = engine.getStateForPlayer('p1');
    assert.equal(state.players[0].defenderCards, 3);
  });

  it('Constitution draw with 4 progress cards in hand does not trigger discard trap', () => {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Alice' });
    engine.addPlayer({ id: 'p2', name: 'Bob' });
    engine.startGame('standard');

    // Fill hand with 4 normal progress cards
    for (let i = 0; i < 4; i++) {
      engine.players[0].progressCards.push({ id: `c${i}`, type: 'crane', played: false });
    }

    // Put constitution on top of politics deck
    engine.progressDecks.politics = [{ id: 'vp_const', type: 'constitution' }];
    const drawn = engine.drawProgressCard(engine.players[0], 'politics');

    assert.equal(drawn, 'constitution');
    assert.equal(engine.pendingProgressDiscard.has('p1'), false);
    assert.equal(engine.players[0].publicVictoryPoints, 1);
  });
});

describe('AI-02 & UX-09: Bot Trade Balancing & Goal-Oriented Bank Trading', () => {
  it('evaluateBotsTrade rejects kingmaking trades to players near victory point target', () => {
    const rm = new RoomManager({ emit: () => {} });
    const room = rm.createRoom({ id: 'h1', name: 'HumanHost' }, { name: 'Room1', turnDuration: 60 });
    rm.addBot(room.code, 'medium');
    room.engine.startGame('standard');

    const human = room.engine.players[0];
    const bot = room.engine.players[1];

    // Proposer is at 8 VP in a 10 VP game
    human.victoryPoints = 8;
    human.resources = { wood: 5, brick: 0, wool: 0, wheat: 0, ore: 0 };
    bot.resources = { wood: 3, brick: 3, wool: 3, wheat: 3, ore: 3 };

    room.engine.phase = GAME_PHASES.TURN_ACTION;
    room.engine.currentTurnPlayerIndex = 0;
    room.engine.proposeTrade(human.id, { wood: 1 }, { brick: 1 });

    rm.evaluateBotsTrade(room);
    assert.equal(room.engine.activeTrade.acceptedBy.has(bot.id), false);
  });

  it('evaluateBotsTrade rejects 1:1 commodity drains and 1:2 rip-offs', () => {
    const rm = new RoomManager({ emit: () => {} });
    const room = rm.createRoom({ id: 'h1', name: 'HumanHost' }, { name: 'Room2', turnDuration: 60, mode: 'cities_knights' });
    rm.addBot(room.code, 'medium');
    room.engine.startGame('standard');

    const human = room.engine.players[0];
    const bot = room.engine.players[1];

    human.resources = { wood: 5, brick: 0, wool: 0, wheat: 0, ore: 0 };
    bot.commodities = { cloth: 2, coin: 2, paper: 2 };
    bot.resources = { wood: 4, brick: 4, wool: 4, wheat: 4, ore: 4 };

    room.engine.phase = GAME_PHASES.TURN_ACTION;
    room.engine.currentTurnPlayerIndex = 0;

    // Test 1: Commodity drain (1 wood for 1 coin)
    room.engine.proposeTrade(human.id, { wood: 1 }, { coin: 1 });
    rm.evaluateBotsTrade(room);
    assert.equal(room.engine.activeTrade.acceptedBy.has(bot.id), false);

    // Test 2: 1:2 rip-off (1 wood for 2 ore)
    room.engine.proposeTrade(human.id, { wood: 1 }, { ore: 2 });
    rm.evaluateBotsTrade(room);
    assert.equal(room.engine.activeTrade.acceptedBy.has(bot.id), false);
  });

  it('BotAI proposes fair 1:1 player trade to fulfill city deficit before bank trade', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'bot1', name: 'Bot', isBot: true });
    engine.addPlayer({ id: 'p2', name: 'Human' });
    engine.startGame('standard');

    const bot = engine.players[0];
    const vId = Array.from(engine.grid.vertices.keys())[0];
    engine.grid.vertices.get(vId).building = { type: 'settlement', playerId: bot.id };
    bot.settlementsBuilt.push(vId);

    // Needs 3 ore + 2 wheat for city. Has 2 ore, 2 wheat, and 4 brick surplus.
    bot.resources = { wood: 0, brick: 4, wool: 0, wheat: 2, ore: 2 };
    engine.phase = GAME_PHASES.TURN_ACTION;

    const action = BotAI.decideTurnAction(engine, bot);
    assert.equal(action.action, 'propose_trade');
    assert.deepEqual(action.give, { brick: 1 });
    assert.deepEqual(action.want, { ore: 1 });
  });

  it('BotAI executes goal-oriented bank trade to fulfill city deficit', () => {
    const engine = new GameEngine({ mode: 'base' });
    engine.addPlayer({ id: 'bot1', name: 'Bot', isBot: true });
    engine.addPlayer({ id: 'p2', name: 'Human' });
    engine.startGame('standard');

    const bot = engine.players[0];
    const vId = Array.from(engine.grid.vertices.keys())[0];
    engine.grid.vertices.get(vId).building = { type: 'settlement', playerId: bot.id };
    bot.settlementsBuilt.push(vId);

    // Needs 3 ore + 2 wheat for city. Has 2 ore, 2 wheat, and 4 brick surplus.
    bot.resources = { wood: 0, brick: 4, wool: 0, wheat: 2, ore: 2 };
    engine.phase = GAME_PHASES.TURN_ACTION;
    bot.hasProposedTradeThisTurn = true;

    const action = BotAI.decideTurnAction(engine, bot);
    assert.equal(action.action, 'bank_trade');
    assert.equal(action.give, 'brick');
    assert.equal(action.receive, 'ore');
    assert.equal(action.ratio, 4);
  });
});

describe('CK-17: Aqueduct & Knight Action Limits', () => {
  function makeCkEngine() {
    const engine = new GameEngine({ mode: 'cities_knights' });
    engine.addPlayer({ id: 'p1', name: 'Player 1' });
    engine.addPlayer({ id: 'p2', name: 'Player 2' });
    engine.startGame('standard');
    return engine;
  }

  function giveRoad(engine, playerId, vertexId) {
    const vertex = engine.grid.vertices.get(vertexId);
    const edgeId = vertex.adjacentEdges[0];
    const edge = engine.grid.edges.get(edgeId);
    edge.road = { playerId, color: '#e63946' };
    engine.players.find(p => p.id === playerId).roadsBuilt.push(edgeId);
    const otherVertexId = edge.v1 === vertexId ? edge.v2 : edge.v1;
    return { edge, otherVertexId };
  }

  it('sets hiredTurn and lastActionTurn when a knight is placed', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 2;
    engine.players[0].resources.wool = 2;
    const vertex = Array.from(engine.grid.vertices.values()).find(v => !v.building && !v.knight);
    giveRoad(engine, 'p1', vertex.id);

    const result = engine.placeKnight('p1', vertex.id);
    assert.equal(result.knight.hiredTurn, engine.turnNumber);
    assert.equal(result.knight.lastActionTurn, engine.turnNumber);
  });

  it('rejects activating or promoting a knight on the turn it is hired', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 3;
    engine.players[0].resources.wool = 2;
    engine.players[0].resources.wheat = 2;
    engine.players[0].cityImprovements.politics = 2;
    const vertex = Array.from(engine.grid.vertices.values()).find(v => !v.building && !v.knight);
    giveRoad(engine, 'p1', vertex.id);

    engine.placeKnight('p1', vertex.id);
    assert.throws(() => engine.activateKnight('p1', vertex.id), /KNIGHT_CANNOT_ACT_ON_HIRED_TURN/);
    assert.throws(() => engine.promoteKnight('p1', vertex.id), /KNIGHT_CANNOT_ACT_ON_HIRED_TURN/);
  });

  it('rejects multiple knight actions on the same turn', () => {
    const engine = makeCkEngine();
    engine.phase = GAME_PHASES.TURN_ACTION;
    engine.players[0].resources.ore = 3;
    engine.players[0].resources.wool = 2;
    engine.players[0].resources.wheat = 3;
    engine.players[0].cityImprovements.politics = 2;
    const vertex = Array.from(engine.grid.vertices.values()).find(v => !v.building && !v.knight);
    const { otherVertexId } = giveRoad(engine, 'p1', vertex.id);

    engine.placeKnight('p1', vertex.id);

    // Advance to next turn so knight is no longer on hired turn
    engine.turnNumber++;
    engine.activateKnight('p1', vertex.id);
    assert.equal(engine.grid.vertices.get(vertex.id).knight.active, true);
    assert.equal(engine.grid.vertices.get(vertex.id).knight.lastActionTurn, engine.turnNumber);

    // Cannot promote on the same turn it was activated
    assert.throws(() => engine.promoteKnight('p1', vertex.id), /KNIGHT_ALREADY_ACTED_THIS_TURN/);

    // Cannot move on the same turn it was activated
    assert.throws(() => engine.moveKnight('p1', vertex.id, otherVertexId), /KNIGHT_ALREADY_ACTED_THIS_TURN/);

    // Advance turn again: now it can move
    engine.turnNumber++;
    engine.moveKnight('p1', vertex.id, otherVertexId);
    assert.equal(engine.grid.vertices.get(otherVertexId).knight.playerId, 'p1');
    assert.equal(engine.grid.vertices.get(otherVertexId).knight.lastActionTurn, engine.turnNumber);
  });

  it('Aqueduct perk arms a chooser instead of auto-picking the lowest resource', () => {
    const engine = makeCkEngine();
    engine.players[0].cityImprovements.science = 3;
    engine.players[0].resources = { wood: 2, brick: 2, wool: 2, wheat: 2, ore: 0 };

    const production = { p1: {}, p2: { wood: 1 } };
    const claimed = engine.applyAqueductBenefit(production);

    assert.equal(claimed.p1, undefined);
    assert.equal(engine.players[0].resources.ore, 0);
    assert.equal(production.p1.ore, undefined);
    assert.equal(engine.pendingAqueductClaims.has('p1'), true);
    assert.deepEqual(engine.getStateForPlayer('p1').pendingAqueductClaims, ['p1']);
  });

  it('claimAqueductResource validates Science level >= 3 and requires a pending blank roll', () => {
    const engine = makeCkEngine();
    engine.players[0].cityImprovements.science = 2;
    assert.throws(() => engine.claimAqueductResource('p1', 'ore'), /AQUEDUCT_NOT_UNLOCKED/);

    engine.players[0].cityImprovements.science = 3;
    assert.throws(() => engine.claimAqueductResource('p1', 'wheat'), /AQUEDUCT_NOT_ELIGIBLE/);

    engine.hasRolledDice = true;
    engine.dice = [2, 3];
    engine.armAqueductEligibility({ p1: {}, p2: { wood: 1 } });
    const res = engine.claimAqueductResource('p1', 'wheat');
    assert.equal(res.resource, 'wheat');
    assert.equal(engine.players[0].resources.wheat, 1);
    assert.equal(engine.pendingAqueductClaims.has('p1'), false);
  });
});




