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

function envToRuntime(env) {
  return {
    jwtSecret: env.SUPABASE_JWT_SECRET || '',
    admin: isSupabaseAdminConfigured(env)
      ? createSupabaseAdmin({ url: env.SUPABASE_URL, serviceRole: env.SUPABASE_SERVICE_ROLE })
      : null
  };
}

export async function resolveAccessToken(token, runtime = getAuthRuntime()) {
  if (!token) return { userId: null, displayName: null };
  if (!runtime.jwtSecret) {
    // Auth not configured: ignore tokens so guests keep working without keys.
    return { userId: null, displayName: null };
  }
  const claims = verifyHs256Jwt(token, runtime.jwtSecret);
  let displayName = typeof claims.display_name === 'string' ? claims.display_name.trim() : '';
  if (runtime.admin?.getProfile) {
    try {
      const profile = await runtime.admin.getProfile(claims.sub);
      if (profile?.display_name) displayName = profile.display_name;
    } catch (err) {
      console.warn('[auth] profile lookup failed:', err.message);
    }
  }
  if (!displayName) {
    displayName = `Player-${String(claims.sub).slice(0, 8)}`;
  }
  return { userId: claims.sub, displayName };
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
