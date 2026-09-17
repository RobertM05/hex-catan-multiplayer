import { randomUUID } from 'node:crypto';
import { getAuthRuntime } from './identity.js';

export const queue = new Map();
let queueInterval = null;

function ensureQueueInterval() {
  if (queueInterval) return;
  queueInterval = setInterval(() => { processQueue().catch(console.error) }, 5000);
  queueInterval.unref();
}

export function stopQueueInterval() {
  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
  }
}

async function processQueue() {
  const now = Date.now();
  const tasksToRun = [];
  for (const [matchId, task] of queue.entries()) {
    if (now >= task.nextAttemptAt && !task.inFlight) {
      tasksToRun.push(task);
    }
  }
  await Promise.all(tasksToRun.map(attemptPersist));
}

function isRetryableError(err) {
  if (err.status === 429 || err.status === 408) return true;
  if (err.status >= 500 && err.status < 600) return true;
  
  const code = err.code || err.cause?.code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET') return true;
  
  if (err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError') return true;
  if (err.message?.includes('network timeout')) return true;
  
  return false;
}

async function attemptPersist(task) {
  task.attempts++;
  task.inFlight = true;
  
  try {
    await task.runtime.admin.insertMatch(task.payload.matchRow, task.payload.playerRows);
    queue.delete(task.payload.matchId);
    task.inFlight = false;
    if (task.room) task.room.matchPersisted = true;
  } catch (err) {
    task.inFlight = false;
    
    if (!isRetryableError(err)) {
      console.error('[auth] match persist client error (no retry):', err.message);
      queue.delete(task.payload.matchId);
      if (task.room) task.room.matchPersistStarted = false;
    } else {
      if (task.attempts >= 10) {
        console.error('[auth] match persist max attempts reached:', err.message);
        queue.delete(task.payload.matchId);
        if (task.room) task.room.matchPersistStarted = false;
      } else {
        const delay = Math.min(300000, 1000 * Math.pow(2, task.attempts) + Math.random() * 1000);
        task.nextAttemptAt = Date.now() + delay;
      }
    }
  }
}

export async function flushPendingQueue(timeoutMs = 10000) {
  const tasks = Array.from(queue.values()).filter(t => !t.inFlight);
  const promises = tasks.map(t => {
    return attemptPersist(t);
  });
  
  if (promises.length === 0) return;
  
  let timer;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  
  try {
    await Promise.race([Promise.allSettled(promises), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

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

  if (room.matchPersistStarted) {
    return { skipped: true, reason: room.matchPersisted ? 'already_persisted' : 'in_flight' };
  }

  if (!runtime.admin?.insertMatch) return { skipped: true, reason: 'supabase_unconfigured' };

  room.matchPersistStarted = true;

  const payload = buildMatchPayload(room);
  room.matchId = payload.matchId;

  // Single-flight deduplication on queue level
  if (queue.has(payload.matchId)) {
    return { skipped: true, reason: 'in_flight' };
  }

  const task = {
    room,
    payload,
    runtime,
    attempts: 0,
    nextAttemptAt: Date.now(),
    inFlight: true
  };
  
  // Add to queue initially to handle single-flight deduplication for concurrent calls
  queue.set(payload.matchId, task);
  ensureQueueInterval();

  try {
    await runtime.admin.insertMatch(payload.matchRow, payload.playerRows);
    room.matchPersisted = true;
    queue.delete(payload.matchId);
    return { skipped: false, matchId: payload.matchId };
  } catch (err) {
    task.inFlight = false;

    if (!isRetryableError(err)) {
      room.matchPersistStarted = false;
      queue.delete(payload.matchId);
      console.error('[auth] match persist client error:', err.message);
      return { skipped: true, reason: 'error', error: err.message };
    }

    // Queue for retry
    task.attempts++;
    const delay = Math.min(300000, 1000 * Math.pow(2, task.attempts) + Math.random() * 1000);
    task.nextAttemptAt = Date.now() + delay;
    console.error(`[auth] match persist failed (5xx/network), retrying in ${Math.round(delay/1000)}s:`, err.message);

    return { skipped: true, reason: 'queued_for_retry', error: err.message };
  }
}
