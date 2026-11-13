/**
 * Chart mode: one dot per model, any column against release date, total parameters (log scale) or
 * another column. Dots are coloured by whether the weights are open. Hovering or stepping with the
 * arrow keys shows a model's values; Enter or a click opens its page. The table is the accessible
 * view of the same data.
 */
import { el } from './dom.ts';

export interface ChartPoint {
  id: string;
  name: string;
  href: string;
  x: number;
  y: number;
  /** true open weights, false API only, undefined unknown */
  open?: boolean;
  /** Shown in the readout: "GPQA: 81.2 (high effort)" */
  xText: string;
  yText: string;
  selected: boolean;
}

export interface ChartSpec {
  xLabel: string;
  yLabel: string;
  xKind: 'linear' | 'log' | 'time';
  yDirection: 'higher' | 'lower';
  /** Formats an axis tick value. */
  xTick: (v: number) => string;
  yTick: (v: number) => string;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** About `count` round tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  const step = (err >= 7.07 ? 10 : err >= 3.16 ? 5 : err >= 1.41 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** 1, 3, 10, 30, ... within [lo, hi] (both > 0). */
export function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 3]) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out;
}

/** Years (as decimal years) to tick between lo and hi. */
export function yearTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let y = Math.ceil(lo); y <= Math.floor(hi); y++) out.push(y);
  return out.length >= 2 ? out : niceTicks(lo, hi, 4);
}

export function renderChart(container: HTMLElement, points: readonly ChartPoint[], spec: ChartSpec): void {
  const width = Math.max(320, container.clientWidth || 800);
  const height = Math.round(Math.min(560, Math.max(320, width * 0.58)));
  const m = { top: 16, right: 20, bottom: 44, left: 60 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  const xs = points.map((p) => (spec.xKind === 'log' ? Math.log10(p.x) : p.x));
  const ys = points.map((p) => p.y);
  const pad = (lo: number, hi: number) => {
    const d = hi - lo || Math.abs(hi) || 1;
    return [lo - d * 0.05, hi + d * 0.05] as const;
  };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const sx = (v: number) => m.left + ((spec.xKind === 'log' ? Math.log10(v) : v) - x0) / (x1 - x0) * iw;
  const sy = (v: number) => m.top + ih - (v - y0) / (y1 - y0) * ih;

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart', role: 'img', tabindex: 0, 'aria-label': `${spec.yLabel} against ${spec.xLabel}, ${points.length} models. Arrow keys step through the models; Enter opens one.` });
  const grid = svg('g', { class: 'grid' });
  const axes = svg('g', { class: 'axis' });
  const xTicks = spec.xKind === 'log' ? logTicks(10 ** x0, 10 ** x1) : spec.xKind === 'time' ? yearTicks(x0, x1) : niceTicks(x0, x1);
  for (const t of xTicks) {
    const x = sx(t);
    grid.append(svg('line', { x1: x, x2: x, y1: m.top, y2: m.top + ih }));
    axes.append(svg('text', { x, y: m.top + ih + 18, 'text-anchor': 'middle' }, spec.xTick(t)));
  }
  for (const t of niceTicks(y0, y1)) {
    const y = sy(t);
    grid.append(svg('line', { x1: m.left, x2: m.left + iw, y1: y, y2: y }));
    axes.append(svg('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end' }, spec.yTick(t)));
  }
  axes.append(svg('line', { class: 'base', x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih }));
  axes.append(svg('text', { class: 'title', x: m.left + iw / 2, y: height - 6, 'text-anchor': 'middle' }, spec.xLabel));
  axes.append(
    svg('text', { class: 'title', x: 14, y: m.top + ih / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.top + ih / 2})` }, `${spec.yLabel} ${spec.yDirection === 'lower' ? '(lower is better)' : '(higher is better)'}`),
  );
  root.append(grid, axes);

  // Dots, selected models last so they sit on top.
  const order = points.map((p, i) => i).sort((a, b) => Number(points[a]!.selected) - Number(points[b]!.selected));
  const dots = svg('g', { class: 'dots' });
  const dotEls: SVGCircleElement[] = new Array(points.length);
  for (const i of order) {
    const p = points[i]!;
    const c = svg('circle', { cx: sx(p.x), cy: sy(p.y), r: p.selected ? 6 : 4.5, class: `dot ${p.open === true ? 'open' : p.open === false ? 'api' : 'unknown'}${p.selected ? ' selected' : ''}` });
    dotEls[i] = c;
    dots.append(c);
  }
  root.append(dots);

  // Direct labels for the best few by y and for models picked for comparison, skipping overlaps.
  const better = (a: number, b: number) => (spec.yDirection === 'lower' ? a - b : b - a);
  const labelled = [...points.keys()].sort((a, b) => Number(points[b]!.selected) - Number(points[a]!.selected) || better(points[a]!.y, points[b]!.y));
  const placed: Array<[number, number, number, number]> = [];
  const labels = svg('g', { class: 'labels' });
  let count = 0;
  for (const i of labelled) {
    const p = points[i]!;
    if (count >= (width < 560 ? 4 : 8) && !p.selected) break;
    const text = p.name.length > 28 ? `${p.name.slice(0, 27)}…` : p.name;
    const w = text.length * 6.4;
    let x = sx(p.x) + 8;
    const anchorEnd = x + w > m.left + iw;
    if (anchorEnd) x = sx(p.x) - 8 - w;
    const y = sy(p.y) - 6;
    const box: [number, number, number, number] = [x, y - 11, x + w, y + 3];
    if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
    placed.push(box);
    labels.append(svg('text', { x, y }, text));
    count++;
  }
  root.append(labels);

  const tip = el('div', { class: 'chart-tip', role: 'status', hidden: true });
  const legend = el(
    'p',
    { class: 'chart-legend' },
    ...[
      ['open', 'Open weights'],
      ['api', 'API only'],
      ['unknown', 'Unknown or not in the catalogue'],
    ].map(([k, label]) => el('span', {}, el('span', { class: `key ${k}`, 'aria-hidden': 'true' }), label!)),
  );
  const frame = el('div', { class: 'chart-frame' });
  frame.append(root, tip);
  container.replaceChildren(legend, frame);

  // Readout: the nearest dot within 24px of the pointer, or the one reached by arrow keys.
  let active = -1;
  const byX = [...points.keys()].sort((a, b) => points[a]!.x - points[b]!.x || better(points[a]!.y, points[b]!.y));
  const show = (i: number) => {
    if (active >= 0) dotEls[active]?.classList.remove('active');
    active = i;
    if (i < 0) {
      tip.hidden = true;
      return;
    }
    const p = points[i]!;
    dotEls[i]!.classList.add('active');
    tip.replaceChildren(el('strong', {}, p.name), el('br'), p.yText, el('br'), el('span', { class: 'muted' }, p.xText));
    tip.hidden = false;
    const scale = root.getBoundingClientRect().width / width || 1;
    const px = sx(p.x) * scale;
    const py = sy(p.y) * scale;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, px + 12), frame.clientWidth - tw)}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 10)}px`;
  };
  const nearest = (e: PointerEvent): number => {
    const r = root.getBoundingClientRect();
    const scale = r.width / width || 1;
    const mx = (e.clientX - r.left) / scale;
    const my = (e.clientY - r.top) / scale;
    let best = -1;
    let bd = (24 / scale) ** 2;
    points.forEach((p, i) => {
      const d = (sx(p.x) - mx) ** 2 + (sy(p.y) - my) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  root.addEventListener('pointermove', (e) => show(nearest(e)));
  root.addEventListener('pointerleave', () => show(-1));
  root.addEventListener('click', (e) => {
    const i = nearest(e as PointerEvent);
    if (i >= 0) location.href = points[i]!.href;
  });
  root.addEventListener('keydown', (e) => {
    const k = byX.indexOf(active);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') show(byX[Math.min(byX.length - 1, k + 1)] ?? -1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') show(byX[Math.max(0, k < 0 ? 0 : k - 1)] ?? -1);
    else if (e.key === 'Enter' && active >= 0) location.href = points[active]!.href;
    else if (e.key === 'Escape') show(-1);
    else return;
    e.preventDefault();
  });
  root.addEventListener('blur', () => show(-1));
}
