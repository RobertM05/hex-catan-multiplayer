import test from 'node:test';
import assert from 'node:assert';
import { persistFinishedMatch, flushPendingQueue, queue } from '../server/auth/matchStore.js';

test('MatchPersistenceQueue', async (t) => {
  let adminInsertCalls = 0;
  let insertError = null;

  const mockRuntime = {
    admin: {
      insertMatch: async (matchRow, playerRows) => {
        adminInsertCalls++;
        if (insertError) throw insertError;
        return true;
      }
    }
  };

  const createMockRoom = (matchId) => ({
    engine: { isGameOver: true, players: [{ id: 'p1', userId: 'u1', name: 'p1', victoryPoints: 10 }] },
    players: [{ id: 'p1', userId: 'u1', name: 'p1' }],
    code: 'TEST',
    matchId
  });

  t.beforeEach(() => {
    adminInsertCalls = 0;
    insertError = null;
    queue.clear();
  });

  await t.test('Successful insert does not queue', async () => {
    const room = createMockRoom('m1');
    const res = await persistFinishedMatch(room, mockRuntime);
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(queue.size, 0);
    assert.strictEqual(adminInsertCalls, 1);
  });

  await t.test('4xx client errors do not enter retry loop', async () => {
    const room = createMockRoom('m2');
    const err = new Error('Bad Request');
    err.status = 400;
    insertError = err;
    
    const res = await persistFinishedMatch(room, mockRuntime);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'error');
    assert.strictEqual(queue.size, 0);
    assert.strictEqual(adminInsertCalls, 1);
  });

  await t.test('5xx error / network error enqueues with backoff and retries', async () => {
    const room = createMockRoom('m3');
    const err = new Error('Internal Server Error');
    err.status = 500;
    insertError = err;
    
    const res = await persistFinishedMatch(room, mockRuntime);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'queued_for_retry');
    assert.strictEqual(queue.size, 1);
    assert.strictEqual(adminInsertCalls, 1);
    
    // Simulate API recovery
    insertError = null;
    
    // Force drain
    await flushPendingQueue(100);
    assert.strictEqual(queue.size, 0);
    assert.strictEqual(adminInsertCalls, 2);
  });

  await t.test('Idempotent deduplication prevents duplicate inserts', async () => {
    const room1 = createMockRoom('m4');
    const room2 = createMockRoom('m4');
    
    const err = new Error('Internal Server Error');
    err.status = 500;
    insertError = err;

    const res1 = await persistFinishedMatch(room1, mockRuntime);
    assert.strictEqual(queue.size, 1);

    const res2 = await persistFinishedMatch(room2, mockRuntime);
    assert.strictEqual(res2.skipped, true);
    // Deduplication should return in_flight
    assert.strictEqual(res2.reason, 'in_flight');
    
    assert.strictEqual(queue.size, 1);
    assert.strictEqual(adminInsertCalls, 1); // Only 1 call attempted
  });
});
