/**
 * Shared-secret gate for /admin UI and /api/admin APIs.
 * Disabled when ADMIN_SECRET is unset; otherwise requires a matching credential.
 */
import crypto from 'node:crypto';

export const ADMIN_COOKIE_NAME = 'catan_admin';
export const ADMIN_SESSION_TTL_SEC = 60 * 60 * 24;

const SESSION_PURPOSE = 'hex-catan-admin-session-v1';

export function isAdminRequestPath(pathname) {
  if (!pathname || typeof pathname !== 'string') return false;
  const p = pathname.split('?')[0];
  return p === '/admin'
    || p === '/admin.html'
    || p.startsWith('/admin/')
    || p === '/api/admin'
    || p.startsWith('/api/admin/');
}

export function getAdminSecret(env = process.env) {
  const secret = env?.ADMIN_SECRET;
  if (typeof secret !== 'string') return null;
  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function adminSessionToken(secret) {
  return crypto.createHmac('sha256', secret).update(SESSION_PURPOSE).digest('hex');
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function buildAdminCookie(secret, { secure = false, maxAge = ADMIN_SESSION_TTL_SEC } = {}) {
  const token = adminSessionToken(secret);
  const parts = [
    `${ADMIN_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearAdminCookie() {
  return `${ADMIN_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function extractAdminCredential(req, expectedSecret) {
  const headers = req?.headers || {};
  const headerSecret = headers['x-admin-secret'];
  if (typeof headerSecret === 'string' && headerSecret.trim()) {
    return { type: 'header', value: headerSecret.trim() };
  }

  const auth = headers.authorization;
  if (typeof auth === 'string') {
    if (auth.startsWith('Bearer ')) {
      const value = auth.slice(7).trim();
      if (value) return { type: 'bearer', value };
    } else if (/^Basic\s+/i.test(auth)) {
      try {
        const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const user = colon === -1 ? decoded : decoded.slice(0, colon);
        const pass = colon === -1 ? '' : decoded.slice(colon + 1);
        const value = pass || user;
        if (value) return { type: 'basic', value };
      } catch {
        return null;
      }
    }
  }

  if (!expectedSecret) return null;
  const token = parseCookies(headers.cookie)[ADMIN_COOKIE_NAME];
  if (token && secretsMatch(token, adminSessionToken(expectedSecret))) {
    return { type: 'cookie', value: expectedSecret };
  }
  return null;
}

function header(req, name) {
  if (typeof req.get === 'function') return req.get(name);
  return req.headers?.[name.toLowerCase()] || req.headers?.[name] || '';
}

function wantsHtml(req) {
  const accept = header(req, 'accept') || '';
  const acceptStr = Array.isArray(accept) ? accept.join(',') : String(accept || '');
  const prefersJson = acceptStr.includes('application/json') && !acceptStr.includes('text/html');
  if (prefersJson) return false;
  if (acceptStr.includes('text/html')) return true;
  const p = req.path || '';
  return p === '/admin' || p === '/admin.html' || (p.startsWith('/admin/') && !p.startsWith('/api/'));
}

function isSessionLoginPath(pathname) {
  return pathname === '/admin/session' || pathname === '/api/admin/session';
}

function isLogoutPath(pathname) {
  return pathname === '/admin/logout' || pathname === '/api/admin/logout';
}

function sendUnauthorized(req, res, { message } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  const html = wantsHtml(req) && req.method === 'GET' && !String(req.path || '').startsWith('/api/');
  if (!html) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Catan Admin", charset="UTF-8"');
  }
  const payload = {
    status: 'error',
    error: 'ADMIN_UNAUTHORIZED',
    message: message || 'Admin authentication required. Send Authorization: Bearer <ADMIN_SECRET>, HTTP Basic, or X-Admin-Secret.'
  };
  if (html) {
    res.status(401);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderLoginPage(payload.message));
  }
  return res.status(401).json(payload);
}

function sendDisabled(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const payload = {
    status: 'error',
    error: 'ADMIN_DISABLED',
    message: 'Admin UI and APIs are disabled. Set a strong ADMIN_SECRET environment variable to enable them.'
  };
  if (wantsHtml(req) && req.method === 'GET' && !String(req.path || '').startsWith('/api/')) {
    res.status(403);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderDisabledPage(payload.message));
  }
  return res.status(403).json(payload);
}

function requestIsSecure(req) {
  return Boolean(req.secure || header(req, 'x-forwarded-proto') === 'https');
}

function bodySecret(req) {
  const body = req.body;
  if (!body || typeof body !== 'object') return null;
  if (typeof body.secret === 'string') return body.secret;
  if (typeof body.password === 'string') return body.password;
  return null;
}

function renderLoginPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Catan Admin Sign-in</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      background:#0f172a; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    form { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:28px; width:min(420px,92vw); }
    h1 { font-size:1.2rem; margin:0 0 8px; }
    p { color:#94a3b8; font-size:0.9rem; margin:0 0 16px; }
    label { display:block; font-size:0.8rem; margin-bottom:6px; color:#cbd5e1; }
    input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid #334155;
      background:#0f172a; color:#f8fafc; margin-bottom:14px; }
    button { width:100%; padding:10px 12px; border:0; border-radius:8px; background:#38bdf8; color:#0f172a;
      font-weight:700; cursor:pointer; }
  </style>
</head>
<body>
  <form method="POST" action="/admin/session" autocomplete="on">
    <h1>Admin access required</h1>
    <p>${escapeHtml(message)}</p>
    <label for="secret">ADMIN_SECRET</label>
    <input id="secret" name="secret" type="password" required autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function renderDisabledPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Catan Admin Disabled</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      background:#0f172a; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:28px; width:min(480px,92vw); }
    h1 { font-size:1.2rem; margin:0 0 8px; }
    p { color:#94a3b8; font-size:0.9rem; margin:0; }
  </style>
</head>
<body>
  <main>
    <h1>Admin is disabled</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Express middleware. No-op for non-admin paths.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {NodeJS.ProcessEnv} [env]
 */
export function enforceAdminAuth(req, res, next, env = process.env) {
  const pathname = req.path || req.url || '';
  if (!isAdminRequestPath(pathname)) return next();

  const expected = getAdminSecret(env);
  if (!expected) return sendDisabled(req, res);

  if (req.method === 'POST' && isSessionLoginPath(pathname)) {
    const provided = bodySecret(req);
    if (typeof provided === 'string' && secretsMatch(provided, expected)) {
      res.setHeader('Set-Cookie', buildAdminCookie(expected, { secure: requestIsSecure(req) }));
      res.setHeader('Cache-Control', 'no-store');
      const contentType = header(req, 'content-type') || '';
      if (wantsHtml(req) || String(contentType).includes('application/x-www-form-urlencoded')) {
        return res.redirect(303, '/admin');
      }
      return res.json({ status: 'ok' });
    }
    return sendUnauthorized(req, res, { message: 'Invalid admin secret.' });
  }

  if (isLogoutPath(pathname) && (req.method === 'GET' || req.method === 'POST')) {
    res.setHeader('Set-Cookie', clearAdminCookie());
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' || wantsHtml(req)) return res.redirect(303, '/admin');
    return res.json({ status: 'ok' });
  }

  const cred = extractAdminCredential(req, expected);
  if (cred && secretsMatch(cred.value, expected)) {
    if (cred.type !== 'cookie') {
      res.setHeader('Set-Cookie', buildAdminCookie(expected, { secure: requestIsSecure(req) }));
    }
    return next();
  }

  return sendUnauthorized(req, res);
}

export function requireAdminAuth(req, res, next) {
  return enforceAdminAuth(req, res, next, process.env);
}
