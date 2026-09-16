import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTimerState,
  getDiscardRemainingSeconds,
  playerMustDiscard,
  TurnTimerUI
} from '../public/js/turnTimer.js';

describe('UX-08: Turn Timer Progress, Discard Sync, and Low-Time Warning', () => {
  it('should handle infinite / no-limit duration (>= 9999)', () => {
    const res = calculateTimerState({ remaining: 9999, duration: 9999 });
    assert.equal(res.isInfinite, true);
    assert.equal(res.text, '∞');
    assert.equal(res.pct, 100);
    assert.equal(res.colorClass, 'timer-infinite');
    assert.equal(res.isLowTime, false);
  });

  it('should format normal time (> 50%) with timer-normal class', () => {
    const res = calculateTimerState({ remaining: 45, duration: 60 });
    assert.equal(res.isInfinite, false);
    assert.equal(res.remaining, 45);
    assert.equal(res.duration, 60);
    assert.equal(res.pct, 75);
    assert.equal(res.colorClass, 'timer-normal');
    assert.equal(res.isLowTime, false);
    assert.equal(res.text, '45s');
  });

  it('should format warning time (20-50%) with timer-warning class', () => {
    const res = calculateTimerState({ remaining: 24, duration: 60 });
    assert.equal(res.isInfinite, false);
    assert.equal(res.pct, 40);
    assert.equal(res.colorClass, 'timer-warning');
    assert.equal(res.isLowTime, false);
    assert.equal(res.text, '24s');
  });

  it('should format critical time (< 20%) with timer-critical class', () => {
    const res = calculateTimerState({ remaining: 10, duration: 60 });
    assert.equal(res.isInfinite, false);
    assert.equal(res.pct, 10 / 60 * 100);
    assert.equal(res.colorClass, 'timer-critical');
    assert.equal(res.isLowTime, false);
    assert.equal(res.text, '10s');
  });

  it('should trigger low-time warning when remaining is 5 seconds or fewer', () => {
    const res5 = calculateTimerState({ remaining: 5, duration: 60 });
    assert.equal(res5.isLowTime, true);
    assert.equal(res5.colorClass, 'timer-critical');

    const res1 = calculateTimerState({ remaining: 1, duration: 60 });
    assert.equal(res1.isLowTime, true);

    const res0 = calculateTimerState({ remaining: 0, duration: 60 });
    assert.equal(res0.isLowTime, false);
    assert.equal(res0.pct, 0);
  });

  it('should calculate remaining discard seconds from future deadline', () => {
    const now = 1000000;
    const deadline = now + 14200; // 14.2s in future
    const remaining = getDiscardRemainingSeconds(deadline, now);
    assert.equal(remaining, 15);
  });

  it('should return 0 for past or empty discard deadline', () => {
    const now = 1000000;
    assert.equal(getDiscardRemainingSeconds(now - 5000, now), 0);
    assert.equal(getDiscardRemainingSeconds(null, now), 0);
    assert.equal(getDiscardRemainingSeconds(undefined, now), 0);
  });

  it('TurnTimerUI: should play audio warning only when it is active player turn and low time', () => {
    let warningPlayed = 0;
    const mockAudio = {
      playTimerWarning: () => { warningPlayed++; }
    };

    const ui = new TurnTimerUI({ audio: mockAudio });

    // Not my turn: should not play sound
    ui.update({ remaining: 5, duration: 60, isMyTurn: false });
    assert.equal(warningPlayed, 0);

    // My turn, remaining 5s: should play sound
    ui.update({ remaining: 5, duration: 60, isMyTurn: true });
    assert.equal(warningPlayed, 1);

    // Repeated call with same remaining second: should deduplicate and not re-play sound
    ui.update({ remaining: 5, duration: 60, isMyTurn: true });
    assert.equal(warningPlayed, 1);

    // Next second (4s): should play sound
    ui.update({ remaining: 4, duration: 60, isMyTurn: true });
    assert.equal(warningPlayed, 2);

    // Not low time (20s): should reset alert tracking
    ui.update({ remaining: 20, duration: 60, isMyTurn: true });
    assert.equal(warningPlayed, 2);
  });

  it('should pulse discard HUD for every pending discarder, not only the roller', () => {
    assert.equal(playerMustDiscard(['p1', 'p3'], 'p3'), true);
    assert.equal(playerMustDiscard(['p1', 'p3'], 'p2'), false);
    assert.equal(playerMustDiscard(undefined, 'p1'), false);

    let warningPlayed = 0;
    const ui = new TurnTimerUI({
      audio: { playTimerWarning: () => { warningPlayed++; } }
    });
    const soon = Date.now() + 4000;
    ui.syncDiscard({ discardDeadline: soon, isPendingDiscard: false });
    assert.equal(warningPlayed, 0);
    ui.syncDiscard({ discardDeadline: soon, isPendingDiscard: true });
    assert.equal(warningPlayed, 1);
  });
});
