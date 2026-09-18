import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculatePlayerEloDelta,
  calculateMatchEloUpdates,
  calculateAbandonPenalty,
  DEFAULT_ELO,
  MIN_ELO
} from '../server/game/EloRating.js';
import { RankedQueue } from '../server/game/RankedQueue.js';
import { RoomManager } from '../server/game/RoomManager.js';
import { GAME_PHASES } from '../server/game/GameEngine.js';
import {
  persistRankedMatchRatings,
  applyRankedAbandonPenalty,
  persistFinishedMatch
} from '../server/auth/matchStore.js';

test('RANK-01: Elo calculation - 1st/2nd gain rating, 3rd/4th lose rating', () => {
  const opponentRatings = [1000, 1000, 1000];

  const delta1 = calculatePlayerEloDelta(1000, opponentRatings, 1);
  const delta2 = calculatePlayerEloDelta(1000, opponentRatings, 2);
  const delta3 = calculatePlayerEloDelta(1000, opponentRatings, 3);
  const delta4 = calculatePlayerEloDelta(1000, opponentRatings, 4);

  assert.ok(delta1 > 0, `1st place should gain Elo, got ${delta1}`);
  assert.ok(delta2 > 0, `2nd place should gain Elo, got ${delta2}`);
  assert.ok(delta3 < 0, `3rd place should lose Elo, got ${delta3}`);
  assert.ok(delta4 < 0, `4th place should lose Elo, got ${delta4}`);
  assert.equal(delta1 + delta2 + delta3 + delta4, 0, 'Symmetric field deltas should sum to 0');
});

test('RANK-01: Elo calculation - disparate ratings clamp guarantee', () => {
  // Even if a 2000-rated player places 2nd against 800-rated opponents, rule guarantees gain
  const delta2 = calculatePlayerEloDelta(2000, [800, 800, 800], 2);
  assert.ok(delta2 >= 1, `2nd place must always gain >= +1, got ${delta2}`);

  // Even if an 800-rated player places 3rd against 2000-rated opponents, rule guarantees loss
  const delta3 = calculatePlayerEloDelta(800, [2000, 2000, 2000], 3);
  assert.ok(delta3 <= -1, `3rd place must always lose <= -1, got ${delta3}`);
});

test('RANK-01: Elo calculation - calculateAbandonPenalty', () => {
  const initialField = [1000, 1050, 950, 1000];
  const penalty = calculateAbandonPenalty(1000, initialField);

  assert.ok(penalty <= -1, `Abandon penalty must be negative, got ${penalty}`);
  // Abandoner receives the 4th-place penalty
  const expected4th = calculatePlayerEloDelta(1000, [1050, 950, 1000], 4);
  assert.equal(penalty, expected4th);
});

test('RANK-01: Elo calculation - MIN_ELO clamp', () => {
  const players = [
    { userId: 'u1', elo: 105, rank: 4 },
    { userId: 'u2', elo: 1000, rank: 1 },
    { userId: 'u3', elo: 1000, rank: 2 },
    { userId: 'u4', elo: 1000, rank: 3 }
  ];
  const updates = calculateMatchEloUpdates(players);
  const u1 = updates.find(u => u.userId === 'u1');
  assert.ok(u1.newElo >= MIN_ELO, `Elo should not drop below ${MIN_ELO}, got ${u1.newElo}`);
});

test('RANK-01: RankedQueue - authentication requirement and queue operations', () => {
  const queue = new RankedQueue();

  // Rejects unauthenticated
  const fail = queue.addPlayer({ name: 'Guest' });
  assert.equal(fail.success, false);
  assert.equal(fail.reason, 'AUTH_REQUIRED');

  // Adds authenticated players
  const p1 = queue.addPlayer({ socketId: 's1', userId: 'u1', name: 'Alice', elo: 1200 });
  assert.equal(p1.success, true);
  assert.equal(queue.getQueueSize(), 1);

  // Re-adding same user updates socket without duplicating
  const p1Again = queue.addPlayer({ socketId: 's1_new', userId: 'u1', name: 'Alice', elo: 1200 });
  assert.equal(p1Again.alreadyQueued, true);
  assert.equal(queue.getQueueSize(), 1);

  // Leave queue
  queue.removePlayer('u1');
  assert.equal(queue.getQueueSize(), 0);
  assert.equal(queue.isInQueue('u1'), false);
});

test('RANK-01: RankedQueue - automatically pops match when 4th player arrives', () => {
  let matchedResult = null;
  const queue = new RankedQueue({
    onMatchReady: (matched) => {
      matchedResult = matched;
    }
  });

  queue.addPlayer({ socketId: 's1', userId: 'u1', name: 'P1' });
  queue.addPlayer({ socketId: 's2', userId: 'u2', name: 'P2' });
  queue.addPlayer({ socketId: 's3', userId: 'u3', name: 'P3' });
  assert.equal(matchedResult, null);
  assert.equal(queue.getQueueSize(), 3);

  queue.addPlayer({ socketId: 's4', userId: 'u4', name: 'P4' });
  assert.ok(matchedResult, 'Match should trigger on 4th player');
  assert.equal(matchedResult.length, 4);
  assert.equal(queue.getQueueSize(), 0);
});

test('RANK-01: RoomManager - ranked match start rules & bot restrictions', () => {
  const ioMock = { to: () => ({ emit: () => {} }) };
  const rm = new RoomManager(ioMock);

  // 1. Create a ranked room (hostData, options)
  const room = rm.createRoom(
    { id: 'p1', name: 'Alice', userId: 'u1', elo: 1100 },
    { ranked: true }
  );
  assert.equal(room.ranked, true);

  // 2. Bots cannot be added to ranked rooms
  const bot = rm.addBot(room.code);
  assert.equal(bot, null, 'addBot must return null for ranked rooms');

  // 3. Cannot start with fewer than 4 players
  rm.joinRoom(room.code, { id: 'p2', name: 'Bob', userId: 'u2', elo: 1000 });
  rm.getRoom(room.code).players[1].isReady = true;
  assert.throws(
    () => rm.startGame(room.code, 'p1'),
    /RANKED_REQUIRES_EXACTLY_4_PLAYERS/
  );

  // Join 3rd player
  rm.joinRoom(room.code, { id: 'p3', name: 'Charlie', userId: 'u3', elo: 950 });

  // 4. Guest cannot join ranked room
  const guestJoin = rm.joinRoom(room.code, { id: 'p4_guest', name: 'Guest', userId: null });
  assert.equal(guestJoin.error, 'RANKED_REQUIRES_SIGNED_IN');

  // Valid 4th player joins
  rm.joinRoom(room.code, { id: 'p4', name: 'David', userId: 'u4', elo: 1050 });
  rm.getRoom(room.code).players[1].isReady = true;
  rm.getRoom(room.code).players[2].isReady = true;
  rm.getRoom(room.code).players[3].isReady = true;

  // If a player somehow lacks a userId, startGame throws
  rm.getRoom(room.code).players[3].userId = null;
  assert.throws(
    () => rm.startGame(room.code, 'p1'),
    /RANKED_REQUIRES_SIGNED_IN_PLAYERS/
  );

  // 5. Valid start with 4 signed-in humans
  rm.getRoom(room.code).players[3].userId = 'u4';
  const started = rm.startGame(room.code, 'p1');
  assert.equal(started.isStarted, true);
  assert.deepEqual(started.initialFieldRatings, [1100, 1000, 950, 1050]);

  // 6. Spectator / mid-match join rejected
  const midJoin = rm.joinRoom(room.code, { id: 'p5', name: 'Intruder', userId: 'u5' });
  assert.equal(midJoin.error, 'CANNOT_JOIN_ACTIVE_RANKED_MATCH');
});

test('RANK-01: Casual games never write Elo ratings', async () => {
  let upsertCalled = false;
  const mockAdmin = {
    insertMatch: async () => {},
    upsertRating: async () => { upsertCalled = true; }
  };
  const mockRuntime = { admin: mockAdmin };

  const engine = {
    isGameOver: true,
    mode: 'base',
    winner: { id: 'p1' },
    players: [
      { id: 'p1', victoryPoints: 10, userId: 'u1' },
      { id: 'p2', victoryPoints: 8, userId: 'u2' },
      { id: 'p3', victoryPoints: 6, userId: 'u3' },
      { id: 'p4', victoryPoints: 4, userId: 'u4' }
    ]
  };

  const casualRoom = {
    code: 'CASUL',
    ranked: false,
    engine,
    players: [
      { id: 'p1', frozenUserId: 'u1', elo: 1000 },
      { id: 'p2', frozenUserId: 'u2', elo: 1000 },
      { id: 'p3', frozenUserId: 'u3', elo: 1000 },
      { id: 'p4', frozenUserId: 'u4', elo: 1000 }
    ]
  };

  await persistFinishedMatch(casualRoom, mockRuntime);
  assert.equal(upsertCalled, false, 'Casual match must never write to ratings');
});

test('RANK-01: Double-abandon - each receives 4th-place penalty, remaining finish with gains', async () => {
  const ratingsStore = new Map([
    ['u1', { elo: 1000, games: 5 }],
    ['u2', { elo: 1000, games: 5 }],
    ['u3', { elo: 1000, games: 5 }],
    ['u4', { elo: 1000, games: 5 }]
  ]);

  const mockAdmin = {
    insertMatch: async () => {},
    getRating: async (uid) => ratingsStore.get(uid) || { elo: 1000, games: 0 },
    upsertRating: async (uid, data) => {
      ratingsStore.set(uid, data);
      return data;
    }
  };
  const mockRuntime = { admin: mockAdmin };

  const ioMock = { to: () => ({ emit: () => {} }) };
  const rm = new RoomManager(ioMock, {
    onRankedAbandon: (room, player) => {
      applyRankedAbandonPenalty(room, player, mockRuntime);
    }
  });

  const room = rm.createRoom({ id: 'p1', name: 'Alice', userId: 'u1', elo: 1000 }, { ranked: true });
  rm.joinRoom(room.code, { id: 'p2', name: 'Bob', userId: 'u2', elo: 1000 });
  rm.joinRoom(room.code, { id: 'p3', name: 'Charlie', userId: 'u3', elo: 1000 });
  rm.joinRoom(room.code, { id: 'p4', name: 'David', userId: 'u4', elo: 1000 });
  for (const p of room.players) p.isReady = true;
  rm.startGame(room.code, 'p1');

  // First player abandons after grace: p4
  const p4 = rm.replaceDisconnectedPlayerWithBot(room.code, 'p4');
  await p4.abandonPromise;
  assert.equal(room.players.find(p => p.id === 'p4').abandoned, true);
  assert.equal(room.players.find(p => p.id === 'p4').isBot, true);

  // Verify p4 received 4th-place penalty immediately
  const p4Rating = ratingsStore.get('u4');
  assert.ok(p4Rating.elo < 1000, `p4 should lose Elo on abandon, got ${p4Rating.elo}`);
  assert.equal(p4Rating.games, 6);

  // Second player abandons after grace: p3
  const p3 = rm.replaceDisconnectedPlayerWithBot(room.code, 'p3');
  await p3.abandonPromise;
  assert.equal(room.players.find(p => p.id === 'p3').abandoned, true);
  assert.equal(room.players.find(p => p.id === 'p3').isBot, true);

  // Verify p3 ALSO received full 4th-place penalty (double abandon rule)
  const p3Rating = ratingsStore.get('u3');
  assert.ok(p3Rating.elo < 1000, `p3 should lose Elo on abandon, got ${p3Rating.elo}`);
  assert.equal(p3Rating.elo, p4Rating.elo, 'Both abandoners should receive identical 4th-place penalty');
  assert.equal(p3Rating.games, 6);

  // Remaining humans (p1, p2) finish the game vs bots
  room.engine.phase = GAME_PHASES.GAME_OVER;
  room.engine.winner = { id: 'p1' };
  room.engine.players.find(p => p.id === 'p1').victoryPoints = 10;
  room.engine.players.find(p => p.id === 'p2').victoryPoints = 7;
  room.engine.players.find(p => p.id === 'p3').victoryPoints = 3;
  room.engine.players.find(p => p.id === 'p4').victoryPoints = 2;

  await persistFinishedMatch(room, mockRuntime);

  const p1Rating = ratingsStore.get('u1');
  const p2Rating = ratingsStore.get('u2');

  assert.ok(p1Rating.elo > 1000, `1st place p1 should gain Elo, got ${p1Rating.elo}`);
  assert.ok(p2Rating.elo > 1000, `2nd place p2 should gain Elo, got ${p2Rating.elo}`);
  assert.equal(p1Rating.games, 6);
  assert.equal(p2Rating.games, 6);

  // Ensure abandoners were not double-penalized on match end
  assert.equal(ratingsStore.get('u3').games, 6);
  assert.equal(ratingsStore.get('u4').games, 6);
});
