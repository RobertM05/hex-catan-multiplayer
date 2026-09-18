import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProfileCache,
  resolveProfileWithCache,
  invalidateProfile,
  clearProfileCache,
  getProfileCache
} from '../server/auth/profileCache.js';
import { createSupabaseAdmin } from '../server/auth/supabase.js';

describe('DATA-02: In-memory LRU profile cache', () => {
  let cache;

  beforeEach(() => {
    cache = new ProfileCache({ capacity: 3, ttl: 1000 });
  });

  it('stores and retrieves profile within TTL (cache hit)', () => {
    cache.set('user-1', { id: 'user-1', displayName: 'Alice' });
    const profile = cache.get('user-1');
    assert.deepEqual(profile, { id: 'user-1', displayName: 'Alice' });
  });

  it('returns null for nonexistent keys (cache miss)', () => {
    assert.equal(cache.get('nonexistent'), null);
    assert.equal(cache.get(null), null);
    assert.equal(cache.get(''), null);
  });

  it('expires entries after TTL', async () => {
    const shortCache = new ProfileCache({ capacity: 10, ttl: 20 });
    shortCache.set('user-exp', { id: 'user-exp', displayName: 'ExpiringUser' });

    assert.ok(shortCache.get('user-exp'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(shortCache.get('user-exp'), null);
  });

  it('preserves stale entry via getStale even after expiration', async () => {
    const shortCache = new ProfileCache({ capacity: 10, ttl: 20 });
    shortCache.set('user-stale', { id: 'user-stale', displayName: 'StaleUser' });

    await new Promise(r => setTimeout(r, 30));
    assert.equal(shortCache.get('user-stale'), null);
    assert.deepEqual(shortCache.getStale('user-stale'), { id: 'user-stale', displayName: 'StaleUser' });
  });

  it('evicts least recently used items when capacity is reached', () => {
    cache.set('u1', { name: 'User 1' });
    cache.set('u2', { name: 'User 2' });
    cache.set('u3', { name: 'User 3' });
    assert.equal(cache.size, 3);

    // Reading u1 makes it recently used; u2 is now least recently used
    cache.get('u1');

    // Adding u4 should evict u2
    cache.set('u4', { name: 'User 4' });
    assert.equal(cache.size, 3);
    assert.equal(cache.get('u2'), null, 'u2 should have been evicted');
    assert.ok(cache.get('u1'), 'u1 should remain cached');
    assert.ok(cache.get('u3'), 'u3 should remain cached');
    assert.ok(cache.get('u4'), 'u4 should remain cached');
  });

  it('evicts correctly at capacity 1000 boundary', () => {
    const bigCache = new ProfileCache({ capacity: 1000, ttl: 600_000 });
    for (let i = 1; i <= 1000; i++) {
      bigCache.set(`user-${i}`, { index: i });
    }
    assert.equal(bigCache.size, 1000);
    assert.ok(bigCache.get('user-1'));

    // Adding user-1001 should evict user-2 (since user-1 was refreshed by get())
    bigCache.set('user-1001', { index: 1001 });
    assert.equal(bigCache.size, 1000);
    assert.equal(bigCache.get('user-2'), null);
    assert.ok(bigCache.get('user-1'));
    assert.ok(bigCache.get('user-1001'));
  });

  it('deletes and clears entries properly', () => {
    cache.set('u1', { name: 'User 1' });
    assert.equal(cache.delete('u1'), true);
    assert.equal(cache.get('u1'), null);
    assert.equal(cache.delete('u1'), false);

    cache.set('u2', { name: 'User 2' });
    cache.set('u3', { name: 'User 3' });
    assert.equal(cache.size, 2);
    cache.clear();
    assert.equal(cache.size, 0);
  });

  describe('resolveProfileWithCache', () => {
    it('hits cache and does not call fetchFn when cached', async () => {
      let fetchCalls = 0;
      const fetchFn = async () => {
        fetchCalls++;
        return { id: 'u1', display_name: 'FetchedAlice' };
      };

      const res1 = await resolveProfileWithCache('u1', fetchFn, { cache });
      assert.deepEqual(res1, { id: 'u1', display_name: 'FetchedAlice' });
      assert.equal(fetchCalls, 1);

      // Second call hits cache
      const res2 = await resolveProfileWithCache('u1', fetchFn, { cache });
      assert.deepEqual(res2, { id: 'u1', display_name: 'FetchedAlice' });
      assert.equal(fetchCalls, 1, 'fetchFn must not be called again');
    });

    it('falls back to stale cache on fetchFn error', async () => {
      const shortCache = new ProfileCache({ capacity: 10, ttl: 15 });
      shortCache.set('u1', { id: 'u1', display_name: 'OldName' });

      // Wait for expiration
      await new Promise(r => setTimeout(r, 25));
      assert.equal(shortCache.get('u1'), null);

      // Fetcher fails (e.g. Supabase network error)
      const failingFetcher = async () => {
        throw new Error('Supabase 503 Gateway Timeout');
      };

      const result = await resolveProfileWithCache('u1', failingFetcher, { cache: shortCache });
      assert.deepEqual(result, { id: 'u1', display_name: 'OldName' }, 'Must return stale profile on failure');
    });

    it('propagates error when no stale cache entry exists', async () => {
      const failingFetcher = async () => {
        throw new Error('Supabase Connection Refused');
      };

      await assert.rejects(
        () => resolveProfileWithCache('nonexistent', failingFetcher, { cache }),
        /Supabase Connection Refused/
      );
    });
  });

  describe('createSupabaseAdmin caching & invalidation', () => {
    it('caches getProfile results and invalidates on updateProfile/upsertProfile', async () => {
      let dbProfiles = {
        'uuid-1': { id: 'uuid-1', display_name: 'OriginalBob', avatar_url: null }
      };
      let restCount = 0;

      const mockFetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        if (method === 'GET') {
          restCount++;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify([dbProfiles['uuid-1']])
          };
        }
        if (method === 'PATCH' || method === 'POST') {
          const body = JSON.parse(opts.body || '{}');
          if (body.display_name) dbProfiles['uuid-1'].display_name = body.display_name;
          if (body.avatar_url !== undefined) dbProfiles['uuid-1'].avatar_url = body.avatar_url;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify([dbProfiles['uuid-1']])
          };
        }
        return { ok: false, status: 404, text: async () => '' };
      };

      const adminCache = new ProfileCache({ capacity: 10, ttl: 600_000 });
      const admin = createSupabaseAdmin({
        url: 'https://fake.supabase.co',
        serviceRole: 'fake_secret',
        fetchImpl: mockFetch,
        profileCache: adminCache
      });

      // 1. Initial lookup -> misses cache, calls REST API
      const p1 = await admin.getProfile('uuid-1');
      assert.equal(p1.display_name, 'OriginalBob');
      assert.equal(restCount, 1);

      // 2. Second lookup -> hits cache, 0 extra REST calls
      const p2 = await admin.getProfile('uuid-1');
      assert.equal(p2.display_name, 'OriginalBob');
      assert.equal(restCount, 1);

      // 3. Update profile -> invalidates cache
      await admin.updateProfile('uuid-1', { displayName: 'UpdatedBob' });
      assert.equal(adminCache.get('uuid-1'), null, 'Cache must be invalidated after update');

      // 4. Third lookup -> fetches fresh profile from REST API
      const p3 = await admin.getProfile('uuid-1');
      assert.equal(p3.display_name, 'UpdatedBob');
      assert.equal(restCount, 2);
    });
  });

  describe('global default instance & exports', () => {
    it('invalidateProfile and clearProfileCache affect defaultProfileCache', () => {
      const defaultCache = getProfileCache();
      defaultCache.set('test-user', { id: 'test-user', displayName: 'DefaultAlice' });
      assert.ok(defaultCache.get('test-user'));

      invalidateProfile('test-user');
      assert.equal(defaultCache.get('test-user'), null);

      defaultCache.set('uA', { name: 'A' });
      defaultCache.set('uB', { name: 'B' });
      clearProfileCache();
      assert.equal(defaultCache.size, 0);
    });
  });
});
