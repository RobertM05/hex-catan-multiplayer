/**
 * Sliding-window rate limiter for socket events (SEC-02 / SCALE-02).
 * Supports both standalone in-memory sliding window and distributed
 * Redis-backed sliding window via atomic Lua scripts.
 */

export const RATE_LIMITED = 'RATE_LIMITED';

export const RATE_LIMITS = {
  createRoom: { max: 5, windowMs: 60_000 },
  sendChat: { max: 5, windowMs: 3_000 },
  gameAction: { max: 25, windowMs: 5_000 }
};

export function createRoomLimitKey(ip) {
  return `create:${ip || 'unknown'}`;
}

export function chatLimitKey(playerId, socketId) {
  return `chat:${playerId || socketId}`;
}

export function actionLimitKey(socketId) {
  return `action:${socketId}`;
}

const REDIS_SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxHits = tonumber(ARGV[3])
local member = ARGV[4]

local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= maxHits then
  return 0
else
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return 1
end
`;

export class SlidingWindowLimiter {
  constructor({ redisClient = null, keyPrefix = 'catan:rl:' } = {}) {
    this.windows = new Map();
    this.redisClient = redisClient;
    this.keyPrefix = keyPrefix;
  }

  setRedisClient(client, { keyPrefix = 'catan:rl:' } = {}) {
    this.redisClient = client;
    this.keyPrefix = keyPrefix;
  }

  /**
   * In-memory synchronous sliding window check.
   */
  allow(key, max, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    let hits = this.windows.get(key);
    if (!hits) {
      hits = [];
    } else {
      hits = hits.filter((t) => t > cutoff);
    }
    if (hits.length >= max) {
      if (hits.length) this.windows.set(key, hits);
      else this.windows.delete(key);
      return false;
    }
    hits.push(now);
    this.windows.set(key, hits);
    return true;
  }

  consume(key, spec, now = Date.now()) {
    return this.allow(key, spec.max, spec.windowMs, now);
  }

  /**
   * Asynchronous distributed sliding window check against Redis with in-memory fallback.
   */
  async allowAsync(key, max, windowMs, now = Date.now()) {
    if (this.redisClient) {
      try {
        const fullKey = `${this.keyPrefix}${key}`;
        const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
        const result = typeof this.redisClient.eval === 'function'
          ? await this.redisClient.eval(REDIS_SLIDING_WINDOW_LUA, {
              keys: [fullKey],
              arguments: [String(now), String(windowMs), String(max), member]
            })
          : null;

        if (result !== null && result !== undefined) {
          return Number(result) === 1;
        }
      } catch (err) {
        // Redis error: gracefully fall back to local in-memory
      }
    }
    return this.allow(key, max, windowMs, now);
  }

  async consumeAsync(key, spec, now = Date.now()) {
    return this.allowAsync(key, spec.max, spec.windowMs, now);
  }

  clearKey(key) {
    this.windows.delete(key);
  }

  async clearKeyAsync(key) {
    this.clearKey(key);
    if (this.redisClient) {
      try {
        await this.redisClient.del(`${this.keyPrefix}${key}`);
      } catch {}
    }
  }

  clearSocket(socketId, playerId = null) {
    if (socketId) {
      this.clearKey(actionLimitKey(socketId));
      this.clearKey(chatLimitKey(null, socketId));
    }
    if (playerId) this.clearKey(chatLimitKey(playerId));
  }

  async clearSocketAsync(socketId, playerId = null) {
    this.clearSocket(socketId, playerId);
    if (socketId) {
      await this.clearKeyAsync(actionLimitKey(socketId));
      await this.clearKeyAsync(chatLimitKey(null, socketId));
    }
    if (playerId) {
      await this.clearKeyAsync(chatLimitKey(playerId));
    }
  }

  size() {
    return this.windows.size;
  }
}
