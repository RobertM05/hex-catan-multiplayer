function restHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}

import { resolveProfileWithCache, defaultProfileCache } from './profileCache.js';

export function isSupabaseConfigured(env = process.env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
}

export function isSupabaseAdminConfigured(env = process.env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE);
}

export function publicAuthConfig(env = process.env) {
  if (!isSupabaseConfigured(env)) {
    return { enabled: false, url: null, anonKey: null };
  }
  return {
    enabled: true,
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY
  };
}

export function createSupabaseAdmin({ url, serviceRole, fetchImpl = fetch, profileCache = defaultProfileCache } = {}) {
  if (!url || !serviceRole) return null;
  const base = String(url).replace(/\/$/, '');

  async function rest(path, { method = 'GET', body, extraHeaders } = {}) {
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method,
      headers: { ...restHeaders(serviceRole), ...(extraHeaders || {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(`SUPABASE_REST_${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    async getProfile(userId) {
      if (!userId) return null;
      return resolveProfileWithCache(userId, async () => {
        const rows = await rest(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,display_name,ad_free,avatar_url`);
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
      }, { cache: profileCache });
    },

    async updateDisplayName(userId, displayName) {
      const rows = await rest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: { display_name: displayName }
      });
      if (profileCache) profileCache.delete(userId);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async updateProfile(userId, { displayName, avatarUrl } = {}) {
      const body = {};
      if (displayName !== undefined) body.display_name = displayName;
      if (avatarUrl !== undefined) body.avatar_url = avatarUrl;
      let rows = await rest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body
      });
      if (!Array.isArray(rows) || !rows[0]) {
        rows = await rest('profiles?on_conflict=id', {
          method: 'POST',
          extraHeaders: { Prefer: 'return=representation,resolution=merge-duplicates' },
          body: { id: userId, ...body }
        });
      }
      if (profileCache) profileCache.delete(userId);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async insertMatch(matchRow, playerRows) {
      await rest('matches', {
        method: 'POST',
        extraHeaders: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: matchRow
      });
      if (playerRows?.length) {
        await rest('match_players', {
          method: 'POST',
          extraHeaders: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
          body: playerRows
        });
      }
    },

    async listOwnMatchPlayers(userId) {
      const players = await rest(
        `match_players?user_id=eq.${encodeURIComponent(userId)}&select=match_id,seat_index,display_name,vp,rank,abandoned,matches(id,started_at,ended_at,mode,ranked,room_code,match_players(display_name,rank,vp))`
      );
      return Array.isArray(players) ? players : [];
    },

    async getRating(userId) {
      if (!userId) return null;
      const rows = await rest(`ratings?user_id=eq.${encodeURIComponent(userId)}&select=user_id,elo,games,updated_at`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async getRecentMatches(userId, limit = 10) {
      if (!userId) return [];
      const rows = await rest(
        `match_players?user_id=eq.${encodeURIComponent(userId)}&select=match_id,vp,rank,abandoned,matches(id,ended_at,started_at,mode,ranked,expansion_cities_knights,match_players(user_id))&order=matches(ended_at).desc&limit=${limit}`
      );
      return Array.isArray(rows) ? rows : [];
    },

    async upsertProfile(userId, displayName) {
      if (!userId) return null;
      const rows = await rest('profiles?on_conflict=id', {
        method: 'POST',
        extraHeaders: { Prefer: 'return=representation,resolution=merge-duplicates' },
        body: { id: userId, display_name: displayName }
      });
      if (profileCache) profileCache.delete(userId);
      return Array.isArray(rows) && rows[0] ? rows[0] : { id: userId, display_name: displayName };
    }
  };
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '\u2014';
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return '\u2014';
  const diffSec = Math.floor((end - start) / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatDate(isoStr) {
  if (!isoStr) return '\u2014';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return String(isoStr);
    return d.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch {
    return String(isoStr);
  }
}

export function summarizeStats(rows) {
  const matches = rows.length;
  const wins = rows.filter(r => Number(r.rank) === 1).length;
  const rankSum = rows.reduce((sum, r) => sum + Number(r.rank || 0), 0);
  const vpSum = rows.reduce((sum, r) => sum + Number(r.vp || 0), 0);

  return {
    matches,
    wins,
    winRate: matches ? Math.round((wins / matches) * 10000) / 100 : 0,
    pointsPerGame: matches ? Math.round((vpSum / matches) * 100) / 100 : 0,
    totalPoints: vpSum,
    averageRank: matches ? Math.round((rankSum / matches) * 100) / 100 : null,
    averageVp: matches ? Math.round((vpSum / matches) * 100) / 100 : null,
    recent: rows.slice(0, 100).map(r => {
      const matchPlayers = Array.isArray(r.matches?.match_players) ? r.matches.match_players : [];
      const totalInMatch = matchPlayers.length || 4;
      const opponents = matchPlayers.length > 0
        ? matchPlayers.map(p => p.display_name).filter(Boolean)
        : (r.display_name ? [r.display_name] : []);

      return {
        matchId: r.match_id,
        rank: r.rank,
        rankDisplay: `${r.rank}/${totalInMatch}`,
        vp: r.vp,
        abandoned: Boolean(r.abandoned),
        mode: r.matches?.mode || 'classic',
        ranked: Boolean(r.matches?.ranked),
        roomCode: r.matches?.room_code || null,
        startedAt: r.matches?.started_at || null,
        endedAt: r.matches?.ended_at || null,
        dateDisplay: formatDate(r.matches?.ended_at || r.matches?.started_at),
        durationDisplay: formatDuration(r.matches?.started_at, r.matches?.ended_at),
        opponents
      };
    })
  };
}
