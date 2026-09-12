/**
 * renderer.js
 * High-performance SVG Board Renderer for Hexagonal Strategy Game.
 * Handles procedural hexes, terrain themes, number tokens, harbors,
 * interactive vertex/edge selection, robber placement, and pan/zoom.
 */

import { ICONS, svgIconGroup } from './icons.js';

const TERRAIN_ICON_FILL = {
  wood: '#d8f3dc',
  brick: '#ffe4e6',
  wool: '#14532d',
  wheat: '#6b3a10',
  ore: '#f1f5f9',
};

export class BoardRenderer {
  constructor(svgContainer, options = {}) {
    this.container = svgContainer;
    this.svg = null;
    this.boardGroup = null;
    this.hexLayer = null;
    this.harborLayer = null;
    this.edgeLayer = null;
    this.vertexLayer = null;
    this.robberLayer = null;
    this.particleLayer = null;

    this.grid = null;
    this.selectedAction = null; // { type: 'settlement'|'road'|'city'|'robber', validIds: Set }
    this.onVertexClick = null;
    this.onEdgeClick = null;
    this.onHexClick = null;

    // Pan & Zoom state
    this.viewBox = { x: -400, y: -350, width: 800, height: 700 };
    this.isPanning = false;
    this.startPoint = { x: 0, y: 0 };
    this.pointers = new Map();
    this.pinchStart = null;

    this.initSVG();
  }

  initSVG() {
    this.container.innerHTML = '';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
    this.svg.setAttribute('class', 'catan-board-svg');

    // Add SVG Defs (Gradients, filters, patterns)
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <!-- Terrain Gradients -->
      <radialGradient id="grad-wood" cx="40%" cy="40%" r="70%">
        <stop offset="0%" stop-color="#2d6a4f" />
        <stop offset="70%" stop-color="#1b4332" />
        <stop offset="100%" stop-color="#081c15" />
      </radialGradient>
      <radialGradient id="grad-brick" cx="40%" cy="40%" r="70%">
        <stop offset="0%" stop-color="#d90429" />
        <stop offset="70%" stop-color="#9a031e" />
        <stop offset="100%" stop-color="#5f0f40" />
      </radialGradient>
      <radialGradient id="grad-wool" cx="40%" cy="40%" r="70%">
        <stop offset="0%" stop-color="#99d98c" />
        <stop offset="70%" stop-color="#76c893" />
        <stop offset="100%" stop-color="#34a0a4" />
      </radialGradient>
      <radialGradient id="grad-wheat" cx="40%" cy="40%" r="70%">
        <stop offset="0%" stop-color="#ffe6a7" />
        <stop offset="60%" stop-color="#e09f3e" />
        <stop offset="100%" stop-color="#9e2a2b" />
      </radialGradient>
      <radialGradient id="grad-ore" cx="40%" cy="40%" r="70%">
        <stop offset="0%" stop-color="#6c757d" />
        <stop offset="60%" stop-color="#495057" />
        <stop offset="100%" stop-color="#212529" />
      </radialGradient>
      <radialGradient id="grad-desert" cx="40%" cy="40%" r="70%">
        <stop offset="0%" stop-color="#faedcd" />
        <stop offset="70%" stop-color="#e9edc9" />
        <stop offset="100%" stop-color="#d4a373" />
      </radialGradient>
      <radialGradient id="token-grad" cx="35%" cy="35%" r="65%">
        <stop offset="0%" stop-color="#fff8e7" />
        <stop offset="85%" stop-color="#e8d8b8" />
        <stop offset="100%" stop-color="#c4b087" />
      </radialGradient>

      <!-- Soft Drop Shadows -->
      <filter id="shadow-hex" x="-10%" y="-10%" width="130%" height="130%">
        <feDropShadow dx="2" dy="5" stdDeviation="4" flood-color="#000" flood-opacity="0.5" />
      </filter>
      <filter id="shadow-building" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="1" dy="3" stdDeviation="2.5" flood-color="#000" flood-opacity="0.6" />
      </filter>
      <filter id="glow-valid" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    `;
    this.svg.appendChild(defs);

    // Board container group
    this.boardGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.boardGroup.setAttribute('id', 'board-layer');

    this.hexLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.harborLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.vertexLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.robberLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.particleLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    this.boardGroup.appendChild(this.hexLayer);
    this.boardGroup.appendChild(this.harborLayer);
    this.boardGroup.appendChild(this.edgeLayer);
    this.boardGroup.appendChild(this.vertexLayer);
    this.boardGroup.appendChild(this.robberLayer);
    this.boardGroup.appendChild(this.particleLayer);
    this.svg.appendChild(this.boardGroup);

    this.container.appendChild(this.svg);
    this.attachPanZoomEvents();
  }

  attachPanZoomEvents() {
    const isInteractiveTarget = (target) => {
      if (!target || !target.classList) return false;
      return target.classList.contains('interactive-node')
        || target.classList.contains('interactive-edge')
        || (typeof target.closest === 'function' && target.closest('.hex-robber-target'));
    };

    this.svg.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { this.svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }

      if (this.pointers.size === 2) {
        this.isPanning = false;
        const pts = [...this.pointers.values()];
        this.pinchStart = {
          dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
          width: this.viewBox.width,
          height: this.viewBox.height,
          cx: (pts[0].x + pts[1].x) / 2,
          cy: (pts[0].y + pts[1].y) / 2
        };
        return;
      }

      if (this.pointers.size === 1 && !isInteractiveTarget(e.target)) {
        this.isPanning = true;
        this.startPoint = { x: e.clientX, y: e.clientY };
      }
    });

    this.svg.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size >= 2 && this.pinchStart && this.pinchStart.dist >= 8) {
        e.preventDefault();
        const pts = [...this.pointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const factor = this.pinchStart.dist / dist;
        const newWidth = Math.max(300, Math.min(1800, this.pinchStart.width * factor));
        const newHeight = Math.max(260, Math.min(1500, this.pinchStart.height * factor));
        this.applyZoomAtClient(this.pinchStart.cx, this.pinchStart.cy, newWidth, newHeight);
        return;
      }

      if (this.isPanning && this.pointers.size === 1) {
        const dx = (e.clientX - this.startPoint.x) * (this.viewBox.width / this.svg.clientWidth);
        const dy = (e.clientY - this.startPoint.y) * (this.viewBox.height / this.svg.clientHeight);
        this.viewBox.x -= dx;
        this.viewBox.y -= dy;
        this.startPoint = { x: e.clientX, y: e.clientY };
        this.updateViewBox();
      }
    }, { passive: false });

    const endPointer = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStart = null;
      if (this.pointers.size === 0) this.isPanning = false;
    };
    this.svg.addEventListener('pointerup', endPointer);
    this.svg.addEventListener('pointercancel', endPointer);
    this.svg.addEventListener('lostpointercapture', endPointer);

    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 0.9 : 1.1;
      const newWidth = Math.max(300, Math.min(1800, this.viewBox.width * zoomFactor));
      const newHeight = Math.max(260, Math.min(1500, this.viewBox.height * zoomFactor));
      const rect = this.svg.getBoundingClientRect();
      this.applyZoomAtClient(rect.left + e.offsetX, rect.top + e.offsetY, newWidth, newHeight);
    }, { passive: false });
  }

  applyZoomAtClient(clientX, clientY, newWidth, newHeight) {
    const rect = this.svg.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const w = Math.max(1, this.svg.clientWidth);
    const h = Math.max(1, this.svg.clientHeight);
    const svgX = this.viewBox.x + (offsetX / w) * this.viewBox.width;
    const svgY = this.viewBox.y + (offsetY / h) * this.viewBox.height;
    this.viewBox.x = svgX - (offsetX / w) * newWidth;
    this.viewBox.y = svgY - (offsetY / h) * newHeight;
    this.viewBox.width = newWidth;
    this.viewBox.height = newHeight;
    this.updateViewBox();
  }

  updateViewBox() {
    this.svg.setAttribute('viewBox', `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
  }

  resetZoom() {
    this.viewBox = { x: -400, y: -350, width: 800, height: 700 };
    this.updateViewBox();
  }

  render(gridData, interactiveAction = null, rollSum = null) {
    if (!gridData) return;
    this.grid = gridData;
    this.selectedAction = interactiveAction;
    this.lastRollSum = rollSum;

    this.renderHexes();
    this.renderHarbors();
    this.renderEdges();
    this.renderVertices();
    this.renderRobber();
  }

  renderHexes() {
    this.hexLayer.innerHTML = '';
    const hexes = Object.values(this.grid.hexes);
    const radius = this.grid.hexRadius || 60;

    for (const hex of hexes) {
      const { x, y } = hex.center;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `hex-tile hex-${hex.resource}`);
      g.setAttribute('data-hex-id', hex.id);

      // Polygon points
      const points = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (30 + i * 60);
        const px = x + radius * Math.cos(angle);
        const py = y + radius * Math.sin(angle);
        points.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      }

      // Outer hex polygon
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', points.join(' '));
      poly.setAttribute('fill', `url(#grad-${hex.resource})`);
      poly.setAttribute('stroke', '#161a1d');
      poly.setAttribute('stroke-width', '3');
      poly.setAttribute('filter', 'url(#shadow-hex)');
      g.appendChild(poly);

      // Terrain Emblem / Vector Icon
      const emblem = this.createTerrainEmblem(hex.resource, x, y - (hex.token ? 16 : 0));
      if (emblem) g.appendChild(emblem);

      // Number Token
      if (hex.token) {
        const isProducing = this.lastRollSum && hex.token === this.lastRollSum && hex.id !== this.grid.robberHexId;
        const tokenG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        tokenG.setAttribute('class', `token-group ${hex.token === 6 || hex.token === 8 ? 'token-hot' : ''} ${isProducing ? 'token-producing' : ''}`);

        const tokenCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        tokenCircle.setAttribute('cx', x);
        tokenCircle.setAttribute('cy', y + 12);
        tokenCircle.setAttribute('r', isProducing ? '18.5' : '17');
        tokenCircle.setAttribute('fill', 'url(#token-grad)');
        tokenCircle.setAttribute('stroke', isProducing ? '#f59e0b' : (hex.token === 6 || hex.token === 8 ? '#d90429' : '#8b7355'));
        tokenCircle.setAttribute('stroke-width', isProducing ? '3' : '1.5');
        if (isProducing) {
          tokenCircle.setAttribute('style', 'filter: drop-shadow(0 0 6px #f59e0b);');
        }
        tokenG.appendChild(tokenCircle);

        const tokenNum = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        tokenNum.setAttribute('x', x);
        tokenNum.setAttribute('y', y + 10);
        tokenNum.setAttribute('text-anchor', 'middle');
        tokenNum.setAttribute('dominant-baseline', 'central');
        tokenNum.setAttribute('class', 'token-number');
        tokenNum.setAttribute('fill', hex.token === 6 || hex.token === 8 ? '#d90429' : '#2b2d42');
        tokenNum.setAttribute('font-weight', 'bold');
        tokenNum.setAttribute('font-size', '14');
        tokenNum.textContent = hex.token;
        tokenG.appendChild(tokenNum);

        // Probability pips
        const pipsCount = this.getPipsCount(hex.token);
        const pipG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const pipSpacing = 3.5;
        const startPipX = x - ((pipsCount - 1) * pipSpacing) / 2;
        for (let p = 0; p < pipsCount; p++) {
          const pip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          pip.setAttribute('cx', startPipX + p * pipSpacing);
          pip.setAttribute('cy', y + 22);
          pip.setAttribute('r', '1.2');
          pip.setAttribute('fill', hex.token === 6 || hex.token === 8 ? '#d90429' : '#3d405b');
          pipG.appendChild(pip);
        }
        tokenG.appendChild(pipG);
        g.appendChild(tokenG);
      }

      // If interactive action is robber move, allow click
      if (this.selectedAction && this.selectedAction.type === 'robber' && hex.id !== this.grid.robberHexId) {
        g.classList.add('hex-robber-target');
        poly.setAttribute('stroke', '#ffb703');
        poly.setAttribute('stroke-width', '4');
        g.style.cursor = 'pointer';
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.onHexClick) this.onHexClick(hex.id);
        });
      }

      this.hexLayer.appendChild(g);
    }
  }

  renderHarbors() {
    this.harborLayer.innerHTML = '';
    const edges = Object.values(this.grid.edges);
    for (const edge of edges) {
      if (edge.harbor) {
        let badgeX = edge.midpoint.x;
        let badgeY = edge.midpoint.y;

        // Project harbor badge outward into the water away from the touching hex center
        if (edge.hexes && edge.hexes.length > 0) {
          const hex = this.grid.hexes[edge.hexes[0]];
          if (hex && hex.center) {
            const dx = edge.midpoint.x - hex.center.x;
            const dy = edge.midpoint.y - hex.center.y;
            const dist = Math.hypot(dx, dy) || 1;
            const offset = 26;
            badgeX += (dx / dist) * offset;
            badgeY += (dy / dist) * offset;
          }
        }

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'harbor-badge');

        // Stylized wooden pier lines connecting coastal vertices to the harbor badge
        const pier1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        pier1.setAttribute('x1', edge.x1);
        pier1.setAttribute('y1', edge.y1);
        pier1.setAttribute('x2', badgeX);
        pier1.setAttribute('y2', badgeY);
        pier1.setAttribute('stroke', '#78350f');
        pier1.setAttribute('stroke-width', '2');
        pier1.setAttribute('stroke-dasharray', '4,3');
        pier1.setAttribute('opacity', '0.75');
        g.appendChild(pier1);

        const pier2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        pier2.setAttribute('x1', edge.x2);
        pier2.setAttribute('y1', edge.y2);
        pier2.setAttribute('x2', badgeX);
        pier2.setAttribute('y2', badgeY);
        pier2.setAttribute('stroke', '#78350f');
        pier2.setAttribute('stroke-width', '2');
        pier2.setAttribute('stroke-dasharray', '4,3');
        pier2.setAttribute('opacity', '0.75');
        g.appendChild(pier2);

        const isGeneric = edge.harbor.type === 'generic';
        const iconName = isGeneric ? 'trade' : edge.harbor.type;
        const hasIcon = Boolean(ICONS[iconName]);
        const badgeW = hasIcon ? 46 : 50;

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', badgeX - badgeW / 2);
        rect.setAttribute('y', badgeY - 11);
        rect.setAttribute('width', String(badgeW));
        rect.setAttribute('height', '22');
        rect.setAttribute('rx', '8');
        rect.setAttribute('fill', '#181e2b');
        rect.setAttribute('stroke', '#d97706');
        rect.setAttribute('stroke-width', '1.75');
        rect.setAttribute('filter', 'url(#shadow-building)');
        g.appendChild(rect);

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = isGeneric ? '3:1' : `2:1 ${this.getHarborLabel(edge.harbor.type)}`;
        g.appendChild(title);

        if (hasIcon) {
          const icon = svgIconGroup(iconName, {
            x: badgeX - 9,
            y: badgeY,
            size: 13,
            fill: '#fef3c7',
          });
          if (icon) {
            icon.setAttribute('class', 'harbor-badge-icon');
            g.appendChild(icon);
          }
        }

        const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        txt.setAttribute('x', hasIcon ? badgeX + 8 : badgeX);
        txt.setAttribute('y', badgeY);
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('dominant-baseline', 'central');
        txt.setAttribute('fill', '#fef3c7');
        txt.setAttribute('font-size', '10');
        txt.setAttribute('font-weight', 'bold');
        txt.setAttribute('letter-spacing', '0.5');
        txt.textContent = isGeneric ? '3:1' : '2:1';
        g.appendChild(txt);

        this.harborLayer.appendChild(g);
      }
    }
  }

  renderEdges() {
    this.edgeLayer.innerHTML = '';
    const edges = Object.values(this.grid.edges);

    for (const edge of edges) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'edge-group');
      g.setAttribute('data-edge-id', edge.id);

      if (edge.road) {
        // Dark casing under the road so it stands out on any terrain color
        const casing = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        casing.setAttribute('x1', edge.x1);
        casing.setAttribute('y1', edge.y1);
        casing.setAttribute('x2', edge.x2);
        casing.setAttribute('y2', edge.y2);
        casing.setAttribute('stroke', 'rgba(0,0,0,0.45)');
        casing.setAttribute('stroke-width', '12');
        casing.setAttribute('stroke-linecap', 'round');
        g.appendChild(casing);

        // Built road: stylized thick wooden beam
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', edge.x1);
        line.setAttribute('y1', edge.y1);
        line.setAttribute('x2', edge.x2);
        line.setAttribute('y2', edge.y2);
        line.setAttribute('stroke', edge.road.color || '#e63946');
        line.setAttribute('stroke-width', '8');
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('filter', 'url(#shadow-building)');
        g.appendChild(line);

        // Inner highlight
        const innerLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        innerLine.setAttribute('x1', edge.x1);
        innerLine.setAttribute('y1', edge.y1);
        innerLine.setAttribute('x2', edge.x2);
        innerLine.setAttribute('y2', edge.y2);
        innerLine.setAttribute('stroke', 'rgba(255,255,255,0.3)');
        innerLine.setAttribute('stroke-width', '2');
        innerLine.setAttribute('stroke-linecap', 'round');
        g.appendChild(innerLine);
      } else {
        // If interactive road build action is active and valid
        const isInteractive = this.selectedAction &&
          this.selectedAction.type === 'road' &&
          this.selectedAction.validIds &&
          this.selectedAction.validIds.has(edge.id);

        if (isInteractive) {
          const roadG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          roadG.setAttribute('class', 'valid-road-group');

          // Generous transparent click target
          const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          hitArea.setAttribute('x1', edge.x1);
          hitArea.setAttribute('y1', edge.y1);
          hitArea.setAttribute('x2', edge.x2);
          hitArea.setAttribute('y2', edge.y2);
          hitArea.setAttribute('stroke', 'transparent');
          hitArea.setAttribute('stroke-width', '18');
          hitArea.setAttribute('stroke-linecap', 'round');
          roadG.appendChild(hitArea);

          // Visible dashed road guide
          const roadLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          roadLine.setAttribute('x1', edge.x1);
          roadLine.setAttribute('y1', edge.y1);
          roadLine.setAttribute('x2', edge.x2);
          roadLine.setAttribute('y2', edge.y2);
          roadLine.setAttribute('class', 'interactive-edge valid-road-path');
          roadLine.setAttribute('stroke', '#d97706');
          roadLine.setAttribute('stroke-width', '6');
          roadLine.setAttribute('stroke-dasharray', '6,4');
          roadLine.setAttribute('stroke-linecap', 'round');
          roadG.appendChild(roadLine);

          roadG.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onEdgeClick) this.onEdgeClick(edge.id);
          });
          g.appendChild(roadG);
        }
      }

      this.edgeLayer.appendChild(g);
    }
  }

  renderVertices() {
    this.vertexLayer.innerHTML = '';
    const vertices = Object.values(this.grid.vertices);

    for (const v of vertices) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'vertex-group');
      g.setAttribute('data-vertex-id', v.id);

      if (v.building) {
        // Render Settlement or City
        const color = v.building.color || '#e63946';

        if (v.building.type === 'settlement') {
          // House shape
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          // House path: center (v.x, v.y)
          const hx = v.x, hy = v.y;
          const d = `M ${hx} ${hy - 12} L ${hx + 10} ${hy - 3} L ${hx + 10} ${hy + 10} L ${hx - 10} ${hy + 10} L ${hx - 10} ${hy - 3} Z`;
          path.setAttribute('d', d);
          path.setAttribute('fill', color);
          path.setAttribute('stroke', '#ffffff');
          path.setAttribute('stroke-width', '1.5');
          path.setAttribute('filter', 'url(#shadow-building)');
          g.appendChild(path);

          // Gable window
          const win = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          win.setAttribute('x', hx - 3);
          win.setAttribute('y', hy + 2);
          win.setAttribute('width', '6');
          win.setAttribute('height', '6');
          win.setAttribute('fill', '#ffeaa7');
          g.appendChild(win);
        } else if (v.building.type === 'city') {
          // Fortified City / Cathedral with two towers
          const hx = v.x, hy = v.y;
          const d = `
            M ${hx - 14} ${hy + 12}
            L ${hx - 14} ${hy - 8}
            L ${hx - 8} ${hy - 16}
            L ${hx - 2} ${hy - 8}
            L ${hx + 2} ${hy - 8}
            L ${hx + 8} ${hy - 16}
            L ${hx + 14} ${hy - 8}
            L ${hx + 14} ${hy + 12}
            Z
          `;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('fill', color);
          path.setAttribute('stroke', '#ffffff');
          path.setAttribute('stroke-width', '2');
          path.setAttribute('filter', 'url(#shadow-building)');
          g.appendChild(path);

          // Cross / tower flag
          const cross = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          cross.setAttribute('cx', hx);
          cross.setAttribute('cy', hy + 2);
          cross.setAttribute('r', '3');
          cross.setAttribute('fill', '#ffd166');
          g.appendChild(cross);
        }

        // If City upgrade action is active on own settlement
        if (this.selectedAction && this.selectedAction.type === 'city' && this.selectedAction.validIds && this.selectedAction.validIds.has(v.id)) {
          const upgradeRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          upgradeRing.setAttribute('cx', v.x);
          upgradeRing.setAttribute('cy', v.y);
          upgradeRing.setAttribute('r', '17');
          upgradeRing.setAttribute('class', 'interactive-node valid-city-target');
          upgradeRing.setAttribute('fill', 'rgba(217, 119, 6, 0.15)');
          upgradeRing.setAttribute('stroke', '#f59e0b');
          upgradeRing.setAttribute('stroke-width', '2.5');
          upgradeRing.setAttribute('stroke-dasharray', '4,3');
          upgradeRing.style.cursor = 'pointer';

          upgradeRing.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onVertexClick) this.onVertexClick(v.id);
          });
          g.appendChild(upgradeRing);
        }
      } else {
        // Empty vertex: check if building settlement is valid here
        const isInteractive = this.selectedAction &&
          this.selectedAction.type === 'settlement' &&
          this.selectedAction.validIds &&
          this.selectedAction.validIds.has(v.id);

        if (isInteractive) {
          const targetG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          targetG.setAttribute('class', 'interactive-node valid-settlement-target');
          targetG.setAttribute('data-id', v.id);

          // Generous transparent hit area
          const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          hitArea.setAttribute('cx', v.x);
          hitArea.setAttribute('cy', v.y);
          hitArea.setAttribute('r', '16');
          hitArea.setAttribute('fill', 'transparent');
          targetG.appendChild(hitArea);

          // Calm outer halo (stationary, no coordinate translation!)
          const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          halo.setAttribute('cx', v.x);
          halo.setAttribute('cy', v.y);
          halo.setAttribute('r', '10');
          halo.setAttribute('class', 'target-halo');
          halo.setAttribute('fill', 'rgba(217, 119, 6, 0.18)');
          halo.setAttribute('stroke', '#d97706');
          halo.setAttribute('stroke-width', '1.5');
          targetG.appendChild(halo);

          // Crisp inner focal peg
          const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          core.setAttribute('cx', v.x);
          core.setAttribute('cy', v.y);
          core.setAttribute('r', '5');
          core.setAttribute('class', 'target-core');
          core.setAttribute('fill', '#fef3c7');
          core.setAttribute('stroke', '#181e2b');
          core.setAttribute('stroke-width', '1.8');
          targetG.appendChild(core);

          targetG.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onVertexClick) this.onVertexClick(v.id);
          });
          g.appendChild(targetG);
        }
      }

      this.vertexLayer.appendChild(g);
    }
  }

  renderRobber() {
    this.robberLayer.innerHTML = '';
    if (!this.grid.robberHexId) return;

    const hex = this.grid.hexes[this.grid.robberHexId];
    if (!hex) return;

    const { x, y } = hex.center;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'robber-figure');
    g.setAttribute('transform', `translate(${x}, ${y - 4})`);

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = 'Robber';
    g.appendChild(title);

    const disc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    disc.setAttribute('cx', '0');
    disc.setAttribute('cy', '0');
    disc.setAttribute('r', '16');
    disc.setAttribute('fill', '#0f172a');
    disc.setAttribute('stroke', '#d97706');
    disc.setAttribute('stroke-width', '1.75');
    disc.setAttribute('filter', 'url(#shadow-building)');
    g.appendChild(disc);

    const icon = svgIconGroup('bandit', { x: 0, y: 0, size: 22, fill: '#fef3c7' });
    if (icon) g.appendChild(icon);

    this.robberLayer.appendChild(g);
  }

  createTerrainEmblem(res, x, y) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${x}, ${y})`);
    g.setAttribute('class', `hex-terrain-icon hex-icon-${res}`);

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = this.getTerrainEmoji(res);
    g.appendChild(title);

    const fill = TERRAIN_ICON_FILL[res] || '#fef3c7';
    const icon = svgIconGroup(res, { x: 0, y: 0, size: 28, fill });
    if (icon) {
      g.appendChild(icon);
      return g;
    }

    if (res === 'desert') {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M -10 2 Q -5 -3 0 2 T 10 2');
      path.setAttribute('stroke', '#c49a6c');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      g.appendChild(path);
    }
    return g;
  }

  getTerrainEmoji(res) {
    switch (res) {
      case 'wood': return 'Wood';
      case 'brick': return 'Brick';
      case 'wool': return 'Wool';
      case 'wheat': return 'Wheat';
      case 'ore': return 'Ore';
      case 'desert': return 'Desert';
      default: return '';
    }
  }

  getHarborLabel(type) {
    switch (type) {
      case 'wood': return 'Wood';
      case 'brick': return 'Brick';
      case 'wool': return 'Wool';
      case 'wheat': return 'Wheat';
      case 'ore': return 'Ore';
      default: return '?';
    }
  }

  getHarborIcon(type) {
    return this.getHarborLabel(type);
  }

  getPipsCount(token) {
    switch (token) {
      case 2: case 12: return 1;
      case 3: case 11: return 2;
      case 4: case 10: return 3;
      case 5: case 9: return 4;
      case 6: case 8: return 5;
      default: return 0;
    }
  }
}
