import { randomUUID } from 'node:crypto';
import { getAuthRuntime } from './identity.js';

export function computeFinishRanks(engine) {
  const players = [...(engine?.players || [])];
  const winnerId = engine?.winner?.id || null;
  players.sort((a, b) => {
    if (winnerId && a.id === winnerId) return -1;
    if (winnerId && b.id === winnerId) return 1;
    return (b.victoryPoints || 0) - (a.victoryPoints || 0);
  });
  return players.map((p, index) => ({ player: p, rank: index + 1 }));
}

export function buildMatchPayload(room, now = Date.now()) {
  const engine = room.engine;
  const matchId = room.matchId || randomUUID();
  const startedAt = new Date(room.startedAt || room.createdAt || now).toISOString();
  const endedAt = new Date(now).toISOString();
  const ranked = Boolean(room.ranked);
  const mode = room.mode || engine?.mode || 'base';
  const ranks = computeFinishRanks(engine);
  const seatById = new Map(room.players.map((p, i) => [p.id, i]));

  const matchRow = {
    id: matchId,
    started_at: startedAt,
    ended_at: endedAt,
    mode,
    ranked,
    room_code: room.code,
    expansion_cities_knights: mode === 'cities_knights'
  };

  const playerRows = ranks.map(({ player, rank }) => {
    const lobby = room.players.find(p => p.id === player.id) || {};
    return {
      match_id: matchId,
      seat_index: seatById.has(player.id) ? seatById.get(player.id) : rank - 1,
      user_id: lobby.frozenUserId || lobby.userId || player.userId || null,
      display_name: lobby.frozenDisplayName || player.name,
      vp: player.victoryPoints || 0,
      rank,
      abandoned: Boolean(lobby.abandoned)
    };
  });

  return { matchId, matchRow, playerRows };
}

export async function persistFinishedMatch(room, runtime = getAuthRuntime()) {
  if (!room?.engine?.isGameOver) return { skipped: true, reason: 'not_over' };
  if (!runtime.admin?.insertMatch) return { skipped: true, reason: 'supabase_unconfigured' };
  if (room.matchPersistStarted && room.matchPersisted) return { skipped: true, reason: 'already_persisted' };
  room.matchPersistStarted = true;
  try {
    const payload = buildMatchPayload(room);
    room.matchId = payload.matchId;
    await runtime.admin.insertMatch(payload.matchRow, payload.playerRows);
    room.matchPersisted = true;
    return { skipped: false, matchId: payload.matchId };
  } catch (err) {
    room.matchPersistStarted = false;
    console.error('[auth] match persist failed:', err.message);
    return { skipped: true, reason: 'error', error: err.message };
  }
}
