import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTrustPredicate,
  extractClientCountry,
  extractClientIp,
  getImmediatePeerIp,
  normalizeIp,
  parseTrustProxySetting
} from '../server/clientIp.js';

function req({ headers = {}, ip, remoteAddress } = {}) {
  const socket = remoteAddress != null ? { remoteAddress } : undefined;
  return { headers, ip, socket };
}

function socketHandshake({ headers = {}, address } = {}) {
  return { handshake: { headers, address } };
}

describe('SEC-08: parseTrustProxySetting', () => {
  it('defaults to loopback (Cloudflare tunnel / local edge) and never returns true', () => {
    assert.equal(parseTrustProxySetting(undefined), 'loopback');
    assert.equal(parseTrustProxySetting(''), 'loopback');
    assert.equal(parseTrustProxySetting('true'), 'loopback');
    assert.equal(parseTrustProxySetting('TRUE'), 'loopback');
    assert.equal(parseTrustProxySetting('yes'), 'loopback');
  });

  it('parses explicit off, hop count, named ranges, and proxy IPs', () => {
    assert.equal(parseTrustProxySetting('false'), false);
    assert.equal(parseTrustProxySetting('0'), false);
    assert.equal(parseTrustProxySetting('off'), false);
    assert.equal(parseTrustProxySetting('1'), 1);
    assert.equal(parseTrustProxySetting('2'), 2);
    assert.equal(parseTrustProxySetting('loopback'), 'loopback');
    assert.equal(parseTrustProxySetting('uniquelocal, loopback'), 'uniquelocal, loopback');
    assert.equal(parseTrustProxySetting('10.0.0.1'), '10.0.0.1');
  });
});

describe('SEC-08: ignore client-supplied forwarded headers without a verified edge', () => {
  it('ignores cf-connecting-ip, x-real-ip, and x-forwarded-for from a public peer', () => {
    const publicPeer = '203.0.113.10';
    const spoofed = req({
      remoteAddress: publicPeer,
      headers: {
        'cf-connecting-ip': '198.51.100.42',
        'x-real-ip': '198.51.100.88',
        'x-forwarded-for': '198.51.100.1, 10.0.0.1'
      }
    });

    assert.equal(extractClientIp(spoofed, 'loopback'), publicPeer);
    assert.equal(extractClientIp(spoofed, false), publicPeer);
    assert.equal(extractClientCountry(spoofed, 'loopback'), null);
  });

  it('ignores forwarded headers when TRUST_PROXY is off even from loopback', () => {
    const local = req({
      remoteAddress: '127.0.0.1',
      headers: {
        'cf-connecting-ip': '198.51.100.42',
        'x-real-ip': '198.51.100.88',
        'x-forwarded-for': '203.0.113.50',
        'cf-ipcountry': 'RO'
      }
    });

    assert.equal(extractClientIp(local, false), '127.0.0.1');
    assert.equal(extractClientCountry(local, false), null);
  });

  it('returns unknown when there is no TCP peer to verify', () => {
    assert.equal(
      extractClientIp({ headers: { 'cf-connecting-ip': '198.51.100.42' } }, 'loopback'),
      'unknown'
    );
  });
});

describe('SEC-08: honor forwarded headers only from a verified edge', () => {
  it('trusts Cloudflare headers from a loopback peer (cloudflared tunnel)', () => {
    const tunneled = req({
      remoteAddress: '127.0.0.1',
      headers: {
        'cf-connecting-ip': '198.51.100.42',
        'x-forwarded-for': '203.0.113.1',
        'cf-ipcountry': 'RO'
      }
    });

    assert.equal(extractClientIp(tunneled, 'loopback'), '198.51.100.42');
    assert.equal(extractClientCountry(tunneled, 'loopback'), 'RO');
  });

  it('trusts Cloudflare headers from IPv6 loopback', () => {
    const tunneled = req({
      remoteAddress: '::1',
      headers: { 'cf-connecting-ip': '2001:db8::53' }
    });
    assert.equal(extractClientIp(tunneled, 'loopback'), '2001:db8::53');
  });

  it('uses hop-stripped X-Forwarded-For (rightmost client hop), not the spoofable leftmost entry', () => {
    const tunneled = req({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.50' }
    });
    assert.equal(extractClientIp(tunneled, 'loopback'), '203.0.113.50');
  });

  it('falls back to X-Real-IP only when the peer is trusted and CF/XFF are absent', () => {
    const tunneled = req({
      remoteAddress: '127.0.0.1',
      headers: { 'x-real-ip': '198.51.100.88' }
    });
    assert.equal(extractClientIp(tunneled, 'loopback'), '198.51.100.88');

    const publicPeer = req({
      remoteAddress: '203.0.113.10',
      headers: { 'x-real-ip': '198.51.100.88' }
    });
    assert.equal(extractClientIp(publicPeer, 'loopback'), '203.0.113.10');
  });

  it('trusts a configured proxy IP / CIDR as the verified edge', () => {
    const viaProxy = req({
      remoteAddress: '10.0.0.2',
      headers: { 'cf-connecting-ip': '198.51.100.42' }
    });
    assert.equal(extractClientIp(viaProxy, '10.0.0.2'), '198.51.100.42');
    assert.equal(extractClientIp(viaProxy, '10.0.0.0/8'), '198.51.100.42');
    assert.equal(extractClientIp(viaProxy, '192.168.0.0/16'), '10.0.0.2');
  });

  it('honors a known hop count for X-Forwarded-For (Node must not be publicly reachable)', () => {
    const viaProxy = req({
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.50' }
    });
    assert.equal(extractClientIp(viaProxy, 1), '203.0.113.50');
  });

  it('does not treat client-supplied Cloudflare headers as authoritative in hop-count mode', () => {
    const direct = req({
      remoteAddress: '203.0.113.10',
      headers: {
        'cf-connecting-ip': '198.51.100.42',
        'x-real-ip': '198.51.100.88',
        'x-forwarded-for': '203.0.113.50',
        'cf-ipcountry': 'US'
      }
    });
    assert.equal(extractClientIp(direct, 1), '203.0.113.50');
    assert.equal(extractClientCountry(direct, 1), null);

    const noXff = req({
      remoteAddress: '203.0.113.10',
      headers: { 'cf-connecting-ip': '198.51.100.42', 'x-real-ip': '198.51.100.88' }
    });
    assert.equal(extractClientIp(noXff, 1), '203.0.113.10');
  });
});

describe('SEC-08: socket handshake and address normalization', () => {
  it('reads Socket.IO handshake headers only when the handshake address is trusted', () => {
    const trusted = socketHandshake({
      headers: { 'cf-connecting-ip': '86.120.10.5' },
      address: '127.0.0.1'
    });
    assert.equal(extractClientIp(trusted, 'loopback'), '86.120.10.5');

    const untrusted = socketHandshake({
      headers: { 'cf-connecting-ip': '86.120.10.5' },
      address: '203.0.113.10'
    });
    assert.equal(extractClientIp(untrusted, 'loopback'), '203.0.113.10');
  });

  it('strips IPv4-mapped IPv6 prefixes', () => {
    assert.equal(normalizeIp('::ffff:192.168.1.100'), '192.168.1.100');
    assert.equal(getImmediatePeerIp({ ip: '::ffff:192.168.1.100', headers: {} }), '192.168.1.100');
    assert.equal(extractClientIp({ ip: '::ffff:192.168.1.100', headers: {} }, false), '192.168.1.100');
  });

  it('rejects non-IP garbage in forwarded headers', () => {
    const tunneled = req({
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': 'not-an-ip<script>' }
    });
    assert.equal(extractClientIp(tunneled, 'loopback'), '127.0.0.1');
  });

  it('accepts Cloudflare XX/T1 country codes and rejects junk', () => {
    const tunneled = req({
      remoteAddress: '127.0.0.1',
      headers: { 'cf-ipcountry': 't1' }
    });
    assert.equal(extractClientCountry(tunneled, 'loopback'), 'T1');
    assert.equal(
      extractClientCountry(req({ remoteAddress: '127.0.0.1', headers: { 'cf-ipcountry': 'ROMANIA' } }), 'loopback'),
      null
    );
  });

  it('compileTrustPredicate treats hop 0 as trusted for hop-count mode only', () => {
    const hops = compileTrustPredicate(1);
    assert.equal(hops('203.0.113.10', 0), true);
    assert.equal(hops('203.0.113.10', 1), false);

    const loopback = compileTrustPredicate('loopback');
    assert.equal(loopback('127.0.0.1', 0), true);
    assert.equal(loopback('203.0.113.10', 0), false);
    assert.equal(compileTrustPredicate(false)('127.0.0.1', 0), false);
  });
});
