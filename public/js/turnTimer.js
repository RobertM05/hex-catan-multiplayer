/**
 * turnTimer.js
 * Turn timer state computation, progress animation, and low-time audio alerts.
 */

export function calculateTimerState({ remaining, duration }) {
  if (!duration || duration >= 9999) {
    return {
      isInfinite: true,
      remaining: Infinity,
      duration: Infinity,
      pct: 100,
      colorClass: 'timer-infinite',
      isLowTime: false,
      text: '∞'
    };
  }

  const dur = Math.max(1, duration);
  const rem = Math.max(0, remaining !== undefined && remaining !== null ? remaining : dur);
  const pct = Math.min(100, Math.max(0, (rem / dur) * 100));

  let colorClass = 'timer-normal';
  if (pct < 20) {
    colorClass = 'timer-critical';
  } else if (pct <= 50) {
    colorClass = 'timer-warning';
  }

  const isLowTime = rem > 0 && rem <= 5;

  return {
    isInfinite: false,
    remaining: rem,
    duration: dur,
    pct,
    colorClass,
    isLowTime,
    text: `${rem}s`
  };
}

export function getDiscardRemainingSeconds(discardDeadline, now = Date.now()) {
  if (!discardDeadline) return 0;
  const deadlineMs = typeof discardDeadline === 'number'
    ? discardDeadline
    : new Date(discardDeadline).getTime();
  const diffMs = deadlineMs - now;
  return Math.max(0, Math.ceil(diffMs / 1000));
}

export class TurnTimerUI {
  constructor({
    wrapperId = 'turn-timer-wrapper',
    displayId = 'turn-timer-display',
    fillId = 'turn-timer-fill',
    audio = null
  } = {}) {
    this.wrapperId = wrapperId;
    this.displayId = displayId;
    this.fillId = fillId;
    this.audio = audio;
    this.lastAlertedSec = null;
    this.currentIsMyTurn = false;
    this.currentTimerState = null;
  }

  update({ remaining, duration, isMyTurn = false, customLabel = null }) {
    this.currentIsMyTurn = isMyTurn;
    const state = calculateTimerState({ remaining, duration });
    this.currentTimerState = state;

    // Audio warning on 5s down to 1s
    if (state.isLowTime && isMyTurn && this.audio && !this.audio.isMuted?.() && typeof this.audio.playTimerWarning === 'function') {
      if (this.lastAlertedSec !== state.remaining) {
        this.lastAlertedSec = state.remaining;
        this.audio.playTimerWarning();
      }
    }

    if (!state.isLowTime) {
      this.lastAlertedSec = null;
    }

    if (typeof document === 'undefined') return state;

    const wrapper = document.getElementById(this.wrapperId);
    const display = document.getElementById(this.displayId);
    const fill = document.getElementById(this.fillId);

    if (display) {
      display.textContent = customLabel ? `${customLabel}: ${state.text}` : state.text;
    }

    if (fill) {
      fill.style.width = `${state.pct}%`;
    }

    if (wrapper) {
      wrapper.classList.remove('timer-normal', 'timer-warning', 'timer-critical', 'timer-infinite', 'timer-pulse');
      wrapper.classList.add(state.colorClass);

      if (state.isLowTime && isMyTurn) {
        wrapper.classList.add('timer-pulse');
      }
    }

    return state;
  }

  syncDiscard({ discardDeadline, isMyTurn = false }) {
    const remaining = getDiscardRemainingSeconds(discardDeadline);
    return this.update({
      remaining,
      duration: 30,
      isMyTurn,
      customLabel: null
    });
  }
}
