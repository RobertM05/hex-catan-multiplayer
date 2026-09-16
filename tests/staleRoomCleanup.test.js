/**
 * SEC-01: stale RoomManager cleanup for inactive rooms.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, STALE_ROOM_MAX_AGE_MS } from '../server/game/RoomManager.js';

function mockIo() {
  return { to: () => ({ emit: () => {} }) };
}

describe('SEC-01 stale room cleanup', () => {
  it('starts an unref\'d periodic cleanup timer by default', () => {
    const rm = new RoomManager(mockIo());
    assert.ok(rm.staleCleanupInterval);
    assert.equal(rm.staleRoomMaxAgeMs, STALE_ROOM_MAX_AGE_MS);
    if (typeof rm.staleCleanupInterval.hasRef === 'function') {
      assert.equal(rm.staleCleanupInterval.hasRef(), false);
    }
    rm.stopStaleCleanup();
  });

  it('destroys rooms that have been inactive for about 2 hours', () => {
    const rm = new RoomManager(mockIo(), { staleCleanupIntervalMs: 0 });
    const stale = rm.createRoom({ id: 'h1', name: 'StaleHost', socketId: 's1' });
    const fresh = rm.createRoom({ id: 'h2', name: 'FreshHost', socketId: 's2' });
    stale.lastActivity = Date.now() - STALE_ROOM_MAX_AGE_MS - 1000;
    const removed = rm.cleanupStaleRooms();
    assert.ok(removed.includes(stale.code));
    assert.equal(rm.getRoom(stale.code), undefined);
    assert.ok(rm.getRoom(fresh.code));
    rm.destroyRoom(fresh.code);
    rm.stopStaleCleanup();
  });

  it('keeps a recently touched room', () => {
    const rm = new RoomManager(mockIo(), { staleCleanupIntervalMs: 0, staleRoomMaxAgeMs: 1000 });
    const room = rm.createRoom({ id: 'h3', name: 'ActiveHost', socketId: 's3' });
    room.lastActivity = Date.now() - 500;
    assert.equal(rm.cleanupStaleRooms().length, 0);
    assert.ok(rm.getRoom(room.code));
    rm.destroyRoom(room.code);
    rm.stopStaleCleanup();
  });
});
