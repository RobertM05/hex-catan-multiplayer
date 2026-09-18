/**
 * Lightweight in-memory LRU profile cache with TTL and stale fallback.
 * Minimizes database queries to Supabase during socket handshakes and stats resolution.
 */

export class ProfileCache {
  constructor({ capacity = 1000, ttl = 600_000 } = {}) {
    this.capacity = capacity;
    this.defaultTtl = ttl;
    this.cache = new Map();
  }

  get(userId) {
    if (!userId) return null;
    const entry = this.cache.get(userId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      return null;
    }

    // Refresh LRU order (delete & re-insert)
    this.cache.delete(userId);
    this.cache.set(userId, entry);
    return entry.value;
  }

  getStale(userId) {
    if (!userId) return null;
    const entry = this.cache.get(userId);
    return entry ? entry.value : null;
  }

  set(userId, profile, ttl = this.defaultTtl) {
    if (!userId || profile == null) return;
    const now = Date.now();
    const entry = {
      value: profile,
      cachedAt: now,
      expiresAt: now + (ttl != null ? ttl : this.defaultTtl)
    };

    if (this.cache.has(userId)) {
      this.cache.delete(userId);
    } else if (this.cache.size >= this.capacity) {
      // Evict least recently used (first key in insertion order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(userId, entry);
  }

  delete(userId) {
    if (!userId) return false;
    return this.cache.delete(userId);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

export const defaultProfileCache = new ProfileCache();

export function getProfileCache() {
  return defaultProfileCache;
}

export function invalidateProfile(userId) {
  return defaultProfileCache.delete(userId);
}

export function clearProfileCache() {
  defaultProfileCache.clear();
}

/**
 * Resolves a profile with cache hit / miss / fallback handling.
 * 1. Checks cache for active (non-expired) profile.
 * 2. If miss or expired, executes fetchFn().
 * 3. On success, writes to cache and returns.
 * 4. On error, returns stale profile if present; otherwise throws error.
 */
export async function resolveProfileWithCache(userId, fetchFn, { cache = defaultProfileCache, ttl } = {}) {
  if (!userId) return null;
  const targetCache = cache || defaultProfileCache;

  const hit = targetCache.get(userId);
  if (hit) {
    return hit;
  }

  try {
    const profile = await fetchFn(userId);
    if (profile) {
      targetCache.set(userId, profile, ttl);
      return profile;
    }
    return null;
  } catch (err) {
    const stale = targetCache.getStale(userId);
    if (stale) {
      console.warn(`[profileCache] fetch failed for user ${userId}, using stale profile:`, err.message);
      return stale;
    }
    throw err;
  }
}
