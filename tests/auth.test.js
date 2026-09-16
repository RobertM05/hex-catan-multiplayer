import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { signHs256Jwt, verifyHs256Jwt } from '../server/auth/jwt.js';
import { configureAuthRuntime } from '../server/auth/identity.js';
import { buildMatchPayload, persistFinishedMatch, computeFinishRanks } from '../server/auth/matchStore.js';
import { summarizeStats, publicAuthConfig } from '../server/auth/supabase.js';
import { server, roomManager, io as serverIo } from '../server/server.js';
import http from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-jwt-secret-auth-phase0';

describe('AUTH-01 schema files', () => {
  const sql = readFileSync(join(root, 'supabase/migrations/20260916100000_auth_profiles_matches.sql'), 'utf8');

  it('defines unique display_name, matches, match_players, unused ratings, and RLS', () => {
    assert.match(sql, /create table if not exists public\.profiles/);
    assert.match(sql, /profiles_display_name_unique unique \(display_name\)/);
    assert.match(sql, /create table if not exists public\.matches/);
    assert.match(sql, /create table if not exists public\.match_players/);
    assert.match(sql, /user_id uuid null/);
    assert.match(sql, /create table if not exists public\.ratings/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /handle_new_user/);
  });

  it('documents SQL smoke for unique name conflict', () => {
    const smoke = readFileSync(join(root, 'supabase/smoke.sql'), 'utf8');
    assert.match(smoke, /profiles_display_name_unique/);
    assert.match(smoke, /to_regclass\('public.ratings'\)/);
  });
});

describe('AUTH JWT HS256', () => {
  it('round-trips a valid token and rejects garbage / bad signatures', () => {
    const token = signHs256Jwt({ sub: 'user-1', display_name: 'Alice' }, SECRET);
    const claims = verifyHs256Jwt(token, SECRET);
    assert.equal(claims.sub, 'user-1');
    assert.throws(() => verifyHs256Jwt('not-a-jwt', SECRET), /INVALID_AUTH_TOKEN/);
    assert.throws(() => verifyHs256Jwt(token.slice(0, -2) + 'xx', SECRET), /INVALID_AUTH_TOKEN/);
  });
});

describe('AUTH-04 match payload', () => {
  it('writes nullable user_id for guests/bots and ranks the winner first', () => {
    const engine = {
      isGameOver: true,
      mode: 'base',
      winner: { id: 'p2' },
      players: [
        { id: 'p1', name: 'Guest', victoryPoints: 8 },
        { id: 'p2', name: 'Signed', victoryPoints: 10, userId: 'uuid-2' },
        { id: 'bot_1', name: 'Bot Ada', victoryPoints: 4, isBot: true }
      ]
    };
    const room = {
      code: 'ABCD2',
      mode: 'base',
      ranked: false,
      startedAt: Date.now() - 1000,
      engine,
      players: [
        { id: 'p1', name: 'Guest', frozenDisplayName: 'Guest', frozenUserId: null },
        { id: 'p2', name: 'Signed', frozenDisplayName: 'Alice', frozenUserId: 'uuid-2' },
        { id: 'bot_1', name: 'Bot Ada', frozenDisplayName: 'Bot Ada', frozenUserId: null }
      ]
    };
    const { matchRow, playerRows } = buildMatchPayload(room);
    assert.equal(matchRow.ranked, false);
    assert.equal(playerRows.length, 3);
    assert.equal(playerRows[0].user_id, 'uuid-2');
    assert.equal(playerRows[0].rank, 1);
    assert.equal(playerRows[1].user_id, null);
    assert.equal(computeFinishRanks(engine)[0].player.id, 'p2');
  });

  it('no-ops persist when Supabase admin is missing and is idempotent after success', async () => {
    const room = { engine: { isGameOver: true, players: [], winner: null }, players: [], code: 'Z' };
    const skipped = await persistFinishedMatch(room, { admin: null, jwtSecret: SECRET });
    assert.equal(skipped.reason, 'supabase_unconfigured');

    const inserts = [];
    const admin = {
      async insertMatch(matchRow, playerRows) {
        inserts.push({ matchRow, playerRows });
      }
    };
    const engine = { isGameOver: true, players: [{ id: 'p1', name: 'A', victoryPoints: 10 }], winner: { id: 'p1' } };
    const live = { code: 'ROOM1', mode: 'base', engine, players: [{ id: 'p1', name: 'A', frozenUserId: 'u1', frozenDisplayName: 'A' }] };
    const first = await persistFinishedMatch(live, { admin, jwtSecret: SECRET });
    const second = await persistFinishedMatch(live, { admin, jwtSecret: SECRET });
    assert.equal(first.skipped, false);
    assert.equal(second.reason, 'already_persisted');
    assert.equal(inserts.length, 1);
  });

  it('summarizes only the caller rows', () => {
    const stats = summarizeStats([
      { rank: 1, vp: 10, match_id: 'm1', abandoned: false, matches: { mode: 'base', ended_at: 't', room_code: 'A' } },
      { rank: 4, vp: 3, match_id: 'm2', abandoned: false, matches: { mode: 'base', ended_at: 't', room_code: 'B' } }
    ]);
    assert.equal(stats.matches, 2);
    assert.equal(stats.wins, 1);
    assert.equal(stats.averageRank, 2.5);
  });
});

describe('AUTH HTTP + socket freeze', () => {
  let port;
  let url;

  before(async () => {
    configureAuthRuntime({
      jwtSecret: SECRET,
      admin: {
        async getProfile(userId) {
          if (userId === 'user-alice') return { id: userId, display_name: 'AliceProfile' };
          if (userId === 'user-bob') return { id: userId, display_name: 'BobProfile' };
          return null;
        },
        async listOwnMatchPlayers(userId) {
          if (userId !== 'user-alice') return [];
          return [{ rank: 1, vp: 13, match_id: 'm', abandoned: false, matches: { mode: 'cities_knights', ended_at: 't', room_code: 'X' } }];
        },
        async insertMatch() {}
      }
    });
    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        url = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    configureAuthRuntime(null);
    for (const code of [...roomManager.rooms.keys()]) {
      roomManager.destroyRoom(code);
    }
    serverIo.close();
    await new Promise((resolve) => server.close(resolve));
  });

  function httpJson(method, path, { token, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(url + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('exposes public config without secrets and keeps guests on /api/auth/config', async () => {
    const cfg = publicAuthConfig({});
    assert.equal(cfg.enabled, false);
    const res = await httpJson('GET', '/api/auth/config');
    assert.equal(res.status, 200);
    assert.equal(res.json.enabled, false);
    assert.equal(res.json.anonKey, null);
  });

  it('rejects missing stats auth and returns only the signed-in user rows', async () => {
    const guest = await httpJson('GET', '/api/me/stats');
    assert.equal(guest.status, 401);
    const alice = signHs256Jwt({ sub: 'user-alice' }, SECRET);
    const ok = await httpJson('GET', '/api/me/stats', { token: alice });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.matches, 1);
    assert.equal(ok.json.wins, 1);
    const bob = signHs256Jwt({ sub: 'user-bob' }, SECRET);
    const other = await httpJson('GET', '/api/me/stats', { token: bob });
    assert.equal(other.json.matches, 0);
  });

  it('rejects invalid JWT on handshake', async () => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: 'totally-invalid' }
    });
    const err = await new Promise((resolve) => {
      socket.on('connect_error', resolve);
      socket.on('connect', () => resolve(new Error('should-not-connect')));
    });
    socket.close();
    assert.match(String(err.message), /INVALID_AUTH_TOKEN/);
  });

  it('attaches profile display name, freezes it at start_game, and ignores a later token', async () => {
    const aliceToken = signHs256Jwt({ sub: 'user-alice' }, SECRET);
    const bobToken = signHs256Jwt({ sub: 'user-bob' }, SECRET);
    const host = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: aliceToken }
    });
    await new Promise((resolve) => host.on('connect', resolve));

    const created = await new Promise((resolve) => {
      host.emit('create_room', { hostName: 'IgnoredLobbyName', roomName: 'AuthFreeze', maxPlayers: 3, mode: 'base' }, resolve);
    });
    assert.equal(created.success, true);
    const room = roomManager.getRoom(created.roomCode);
    assert.equal(room.players[0].name, 'AliceProfile');
    assert.equal(room.players[0].userId, 'user-alice');

    const addBot = await new Promise((resolve) => {
      host.emit('add_bot', { code: created.roomCode }, resolve);
    });
    assert.equal(addBot.success, true);

    const started = await new Promise((resolve) => {
      host.emit('start_game', { code: created.roomCode }, resolve);
    });
    assert.equal(started.success, true);
    assert.equal(room.authFrozen, true);
    assert.equal(room.players[0].frozenDisplayName, 'AliceProfile');
    assert.equal(room.players[0].frozenUserId, 'user-alice');

    const hijack = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: bobToken }
    });
    await new Promise((resolve) => hijack.on('connect', resolve));
    const rejoin = await new Promise((resolve) => {
      hijack.emit('join_room', {
        code: created.roomCode,
        playerName: 'BobShouldNotApply',
        reconnectToken: created.reconnectToken
      }, resolve);
    });
    assert.equal(rejoin.success, true);
    assert.equal(room.players[0].name, 'AliceProfile');
    assert.equal(room.players[0].userId, 'user-alice');
    assert.equal(room.engine.players[0].name, 'AliceProfile');
    roomManager.destroyRoom(created.roomCode);
    hijack.close();
    host.close();
  });

  it('still allows guests with no token', async () => {
    const guest = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((resolve) => guest.on('connect', resolve));
    const created = await new Promise((resolve) => {
      guest.emit('create_room', { hostName: 'GuestHost', roomName: 'NoAuth', maxPlayers: 3, mode: 'base' }, resolve);
    });
    assert.equal(created.success, true);
    const room = roomManager.getRoom(created.roomCode);
    assert.equal(room.players[0].name, 'GuestHost');
    assert.equal(room.players[0].userId, null);
    roomManager.destroyRoom(created.roomCode);
    guest.close();
  });
});
