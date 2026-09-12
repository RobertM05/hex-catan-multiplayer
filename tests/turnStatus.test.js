import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPhaseToStatusKey,
  mapPhaseToOpponentStateKey,
  canPayCost,
  BUILD_COSTS
} from '../public/js/turnStatus.js';

describe('UX-04 phase to status mapping', () => {
  it('maps each known phase to the expected key for the active player', () => {
    assert.equal(mapPhaseToStatusKey('TURN_ROLL', true), 'STATUS_YOUR_ROLL');
    assert.equal(mapPhaseToStatusKey('TURN_DISCARD', true), 'STATUS_YOUR_DISCARD');
    assert.equal(mapPhaseToStatusKey('TURN_ROBBER', true), 'STATUS_YOUR_ROBBER');
    assert.equal(mapPhaseToStatusKey('TURN_ACTION', true), 'STATUS_YOUR_ACTION');
    assert.equal(mapPhaseToStatusKey('SETUP_ROUND_1', true), 'STATUS_YOUR_SETUP');
    assert.equal(mapPhaseToStatusKey('SETUP_ROUND_2', true), 'STATUS_YOUR_SETUP');
    assert.equal(mapPhaseToStatusKey('TURN_BARBARIAN_RESOLVE', true), 'STATUS_YOUR_BARBARIAN');
    assert.equal(mapPhaseToStatusKey('TURN_BARBARIAN_DOWNGRADE', true), 'STATUS_YOUR_BARBARIAN');
    assert.equal(mapPhaseToStatusKey('GAME_OVER', true), 'STATUS_GAME_OVER');
  });

  it('maps each known phase to a waiting key when it is not your turn', () => {
    assert.equal(mapPhaseToStatusKey('TURN_ROLL', false), 'STATUS_WAIT_ROLL');
    assert.equal(mapPhaseToStatusKey('TURN_DISCARD', false), 'STATUS_WAIT_DISCARD');
    assert.equal(mapPhaseToStatusKey('TURN_ROBBER', false), 'STATUS_WAIT_ROBBER');
    assert.equal(mapPhaseToStatusKey('TURN_ACTION', false), 'STATUS_WAIT_ACTION');
    assert.equal(mapPhaseToStatusKey('SETUP_ROUND_1', false), 'STATUS_WAIT_SETUP');
    assert.equal(mapPhaseToStatusKey('TURN_BARBARIAN_RESOLVE', false), 'STATUS_WAIT_BARBARIAN');
  });

  it('falls back to a generic waiting message for unknown phases', () => {
    assert.equal(mapPhaseToStatusKey('SOME_NEW_PHASE', false), 'STATUS_WAIT_GENERIC');
    assert.equal(mapPhaseToStatusKey(undefined, true), 'STATUS_WAIT_GENERIC');
  });

  it('maps opponent cards to rolling, discarding, robber, acting, or waiting', () => {
    assert.equal(mapPhaseToOpponentStateKey('TURN_ROLL', true), 'OPP_STATE_ROLLING');
    assert.equal(mapPhaseToOpponentStateKey('TURN_DISCARD', true), 'OPP_STATE_DISCARDING');
    assert.equal(mapPhaseToOpponentStateKey('TURN_ROBBER', true), 'OPP_STATE_ROBBER');
    assert.equal(mapPhaseToOpponentStateKey('TURN_ACTION', true), 'OPP_STATE_ACTING');
    assert.equal(mapPhaseToOpponentStateKey('TURN_ACTION', false), 'OPP_STATE_WAITING');
  });

  it('checks build costs against a resource hand', () => {
    assert.equal(canPayCost({ wood: 1, brick: 1 }, BUILD_COSTS.ROAD), true);
    assert.equal(canPayCost({ wood: 1, brick: 0 }, BUILD_COSTS.ROAD), false);
  });
});
