function restHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}

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

export function createSupabaseAdmin({ url, serviceRole, fetchImpl = fetch } = {}) {
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
      const rows = await rest(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,display_name,ad_free`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async updateDisplayName(userId, displayName) {
      const rows = await rest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: { display_name: displayName }
      });
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
        `match_players?user_id=eq.${encodeURIComponent(userId)}&select=match_id,seat_index,display_name,vp,rank,abandoned,matches(id,started_at,ended_at,mode,ranked,room_code)`
      );
      return Array.isArray(players) ? players : [];
    }
  };
}

export function summarizeStats(rows) {
  const matches = rows.length;
  const wins = rows.filter(r => Number(r.rank) === 1).length;
  const rankSum = rows.reduce((sum, r) => sum + Number(r.rank || 0), 0);
  const vpSum = rows.reduce((sum, r) => sum + Number(r.vp || 0), 0);
  return {
    matches,
    wins,
    averageRank: matches ? Math.round((rankSum / matches) * 100) / 100 : null,
    averageVp: matches ? Math.round((vpSum / matches) * 100) / 100 : null,
    recent: rows.slice(0, 20).map(r => ({
      matchId: r.match_id,
      rank: r.rank,
      vp: r.vp,
      abandoned: Boolean(r.abandoned),
      mode: r.matches?.mode || null,
      endedAt: r.matches?.ended_at || null,
      roomCode: r.matches?.room_code || null
    }))
  };
}
