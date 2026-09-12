import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'icons');

function read(name) {
  return fs.readFileSync(path.join(dir, name), 'utf8').trim();
}

function phosphor(svg) {
  return svg
    .replace('<svg ', '<svg class="ico-svg" ')
    .replace(
      'viewBox="0 0 256 256"',
      'viewBox="0 0 256 256" width="1em" height="1em" aria-hidden="true"'
    );
}

function gameIcon(svg) {
  return svg
    .replace(/<path d="M0 0h512v512H0z"\s*\/?>/, '')
    .replace('fill="#fff"', 'fill="currentColor"')
    .replace('<svg ', '<svg class="ico-svg" fill="currentColor" ')
    .replace(
      'viewBox="0 0 512 512"',
      'viewBox="0 0 512 512" width="1em" height="1em" aria-hidden="true"'
    );
}

const map = {
  hexagon: phosphor(read('ph-hexagon.svg')),
  speakerHigh: phosphor(read('ph-speaker-high.svg')),
  speakerSlash: phosphor(read('ph-speaker-slash.svg')),
  bookOpen: phosphor(read('ph-book-open.svg')),
  link: phosphor(read('ph-link.svg')),
  clock: phosphor(read('ph-clock.svg')),
  plus: phosphor(read('ph-plus.svg')),
  minus: phosphor(read('ph-minus.svg')),
  refresh: phosphor(read('ph-arrows-clockwise.svg')),
  trophy: phosphor(read('ph-trophy.svg')),
  trade: phosphor(read('ph-arrows-left-right.svg')),
  chat: phosphor(read('ph-chat-teardrop.svg')),
  cards: phosphor(read('ph-cards.svg')),
  warning: phosphor(read('ph-warning-circle.svg')),
  check: phosphor(read('ph-check-circle.svg')),
  handshake: phosphor(read('ph-handshake.svg')),
  path: phosphor(read('ph-path.svg')),
  house: phosphor(read('ph-house.svg')),
  city: phosphor(read('ph-buildings.svg')),
  wood: gameIcon(read('gi-wood-pile.svg')),
  brick: gameIcon(read('gi-brick-pile.svg')),
  wool: gameIcon(read('gi-sheep.svg')),
  wheat: gameIcon(read('gi-wheat.svg')),
  ore: gameIcon(read('gi-crystal-cluster.svg')),
  cloth: gameIcon(read('gi-rolled-cloth.svg')),
  coin: gameIcon(read('gi-coins.svg')),
  paper: gameIcon(read('gi-scroll-unfurled.svg')),
  bandit: gameIcon(read('gi-bandit.svg'))
};

const out = `/**
 * Icon set: Phosphor Duotone (MIT) for UI chrome,
 * Game-Icons.net (CC BY 3.0, Delapouite & Lorc) for resources.
 */
export const ICONS = ${JSON.stringify(map, null, 2)};

ICONS.road = ICONS.path;
ICONS.settlement = ICONS.house;
ICONS.robber = ICONS.bandit;

const SVG_NS = 'http://www.w3.org/2000/svg';
const iconTemplateCache = new Map();

function getIconTemplate(name) {
  if (iconTemplateCache.has(name)) return iconTemplateCache.get(name);
  const html = ICONS[name];
  if (!html) {
    iconTemplateCache.set(name, null);
    return null;
  }
  const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
  const src = doc.documentElement;
  if (!src || src.localName !== 'svg') {
    iconTemplateCache.set(name, null);
    return null;
  }
  const vb = (src.getAttribute('viewBox') || '0 0 256 256').trim().split(/[\\s,]+/).map(Number);
  const template = {
    vw: vb[2] || 256,
    vh: vb[3] || 256,
    nodes: Array.from(src.childNodes).filter((n) => n.nodeType === 1),
  };
  iconTemplateCache.set(name, template);
  return template;
}

/** SVG <g> with the named icon, scaled to \`size\` and centered on (x, y). */
export function svgIconGroup(name, { x = 0, y = 0, size = 24, fill = 'currentColor' } = {}) {
  const tpl = getIconTemplate(name);
  if (!tpl) return null;
  const g = document.createElementNS(SVG_NS, 'g');
  const scale = size / Math.max(tpl.vw, tpl.vh);
  g.setAttribute('transform', \`translate(\${x - (tpl.vw * scale) / 2}, \${y - (tpl.vh * scale) / 2}) scale(\${scale})\`);
  g.setAttribute('fill', fill);
  g.style.color = fill;
  for (const node of tpl.nodes) {
    g.appendChild(document.importNode(node, true));
  }
  return g;
}

export function iconSvg(name) {
  return ICONS[name] || '';
}

export function ico(name, extraClass = '') {
  const svg = ICONS[name];
  if (!svg) return '';
  const cls = extraClass ? \`ico \${extraClass}\` : 'ico';
  return \`<span class="\${cls}">\${svg}</span>\`;
}

export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    const svg = ICONS[name];
    if (!svg) return;
    el.innerHTML = svg;
    el.classList.add('ico');
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountIcons());
  } else {
    mountIcons();
  }
}
`;

fs.writeFileSync(path.join(root, 'public', 'js', 'icons.js'), out);
console.log('wrote icons.js', Object.keys(map).length, 'icons', out.length, 'chars');
