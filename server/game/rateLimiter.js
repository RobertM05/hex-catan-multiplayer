/**
 * Sliding-window rate limiter for socket events (SEC-02).
 * Keys are caller-defined (IP, player id, socket id). Empty windows are pruned.
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

export class SlidingWindowLimiter {
  constructor() {
    this.windows = new Map();
  }

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

  clearKey(key) {
    this.windows.delete(key);
  }

  /**
   * Drop chat/action buckets for a disconnected socket/player.
   * IP create_room buckets are left intact (they are not socket-scoped).
   */
  clearSocket(socketId, playerId = null) {
    if (socketId) {
      this.clearKey(actionLimitKey(socketId));
      this.clearKey(chatLimitKey(null, socketId));
    }
    if (playerId) this.clearKey(chatLimitKey(playerId));
  }

  size() {
    return this.windows.size;
  }
}
