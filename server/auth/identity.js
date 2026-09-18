import { extractBearerToken, verifyHs256Jwt } from './jwt.js';
import { createSupabaseAdmin, isSupabaseAdminConfigured } from './supabase.js';

let testOverrides = null;

export function configureAuthRuntime(overrides) {
  testOverrides = overrides;
}

export function getAuthRuntime(env = process.env) {
  const base = envToRuntime(env);
  if (testOverrides && typeof testOverrides === 'object') {
    return { ...base, ...testOverrides };
  }
  return base;
}

const tokenCache = new Map();

export function clearTokenCache(token) {
  if (token) {
    tokenCache.delete(token);
  } else {
    tokenCache.clear();
  }
}

function envToRuntime(env) {
  return {
    jwtSecret: env.SUPABASE_JWT_SECRET || '',
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    admin: isSupabaseAdminConfigured(env)
      ? createSupabaseAdmin({ url: env.SUPABASE_URL, serviceRole: env.SUPABASE_SERVICE_ROLE })
      : null
  };
}

export async function resolveAccessToken(token, runtime = getAuthRuntime()) {
  if (!token) return { userId: null, displayName: null };
  if (!runtime.jwtSecret && !runtime.supabaseUrl) {
    // Auth not configured: ignore tokens so guests keep working without keys.
    return { userId: null, displayName: null };
  }

  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { userId: cached.userId, displayName: cached.displayName };
  }

  let claims = null;
  if (runtime.jwtSecret) {
    claims = verifyHs256Jwt(token, runtime.jwtSecret);
  } else if (runtime.supabaseUrl && runtime.supabaseAnonKey) {
    const base = String(runtime.supabaseUrl).replace(/\/$/, '');
    try {
      const authRes = await fetch(`${base}/auth/v1/user`, {
        headers: {
          apikey: runtime.supabaseAnonKey,
          Authorization: `Bearer ${token}`
        }
      });
      if (!authRes.ok) {
        throw new Error('INVALID_AUTH_TOKEN');
      }
      const userData = await authRes.json();
      if (!userData?.id) {
        throw new Error('INVALID_AUTH_TOKEN');
      }
      claims = {
        sub: userData.id,
        email: userData.email || '',
        display_name: userData.user_metadata?.display_name || ''
      };
    } catch (err) {
      if (err.message === 'INVALID_AUTH_TOKEN') throw err;
      console.warn('[auth] Supabase token verification error:', err.message);
      throw new Error('INVALID_AUTH_TOKEN');
    }
  }

  if (!claims?.sub) {
    return { userId: null, displayName: null };
  }

  let displayName = typeof claims.display_name === 'string' ? claims.display_name.trim() : '';
  if (runtime.admin?.getProfile) {
    try {
      const profile = await runtime.admin.getProfile(claims.sub);
      if (profile?.display_name) displayName = profile.display_name;
    } catch (err) {
      console.warn('[auth] profile lookup failed:', err.message);
    }
  } else if (runtime.supabaseUrl && runtime.supabaseAnonKey) {
    try {
      const base = String(runtime.supabaseUrl).replace(/\/$/, '');
      const profileRes = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(claims.sub)}&select=display_name`, {
        headers: {
          apikey: runtime.supabaseAnonKey,
          Authorization: `Bearer ${token}`
        }
      });
      if (profileRes.ok) {
        const rows = await profileRes.json();
        if (Array.isArray(rows) && rows[0]?.display_name) {
          displayName = rows[0].display_name;
        }
      }
    } catch (err) {
      console.warn('[auth] fallback profile lookup failed:', err.message);
    }
  }

  if (!displayName) {
    if (claims.email) {
      displayName = claims.email.split('@')[0];
    } else {
      displayName = `Player-${String(claims.sub).slice(0, 8)}`;
    }
  }

  const result = { userId: claims.sub, displayName };
  tokenCache.set(token, { ...result, expiresAt: now + 60_000 });
  if (tokenCache.size > 500) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey) tokenCache.delete(oldestKey);
  }
  return result;
}

export async function resolveSocketIdentity(socket, extraToken) {
  const token = (typeof extraToken === 'string' && extraToken.trim())
    ? extraToken.trim()
    : extractBearerToken(socket);
  return resolveAccessToken(token);
}

export function identityFromSocket(socket) {
  return socket.data?.auth || { userId: null, displayName: null };
}
