import { createHmac, timingSafeEqual } from 'node:crypto';

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function signHs256Jwt(payload, secret, { expiresInSec = 3600 } = {}) {
  if (!secret) throw new Error('JWT_SECRET_REQUIRED');
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64urlJson({ iat: now, exp: now + expiresInSec, ...payload });
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyHs256Jwt(token, secret) {
  if (typeof token !== 'string' || !secret) throw new Error('INVALID_AUTH_TOKEN');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_AUTH_TOKEN');
  const [header, body, sig] = parts;
  let headerJson;
  try {
    headerJson = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new Error('INVALID_AUTH_TOKEN');
  }
  if (headerJson.alg !== 'HS256') throw new Error('INVALID_AUTH_TOKEN');
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  let actual;
  try {
    actual = Buffer.from(sig, 'base64url');
  } catch {
    throw new Error('INVALID_AUTH_TOKEN');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('INVALID_AUTH_TOKEN');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('INVALID_AUTH_TOKEN');
  }
  if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    throw new Error('INVALID_AUTH_TOKEN');
  }
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('INVALID_AUTH_TOKEN');
  return payload;
}

export function extractBearerToken(reqOrSocket) {
  const handshakeAuth = reqOrSocket.handshake?.auth?.token;
  if (typeof handshakeAuth === 'string' && handshakeAuth.trim()) return handshakeAuth.trim();
  const headers = reqOrSocket.headers || reqOrSocket.handshake?.headers || {};
  const raw = headers.authorization || headers.Authorization;
  if (typeof raw === 'string' && raw.toLowerCase().startsWith('bearer ')) {
    return raw.slice(7).trim();
  }
  return null;
}
