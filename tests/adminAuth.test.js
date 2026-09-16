import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_COOKIE_NAME,
  adminSessionToken,
  buildAdminCookie,
  enforceAdminAuth,
  extractAdminCredential,
  getAdminSecret,
  isAdminRequestPath,
  parseCookies,
  secretsMatch
} from '../server/adminAuth.js';

function mockReq({ path, method = 'GET', headers = {}, body = null, secure = false } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return {
    path,
    method,
    headers: normalized,
    body,
    secure,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    }
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    finished: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.headers.location = url;
      this.finished = true;
      return this;
    }
  };
  return res;
}

async function runAuth(req, env) {
  const res = mockRes();
  let nextCalled = false;
  enforceAdminAuth(req, res, () => {
    nextCalled = true;
  }, env);
  return { res, nextCalled };
}

describe('SEC-03: admin path matching and secret helpers', () => {
  it('treats /admin* and /api/admin* as gated paths including static admin.html', () => {
    assert.equal(isAdminRequestPath('/admin'), true);
    assert.equal(isAdminRequestPath('/admin/traffic'), true);
    assert.equal(isAdminRequestPath('/admin.html'), true);
    assert.equal(isAdminRequestPath('/api/admin/traffic'), true);
    assert.equal(isAdminRequestPath('/api/admin/room/ABCD1'), true);
    assert.equal(isAdminRequestPath('/api/health'), false);
    assert.equal(isAdminRequestPath('/api/rooms'), false);
    assert.equal(isAdminRequestPath('/'), false);
  });

  it('getAdminSecret requires a non-empty ADMIN_SECRET', () => {
    assert.equal(getAdminSecret({}), null);
    assert.equal(getAdminSecret({ ADMIN_SECRET: '' }), null);
    assert.equal(getAdminSecret({ ADMIN_SECRET: '   ' }), null);
    assert.equal(getAdminSecret({ ADMIN_SECRET: 'super-secret-value' }), 'super-secret-value');
  });

  it('secretsMatch is length-safe and rejects mismatches', () => {
    assert.equal(secretsMatch('abc', 'abc'), true);
    assert.equal(secretsMatch('abc', 'abd'), false);
    assert.equal(secretsMatch('short', 'much-longer-secret'), false);
    assert.equal(secretsMatch(null, 'abc'), false);
  });
});

describe('SEC-03: unauthenticated admin routes return 401/403 without leaking state', () => {
  const secret = 'unit-test-admin-secret-value';
  const leakKeys = ['recentEvents', 'uniqueIps', 'playerIps', 'resources', 'commodities', 'eventLog'];

  function assertNoLeak(body) {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    for (const key of leakKeys) {
      assert.equal(serialized.includes(`"${key}"`), false, `response leaked ${key}`);
    }
    assert.equal(serialized.includes('wood'), false);
    assert.equal(serialized.includes('198.51.100'), false);
  }

  it('returns 403 ADMIN_DISABLED when ADMIN_SECRET is unset', async () => {
    for (const path of ['/admin', '/admin/traffic', '/admin.html', '/api/admin/traffic', '/api/admin/room/ROOM1', '/api/admin/traffic/clear']) {
      const { res, nextCalled } = await runAuth(mockReq({ path, headers: { accept: 'application/json' } }), {});
      assert.equal(nextCalled, false, path);
      assert.equal(res.statusCode, 403, path);
      assert.equal(res.body.error, 'ADMIN_DISABLED', path);
      assertNoLeak(res.body);
    }
  });

  it('returns 401 ADMIN_UNAUTHORIZED without credentials when secret is configured', async () => {
    const env = { ADMIN_SECRET: secret };
    for (const path of ['/api/admin/traffic', '/api/admin/room/ROOM1']) {
      const { res, nextCalled } = await runAuth(mockReq({ path, headers: { accept: 'application/json' } }), env);
      assert.equal(nextCalled, false, path);
      assert.equal(res.statusCode, 401, path);
      assert.equal(res.body.error, 'ADMIN_UNAUTHORIZED', path);
      assert.equal(res.headers['www-authenticate'].includes('Basic'), true);
      assertNoLeak(res.body);
    }
  });

  it('returns 401 for wrong Bearer, Basic, and X-Admin-Secret values', async () => {
    const env = { ADMIN_SECRET: secret };
    const attempts = [
      { authorization: 'Bearer wrong-secret' },
      { authorization: `Basic ${Buffer.from('admin:wrong-secret').toString('base64')}` },
      { 'x-admin-secret': 'wrong-secret' }
    ];
    for (const headers of attempts) {
      const { res, nextCalled } = await runAuth(
        mockReq({ path: '/api/admin/room/ROOM1', headers: { accept: 'application/json', ...headers } }),
        env
      );
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'ADMIN_UNAUTHORIZED');
      assertNoLeak(res.body);
    }
  });

  it('does not gate non-admin routes even without a secret', async () => {
    const { res, nextCalled } = await runAuth(mockReq({ path: '/api/health' }), {});
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  });
});

describe('SEC-03: valid admin credentials are accepted', () => {
  const secret = 'unit-test-admin-secret-value';
  const env = { ADMIN_SECRET: secret };

  it('accepts Bearer, Basic password, X-Admin-Secret, and session cookie', async () => {
    const cookie = `${ADMIN_COOKIE_NAME}=${adminSessionToken(secret)}`;
    const attempts = [
      { authorization: `Bearer ${secret}` },
      { authorization: `Basic ${Buffer.from(`admin:${secret}`).toString('base64')}` },
      { 'x-admin-secret': secret },
      { cookie }
    ];
    for (const headers of attempts) {
      const { res, nextCalled } = await runAuth(
        mockReq({ path: '/api/admin/traffic', headers }),
        env
      );
      assert.equal(nextCalled, true, JSON.stringify(headers));
      assert.equal(res.statusCode, 200, JSON.stringify(headers));
    }
  });

  it('sets an HttpOnly session cookie after Bearer login', async () => {
    const { res, nextCalled } = await runAuth(
      mockReq({ path: '/admin', headers: { authorization: `Bearer ${secret}` } }),
      env
    );
    assert.equal(nextCalled, true);
    assert.ok(String(res.headers['set-cookie'] || '').includes('HttpOnly'));
    assert.ok(String(res.headers['set-cookie'] || '').includes(ADMIN_COOKIE_NAME));
  });

  it('POST /admin/session with the secret establishes a session', async () => {
    const { res, nextCalled } = await runAuth(
      mockReq({
        path: '/admin/session',
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: { secret }
      }),
      env
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(String(res.headers['set-cookie'] || '').includes(ADMIN_COOKIE_NAME));
  });

  it('extractAdminCredential and parseCookies round-trip the session token', () => {
    const token = adminSessionToken(secret);
    const cred = extractAdminCredential(
      { headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` } },
      secret
    );
    assert.equal(cred.type, 'cookie');
    assert.equal(cred.value, secret);
    assert.equal(parseCookies(buildAdminCookie(secret))[ADMIN_COOKIE_NAME], token);
    assert.equal(secretsMatch(token, adminSessionToken(secret)), true);
  });
});
