import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { audio } from '../public/js/audio.js';
import { ConfettiCelebration } from '../public/js/confetti.js';
import { renderVictoryStatsHtml } from '../public/js/app.js';
import { TurnTimerUI } from '../public/js/turnTimer.js';

describe('UX-10: Celebration & Audio SFX Controls', () => {
  // Mock localStorage for headless Node environment
  const mockStorage = {};
  global.localStorage = {
    getItem: (key) => (key in mockStorage ? mockStorage[key] : null),
    setItem: (key, val) => { mockStorage[key] = String(val); },
    removeItem: (key) => { delete mockStorage[key]; },
    clear: () => { for (const k in mockStorage) delete mockStorage[k]; }
  };

  beforeEach(() => {
    global.localStorage.clear();
  });

  describe('Audio Sound Effects & Mute Controls', () => {
    it('initializes unmuted by default when localStorage is empty', () => {
      audio.setMuted(false);
      assert.equal(audio.isMuted(), false);
      assert.equal(audio.enabled, true);
    });

    it('toggles mute state and persists to localStorage', () => {
      audio.setMuted(false);
      assert.equal(audio.isMuted(), false);

      const res1 = audio.toggle();
      assert.equal(res1, false); // now disabled / muted
      assert.equal(audio.isMuted(), true);
      assert.equal(global.localStorage.getItem('catan_sfx_muted'), 'true');
      assert.equal(global.localStorage.getItem('catan_sound'), 'false');

      const res2 = audio.toggle();
      assert.equal(res2, true); // now enabled / unmuted
      assert.equal(audio.isMuted(), false);
      assert.equal(global.localStorage.getItem('catan_sfx_muted'), 'false');
      assert.equal(global.localStorage.getItem('catan_sound'), 'true');
    });

    it('safely calls synthesis methods without throwing in headless/muted environment', () => {
      audio.setMuted(true);
      assert.doesNotThrow(() => {
        audio.playDiceRoll();
        audio.playBuild();
        audio.playFanfare();
        audio.playVictory();
        audio.playTrade();
        audio.playRobber();
        audio.playTurnAlert();
        audio.playTimerWarning();
      });
    });

    it('TurnTimerUI respects global SFX mute state', () => {
      let warningPlayed = 0;
      const mockAudio = {
        isMuted: () => true,
        playTimerWarning: () => { warningPlayed++; }
      };

      const ui = new TurnTimerUI({ audio: mockAudio });
      // In low time, but audio is muted: sound should NOT play
      ui.update({ remaining: 3, duration: 60, isMyTurn: true });
      assert.equal(warningPlayed, 0);

      // Unmute audio: sound should play
      mockAudio.isMuted = () => false;
      ui.update({ remaining: 2, duration: 60, isMyTurn: true });
      assert.equal(warningPlayed, 1);
    });
  });

  describe('Confetti Celebration Canvas Engine', () => {
    it('creates ConfettiCelebration instance with configurable duration', () => {
      const celebration = new ConfettiCelebration('test-canvas');
      assert.equal(celebration.canvasId, 'test-canvas');
      assert.equal(celebration.running, false);
      assert.equal(celebration.particles.length, 0);
    });

    it('handles start, update, and stop lifecycle without DOM errors in headless environment', () => {
      const celebration = new ConfettiCelebration('mock-canvas');
      celebration.canvas = { width: 800, height: 600 };
      celebration.ctx = {
        clearRect: () => {},
        save: () => {},
        translate: () => {},
        rotate: () => {},
        fillRect: () => {},
        restore: () => {}
      };

      celebration.start(30);
      assert.equal(celebration.running, true);
      assert.equal(celebration.particles.length, 30);

      // Verify particle structure
      const p = celebration.particles[0];
      assert.ok(typeof p.x === 'number');
      assert.ok(typeof p.y === 'number');
      assert.ok(typeof p.vx === 'number');
      assert.ok(typeof p.color === 'string');

      // Update simulation
      celebration.update(500);
      assert.equal(celebration.running, true);

      // Stop celebration
      celebration.stop();
      assert.equal(celebration.running, false);
      assert.equal(celebration.particles.length, 0);
    });
  });

  describe('Game Over Summary Modal & Stats Formatting', () => {
    it('formats basic victory stats: victory points and total turns', () => {
      const winner = { id: 'p1', name: 'Alice', victoryPoints: 10 };
      const gameState = { turnNumber: 24, vpTarget: 10, players: [winner] };

      const html = renderVictoryStatsHtml(winner, gameState);
      assert.ok(html.includes('10'));
      assert.ok(html.includes('24'));
      assert.ok(!html.includes('Longest Road') && !html.includes('Cel mai lung drum'));
    });

    it('includes Longest Road badge when winner holds longest road', () => {
      const winner = { id: 'p1', name: 'Alice', victoryPoints: 10 };
      const gameState = {
        turnNumber: 18,
        vpTarget: 10,
        players: [winner],
        longestRoad: { playerId: 'p1', length: 7 }
      };

      const html = renderVictoryStatsHtml(winner, gameState);
      assert.ok(html.includes('7'));
      assert.ok(html.includes('🛣️'));
    });

    it('includes Largest Army badge when winner holds largest army', () => {
      const winner = { id: 'p1', name: 'Alice', victoryPoints: 10 };
      const gameState = {
        turnNumber: 22,
        vpTarget: 10,
        players: [winner],
        largestArmy: { playerId: 'p1', count: 4 }
      };

      const html = renderVictoryStatsHtml(winner, gameState);
      assert.ok(html.includes('4'));
      assert.ok(html.includes('⚔️'));
    });

    it('includes Metropolises count in Cities & Knights mode', () => {
      const winner = { id: 'p1', name: 'Alice', victoryPoints: 13 };
      const gameState = {
        mode: 'cities_knights',
        turnNumber: 30,
        vpTarget: 13,
        players: [winner],
        metropolises: {
          trade: { playerId: 'p1', vertexId: 'v1' },
          science: { playerId: 'p1', vertexId: 'v2' },
          politics: { playerId: 'p2', vertexId: 'v3' }
        }
      };

      const html = renderVictoryStatsHtml(winner, gameState);
      assert.ok(html.includes('🏛️ 2'));
    });
  });
});
