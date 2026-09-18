import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, GAME_MODES, GAME_PHASES } from '../server/game/GameEngine.js';
import { CitiesKnightsModule } from '../server/game/CitiesKnightsModule.js';

describe('ARCH-03: CitiesKnightsModule Decomposition', () => {
  it('Base game mode isolates C&K subsystem with null ckModule', () => {
    const baseEngine = new GameEngine({ mode: 'base' });
    assert.equal(baseEngine.mode, GAME_MODES.BASE);
    assert.equal(baseEngine.ckModule, null);

    // Any C&K actions in base mode fail-close with NOT_CITIES_KNIGHTS_MODE
    assert.throws(() => baseEngine.recruitKnight('p1', 'v1'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.activateKnight('p1', 'v1'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.promoteKnight('p1', 'v1'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.moveKnight('p1', 'v1', 'v2'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.chaseRobber('p1', 'v1', 'h1'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.improveCityTrack('p1', 'science'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.chooseMetropolis('p1', 'v1'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.resolveBarbarianAttack(), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.downgradeCity('p1', 'v1'), /NOT_CITIES_KNIGHTS_MODE/);
    assert.throws(() => baseEngine.chooseBarbarianReward('p1', 'trade'), /NOT_CITIES_KNIGHTS_MODE/);
  });

  it('Cities & Knights mode instantiates CitiesKnightsModule instance', () => {
    const ckEngine = new GameEngine({ mode: 'cities_knights' });
    assert.equal(ckEngine.mode, GAME_MODES.CITIES_KNIGHTS);
    assert.ok(ckEngine.ckModule instanceof CitiesKnightsModule);
    assert.equal(ckEngine.ckModule.engine, ckEngine);
  });

  it('Lifecycle hook onDiceRoll advances barbarian voyage track or sets progress color', () => {
    const ckEngine = new GameEngine({ mode: 'cities_knights' });
    ckEngine.barbarianPosition = 0;

    // Barbarian face advances voyage track
    ckEngine.ckModule.onDiceRoll(3, 4, 'barbarian');
    assert.equal(ckEngine.barbarianPosition, 1);

    // Track caps at 7
    ckEngine.barbarianPosition = 6;
    ckEngine.ckModule.onDiceRoll(2, 5, 'barbarian');
    assert.equal(ckEngine.barbarianPosition, 7);

    // Non-barbarian event die sets progress card color
    ckEngine.ckModule.onDiceRoll(3, 4, 'science');
    assert.equal(ckEngine.pendingProgressCardColor, 'science');
  });

  it('Lifecycle hook onTurnEnd validates progress card hand limit', () => {
    const ckEngine = new GameEngine({ mode: 'cities_knights' });
    const player = {
      id: 'p1',
      progressCards: [
        { id: '1', played: false },
        { id: '2', played: false },
        { id: '3', played: false },
        { id: '4', played: false },
        { id: '5', played: false } // 5 unplayed cards exceeds limit of 4
      ]
    };

    assert.throws(() => {
      ckEngine.ckModule.onTurnEnd(player);
    }, /MUST_DISCARD_PROGRESS_CARD_BEFORE_ENDING_TURN/);

    // Within limit (4 cards) and pending discard cleared passes without error
    player.progressCards.pop();
    ckEngine.pendingProgressDiscard.delete(player.id);
    assert.doesNotThrow(() => {
      ckEngine.ckModule.onTurnEnd(player);
    });
  });

  it('Lifecycle hook onBuildingUpgraded recalculates victory points on city upgrade', () => {
    const ckEngine = new GameEngine({ mode: 'cities_knights' });
    ckEngine.addPlayer({ id: 'p1', name: 'Alice' });
    ckEngine.addPlayer({ id: 'p2', name: 'Bob' });
    ckEngine.startGame('standard');

    let recalculated = false;
    const origRecalc = ckEngine.recalculateVictoryPoints.bind(ckEngine);
    ckEngine.recalculateVictoryPoints = () => {
      recalculated = true;
      return origRecalc();
    };

    ckEngine.ckModule.onBuildingUpgraded(ckEngine.players[0], 'v1', 'city');
    assert.equal(recalculated, true);
  });

  it('Progress card decks initialize, draw, and recycle under deck', () => {
    const ckEngine = new GameEngine({ mode: 'cities_knights' });
    ckEngine.ckModule.initProgressCardDecks();

    assert.equal(ckEngine.progressDecks.trade.length, 18);
    assert.equal(ckEngine.progressDecks.politics.length, 18);
    assert.equal(ckEngine.progressDecks.science.length, 18);

    const player = {
      id: 'p1',
      progressCards: []
    };

    const drawnType = ckEngine.ckModule.drawProgressCard(player, 'science');
    assert.ok(drawnType);
    assert.equal(player.progressCards.length, 1);
    assert.equal(ckEngine.progressDecks.science.length, 17);

    // Recycling under deck
    const discardedCard = player.progressCards[0];
    ckEngine.ckModule.placeProgressCardUnderDeck(discardedCard);
    assert.equal(ckEngine.progressDecks.science.length, 18);
    assert.equal(ckEngine.progressDecks.science[0].type, discardedCard.type);
  });

  it('Barbarian attack resolution evaluates knights vs cities', () => {
    const ckEngine = new GameEngine({ mode: 'cities_knights' });
    ckEngine.addPlayer({ id: 'p1', name: 'Alice' });
    ckEngine.addPlayer({ id: 'p2', name: 'Bob' });
    ckEngine.startGame('standard');

    ckEngine.players[0].citiesBuilt = ['v1'];
    ckEngine.players[1].citiesBuilt = ['v2'];
    // 2 cities vs 0 active knights -> defeat
    const resultDefeat = ckEngine.ckModule.resolveBarbarianAttack();
    assert.equal(resultDefeat.outcome, 'defeat');
    assert.equal(ckEngine.barbariansHaveAttacked, true);
    assert.equal(ckEngine.barbarianPosition, 0);

    // Active knights >= cities -> victory
    ckEngine.players[0].knightsPlaced = [{ active: true, strength: 2 }];
    ckEngine.players[1].knightsPlaced = [{ active: true, strength: 1 }];
    const resultVictory = ckEngine.ckModule.resolveBarbarianAttack();
    assert.equal(resultVictory.outcome, 'victory');
    assert.equal(ckEngine.defenderOfCatan, 'p1');
  });
});
