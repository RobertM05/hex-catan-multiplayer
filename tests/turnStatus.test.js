import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPhaseToStatusKey,
  mapPhaseToOpponentStateKey,
  canPayCost,
  canBuildWall,
  isCityWallHost,
  BUILD_COSTS
} from '../public/js/turnStatus.js';

describe('UX-04 phase to status mapping', () => {
  it('maps each known phase to the expected key for the active player', () => {
    assert.equal(mapPhaseToStatusKey('TURN_ROLL', true), 'STATUS_YOUR_ROLL');
    assert.equal(mapPhaseToStatusKey('TURN_DISCARD', true), 'STATUS_YOUR_DISCARD');
    assert.equal(mapPhaseToStatusKey('TURN_ROBBER', true), 'STATUS_YOUR_ROBBER');
    assert.equal(mapPhaseToStatusKey('TURN_ACTION', true), 'STATUS_YOUR_ACTION');
    assert.equal(mapPhaseToStatusKey('TURN_SPECIAL_BUILDING', true), 'STATUS_YOUR_SBP');
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
    assert.equal(mapPhaseToStatusKey('TURN_SPECIAL_BUILDING', false), 'STATUS_WAIT_SBP');
    assert.equal(mapPhaseToStatusKey('SETUP_ROUND_1', false), 'STATUS_WAIT_SETUP');
    assert.equal(mapPhaseToStatusKey('TURN_BARBARIAN_RESOLVE', false), 'STATUS_WAIT_BARBARIAN');
  });

  it('maps deserter choice phases using extras for the chooser vs spectators', () => {
    assert.equal(mapPhaseToStatusKey('TURN_CHOOSE_DESERTER_KNIGHT', false, { isDeserterChooser: true }), 'STATUS_YOUR_DESERTER_KNIGHT');
    assert.equal(mapPhaseToStatusKey('TURN_CHOOSE_DESERTER_KNIGHT', true, { isDeserterChooser: false }), 'STATUS_WAIT_DESERTER_KNIGHT');
    assert.equal(mapPhaseToStatusKey('TURN_PLACE_DESERTER_KNIGHT', true, { isDeserterPlacer: true }), 'STATUS_YOUR_DESERTER_PLACE');
    assert.equal(mapPhaseToStatusKey('TURN_PLACE_DESERTER_KNIGHT', false, { isDeserterPlacer: false }), 'STATUS_WAIT_DESERTER_PLACE');
    assert.equal(mapPhaseToStatusKey('TURN_DISCARD', false, { mustDiscard: true }), 'STATUS_YOUR_DISCARD');
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
    assert.equal(canPayCost({ brick: 2 }, BUILD_COSTS.WALL), true);
    assert.equal(canPayCost({ brick: 1 }, BUILD_COSTS.WALL), false);
  });
});

describe('canBuildWall helper', () => {
  it('disallows wall building when not in C&K mode', () => {
    const player = { id: 'p1', cityWalls: 3, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'city', playerId: 'p1', hasWall: false } } } };
    const res = canBuildWall(player, false, true, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'REASON_WRONG_PHASE');
  });

  it('disallows wall building when not in action phase', () => {
    const player = { id: 'p1', cityWalls: 3, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'city', playerId: 'p1', hasWall: false } } } };
    const res = canBuildWall(player, true, false, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'REASON_NOT_YOUR_TURN');
  });

  it('disallows wall building when supply is 0', () => {
    const player = { id: 'p1', cityWalls: 0, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'city', playerId: 'p1', hasWall: false } } } };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'ERROR_NO_WALLS_REMAINING');
  });

  it('disallows wall building when player does not have enough resources (brick < 2)', () => {
    const player = { id: 'p1', cityWalls: 3, resources: { brick: 1 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'city', playerId: 'p1', hasWall: false } } } };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'REASON_NOT_ENOUGH_RESOURCES');
  });

  it('disallows wall building when player has no cities built', () => {
    const player = { id: 'p1', cityWalls: 3, resources: { brick: 2 }, citiesBuilt: [] };
    const grid = { vertices: {} };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'ERROR_WALLS_ONLY_ON_CITIES');
  });

  it('disallows wall building when all existing cities already have a wall', () => {
    const player = { id: 'p1', cityWalls: 2, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'city', playerId: 'p1', hasWall: true } } } };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'ERROR_CITY_ALREADY_HAS_WALL');
  });

  it('allows wall building when all requirements are met', () => {
    const player = { id: 'p1', cityWalls: 3, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'city', playerId: 'p1', hasWall: false } } } };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, true);
    assert.equal(res.reasonKey, null);
  });

  it('allows wall building on a metropolis city vertex (CK-39)', () => {
    const player = { id: 'p1', cityWalls: 3, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'metropolis', playerId: 'p1', hasWall: false, hasMetropolis: true } } } };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, true);
    assert.equal(res.reasonKey, null);
  });

  it('disallows wall building when the only city is a walled metropolis', () => {
    const player = { id: 'p1', cityWalls: 2, resources: { brick: 2 }, citiesBuilt: ['v1'] };
    const grid = { vertices: { v1: { building: { type: 'metropolis', playerId: 'p1', hasWall: true, hasMetropolis: true } } } };
    const res = canBuildWall(player, true, true, grid);
    assert.equal(res.allowed, false);
    assert.equal(res.reasonKey, 'ERROR_CITY_ALREADY_HAS_WALL');
  });

  it('treats city and metropolis as wall hosts but not settlements', () => {
    assert.equal(isCityWallHost({ type: 'city' }), true);
    assert.equal(isCityWallHost({ type: 'metropolis' }), true);
    assert.equal(isCityWallHost({ type: 'settlement' }), false);
    assert.equal(isCityWallHost(null), false);
  });
});
