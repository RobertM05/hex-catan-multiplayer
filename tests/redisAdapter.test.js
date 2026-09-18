import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter, actionLimitKey, chatLimitKey, createRoomLimitKey } from '../server/game/rateLimiter.js';
import { initRedisAdapter, closeRedisClients, getRedisClients } from '../server/redis.js';

test('initRedisAdapter returns null when REDIS_URL is not configured', async () => {
  const result = await initRedisAdapter({ redisUrl: '' });
  assert.equal(result, null);
  const { pubClient, subClient } = getRedisClients();
  assert.equal(pubClient, null);
  assert.equal(subClient, null);
});

test('initRedisAdapter handles connection errors gracefully without throwing', async () => {
  // Using an unreachable port to simulate failed connection
  const result = await initRedisAdapter({ redisUrl: 'redis://127.0.0.1:54321' });
  assert.equal(result, null);
  const { pubClient, subClient } = getRedisClients();
  assert.equal(pubClient, null);
  assert.equal(subClient, null);
});

test('SlidingWindowLimiter works synchronously without Redis', () => {
  const limiter = new SlidingWindowLimiter();
  const key = 'test-key-sync';
  const spec = { max: 2, windowMs: 1000 };

  assert.equal(limiter.consume(key, spec), true);
  assert.equal(limiter.consume(key, spec), true);
  assert.equal(limiter.consume(key, spec), false);

  limiter.clearKey(key);
  assert.equal(limiter.consume(key, spec), true);
});

test('SlidingWindowLimiter async methods work with in-memory fallback', async () => {
  const limiter = new SlidingWindowLimiter();
  const key = 'test-key-async-fallback';
  const spec = { max: 2, windowMs: 1000 };

  const r1 = await limiter.consumeAsync(key, spec);
  const r2 = await limiter.consumeAsync(key, spec);
  const r3 = await limiter.consumeAsync(key, spec);

  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(r3, false);

  await limiter.clearKeyAsync(key);
  assert.equal(await limiter.consumeAsync(key, spec), true);
});

test('SlidingWindowLimiter delegates to Redis Lua script when client is set', async () => {
  let evalCalled = false;
  let evalArgs = null;
  let returnAllowed = 1;

  const mockRedis = {
    eval: async (script, opts) => {
      evalCalled = true;
      evalArgs = opts;
      return returnAllowed;
    },
    del: async (key) => {
      return 1;
    }
  };

  const limiter = new SlidingWindowLimiter({ redisClient: mockRedis, keyPrefix: 'test:' });
  const key = 'player-123';
  const spec = { max: 5, windowMs: 3000 };

  const allowed1 = await limiter.consumeAsync(key, spec, 10000);
  assert.equal(allowed1, true);
  assert.equal(evalCalled, true);
  assert.deepEqual(evalArgs.keys, ['test:player-123']);
  assert.equal(evalArgs.arguments[0], '10000'); // now
  assert.equal(evalArgs.arguments[1], '3000');  // windowMs
  assert.equal(evalArgs.arguments[2], '5');     // max

  // When Redis returns 0 (limit exceeded)
  returnAllowed = 0;
  const allowed2 = await limiter.consumeAsync(key, spec, 10001);
  assert.equal(allowed2, false);

  // Clearing socket
  let delKeys = [];
  mockRedis.del = async (k) => {
    delKeys.push(k);
    return 1;
  };
  await limiter.clearSocketAsync('socket-xyz', 'p-1');
  assert.ok(delKeys.includes('test:action:socket-xyz'));
  assert.ok(delKeys.includes('test:chat:p-1'));
});

test('SlidingWindowLimiter falls back to local in-memory if Redis eval throws', async () => {
  const mockFailingRedis = {
    eval: async () => {
      throw new Error('Connection lost to Redis');
    }
  };

  const limiter = new SlidingWindowLimiter({ redisClient: mockFailingRedis });
  const key = 'fallback-on-error';
  const spec = { max: 2, windowMs: 1000 };

  // Should catch the Redis error and succeed with in-memory limiter
  const r1 = await limiter.consumeAsync(key, spec);
  const r2 = await limiter.consumeAsync(key, spec);
  const r3 = await limiter.consumeAsync(key, spec);

  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(r3, false);
});

test('closeRedisClients closes open clients safely', async () => {
  await closeRedisClients();
  const { pubClient, subClient } = getRedisClients();
  assert.equal(pubClient, null);
  assert.equal(subClient, null);
});
