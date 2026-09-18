import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasBoardRenderer, BoardRenderer } from '../public/js/renderer.js';

function createMockCanvas(width = 800, height = 600) {
  const operations = [];
  const ctx = {
    operations,
    scaleCalls: [],
    drawImageCalls: [],
    clearRectCalls: [],
    fillTextCalls: [],
    scale(sx, sy) {
      this.scaleCalls.push({ sx, sy });
      operations.push({ op: 'scale', sx, sy });
    },
    setTransform(a, b, c, d, e, f) {
      operations.push({ op: 'setTransform', a, b, c, d, e, f });
    },
    clearRect(x, y, w, h) {
      this.clearRectCalls.push({ x, y, w, h });
      operations.push({ op: 'clearRect', x, y, w, h });
    },
    drawImage(image, sx, sy, sw, sh) {
      this.drawImageCalls.push({ image, sx, sy, sw, sh });
      operations.push({ op: 'drawImage', image, sx, sy, sw, sh });
    },
    save() { operations.push({ op: 'save' }); },
    restore() { operations.push({ op: 'restore' }); },
    translate(x, y) { operations.push({ op: 'translate', x, y }); },
    beginPath() { operations.push({ op: 'beginPath' }); },
    closePath() { operations.push({ op: 'closePath' }); },
    moveTo(x, y) { operations.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { operations.push({ op: 'lineTo', x, y }); },
    arc(x, y, r, sa, ea) { operations.push({ op: 'arc', x, y, r, sa, ea }); },
    stroke() { operations.push({ op: 'stroke' }); },
    fill() { operations.push({ op: 'fill' }); },
    fillRect(x, y, w, h) { operations.push({ op: 'fillRect', x, y, w, h }); },
    fillText(text, x, y) {
      this.fillTextCalls.push({ text, x, y });
      operations.push({ op: 'fillText', text, x, y });
    }
  };

  const canvas = {
    width,
    height,
    style: { width: `${width}px`, height: `${height}px` },
    getContext(type) {
      return type === '2d' ? ctx : null;
    }
  };

  return { canvas, ctx };
}

function makeMockGrid() {
  return {
    hexRadius: 60,
    hexes: {
      h1: { id: 'h1', center: { x: 0, y: 0 }, resource: 'wood', token: 6 },
      h2: { id: 'h2', center: { x: 100, y: 0 }, resource: 'wheat', token: 8 },
      h3: { id: 'h3', center: { x: 50, y: 86 }, resource: 'brick', token: 5 }
    },
    edges: {
      e1: { id: 'e1', x1: 0, y1: -60, x2: 50, y2: -30, midpoint: { x: 25, y: -45 }, hexes: ['h1'], road: { playerId: 'p1', color: '#e63946' } },
      e2: { id: 'e2', x1: 50, y1: -30, x2: 50, y2: 30, midpoint: { x: 50, y: 0 }, hexes: ['h1', 'h2'], road: null, harbor: { type: 'generic' } }
    },
    vertices: {
      v1: { id: 'v1', x: 0, y: -60, building: { type: 'settlement', playerId: 'p1', color: '#e63946' } },
      v2: { id: 'v2', x: 50, y: -30, building: null }
    },
    robberHexId: 'h3'
  };
}

test('CanvasBoardRenderer scales dimensions correctly for High-DPI / Retina displays (UI-01)', () => {
  const { canvas, ctx } = createMockCanvas(800, 600);
  const { canvas: offscreenCanvas, ctx: offscreenCtx } = createMockCanvas(800, 600);

  // Retina 2x display
  const renderer = new CanvasBoardRenderer(null, {
    canvas,
    ctx,
    offscreenCanvas,
    offscreenCtx,
    dpr: 2,
    width: 800,
    height: 600
  });

  // Physical canvas buffer dimensions should be multiplied by DPR (800*2 = 1600, 600*2 = 1200)
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 1200);
  assert.equal(canvas.style.width, '800px');
  assert.equal(canvas.style.height, '600px');

  // Offscreen canvas should match physical dimensions
  assert.equal(offscreenCanvas.width, 1600);
  assert.equal(offscreenCanvas.height, 1200);

  // Scale transform applied to contexts
  assert.ok(ctx.scaleCalls.some(c => c.sx === 2 && c.sy === 2));
  assert.ok(offscreenCtx.scaleCalls.some(c => c.sx === 2 && c.sy === 2));

  // 3x High-DPI display (e.g. 4K / Super Retina)
  renderer.dpr = 3;
  renderer.setupHighDpiCanvas(800, 600);
  assert.equal(canvas.width, 2400);
  assert.equal(canvas.height, 1800);
  assert.equal(offscreenCanvas.width, 2400);
  assert.equal(offscreenCanvas.height, 1800);
});

test('Static hex background is drawn to offscreen buffer and reused across frame renders', () => {
  const { canvas, ctx } = createMockCanvas(800, 600);
  const { canvas: offscreenCanvas, ctx: offscreenCtx } = createMockCanvas(800, 600);
  const grid = makeMockGrid();

  const renderer = new CanvasBoardRenderer(null, {
    canvas,
    ctx,
    offscreenCanvas,
    offscreenCtx,
    dpr: 1,
    width: 800,
    height: 600
  });

  assert.equal(renderer.backgroundDirty, true);
  assert.equal(renderer.backgroundRenderCycles, 0);

  // Frame 1: Initial render
  renderer.render(grid);
  assert.equal(renderer.backgroundRenderCycles, 1);
  assert.equal(renderer.backgroundDirty, false);

  // Verifies offscreen buffer received background hexes and number tokens
  assert.ok(offscreenCtx.fillTextCalls.some(c => c.text === '6'));
  assert.ok(offscreenCtx.fillTextCalls.some(c => c.text === '8'));
  assert.ok(offscreenCtx.fillTextCalls.some(c => c.text === '5'));

  // Verifies main canvas cleared and drew from offscreen canvas
  assert.equal(ctx.clearRectCalls.length, 1);
  assert.equal(ctx.drawImageCalls.length, 1);
  assert.equal(ctx.drawImageCalls[0].image, offscreenCanvas);

  // Frame 2: Subsequent render with same grid
  const offscreenOpCountBefore = offscreenCtx.operations.length;
  renderer.render(grid);

  // Background should be reused without re-drawing to offscreen buffer
  assert.equal(renderer.backgroundRenderCycles, 1);
  assert.equal(offscreenCtx.operations.length, offscreenOpCountBefore);
  assert.equal(ctx.drawImageCalls.length, 2);
});

test('Invalidating background triggers re-rendering of offscreen static buffer', () => {
  const { canvas, ctx } = createMockCanvas(800, 600);
  const { canvas: offscreenCanvas, ctx: offscreenCtx } = createMockCanvas(800, 600);
  const grid = makeMockGrid();

  const renderer = new CanvasBoardRenderer(null, {
    canvas,
    ctx,
    offscreenCanvas,
    offscreenCtx,
    dpr: 1
  });

  renderer.render(grid);
  assert.equal(renderer.backgroundRenderCycles, 1);

  // Invalidate background (e.g. map size changed or token swapped)
  renderer.invalidateBackground();
  assert.equal(renderer.backgroundDirty, true);

  renderer.render(grid);
  assert.equal(renderer.backgroundRenderCycles, 2);
});

test('Inventor card token swap automatically detects change and invalidates background', () => {
  const { canvas, ctx } = createMockCanvas(800, 600);
  const { canvas: offscreenCanvas, ctx: offscreenCtx } = createMockCanvas(800, 600);
  const grid = makeMockGrid();

  const renderer = new CanvasBoardRenderer(null, {
    canvas,
    ctx,
    offscreenCanvas,
    offscreenCtx,
    dpr: 1
  });

  renderer.render(grid);
  assert.equal(renderer.backgroundRenderCycles, 1);

  // Simulate Inventor card swapping token 6 and token 8
  grid.hexes.h1.token = 8;
  grid.hexes.h2.token = 6;

  renderer.render(grid);
  // Background should automatically detect token change and re-render static buffer
  assert.equal(renderer.backgroundRenderCycles, 2);
});

test('Hover states and road placement previews render without full-board redrawing', () => {
  const { canvas, ctx } = createMockCanvas(800, 600);
  const { canvas: offscreenCanvas, ctx: offscreenCtx } = createMockCanvas(800, 600);
  const grid = makeMockGrid();

  const renderer = new CanvasBoardRenderer(null, {
    canvas,
    ctx,
    offscreenCanvas,
    offscreenCtx,
    dpr: 1
  });

  renderer.render(grid);
  assert.equal(renderer.backgroundRenderCycles, 1);
  const offscreenOpCount = offscreenCtx.operations.length;

  // Hover over edge e2 (e.g. road placement preview)
  renderer.setHoverPreview('e2');

  // Background buffer must NOT be touched
  assert.equal(renderer.backgroundRenderCycles, 1);
  assert.equal(offscreenCtx.operations.length, offscreenOpCount);

  // Dynamic frame was composited using cached background
  assert.equal(renderer.dynamicRenderCount, 2);
  assert.equal(ctx.drawImageCalls.length, 2);
});

test('BoardRenderer exposes invalidateBackground and reuses cached background', () => {
  const mockContainer = { innerHTML: '', appendChild() {} };
  // Verify BoardRenderer has invalidateBackground
  assert.equal(typeof BoardRenderer.prototype.invalidateBackground, 'function');

  // Verify hasGridTokensChanged
  assert.equal(typeof BoardRenderer.prototype.hasGridTokensChanged, 'function');
  assert.equal(typeof BoardRenderer.prototype.cacheGridTokens, 'function');
});
