/**
 * Pure turn/phase status helpers for the in-game HUD (UX-04).
 * Kept DOM-free so node:test can import it without a browser.
 */

export const BUILD_COSTS = {
  ROAD: { wood: 1, brick: 1 },
  SETTLEMENT: { wood: 1, brick: 1, wool: 1, wheat: 1 },
  CITY: { ore: 3, wheat: 2 },
  DEV_CARD: { ore: 1, wool: 1, wheat: 1 },
  WALL: { brick: 2 }
};

export function mapPhaseToStatusKey(phase, isMyTurn) {
  switch (phase) {
    case 'TURN_ROLL':
      return isMyTurn ? 'STATUS_YOUR_ROLL' : 'STATUS_WAIT_ROLL';
    case 'TURN_DISCARD':
      return isMyTurn ? 'STATUS_YOUR_DISCARD' : 'STATUS_WAIT_DISCARD';
    case 'TURN_ROBBER':
      return isMyTurn ? 'STATUS_YOUR_ROBBER' : 'STATUS_WAIT_ROBBER';
    case 'TURN_ACTION':
      return isMyTurn ? 'STATUS_YOUR_ACTION' : 'STATUS_WAIT_ACTION';
    case 'SETUP_ROUND_1':
    case 'SETUP_ROUND_2':
      return isMyTurn ? 'STATUS_YOUR_SETUP' : 'STATUS_WAIT_SETUP';
    case 'TURN_BARBARIAN_RESOLVE':
    case 'TURN_BARBARIAN_DOWNGRADE':
      return isMyTurn ? 'STATUS_YOUR_BARBARIAN' : 'STATUS_WAIT_BARBARIAN';
    case 'GAME_OVER':
      return 'STATUS_GAME_OVER';
    default:
      return 'STATUS_WAIT_GENERIC';
  }
}

export function mapPhaseToOpponentStateKey(phase, isActivePlayer) {
  if (!isActivePlayer) return 'OPP_STATE_WAITING';
  switch (phase) {
    case 'TURN_ROLL':
      return 'OPP_STATE_ROLLING';
    case 'TURN_DISCARD':
      return 'OPP_STATE_DISCARDING';
    case 'TURN_ROBBER':
      return 'OPP_STATE_ROBBER';
    case 'TURN_ACTION':
    case 'SETUP_ROUND_1':
    case 'SETUP_ROUND_2':
      return 'OPP_STATE_ACTING';
    default:
      return 'OPP_STATE_WAITING';
  }
}

export function canPayCost(resources = {}, cost = {}) {
  return Object.entries(cost).every(([res, amt]) => (Number(resources[res]) || 0) >= amt);
}
