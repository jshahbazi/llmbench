/**
 * The explorer: rows are models, columns are any metrics from any source, and each cell shows the
 * best score that passes the filters. Everything about the view lives in the URL.
 */
import { renderChart, type ChartPoint } from './chart.ts';
import { $, el, link } from './dom.ts';
import { fmt, isPermissive, paramsLabel, RUN_BY_LABELS, safeUrl, unitSuffix } from './format.ts';
import { FLAG_QUANTIZED, FLAG_SEARCH, pickBest, toCsv, type Candidate } from './select.ts';
import { parseState, serializeState, type ViewState } from './state.ts';
import type { CellsFile, SiteColumn, SiteIndex, SiteModel } from './types.ts';

let index: SiteIndex;
let state: ViewState;
/** `${model}:${column}` -> every score for that cell */
const candidates = new Map<string, Candidate[]>();
const colById = new Map<string, number>();
const modelById = new Map<string, number>();
const sourceName = new Map<string, string>();

interface Shown {
  best: Candidate;
  n: number;
  all: Candidate[];
}
interface View {
  rows: number[];
  cols: number[];
  cell: Map<string, Shown>;
  coverage: number[];
  auto: boolean;
}
let view: View;

const key = (mi: number, ci: number) => `${mi}:${ci}`;
const colHref = (c: SiteColumn) => `benchmarks/${c.source}/${c.slug}/`;
const modelHref = (m: SiteModel) => `models/${m.id}/`;
/** Flags whose runs the "plain runs only" filter leaves out. */
const hidden = () => (state.plain ? FLAG_QUANTIZED | FLAG_SEARCH : 0);

function sinceMonth(months: number): string | null {
  if (!months) return null;
  const d = new Date(index.generated_at);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 7);
}

function modelPasses(m: SiteModel): boolean {
  const s = state;
  if (m.unlisted && !s.unlisted) return false;
  if (s.open && m.open_weights !== true) return false;
  if (s.permissive && !isPermissive(m.license)) return false;
  if (s.maker && m.provider !== s.maker) return false;
  if (s.size > 0 && !(m.params_b !== undefined && m.params_b <= s.size)) return false;
  if (s.size < 0 && !(m.params_b !== undefined && m.params_b > -s.size)) return false;
  const since = sinceMonth(s.since);
  if (since && !((m.released ?? '') >= since)) return false;
  if (s.q) {
    const q = s.q.toLowerCase();
    if (!m.name.toLowerCase().includes(q) && !(m.provider ?? '').toLowerCase().includes(q) && !m.id.includes(q)) return false;
  }
  return true;
}

function compute(): View {
  const runBy = new Set(state.runBy);
  const hide = hidden();
  const ok = index.models.map(modelPasses);
  const cell = new Map<string, Shown>();
  const coverage = new Array<number>(index.columns.length).fill(0);
  for (const [k, list] of candidates) {
    const sep = k.indexOf(':');
    const mi = Number(k.slice(0, sep));
    if (!ok[mi]) continue;
    const ci = Number(k.slice(sep + 1));
    const p = pickBest(list, index.columns[ci]!.direction, runBy, hide);
    if (!p) continue;
    cell.set(k, { ...p, all: list });
    coverage[ci] = (coverage[ci] ?? 0) + 1;
  }

  let cols: number[];
  const auto = !state.cols;
  if (state.cols) {
    cols = state.cols.map((id) => colById.get(id)).filter((ci): ci is number => ci !== undefined);
  } else {
    cols = index.columns
      .map((_, i) => i)
      .filter((i) => {
        const c = index.columns[i]!;
        return coverage[i]! > 0 && c.headline && (!state.tag || (c.tags ?? []).includes(state.tag));
      })
      .sort((a, b) => coverage[b]! - coverage[a]! || index.columns[a]!.label.localeCompare(index.columns[b]!.label))
      .slice(0, state.n);
  }

  const min = Math.min(state.min, cols.length);
  const rows: number[] = [];
  index.models.forEach((_, mi) => {
    if (!ok[mi]) return;
    let k = 0;
    for (const ci of cols) if (cell.has(key(mi, ci))) k++;
    if (k >= Math.max(min, 1)) rows.push(mi);
  });

  const sortCol = state.sort && state.sort !== 'name' ? colById.get(state.sort) : undefined;
  if (sortCol !== undefined && cols.includes(sortCol)) {
    const sign = state.dir === 'desc' ? -1 : 1;
    const v = (mi: number) => cell.get(key(mi, sortCol))?.best.value;
    rows.sort((a, b) => {
      const va = v(a);
      const vb = v(b);
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      return sign * (va - vb);
    });
  } else if (state.sort === 'name') {
    const sign = state.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => sign * index.models[a]!.name.localeCompare(index.models[b]!.name));
  } else {
    const rel = (mi: number) => index.models[mi]!.released ?? '';
    rows.sort((a, b) => rel(b).localeCompare(rel(a)) || index.models[a]!.name.localeCompare(index.models[b]!.name));
  }
  return { rows, cols, cell, coverage, auto };
}

// ---- Rendering ----------------------------------------------------------------------------------

function modelSub(m: SiteModel): string {
  if (m.unlisted) return 'not in the catalogue';
  return [m.provider, m.released, paramsLabel(m.params_b, m.active_b), m.open_weights === true ? 'open' : m.open_weights === false ? 'API' : '']
    .filter(Boolean)
    .join(' · ');
}

function sortBy(id: string, defaultDir: 'asc' | 'desc') {
  if (state.sort === id) state.dir = state.dir === 'desc' ? 'asc' : 'desc';
  else {
    state.sort = id;
    state.dir = defaultDir;
  }
  update();
}

function removeColumn(ci: number) {
  state.cols = view.cols.filter((c) => c !== ci).map((c) => index.columns[c]!.id);
  if (state.sort === index.columns[ci]!.id) state.sort = '';
  update();
}

function renderTable() {
  const { rows, cols, cell } = view;
  const ranked = new Map<number, number[]>();
  for (const ci of cols) {
    const col = index.columns[ci]!;
    const vals = rows.map((mi) => cell.get(key(mi, ci))?.best.value).filter((x): x is number => x !== undefined);
    vals.sort((a, b) => (col.direction === 'lower' ? a - b : b - a));
    ranked.set(ci, vals);
  }

  const nameSort = state.sort === 'name' ? (state.dir === 'desc' ? 'descending' : 'ascending') : null;
  const head = el(
    'tr',
    {},
    el(
      'th',
      { class: 'model', scope: 'col', 'aria-sort': nameSort },
      el('button', { type: 'button', class: 'sort', title: 'Sort by name' }, `Model (${rows.length})`),
    ),
  );
  head.querySelector('button')!.addEventListener('click', () => sortBy('name', 'asc'));

  for (const ci of cols) {
    const col = index.columns[ci]!;
    const src = sourceName.get(col.source) ?? col.source;
    const sorted = state.sort === col.id;
    const sortBtn = el(
      'button',
      {
        type: 'button',
        class: 'sort',
        title: `${col.label}\nsource: ${src}\n${col.direction === 'lower' ? 'lower' : 'higher'} is better\n${view.coverage[ci]} models with a score${col.description ? `\n${col.description}` : ''}`,
      },
      el('span', { class: 'label' }, col.label),
      el('span', { class: 'meta' }, `${src} · ${view.coverage[ci]}${col.direction === 'lower' ? ' ↓' : ''}`),
    );
    sortBtn.addEventListener('click', () => sortBy(col.id, col.direction === 'lower' ? 'asc' : 'desc'));
    const remove = el('button', { type: 'button', class: 'icon', title: `Remove ${col.label}`, 'aria-label': `Remove column ${col.label}` }, '×');
    remove.addEventListener('click', () => removeColumn(ci));
    const th = el(
      'th',
      { scope: 'col', 'aria-sort': sorted ? (state.dir === 'desc' ? 'descending' : 'ascending') : null },
      sortBtn,
      el('span', { class: 'th-actions' }, el('a', { href: colHref(col), class: 'icon', title: `About ${col.label}`, 'aria-label': `About ${col.label}` }, 'ⓘ'), remove),
    );
    head.append(th);
  }

  const body = el('tbody');
  const cmp = new Set(state.cmp);
  let first = true;
  for (const mi of rows) {
    const m = index.models[mi]!;
    const check = el('input', { type: 'checkbox', 'aria-label': `Compare ${m.name}`, checked: cmp.has(m.id), disabled: !cmp.has(m.id) && cmp.size >= 5 });
    check.addEventListener('change', () => {
      state.cmp = check.checked ? [...state.cmp, m.id].slice(0, 5) : state.cmp.filter((x) => x !== m.id);
      update();
    });
    const tr = el(
      'tr',
      { class: m.unlisted ? 'unlisted' : null },
      el('th', { class: 'model', scope: 'row' }, check, el('a', { href: modelHref(m), class: 'name' }, m.name), el('span', { class: 'sub' }, modelSub(m))),
    );
    for (const ci of cols) {
      const shown = cell.get(key(mi, ci));
      if (!shown) {
        tr.append(el('td', { class: 'score empty' }));
        continue;
      }
      const col = index.columns[ci]!;
      const vals = ranked.get(ci)!;
      const pct = vals.length > 1 ? 1 - vals.indexOf(shown.best.value) / (vals.length - 1) : 1;
      const td = el(
        'td',
        {
          class: 'score',
          tabindex: first ? 0 : -1,
          'data-m': mi,
          'data-c': ci,
          style: `--t: ${(0.06 + 0.34 * pct * pct).toFixed(3)}`,
          title: `${m.name} — ${col.label}: ${fmt(shown.best.value, col.unit)}${unitSuffix(col.unit)}${shown.best.context ? ` (${shown.best.context})` : ''}\nClick for details`,
        },
        fmt(shown.best.value, col.unit),
        shown.n > 1 ? el('span', { class: 'n', 'aria-label': `${shown.n} scores` }, String(shown.n)) : null,
      );
      first = false;
      tr.append(td);
    }
    body.append(tr);
  }

  const table = el('table', { class: 'matrix' }, el('thead', {}, head), body);
  if (!rows.length || !cols.length) {
    $('table-wrap').replaceChildren(el('p', { class: 'empty-note' }, 'No models match these filters and columns. Try fewer filters, a lower “fewer than” number, or other columns.'));
  } else {
    $('table-wrap').replaceChildren(table);
  }

  const shownCount = rows.reduce((n, mi) => n + cols.filter((ci) => cell.has(key(mi, ci))).length, 0);
  const fill = rows.length && cols.length ? ((100 * shownCount) / (rows.length * cols.length)).toFixed(1) : '0';
  $('viewstats').textContent = `${rows.length} models × ${cols.length} columns · ${shownCount.toLocaleString()} scores · ${fill}% of cells filled`;
}

function renderCompare() {
  const runBy = new Set(state.runBy);
  const ms = state.cmp.map((id) => modelById.get(id)).filter((mi): mi is number => mi !== undefined);
  const lines: Array<{ ci: number; vals: Array<Candidate | null> }> = [];
  index.columns.forEach((col, ci) => {
    const vals = ms.map((mi) => pickBest(candidates.get(key(mi, ci)) ?? [], col.direction, runBy, hidden())?.best ?? null);
    const k = vals.filter(Boolean).length;
    if (k >= Math.min(2, ms.length)) lines.push({ ci, vals });
  });
  lines.sort((a, b) => b.vals.filter(Boolean).length - a.vals.filter(Boolean).length || index.columns[b.ci]!.coverage - index.columns[a.ci]!.coverage);

  const head = el('tr', {}, el('th', { scope: 'col' }, 'Benchmark'));
  for (const mi of ms) {
    const m = index.models[mi]!;
    const x = el('button', { type: 'button', class: 'icon', 'aria-label': `Remove ${m.name}` }, '×');
    x.addEventListener('click', () => {
      state.cmp = state.cmp.filter((id) => id !== m.id);
      if (state.cmp.length < 2) state.view = 'table';
      update();
    });
    head.append(el('th', { scope: 'col', class: 'num' }, el('a', { href: modelHref(m) }, m.name), ' ', x));
  }
  const body = el('tbody');
  for (const { ci, vals } of lines) {
    const col = index.columns[ci]!;
    const present = vals.filter((v): v is Candidate => !!v).map((v) => v.value);
    const top = col.direction === 'lower' ? Math.min(...present) : Math.max(...present);
    const tr = el(
      'tr',
      {},
      el('th', { scope: 'row' }, el('a', { href: colHref(col) }, col.label), el('span', { class: 'sub' }, sourceName.get(col.source) ?? col.source)),
    );
    vals.forEach((v, k) => {
      if (!v) return void tr.append(el('td', { class: 'score empty' }));
      const td = el(
        'td',
        { class: `score${v.value === top && present.length > 1 ? ' best' : ''}`, tabindex: -1, 'data-m': ms[k]!, 'data-c': ci },
        fmt(v.value, col.unit),
      );
      tr.append(td);
    });
    body.append(tr);
  }
  $('table-wrap').replaceChildren(
    el('p', { class: 'compare-head muted' }, 'Benchmarks where at least two of these models have a score. The best score in each row is highlighted.'),
    lines.length ? el('table', { class: 'matrix compare' }, el('thead', {}, head), body) : el('p', { class: 'empty-note' }, 'These models share no benchmarks under the current filters.'),
  );
  $('viewstats').textContent = `Comparing ${ms.length} models on ${lines.length} benchmarks`;
}

/** Decimal year of a "YYYY-MM" release month. */
const yearOf = (released?: string): number | undefined => {
  const m = released && /^(\d{4})-(\d{2})/.exec(released);
  return m ? Number(m[1]) + (Number(m[2]) - 1) / 12 : undefined;
};

function renderChartView() {
  const { rows, cols, cell } = view;
  const ySelect = $<HTMLSelectElement>('y-axis');
  const xSelect = $<HTMLSelectElement>('x-axis');
  const label = (ci: number) => `${index.columns[ci]!.label} (${sourceName.get(index.columns[ci]!.source) ?? index.columns[ci]!.source})`;
  const sortCol = colById.get(state.sort);
  const yi = colById.get(state.y) ?? (sortCol !== undefined && cols.includes(sortCol) ? sortCol : cols[0]);
  const yCol = yi !== undefined && cols.includes(yi) ? yi : cols[0];
  ySelect.replaceChildren(...cols.map((ci) => el('option', { value: index.columns[ci]!.id, selected: ci === yCol }, label(ci))));
  xSelect.replaceChildren(
    el('option', { value: 'released', selected: state.x === 'released' }, 'Release date'),
    el('option', { value: 'params', selected: state.x === 'params' }, 'Total parameters'),
    ...cols.filter((ci) => ci !== yCol).map((ci) => el('option', { value: index.columns[ci]!.id, selected: index.columns[ci]!.id === state.x }, label(ci))),
  );
  if (yCol === undefined) {
    $('table-wrap').replaceChildren(el('p', { class: 'empty-note' }, 'Choose at least one column to chart.'));
    $('viewstats').textContent = '';
    return;
  }
  const y = index.columns[yCol]!;
  const xc = colById.get(state.x);
  const xCol = xc !== undefined && cols.includes(xc) && xc !== yCol ? index.columns[xc] : undefined;
  const xKey = xCol ? xCol.id : state.x === 'params' ? 'params' : 'released';
  const valueText = (c: SiteColumn, s: Shown) => `${c.label}: ${fmt(s.best.value, c.unit)}${unitSuffix(c.unit)}${s.best.context ? ` (${s.best.context})` : ''}`;
  const points: ChartPoint[] = [];
  const cmp = new Set(state.cmp);
  for (const mi of rows) {
    const m = index.models[mi]!;
    const ys = cell.get(key(mi, yCol));
    if (!ys) continue;
    let x: number | undefined;
    let xText = '';
    if (xCol) {
      const xs = cell.get(key(mi, xc!));
      x = xs?.best.value;
      if (xs) xText = valueText(xCol, xs);
    } else if (xKey === 'params') {
      x = m.params_b && m.params_b > 0 ? m.params_b : undefined;
      xText = `${paramsLabel(m.params_b, m.active_b)} parameters`;
    } else {
      x = yearOf(m.released);
      xText = `released ${m.released}`;
    }
    if (x === undefined) continue;
    points.push({ id: m.id, name: m.name, href: modelHref(m), x, y: ys.best.value, ...(m.open_weights !== undefined && { open: m.open_weights }), xText, yText: valueText(y, ys), selected: cmp.has(m.id) });
  }
  const missing = rows.filter((mi) => cell.has(key(mi, yCol))).length - points.length;
  if (points.length < 2) {
    $('table-wrap').replaceChildren(el('p', { class: 'empty-note' }, 'Fewer than two models have both values. Try another axis, fewer filters, or a lower “fewer than” number.'));
  } else {
    renderChart($('table-wrap'), points, {
      xLabel: xCol ? label(xc!) : xKey === 'params' ? 'Total parameters (billions, log scale)' : 'Release date',
      yLabel: label(yCol),
      xKind: xCol ? 'linear' : xKey === 'params' ? 'log' : 'time',
      yDirection: y.direction,
      xTick: (v) => (xCol ? fmt(v, xCol.unit) : xKey === 'params' ? `${v}B` : String(Math.round(v))),
      yTick: (v) => fmt(v, y.unit),
    });
  }
  $('viewstats').textContent = `${points.length} models${missing > 0 ? ` (${missing} more have no ${xKey === 'released' ? 'release date' : xKey === 'params' ? 'parameter count' : 'score on the x axis'})` : ''}`;
}

function renderToolbar() {
  const presets = $('presets');
  presets.replaceChildren(
    ...[{ id: '', label: 'All' }, ...index.tags].map((t) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': view.auto && state.tag === t.id ? 'true' : 'false' }, t.label);
      b.addEventListener('click', () => {
        state.tag = t.id;
        state.cols = null;
        state.sort = '';
        update();
      });
      return b;
    }),
  );
  $<HTMLSelectElement>('ncols').value = String(state.n);
  document.querySelector<HTMLElement>('.auto-only')!.hidden = !view.auto;
  $('reset-cols').hidden = view.auto;
  const cmp = $<HTMLButtonElement>('compare');
  cmp.disabled = state.cmp.length < 2 && state.view !== 'compare';
  cmp.textContent = state.view === 'compare' ? 'Back to the table' : `Compare${state.cmp.length ? ` (${state.cmp.length})` : ''}`;
  $('chart').textContent = state.view === 'chart' ? 'Back to the table' : 'Chart';
  $('chart').setAttribute('aria-pressed', String(state.view === 'chart'));
  $('chart-axes').hidden = state.view !== 'chart';
}

function update() {
  view = compute();
  renderToolbar();
  if (state.view === 'compare' && state.cmp.length >= 2) renderCompare();
  else if (state.view === 'chart') renderChartView();
  else renderTable();
  history.replaceState(null, '', location.pathname + serializeState(state));
}

// ---- Popover ------------------------------------------------------------------------------------

let popoverFrom: HTMLElement | null = null;

function closePopover() {
  const p = $('popover');
  if (p.hidden) return;
  p.hidden = true;
  popoverFrom?.focus();
  popoverFrom = null;
}

function openPopover(td: HTMLElement) {
  const mi = Number(td.dataset['m']);
  const ci = Number(td.dataset['c']);
  const m = index.models[mi]!;
  const col = index.columns[ci]!;
  const runBy = new Set(state.runBy);
  const hide = hidden();
  const list = [...(candidates.get(key(mi, ci)) ?? [])].sort((a, b) => (col.direction === 'lower' ? a.value - b.value : b.value - a.value));
  const close = el('button', { type: 'button', class: 'icon close', 'aria-label': 'Close' }, '×');
  close.addEventListener('click', closePopover);
  const items = list.map((c) => {
    const url = safeUrl(c.url);
    const why = !runBy.has(c.runBy) ? 'the Run by filter' : c.flags & hide ? 'the plain-runs filter' : '';
    return el(
      'li',
      { class: why ? 'filtered' : null },
      el('strong', {}, `${fmt(c.value, col.unit)}${unitSuffix(col.unit)}`),
      c.interval ? el('span', { class: 'muted' }, ` (${c.interval})`) : null,
      el('br'),
      `${RUN_BY_LABELS[c.runBy] ?? 'unknown'}${c.date ? ` · ${c.date}` : ''}${c.context ? ` · ${c.context}` : ''}`,
      el('br'),
      el('span', { class: 'muted' }, `as “${c.rawName}” in `),
      el('a', { href: `sources/${c.source}/` }, sourceName.get(c.source) ?? c.source),
      url ? el('span', {}, ' · ', link(url, 'original ↗', { rel: 'noopener', target: '_blank' })) : null,
      c.history?.length
        ? el(
            'ul',
            { class: 'history' },
            ...c.history.map(([t, op, from, to]) =>
              el('li', {}, `${t.slice(0, 10)}: ${op === 'change' ? `${from} → ${to}` : op === 'add' ? `added ${to}` : op === 'remove' ? `removed (was ${from})` : `back, ${to}`}`),
            ),
          )
        : null,
      why ? el('span', { class: 'muted' }, ` (hidden by ${why})`) : null,
    );
  });
  const p = $('popover');
  p.replaceChildren(
    close,
    el('h2', {}, m.name),
    el('p', { class: 'muted' }, el('a', { href: colHref(col) }, col.label), ` · ${sourceName.get(col.source) ?? col.source}`),
    el('ul', { class: 'cands' }, ...items),
    el('p', { class: 'links' }, el('a', { href: modelHref(m) }, 'All scores for this model'), ' · ', el('a', { href: colHref(col) }, 'Full leaderboard')),
  );
  p.hidden = false;
  const r = td.getBoundingClientRect();
  const w = Math.min(360, window.innerWidth - 24);
  p.style.width = `${w}px`;
  const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
  const below = r.bottom + 6;
  const height = p.offsetHeight;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 6) : below;
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
  popoverFrom = td;
  close.focus();
}

// ---- Column picker ------------------------------------------------------------------------------

function renderPicker() {
  const q = $<HTMLInputElement>('picker-q').value.trim().toLowerCase();
  const subs = $<HTMLInputElement>('picker-sub').checked;
  const selected = new Set(view.cols);
  const groups = index.sources
    .filter((s) => index.columns.some((c) => c.source === s.id))
    .map((s) => {
      const cols = index.columns
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => c.source === s.id && (subs || c.headline || selected.has(i)))
        .filter(({ c }) => !q || `${c.label} ${c.metric} ${s.name} ${(c.tags ?? []).join(' ')}`.toLowerCase().includes(q))
        .sort((a, b) => (view.coverage[b.i] ?? 0) - (view.coverage[a.i] ?? 0));
      if (!cols.length) return null;
      const list = el(
        'ul',
        {},
        ...cols.map(({ c, i }) => {
          const box = el('input', { type: 'checkbox', checked: selected.has(i) });
          box.addEventListener('change', () => {
            const current = view.cols.map((ci) => index.columns[ci]!.id);
            state.cols = box.checked ? [...current, c.id] : current.filter((id) => id !== c.id);
            update();
          });
          return el(
            'li',
            {},
            el('label', {}, box, ` ${c.label} `, el('span', { class: 'muted' }, `${view.coverage[i] ?? 0}${c.tags?.length ? ` · ${c.tags.join(', ')}` : ''}`)),
          );
        }),
      );
      return el('details', { open: !!q || cols.length <= 12 || s.id !== 'whatmodel' }, el('summary', {}, `${s.name} `, el('span', { class: 'muted' }, String(cols.length))), list);
    })
    .filter((g): g is HTMLDetailsElement => !!g);
  $('picker-list').replaceChildren(...(groups.length ? groups : [el('p', { class: 'muted' }, 'No metrics match.')]));
}

// ---- Wiring -------------------------------------------------------------------------------------

function syncControls() {
  $<HTMLInputElement>('q').value = state.q;
  $<HTMLSelectElement>('since').value = String(state.since);
  $<HTMLSelectElement>('size').value = String(state.size);
  $<HTMLSelectElement>('maker').value = state.maker;
  $<HTMLInputElement>('open').checked = state.open;
  $<HTMLInputElement>('perm').checked = state.permissive;
  $<HTMLInputElement>('um').checked = state.unlisted;
  $<HTMLInputElement>('plain').checked = state.plain;
  $<HTMLSelectElement>('min').value = String(state.min);
  for (const box of document.querySelectorAll<HTMLInputElement>('input[data-runby]')) box.checked = state.runBy.includes(Number(box.dataset['runby']));
}

function exportCsv() {
  const rows: Array<Array<string | number>> = [];
  if (state.view === 'compare' && state.cmp.length >= 2) {
    const ms = state.cmp.map((id) => modelById.get(id)).filter((mi): mi is number => mi !== undefined);
    const runBy = new Set(state.runBy);
    rows.push(['Benchmark', 'Source', 'Unit', ...ms.map((mi) => index.models[mi]!.name)]);
    index.columns.forEach((col, ci) => {
      const vals = ms.map((mi) => pickBest(candidates.get(key(mi, ci)) ?? [], col.direction, runBy, hidden())?.best.value);
      if (vals.filter((v) => v !== undefined).length < 2) return;
      rows.push([col.label, sourceName.get(col.source) ?? col.source, unitSuffix(col.unit) || col.unit, ...vals.map((v) => (v === undefined ? '' : fmt(v, col.unit)))]);
    });
  } else {
    rows.push([
      'Model',
      'Maker',
      'Released',
      'Total parameters (B)',
      'Open weights',
      ...view.cols.map((ci) => {
        const c = index.columns[ci]!;
        return `${c.label} (${sourceName.get(c.source) ?? c.source})${unitSuffix(c.unit) ? ' %' : ''}`;
      }),
    ]);
    for (const mi of view.rows) {
      const m = index.models[mi]!;
      rows.push([
        m.name,
        m.provider ?? '',
        m.released ?? '',
        m.params_b ?? '',
        m.open_weights === undefined ? '' : m.open_weights ? 'yes' : 'no',
        ...view.cols.map((ci) => {
          const s = view.cell.get(key(mi, ci));
          return s ? fmt(s.best.value, index.columns[ci]!.unit) : '';
        }),
      ]);
    }
  }
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `llmbench-${index.generated_at.slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

function wire() {
  const on = (id: string, ev: string, fn: (e: Event) => void) => $(id).addEventListener(ev, fn);
  on('q', 'input', () => {
    state.q = $<HTMLInputElement>('q').value.trim();
    update();
  });
  on('since', 'change', () => {
    state.since = Number($<HTMLSelectElement>('since').value);
    update();
  });
  on('size', 'change', () => {
    state.size = Number($<HTMLSelectElement>('size').value);
    update();
  });
  on('maker', 'change', () => {
    state.maker = $<HTMLSelectElement>('maker').value;
    update();
  });
  on('open', 'change', () => {
    state.open = $<HTMLInputElement>('open').checked;
    update();
  });
  on('perm', 'change', () => {
    state.permissive = $<HTMLInputElement>('perm').checked;
    update();
  });
  on('um', 'change', () => {
    state.unlisted = $<HTMLInputElement>('um').checked;
    update();
  });
  on('plain', 'change', () => {
    state.plain = $<HTMLInputElement>('plain').checked;
    update();
  });
  on('min', 'change', () => {
    state.min = Number($<HTMLSelectElement>('min').value);
    update();
  });
  for (const box of document.querySelectorAll<HTMLInputElement>('input[data-runby]')) {
    box.addEventListener('change', () => {
      state.runBy = [...document.querySelectorAll<HTMLInputElement>('input[data-runby]')].filter((b) => b.checked).map((b) => Number(b.dataset['runby']));
      update();
    });
  }
  on('ncols', 'change', () => {
    state.n = Number($<HTMLSelectElement>('ncols').value);
    update();
  });
  on('reset-cols', 'click', () => {
    state.cols = null;
    state.sort = '';
    update();
  });
  on('compare', 'click', () => {
    state.view = state.view === 'compare' ? 'table' : 'compare';
    update();
  });
  on('chart', 'click', () => {
    state.view = state.view === 'chart' ? 'table' : 'chart';
    update();
  });
  on('y-axis', 'change', () => {
    state.y = $<HTMLSelectElement>('y-axis').value;
    if (state.x === state.y) state.x = 'released';
    update();
  });
  on('x-axis', 'change', () => {
    state.x = $<HTMLSelectElement>('x-axis').value;
    update();
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => state.view === 'chart' && update(), 150);
  });
  on('export', 'click', exportCsv);
  on('share', 'click', async () => {
    const b = $<HTMLButtonElement>('share');
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = 'Link copied';
    } catch {
      b.textContent = 'Copy the address bar';
    }
    setTimeout(() => (b.textContent = 'Copy link'), 2000);
  });

  const picker = $<HTMLDialogElement>('picker');
  on('pick', 'click', () => {
    renderPicker();
    picker.showModal();
    $<HTMLInputElement>('picker-q').focus();
  });
  on('picker-q', 'input', renderPicker);
  on('picker-sub', 'change', renderPicker);
  picker.addEventListener('click', (e) => {
    if (e.target === picker) picker.close();
  });

  // Cells: click or Enter opens the details; arrow keys move between cells.
  const wrap = $('table-wrap');
  wrap.addEventListener('click', (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>('td.score:not(.empty)');
    if (td) openPopover(td);
  });
  wrap.addEventListener('keydown', (e) => {
    const td = (e.target as HTMLElement).closest<HTMLTableCellElement>('td.score');
    if (!td) return;
    if ((e.key === 'Enter' || e.key === ' ') && !td.classList.contains('empty')) {
      e.preventDefault();
      openPopover(td);
      return;
    }
    const tr = td.parentElement as HTMLTableRowElement;
    const idx = td.cellIndex;
    let next: Element | null | undefined = null;
    if (e.key === 'ArrowRight') next = td.nextElementSibling;
    else if (e.key === 'ArrowLeft') next = td.previousElementSibling;
    else if (e.key === 'ArrowDown') next = tr.nextElementSibling?.children[idx];
    else if (e.key === 'ArrowUp') next = tr.previousElementSibling?.children[idx];
    if (next instanceof HTMLTableCellElement && next.classList.contains('score')) {
      e.preventDefault();
      td.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });
  document.addEventListener('click', (e) => {
    const p = $('popover');
    if (!p.hidden && !p.contains(e.target as Node) && !(e.target as HTMLElement).closest('td.score')) closePopover();
  });
  window.addEventListener('resize', closePopover);
  $('table-wrap').addEventListener('scroll', closePopover, { passive: true });
}

async function main() {
  index = (await (await fetch('data/index.json')).json()) as SiteIndex;
  index.columns.forEach((c, i) => colById.set(c.id, i));
  index.models.forEach((m, i) => modelById.set(m.id, i));
  for (const s of index.sources) sourceName.set(s.id, s.name);

  const files = await Promise.all(
    index.sources.filter((s) => s.row_count > 0).map(async (s) => (await (await fetch(`data/cells/${s.id}.json`)).json()) as CellsFile),
  );
  let total = 0;
  for (const f of files) {
    for (const [mi, ci, value, runBy, date, context, ui, interval, ni, hi, flags] of f.cells) {
      const k = key(mi, ci);
      let list = candidates.get(k);
      if (!list) candidates.set(k, (list = []));
      list.push({
        value,
        runBy,
        date,
        context,
        url: ui >= 0 ? (f.urls[ui] ?? null) : null,
        interval,
        rawName: ni >= 0 ? (f.names[ni] ?? '') : '',
        source: f.source,
        history: hi >= 0 ? (f.history[hi] ?? null) : null,
        flags,
      });
      total++;
    }
  }

  $('stats').textContent =
    `${files.length} sources · ${total.toLocaleString()} scores · ${index.models.length.toLocaleString()} models · ` +
    `${index.columns.length.toLocaleString()} metrics · updated ${index.generated_at.slice(0, 10)}`;
  $('um-label').textContent = `Models not in the catalogue (${index.stats.unlisted_models})`;

  state = parseState(location.search);
  syncControls();
  wire();
  update();
}

main().catch((e: unknown) => {
  $('stats').textContent = `Could not load the data: ${e instanceof Error ? e.message : String(e)}`;
});

