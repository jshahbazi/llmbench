// The matrix: rows are models, columns are source metrics, each cell is the best score that passes
// the filters. Scraped strings are only ever inserted as text, never as HTML.

const RUN_BY = ['independent', 'submitted', 'lab'];
const $ = (id) => document.getElementById(id);

const state = { sortCol: null, sortDir: 'desc' };
let index;
let sourceById;
/** key `${model}:${col}` -> array of [value, runBy, date, context, urlIndex, sourceId, interval] */
const candidates = new Map();
const urlsBySource = new Map();

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

function fmt(value, unit) {
  if (unit === 'fraction') return (value * 100).toFixed(1);
  if (unit === 'percent') return value.toFixed(1);
  if (unit === 'elo' || Math.abs(value) >= 100) return String(Math.round(value));
  return String(Number(value.toFixed(2)));
}

const better = (a, b, dir) => (dir === 'lower' ? a < b : a > b);

/** 'YYYY-MM' that many months before the build date, or null for "any time". */
function sinceMonth(months) {
  if (!months) return null;
  const d = new Date(index.generated_at);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 7);
}

/** The headline score in one cell: best by the column's direction, ties to the newest date. */
function pick(list, col, includeLab) {
  let best = null;
  let n = 0;
  for (const c of list) {
    if (!includeLab && c[1] === 2) continue;
    n++;
    if (!best || better(c[0], best[0], col.direction) || (c[0] === best[0] && c[2] > best[2])) best = c;
  }
  return best ? { best, n } : null;
}

function modelSub(m) {
  if (m.unmatched) return `unmatched name from ${sourceById.get(m.unmatched)?.name ?? m.unmatched}`;
  const parts = [];
  if (m.provider) parts.push(m.provider);
  if (m.released) parts.push(m.released);
  if (m.params_b) parts.push(m.active_b && m.active_b !== m.params_b ? `${m.params_b}B-A${m.active_b}B` : `${m.params_b}B`);
  if (m.open_weights === true) parts.push('open');
  else if (m.open_weights === false) parts.push('API');
  return parts.join(' · ');
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const openOnly = $('open').checked;
  const includeLab = $('lab').checked;
  const showUnmatched = $('unmatched').checked;
  const ncols = Number($('ncols').value);
  const minScores = Number($('minscores').value);
  const since = sinceMonth(Number($('since').value));

  // 1. Models that pass the model filters. Columns are then chosen by coverage among these
  //    models, so filtering to recent models also brings up the benchmarks they are scored on.
  const modelOk = index.models.map(
    (m) =>
      (showUnmatched || !m.unmatched) &&
      (!openOnly || m.open_weights === true) &&
      (!since || (m.released ?? '') >= since) &&
      (!q || m.name.toLowerCase().includes(q) || (m.provider ?? '').toLowerCase().includes(q)),
  );

  // 2. Headline score per (model, column), and column coverage over those models.
  const cell = new Map();
  const coverage = new Array(index.columns.length).fill(0);
  for (const [key, list] of candidates) {
    const sep = key.indexOf(':');
    const mi = Number(key.slice(0, sep));
    const ci = Number(key.slice(sep + 1));
    if (!modelOk[mi]) continue;
    const p = pick(list, index.columns[ci], includeLab);
    if (!p) continue;
    cell.set(key, p);
    coverage[ci]++;
  }

  // 3. The most-covered headline columns, or every column.
  let cols = index.columns.map((_, i) => i).filter((i) => coverage[i] > 0 && (ncols === 0 || index.columns[i].headline));
  cols.sort((a, b) => coverage[b] - coverage[a] || index.columns[a].label.localeCompare(index.columns[b].label));
  if (ncols > 0) cols = cols.slice(0, ncols);
  if (state.sortCol !== null && !cols.includes(state.sortCol)) state.sortCol = null;

  // 4. Models with enough scores in those columns.
  const rows = [];
  let shown = 0;
  index.models.forEach((m, mi) => {
    if (!modelOk[mi]) return;
    let k = 0;
    for (const ci of cols) if (cell.has(`${mi}:${ci}`)) k++;
    if (k >= minScores) {
      rows.push(mi);
      shown += k;
    }
  });

  // 5. Sort: by a column if one is chosen (blanks last), else newest release first.
  if (state.sortCol !== null) {
    const sign = state.sortDir === 'desc' ? -1 : 1;
    const v = (mi) => cell.get(`${mi}:${state.sortCol}`)?.best[0];
    rows.sort((a, b) => {
      const va = v(a);
      const vb = v(b);
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      return sign * (va - vb);
    });
  } else {
    const rel = (mi) => index.models[mi].released ?? '';
    rows.sort((a, b) => rel(b).localeCompare(rel(a)) || index.models[a].name.localeCompare(index.models[b].name));
  }

  // 6. Per-column ranks among shown rows, for the tint.
  const rank = new Map();
  for (const ci of cols) {
    const col = index.columns[ci];
    const vals = rows.map((mi) => cell.get(`${mi}:${ci}`)?.best[0]).filter((x) => x !== undefined);
    vals.sort((a, b) => (col.direction === 'lower' ? a - b : b - a));
    rank.set(ci, vals);
  }

  // 7. Table.
  const head = el('tr', {}, el('th', { class: 'model', scope: 'col' }, `Model (${rows.length})`));
  for (const ci of cols) {
    const col = index.columns[ci];
    const src = sourceById.get(col.source)?.name ?? col.source;
    const sorted = state.sortCol === ci;
    const th = el(
      'th',
      {
        scope: 'col',
        'aria-sort': sorted ? (state.sortDir === 'desc' ? 'descending' : 'ascending') : false,
        title:
          `${col.label}\nsource: ${src}\n${col.direction === 'lower' ? 'lower' : 'higher'} is better` +
          `\n${coverage[ci]} models with a score` +
          (col.description ? `\n${col.description}` : ''),
      },
      el('span', { class: 'label' }, col.label),
      el('span', { class: 'meta' }, `${src} · ${coverage[ci]}${col.direction === 'lower' ? ' ↓' : ''}`),
    );
    th.addEventListener('click', () => {
      if (state.sortCol === ci) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      else {
        state.sortCol = ci;
        state.sortDir = col.direction === 'lower' ? 'asc' : 'desc';
      }
      render();
    });
    head.append(th);
  }

  const body = el('tbody');
  for (const mi of rows) {
    const m = index.models[mi];
    const repo = safeUrl(m.model_repo);
    const name = repo ? el('a', { href: repo, target: '_blank', rel: 'noopener' }, m.name) : m.name;
    const tr = el(
      'tr',
      { class: m.unmatched ? 'unmatched' : false },
      el('td', { class: 'model' }, el('span', { class: 'name' }, name), el('span', { class: 'sub' }, modelSub(m))),
    );
    for (const ci of cols) {
      const p = cell.get(`${mi}:${ci}`);
      if (!p) {
        tr.append(el('td', { class: 'score empty' }));
        continue;
      }
      const col = index.columns[ci];
      const [value, runBy, date, context, ui, sourceId, interval] = p.best;
      const vals = rank.get(ci);
      const pct = vals.length > 1 ? 1 - vals.indexOf(value) / (vals.length - 1) : 1;
      const url = safeUrl(urlsBySource.get(sourceId)?.[ui]);
      const td = el(
        'td',
        {
          class: 'score',
          style: `background: rgba(var(--heat), ${(0.06 + 0.34 * pct * pct).toFixed(3)})`,
          title:
            `${m.name} — ${col.label}\n${fmt(value, col.unit)}${col.unit === 'fraction' || col.unit === 'percent' ? '%' : ''}` +
            (interval ? ` (interval ${interval})` : '') +
            `\nsource: ${sourceById.get(sourceId)?.name ?? sourceId}` +
            `\nrun by: ${RUN_BY[runBy] ?? 'unknown'}` +
            (date ? `\ndate: ${date}` : '') +
            (context ? `\ncontext: ${context}` : '') +
            (p.n > 1 ? `\n${p.n} scores for this cell; showing the best` : '') +
            (url ? `\nclick to open the source` : ''),
        },
        fmt(value, col.unit),
        p.n > 1 ? el('span', { class: 'n' }, `${p.n}`) : null,
      );
      if (url) td.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
      tr.append(td);
    }
    body.append(tr);
  }
  $('table-wrap').replaceChildren(el('table', {}, el('thead', {}, head), body));

  const fill = rows.length && cols.length ? ((100 * shown) / (rows.length * cols.length)).toFixed(1) : '0';
  $('viewstats').textContent = `Showing ${rows.length} models × ${cols.length} columns · ${shown} scores · ${fill}% of cells filled`;
}

function sourceLine(s) {
  const home = safeUrl(s.homepage);
  const name = home ? el('a', { href: home, target: '_blank', rel: 'noopener' }, s.name) : s.name;
  if (s.terms !== 'allowed') return el('p', {}, name, ` — not used. ${s.terms_note ?? ''}`);
  const status =
    s.outcome === 'held'
      ? ` Held at its last good data: ${(s.reasons ?? []).join('; ')}.`
      : s.outcome === 'failed'
        ? ` Last check failed: ${(s.reasons ?? []).join('; ')}.`
        : '';
  const when = [s.changed_at && `changed ${s.changed_at.slice(0, 10)}`, s.checked_at && `checked ${s.checked_at.slice(0, 16).replace('T', ' ')} UTC`]
    .filter(Boolean)
    .join(', ');
  return el('p', {}, name, ` — ${s.license ?? 'licence not recorded'}. ${s.attribution ?? ''}${when ? ` (${when}.)` : ''}${status}`);
}

async function main() {
  index = await (await fetch('data/index.json')).json();
  sourceById = new Map(index.sources.map((s) => [s.id, s]));
  const withData = index.sources.filter((s) => s.row_count > 0);
  const files = await Promise.all(withData.map((s) => fetch(`data/cells/${s.id}.json`).then((r) => r.json())));
  let total = 0;
  for (const f of files) {
    urlsBySource.set(f.source, f.urls);
    for (const [mi, ci, value, runBy, date, context, ui, interval] of f.cells) {
      const key = `${mi}:${ci}`;
      let list = candidates.get(key);
      if (!list) candidates.set(key, (list = []));
      list.push([value, runBy, date, context, ui, f.source, interval]);
      total++;
    }
  }

  const matchedModels = new Set();
  const colsWithData = new Set();
  for (const k of candidates.keys()) {
    const sep = k.indexOf(':');
    if (!index.models[Number(k.slice(0, sep))].unmatched) matchedModels.add(k.slice(0, sep));
    colsWithData.add(k.slice(sep + 1));
  }
  $('stats').textContent =
    `${withData.length} sources · ${total.toLocaleString()} scores · ${matchedModels.size.toLocaleString()} models · ` +
    `${colsWithData.size.toLocaleString()} metrics · built ${index.generated_at.slice(0, 10)}`;
  $('unmatched-label').textContent = `Show ${index.stats.unmatched_models} unmatched model names`;

  const footer = $('footer');
  footer.append(el('p', {}, 'Sources:'));
  for (const s of index.sources) footer.append(sourceLine(s));
  footer.append(el('p', {}, `${index.stats.invalid_excluded} results flagged as implausible upstream are not shown.`));

  for (const id of ['q', 'since', 'open', 'lab', 'unmatched', 'ncols', 'minscores']) $(id).addEventListener('input', render);
  render();
}

main().catch((e) => {
  $('stats').textContent = `Could not load data: ${e.message}`;
});
