/**
 * SEC-02: sliding-window rate limits for create_room, chat, and game actions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SlidingWindowLimiter,
  RATE_LIMITS,
  RATE_LIMITED,
  createRoomLimitKey,
  chatLimitKey,
  actionLimitKey
} from '../server/game/rateLimiter.js';

describe('SEC-02 socket rate limiter', () => {
  it('exposes the documented create_room / chat / action windows', () => {
    assert.equal(RATE_LIMITED, 'RATE_LIMITED');
    assert.equal(RATE_LIMITS.createRoom.max, 5);
    assert.equal(RATE_LIMITS.createRoom.windowMs, 60_000);
    assert.equal(RATE_LIMITS.sendChat.max, 5);
    assert.equal(RATE_LIMITS.sendChat.windowMs, 3_000);
    assert.equal(RATE_LIMITS.gameAction.max, 25);
    assert.equal(RATE_LIMITS.gameAction.windowMs, 5_000);
  });

  it('rejects a 6th create_room in the same minute for one IP', () => {
    const limiter = new SlidingWindowLimiter();
    const key = createRoomLimitKey('203.0.113.10');
    const spec = RATE_LIMITS.createRoom;
    const now = 1_000_000;
    for (let i = 0; i < spec.max; i++) {
      assert.equal(limiter.consume(key, spec, now + i), true);
    }
    assert.equal(limiter.consume(key, spec, now + spec.max), false);
    assert.equal(limiter.consume(key, spec, now + spec.windowMs + 1), true);
  });

  it('rejects a 6th chat message within 3 seconds for one player', () => {
    const limiter = new SlidingWindowLimiter();
    const key = chatLimitKey('player-a', 'sock-a');
    const spec = RATE_LIMITS.sendChat;
    const now = 2_000_000;
    for (let i = 0; i < spec.max; i++) {
      assert.equal(limiter.consume(key, spec, now + i), true);
    }
    assert.equal(limiter.consume(key, spec, now + spec.max), false);
    assert.equal(limiter.consume(key, spec, now + spec.windowMs + 1), true);
  });

  it('rejects a 26th game action within 5 seconds for one socket', () => {
    const limiter = new SlidingWindowLimiter();
    const key = actionLimitKey('sock-burst');
    const spec = RATE_LIMITS.gameAction;
    const now = 3_000_000;
    for (let i = 0; i < spec.max; i++) {
      assert.equal(limiter.consume(key, spec, now + i), true);
    }
    assert.equal(limiter.consume(key, spec, now + spec.max), false);
    assert.equal(limiter.consume(key, spec, now + spec.windowMs + 1), true);
  });

  it('does not leak keys across different IPs or sockets', () => {
    const limiter = new SlidingWindowLimiter();
    const spec = { max: 1, windowMs: 1000 };
    const now = 4_000_000;
    assert.equal(limiter.consume(createRoomLimitKey('1.1.1.1'), spec, now), true);
    assert.equal(limiter.consume(createRoomLimitKey('1.1.1.1'), spec, now), false);
    assert.equal(limiter.consume(createRoomLimitKey('8.8.8.8'), spec, now), true);
  });

  it('clears socket and player buckets on disconnect without touching IP create_room state', () => {
    const limiter = new SlidingWindowLimiter();
    const spec = { max: 1, windowMs: 60_000 };
    const now = 5_000_000;
    const ipKey = createRoomLimitKey('198.51.100.9');
    const sock = 'dead-socket';
    const player = 'dead-player';
    assert.equal(limiter.consume(ipKey, spec, now), true);
    assert.equal(limiter.consume(actionLimitKey(sock), spec, now), true);
    assert.equal(limiter.consume(chatLimitKey(player, sock), spec, now), true);
    limiter.clearSocket(sock, player);
    assert.equal(limiter.consume(actionLimitKey(sock), spec, now), true);
    assert.equal(limiter.consume(chatLimitKey(player), spec, now), true);
    assert.equal(limiter.consume(ipKey, spec, now), false);
  });
});
