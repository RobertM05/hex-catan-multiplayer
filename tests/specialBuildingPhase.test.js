/**
 * RULE-01: Colonist-style Special Building Phase for 5–6 players.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, GAME_PHASES } from '../server/game/GameEngine.js';

function makeEngine(playerCount) {
  const engine = new GameEngine({ roomId: 'sbp-test' });
  for (let i = 1; i <= playerCount; i++) {
    engine.addPlayer({ id: `p${i}`, name: `P${i}` });
  }
  engine.startGame(playerCount <= 4 ? 'standard' : 'extended');
  engine.phase = GAME_PHASES.TURN_ACTION;
  engine.currentTurnPlayerIndex = 0;
  engine.hasRolledDice = true;
  return engine;
}

describe('RULE-01 Colonist Special Building Phase', () => {
  it('does not enter SBP for 4 players', () => {
    const engine = makeEngine(4);
    engine.endTurn('p1');
    assert.equal(engine.phase, GAME_PHASES.TURN_ROLL);
    assert.equal(engine.getCurrentPlayer().id, 'p2');
  });

  it('5-player endTurn enters TURN_SPECIAL_BUILDING before the next roll', () => {
    const engine = makeEngine(5);
    const result = engine.endTurn('p1');
    assert.equal(engine.phase, GAME_PHASES.TURN_SPECIAL_BUILDING);
    assert.equal(result.specialBuilding, true);
    assert.equal(engine.getCurrentPlayer().id, 'p2');
    assert.deepEqual(engine.specialBuildingQueue, ['p2', 'p3', 'p4', 'p5']);
    const state = engine.getStateForPlayer('p2');
    assert.equal(state.phase, GAME_PHASES.TURN_SPECIAL_BUILDING);
    assert.deepEqual(state.specialBuildingQueue, ['p2', 'p3', 'p4', 'p5']);
  });

  it('SBP proceeds clockwise and then starts the next player\'s roll', () => {
    const engine = makeEngine(5);
    engine.endTurn('p1');
    assert.equal(engine.endTurn('p2').currentPlayerId, 'p3');
    assert.equal(engine.getCurrentPlayer().id, 'p3');
    engine.endTurn('p3');
    engine.endTurn('p4');
    const done = engine.endTurn('p5');
    assert.equal(engine.phase, GAME_PHASES.TURN_ROLL);
    assert.equal(engine.getCurrentPlayer().id, 'p2');
    assert.equal(done.nextPlayer.id, 'p2');
    assert.equal(engine.specialBuildingQueue.length, 0);
  });

  it('blocks bank and player trades during SBP', () => {
    const engine = makeEngine(5);
    engine.players[1].resources.wood = 4;
    engine.endTurn('p1');
    assert.throws(
      () => engine.tradeWithBank('p2', 'wood', 'brick', 4),
      /TRADE_BLOCKED_DURING_SPECIAL_BUILDING/
    );
    assert.throws(
      () => engine.proposeTrade('p2', { wood: 1 }, { brick: 1 }),
      /TRADE_BLOCKED_DURING_SPECIAL_BUILDING/
    );
  });

  it('allows building a road during SBP', () => {
    const engine = makeEngine(5);
    const p2 = engine.players[1];
    const vertex = Array.from(engine.grid.vertices.values()).find(v => !v.building);
    vertex.building = { type: 'settlement', playerId: 'p2', color: p2.color };
    p2.settlementsBuilt.push(vertex.id);
    p2.settlementsRemaining--;
    const edgeId = vertex.adjacentEdges.find(id => !engine.grid.edges.get(id).road);
    p2.resources.wood = 1;
    p2.resources.brick = 1;
    engine.endTurn('p1');
    const built = engine.buildRoad('p2', edgeId);
    assert.equal(built.edgeId, edgeId);
    assert.equal(engine.phase, GAME_PHASES.TURN_SPECIAL_BUILDING);
  });

  it('rejects building by a player who is not the current SBP actor', () => {
    const engine = makeEngine(5);
    engine.endTurn('p1');
    assert.throws(() => engine.endTurn('p3'), /NOT_YOUR_TURN/);
  });
});
