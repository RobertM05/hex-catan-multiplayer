/**
 * confetti.js
 * Lightweight HTML5 canvas particle celebration engine.
 * Generates smooth 60fps celebratory confetti on victory with zero dependencies.
 */

export class ConfettiCelebration {
  constructor(canvasId = 'confetti-canvas') {
    this.canvasId = canvasId;
    this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.animFrameId = null;
    this.running = false;
    this.startTime = 0;
    this.durationMs = 6000;
  }

  init() {
    if (typeof document === 'undefined') return;
    let canvas = document.getElementById(this.canvasId);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = this.canvasId;
      canvas.className = 'confetti-canvas';
      document.body.appendChild(canvas);
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.resize();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.resize());
    }
  }

  resize() {
    if (!this.canvas) return;
    if (typeof window !== 'undefined') {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    }
  }

  start(particleCount = 150) {
    this.init();
    if (!this.canvas || !this.ctx) return;

    this.stop();
    this.resize();
    this.running = true;
    this.startTime = Date.now();

    const colors = [
      '#f59e0b', // gold
      '#ef4444', // crimson
      '#10b981', // emerald
      '#3b82f6', // royal blue
      '#8b5cf6', // purple
      '#06b6d4', // cyan
      '#f97316'  // amber
    ];

    this.particles = [];
    const w = this.canvas.width || 800;
    const h = this.canvas.height || 600;

    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * w,
        y: Math.random() * -h * 0.5,
        w: 8 + Math.random() * 8,
        h: 6 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: 2.5 + Math.random() * 4,
        angle: Math.random() * 360,
        angularSpeed: (Math.random() - 0.5) * 6,
        wobble: Math.random() * 10,
        wobbleSpeed: 0.05 + Math.random() * 0.05
      });
    }

    const loop = () => {
      if (!this.running) return;
      const elapsed = Date.now() - this.startTime;
      if (elapsed > this.durationMs) {
        this.stop();
        return;
      }

      this.update(elapsed);
      this.draw();
      if (typeof requestAnimationFrame !== 'undefined') {
        this.animFrameId = requestAnimationFrame(loop);
      }
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      this.animFrameId = requestAnimationFrame(loop);
    }
  }

  update(elapsed) {
    if (!this.canvas) return;
    const h = this.canvas.height || 600;
    const w = this.canvas.width || 800;
    const remaining = this.durationMs - elapsed;
    const alpha = remaining < 1000 ? remaining / 1000 : 1;

    for (const p of this.particles) {
      p.x += p.vx + Math.sin(p.wobble) * 1.5;
      p.y += p.vy;
      p.angle += p.angularSpeed;
      p.wobble += p.wobbleSpeed;
      p.alpha = alpha;

      if (p.y > h + 20) {
        p.y = -20;
        p.x = Math.random() * w;
      }
    }
  }

  draw() {
    if (!this.ctx || !this.canvas) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const p of this.particles) {
      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate((p.angle * Math.PI) / 180);
      this.ctx.globalAlpha = Math.max(0, p.alpha ?? 1);
      this.ctx.fillStyle = p.color;
      this.ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      this.ctx.restore();
    }
  }

  stop() {
    this.running = false;
    if (this.animFrameId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.particles = [];
  }
}

export const confetti = new ConfettiCelebration();
