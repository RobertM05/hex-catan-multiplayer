import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HexGrid } from '../server/game/HexGrid.js';
import { RoomManager } from '../server/game/RoomManager.js';

describe('Robika fixes', () => {
  it('avoids three mutually adjacent hexes of the same resource', () => {
    for (let i = 0; i < 12; i++) {
      const grid = new HexGrid({ mapSize: 'standard' });
      assert.equal(grid.hasTightSameResourceCluster(), false);
    }
  });

  it('blocks start until every human player is ready', () => {
    const rm = new RoomManager({ to: () => ({ emit() {} }) });
    const room = rm.createRoom({ id: 'h1', name: 'Host', socketId: 's1' });
    rm.joinRoom(room.code, { id: 'p2', name: 'Guest', socketId: 's2' });
    assert.throws(() => rm.startGame(room.code, 'h1'), /PLAYERS_NOT_READY/);
    rm.setPlayerReady(room.code, 'p2', true);
    assert.equal(rm.startGame(room.code, 'h1').isStarted, true);
    rm.destroyRoom(room.code);
  });
});
