/**
 * SEC-01: stale RoomManager cleanup for inactive rooms.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, STALE_ROOM_MAX_AGE_MS } from '../server/game/RoomManager.js';
import { killSpawnedAgentsForRoom, spawnedAgents } from '../server/server.js';

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

  it('invokes onRoomDestroyed when destroyRoom runs', () => {
    const destroyed = [];
    const rm = new RoomManager(mockIo(), {
      staleCleanupIntervalMs: 0,
      onRoomDestroyed: (code) => destroyed.push(code)
    });
    const room = rm.createRoom({ id: 'h4', name: 'HookHost', socketId: 's4' });
    rm.destroyRoom(room.code);
    assert.deepEqual(destroyed, [room.code]);
    rm.stopStaleCleanup();
  });

  it('stale sweep teardown invokes onRoomDestroyed for removed rooms', () => {
    const destroyed = [];
    const rm = new RoomManager(mockIo(), {
      staleCleanupIntervalMs: 0,
      onRoomDestroyed: (code) => destroyed.push(code)
    });
    const stale = rm.createRoom({ id: 'h5', name: 'SweepHost', socketId: 's5' });
    stale.lastActivity = Date.now() - STALE_ROOM_MAX_AGE_MS - 1000;
    const removed = rm.cleanupStaleRooms();
    assert.deepEqual(removed, [stale.code]);
    assert.deepEqual(destroyed, [stale.code]);
    rm.stopStaleCleanup();
  });

  it('killSpawnedAgentsForRoom kills tracked children and clears tracking', () => {
    const kills = [];
    const mockChild = {
      killed: false,
      kill(signal) {
        kills.push(signal);
        this.killed = true;
      }
    };
    const code = 'ZZZZZ';
    spawnedAgents.set(code, [mockChild]);
    try {
      killSpawnedAgentsForRoom(code);
      assert.deepEqual(kills, ['SIGTERM']);
      assert.equal(mockChild.killed, true);
      assert.equal(spawnedAgents.has(code), false);
    } finally {
      spawnedAgents.delete(code);
    }
  });

  it('destroyRoom via RoomManager hook kills spawned agents for that room', () => {
    const kills = [];
    const mockChild = {
      killed: false,
      kill(signal) {
        kills.push(signal);
        this.killed = true;
      }
    };
    const rm = new RoomManager(mockIo(), {
      staleCleanupIntervalMs: 0,
      onRoomDestroyed: killSpawnedAgentsForRoom
    });
    const room = rm.createRoom({ id: 'h6', name: 'AgentHost', socketId: 's6' });
    spawnedAgents.set(room.code, [mockChild]);
    try {
      rm.destroyRoom(room.code);
      assert.deepEqual(kills, ['SIGTERM']);
      assert.equal(spawnedAgents.has(room.code), false);
    } finally {
      spawnedAgents.delete(room.code);
      rm.stopStaleCleanup();
    }
  });
});
