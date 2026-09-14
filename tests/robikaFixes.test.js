import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HexGrid } from '../server/game/HexGrid.js';

describe('Robika #88 hex resource clustering', () => {
  it('avoids three mutually adjacent hexes of the same resource', () => {
    for (let i = 0; i < 12; i++) {
      const grid = new HexGrid({ mapSize: 'standard' });
      assert.equal(grid.hasTightSameResourceCluster(), false);
    }
  });
});
