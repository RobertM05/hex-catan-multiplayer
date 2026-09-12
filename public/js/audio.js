/**
 * audio.js
 * Procedural sound synthesizer using the Web Audio API.
 * High fidelity board game audio effects with zero external file dependencies.
 */

class SoundEffects {
  constructor() {
    this.ctx = null;
    const sfxMuted = typeof localStorage !== 'undefined' && localStorage.getItem('catan_sfx_muted') === 'true';
    const soundEnabled = typeof localStorage === 'undefined' || localStorage.getItem('catan_sound') !== 'false';
    this.enabled = !sfxMuted && soundEnabled;
  }

  init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.ctx = new AudioContext();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  isMuted() {
    return !this.enabled;
  }

  setMuted(muted) {
    this.enabled = !muted;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('catan_sfx_muted', muted ? 'true' : 'false');
      localStorage.setItem('catan_sound', this.enabled ? 'true' : 'false');
    }
    return this.enabled;
  }

  toggle() {
    return this.setMuted(this.enabled);
  }

  playDiceRoll() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    // Rattle sequence
    for (let i = 0; i < 4; i++) {
      const delay = i * 0.07;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(140 + Math.random() * 80, now + delay);
      osc.frequency.exponentialRampToValueAtTime(40, now + delay + 0.05);

      gain.gain.setValueAtTime(0.25, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.01, now + delay + 0.05);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.06);
    }
  }

  playBuild() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.15);

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  playTrade() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    // Pleasant double chime (coin sound)
    const notes = [587.33, 880]; // D5, A5
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.09);

      gain.gain.setValueAtTime(0.25, now + idx * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.25);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + idx * 0.09);
      osc.stop(now + idx * 0.09 + 0.26);
    });
  }

  playTurnAlert() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now); // A4
    osc.frequency.setValueAtTime(554.37, now + 0.1); // C#5

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  }

  playTimerWarning() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now); // A5
    osc.frequency.setValueAtTime(659.25, now + 0.08); // E5

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  playRobber() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.linearRampToValueAtTime(80, now + 0.4);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.42);
  }

  playVictory() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    // Fanfare chords: C4, E4, G4, C5
    const fanfare = [
      { f: 261.63, t: 0.0, d: 0.2 },
      { f: 329.63, t: 0.18, d: 0.2 },
      { f: 392.00, t: 0.36, d: 0.2 },
      { f: 523.25, t: 0.54, d: 0.8 }
    ];

    fanfare.forEach(item => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(item.f, now + item.t);

      gain.gain.setValueAtTime(0.3, now + item.t);
      gain.gain.exponentialRampToValueAtTime(0.001, now + item.t + item.d);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + item.t);
      osc.stop(now + item.t + item.d);
    });
  }

  playFanfare() {
    return this.playVictory();
  }
}

export const audio = new SoundEffects();
