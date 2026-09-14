import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server, io, extractClientIp, extractClientCountry, recordTrafficEvent, trafficBuffer, trafficStats } from '../server/server.js';

describe('API: Real-time Traffic & IP Telemetry', () => {
  let serverPort = null;
  let serverUrl = null;

  before(async () => {
    await new Promise((resolve) => {
      server.listen(0, () => {
        serverPort = server.address().port;
        serverUrl = `http://localhost:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    io.close();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('extractClientIp should correctly prioritize cf-connecting-ip, x-real-ip, x-forwarded-for, and req.ip', () => {
    // Cloudflare Connecting IP
    const reqCf = { headers: { 'cf-connecting-ip': '198.51.100.42', 'x-forwarded-for': '203.0.113.1' } };
    assert.equal(extractClientIp(reqCf), '198.51.100.42');

    // X-Real-IP
    const reqReal = { headers: { 'x-real-ip': '198.51.100.88' } };
    assert.equal(extractClientIp(reqReal), '198.51.100.88');

    // X-Forwarded-For chain
    const reqFwd = { headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1, 192.168.1.1' } };
    assert.equal(extractClientIp(reqFwd), '203.0.113.50');

    // Socket handshake format
    const socket = { handshake: { headers: { 'cf-connecting-ip': '86.120.10.5' }, address: '127.0.0.1' } };
    assert.equal(extractClientIp(socket), '86.120.10.5');

    // Strips ::ffff:
    const reqIpv6 = { ip: '::ffff:192.168.1.100', headers: {} };
    assert.equal(extractClientIp(reqIpv6), '192.168.1.100');
  });

  it('extractClientCountry should extract cf-ipcountry header', () => {
    const req = { headers: { 'cf-ipcountry': 'RO' } };
    assert.equal(extractClientCountry(req), 'RO');

    const reqEmpty = { headers: {} };
    assert.equal(extractClientCountry(reqEmpty), null);
  });

  it('recordTrafficEvent should append to buffer and track unique IPs', () => {
    const initialCount = trafficBuffer.length;
    const testIp = '198.51.100.99';
    recordTrafficEvent({
      type: 'TEST_EVENT',
      ip: testIp,
      country: 'RO'
    });

    assert.ok(trafficBuffer.length >= initialCount + 1);
    assert.ok(trafficStats.uniqueIps.has(testIp));
  });

  it('GET /api/admin/traffic should return telemetry data and respect query limits', async () => {
    const res = await fetch(`${serverUrl}/api/admin/traffic?limit=5`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.status, 'ok');
    assert.ok(data.stats);
    assert.equal(typeof data.stats.totalHttpRequests, 'number');
    assert.equal(typeof data.stats.totalSocketPackets, 'number');
    assert.equal(typeof data.stats.uniqueIpCount, 'number');
    assert.ok(Array.isArray(data.stats.uniqueIps));
    assert.ok(Array.isArray(data.activeConnections));
    assert.ok(Array.isArray(data.recentEvents));
    assert.ok(data.recentEvents.length <= 5);
  });

  it('GET /api/admin/traffic should filter by event type when requested', async () => {
    const res = await fetch(`${serverUrl}/api/admin/traffic?type=HTTP&limit=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.recentEvents));
    for (const event of data.recentEvents) {
      assert.equal(event.type, 'HTTP');
    }
  });
});
