/**
 * redis.js
 * Multi-instance Redis adapter & distributed synchronization for Socket.IO.
 * Enables horizontal scaling across multiple container instances with graceful in-memory fallback.
 */

import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { logger } from './logger.js';

let pubClient = null;
let subClient = null;

/**
 * Initializes Redis pub/sub adapter for Socket.IO and connects distributed rate limiter.
 * If redisUrl is absent or connection fails, falls back gracefully to in-memory mode.
 */
export async function initRedisAdapter({
  redisUrl = process.env.REDIS_URL,
  io = null,
  limiter = null
} = {}) {
  if (!redisUrl) {
    logger.info('REDIS_URL not configured. Running in standalone in-memory mode.');
    return null;
  }

  try {
    pubClient = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 3) return new Error('Redis connection retries exhausted');
          return Math.min(retries * 50, 500);
        }
      }
    });
    pubClient.on('error', (err) => {
      logger.error({ err }, 'Redis Pub Client error');
    });

    subClient = pubClient.duplicate();
    subClient.on('error', (err) => {
      logger.error({ err }, 'Redis Sub Client error');
    });

    await Promise.all([pubClient.connect(), subClient.connect()]);

    if (io && typeof io.adapter === 'function') {
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.IO Redis adapter attached successfully.');
    }

    if (limiter && typeof limiter.setRedisClient === 'function') {
      limiter.setRedisClient(pubClient);
      logger.info('Distributed rate limiter bound to Redis.');
    }

    return { pubClient, subClient };
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Redis adapter; continuing in standalone in-memory mode');
    if (pubClient) {
      try { await pubClient.disconnect(); } catch {}
    }
    if (subClient) {
      try { await subClient.disconnect(); } catch {}
    }
    pubClient = null;
    subClient = null;
    return null;
  }
}

export function getRedisClients() {
  return { pubClient, subClient };
}

export async function closeRedisClients() {
  const promises = [];
  if (pubClient && pubClient.isOpen) {
    promises.push(pubClient.quit().catch(() => pubClient.disconnect()));
  }
  if (subClient && subClient.isOpen) {
    promises.push(subClient.quit().catch(() => subClient.disconnect()));
  }
  await Promise.all(promises);
  pubClient = null;
  subClient = null;
}
