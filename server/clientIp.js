/**
 * Client IP extraction with explicit proxy-trust policy (SEC-08).
 *
 * `trust proxy: true` plus blindly honoring CF-Connecting-IP / X-Real-IP /
 * X-Forwarded-For lets any client spoof their IP. This module trusts those
 * headers only for a known hop count or a verified edge (loopback / listed
 * proxy IPs). See README "Deployment topology & client IPs".
 */

export const DEFAULT_TRUST_PROXY = 'loopback';

/**
 * Parse TRUST_PROXY into an Express-compatible setting.
 * Never returns `true` (trust every hop) — that is the SEC-08 failure mode.
 *
 * @param {string | undefined | null} raw
 * @returns {false | number | string}
 */
export function parseTrustProxySetting(raw = process.env.TRUST_PROXY) {
  if (raw == null) return DEFAULT_TRUST_PROXY;
  const value = String(raw).trim();
  if (value === '') return DEFAULT_TRUST_PROXY;

  const lower = value.toLowerCase();
  if (['false', '0', 'off', 'no'].includes(lower)) return false;
  if (['true', 'yes', 'on'].includes(lower)) {
    console.warn(
      '[sec-08] TRUST_PROXY=true trusts every hop and is spoofable. ' +
        'Using "loopback" (Cloudflare tunnel / local edge) instead. ' +
        'Set TRUST_PROXY to a hop count (e.g. 1) or proxy IPs if needed.'
    );
    return DEFAULT_TRUST_PROXY;
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops === 0 ? false : hops;
  }
  return value;
}

export const TRUST_PROXY_SETTING = parseTrustProxySetting(process.env.TRUST_PROXY);

export function describeTrustProxySetting(trustSetting = TRUST_PROXY_SETTING) {
  if (trustSetting === false) {
    return 'off (bare Node — forwarded headers ignored)';
  }
  if (typeof trustSetting === 'number') {
    return `${trustSetting} hop(s) — only safe if Node is not directly reachable`;
  }
  return String(trustSetting);
}

export function normalizeIp(raw) {
  if (raw == null) return null;
  let ip = String(raw).trim();
  if (!ip) return null;

  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1];

  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));

  return isValidIp(ip) ? ip : null;
}

function isValidIp(ip) {
  if (isValidIpv4(ip)) return true;
  if (!ip.includes(':')) return false;
  if (/[^0-9a-fA-F:]/.test(ip)) return false;
  const parts = ip.split(':');
  if (parts.length < 3 || parts.length > 8) return false;
  return parts.every((part) => part === '' || /^[0-9a-fA-F]{1,4}$/.test(part));
}

function isValidIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255 && String(n) === part;
  });
}

function ipv4ToInt(ip) {
  const [a, b, c, d] = ip.split('.').map(Number);
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function isLoopbackIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (n === '::1') return true;
  return n.startsWith('127.');
}

function ipv6FirstHextet(ip) {
  const first = String(ip).split(':')[0];
  if (!first) return null;
  const val = Number.parseInt(first, 16);
  return Number.isNaN(val) ? null : val;
}

function isLinkLocalIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (n.includes(':')) {
    const hextet = ipv6FirstHextet(n);
    return hextet != null && hextet >= 0xfe80 && hextet <= 0xfebf;
  }
  const parts = n.split('.');
  if (parts.length !== 4) return false;
  return Number(parts[0]) === 169 && Number(parts[1]) === 254;
}

function isUniqueLocalIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (n.includes(':')) {
    const hextet = ipv6FirstHextet(n);
    return hextet != null && hextet >= 0xfc00 && hextet <= 0xfdff;
  }
  const a = Number(n.split('.')[0]);
  const b = Number(n.split('.')[1]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function ipv4InCidr(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  if (!isValidIpv4(ip) || !isValidIpv4(base)) return false;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function addrMatchesTrustToken(addr, token) {
  const ip = normalizeIp(addr);
  if (!ip) return false;
  const t = String(token).trim().toLowerCase();
  if (!t) return false;
  if (t === 'loopback') return isLoopbackIp(ip);
  if (t === 'uniquelocal') return isUniqueLocalIp(ip);
  if (t === 'linklocal') return isLinkLocalIp(ip);
  if (t.includes('/')) return ipv4InCidr(ip, t);
  return normalizeIp(t) === ip;
}

/**
 * Compile a trust predicate in proxy-addr order: addresses are listed
 * closest-hop-first (socket, then X-Forwarded-For from right to left).
 *
 * @param {false | number | string} trustSetting
 * @returns {(addr: string, index: number) => boolean}
 */
export function compileTrustPredicate(trustSetting) {
  if (trustSetting === false || trustSetting == null) return () => false;
  if (typeof trustSetting === 'number') {
    const hops = trustSetting;
    return (_addr, index) => index < hops;
  }
  const tokens = String(trustSetting)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return () => false;
  return (addr) => tokens.some((token) => addrMatchesTrustToken(addr, token));
}

function getHeaders(reqOrSocket) {
  return reqOrSocket.headers || reqOrSocket.handshake?.headers || reqOrSocket.request?.headers || {};
}

export function getImmediatePeerIp(reqOrSocket) {
  if (!reqOrSocket || typeof reqOrSocket !== 'object') return null;
  const raw =
    reqOrSocket.socket?.remoteAddress ||
    reqOrSocket.connection?.remoteAddress ||
    reqOrSocket.conn?.remoteAddress ||
    reqOrSocket.request?.socket?.remoteAddress ||
    reqOrSocket.handshake?.address ||
    reqOrSocket.ip;
  return normalizeIp(raw);
}

function headerIp(value) {
  if (typeof value !== 'string') return null;
  return normalizeIp(value.split(',')[0]);
}

function forwardedChain(peerIp, xForwardedFor) {
  const hops = [];
  if (typeof xForwardedFor === 'string') {
    const parts = xForwardedFor.split(',');
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = normalizeIp(parts[i]);
      if (ip) hops.push(ip);
    }
  }
  const addrs = [];
  if (peerIp) addrs.push(peerIp);
  addrs.push(...hops);
  return addrs;
}

function pickUntrustedHop(addrs, trustFn) {
  if (addrs.length === 0) return null;
  let i = 0;
  while (i < addrs.length - 1 && trustFn(addrs[i], i)) i++;
  return addrs[i];
}

function isVerifiedEdgePeer(peer, trustSetting) {
  return typeof trustSetting === 'string' && Boolean(peer) && compileTrustPredicate(trustSetting)(peer, 0);
}

/**
 * Extract the client IP. Forwarded headers are ignored unless the immediate
 * TCP peer is a configured trusted hop / verified edge.
 *
 * Cloudflare-specific headers (CF-Connecting-IP, X-Real-IP, CF-IPCountry) are
 * honored only when the TCP peer matches a named/IP edge (e.g. loopback for
 * cloudflared). Hop-count mode uses X-Forwarded-For stripping only — it must
 * not treat client-supplied CF-* headers as authoritative.
 */
export function extractClientIp(reqOrSocket, trustSetting = TRUST_PROXY_SETTING) {
  const headers = getHeaders(reqOrSocket);
  const peer = getImmediatePeerIp(reqOrSocket);
  if (!peer) return 'unknown';

  const trustFn = compileTrustPredicate(trustSetting);
  const verifiedEdge = isVerifiedEdgePeer(peer, trustSetting);
  const honorXff = verifiedEdge || typeof trustSetting === 'number';

  if (verifiedEdge) {
    const cfConnectingIp = headerIp(headers['cf-connecting-ip']);
    if (cfConnectingIp) return cfConnectingIp;
  }

  const xff = honorXff ? headers['x-forwarded-for'] : undefined;
  if (typeof xff === 'string' && xff.trim()) {
    const fromChain = pickUntrustedHop(forwardedChain(peer, xff), trustFn);
    if (fromChain) return fromChain;
  }

  if (verifiedEdge) {
    const xRealIp = headerIp(headers['x-real-ip']);
    if (xRealIp) return xRealIp;
  }

  return peer;
}

/**
 * Cloudflare country header is only honored from a verified edge.
 */
export function extractClientCountry(reqOrSocket, trustSetting = TRUST_PROXY_SETTING) {
  const peer = getImmediatePeerIp(reqOrSocket);
  if (!isVerifiedEdgePeer(peer, trustSetting)) return null;
  const headers = getHeaders(reqOrSocket);
  const raw = headers['cf-ipcountry'];
  if (typeof raw !== 'string') return null;
  const cc = raw.trim().toUpperCase();
  if (cc === 'XX' || cc === 'T1') return cc;
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  return cc;
}
