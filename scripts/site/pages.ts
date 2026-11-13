/**
 * Static pages: one per model, per benchmark column and per source, plus directories, the method
 * and data pages. Plain HTML that works without JavaScript; the explorer is the one interactive page.
 */
import { dataReuse, fmt, paramsLabel, REUSE_TEXT, RUN_BY_LABELS, safeUrl, unitSuffix, unitWords } from '../../site/src/format.ts';
import { pickBest, ranks, type Candidate } from '../../site/src/select.ts';
import type { SiteColumn, SiteModel, SiteSource } from '../../site/src/types.ts';
import { html, raw, up, type Html } from './html.ts';

/** Text ending in a full stop, for attributions followed by more text. */
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
import type { SiteData } from './data.ts';
import { SQLITE_SCHEMA, type Download } from './exports.ts';

export const SITE_URL = (process.env['SITE_URL'] ?? 'https://llmbench.site').replace(/\/$/, '');
const ALL_RUN_BY = new Set([0, 1, 2]);

export interface Page {
  path: string;
  html: string;
}

const NAV: Array<[string, string, string]> = [
  ['explorer', '', 'Explorer'],
  ['benchmarks', 'benchmarks/', 'Benchmarks'],
  ['sources', 'sources/', 'Sources'],
  ['method', 'method/', 'Method'],
  ['data', 'data/', 'Data'],
  ['sql', 'sql/', 'SQL'],
];

function layout(o: { title: string; description: string; depth: number; active: string; body: Html; path: string; script?: string }): string {
  const u = up(o.depth);
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${SITE_URL}/${o.path}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1' y='9' width='3' height='6' fill='%231a5fb4'/%3E%3Crect x='6.5' y='5' width='3' height='10' fill='%231a5fb4'/%3E%3Crect x='12' y='1' width='3' height='14' fill='%231a5fb4'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${u}style.css">
${o.script ? html`<script type="module" src="${u}${o.script}"></script>` : ''}
</head>
<body>
<header class="site">
<a class="brand" href="${u}">llmbench</a>
<nav aria-label="Site">${NAV.map(([id, href, label]) => html`<a href="${u}${href}"${id === o.active ? raw(' aria-current="page"') : ''}>${label}</a>`)}</nav>
</header>
<main id="main">
${o.body}
</main>
<footer class="site">
<p>Every score links to where it came from. Data: CC BY-SA 4.0 with each source's own licence kept (<a href="${u}data/">details</a>). Code: MIT. <a href="https://github.com/jshahbazi/llmbench">Source on GitHub</a>.</p>
</footer>
</body>
</html>
`;
  return doc.value;
}

const runByLabel = (code: number) => RUN_BY_LABELS[code] ?? 'unknown';
const score = (c: Candidate, col: SiteColumn) => `${fmt(c.value, col.unit)}${unitSuffix(col.unit)}`;
const colHref = (u: string, col: SiteColumn) => `${u}benchmarks/${col.source}/${col.slug}/`;
const modelHref = (u: string, m: SiteModel) => `${u}models/${m.id}/`;
const explorerHref = (u: string, params: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return `${u}?${p}`;
};

function ext(url: string | null, label = '↗'): Html {
  const safe = safeUrl(url);
  return safe ? html`<a href="${safe}" rel="noopener" title="Open the original">${label}</a>` : html``;
}

/** Location of a source's data, as a link a person can open. */
export function fetchUrl(fetch?: string): string | null {
  if (!fetch) return null;
  let m = /^github:([^/]+)\/([^/]+)\/(.+)$/.exec(fetch);
  if (m) return `https://github.com/${m[1]}/${m[2]}/blob/HEAD/${m[3]!.replace(/\*.*$/, '')}`;
  m = /^hf:(.+)$/.exec(fetch);
  if (m) return `https://huggingface.co/datasets/${m[1]}`;
  return safeUrl(fetch);
}

function modelMeta(m: SiteModel): string {
  return [
    m.provider,
    m.released && `released ${m.released}`,
    paramsLabel(m.params_b, m.active_b) && `${paramsLabel(m.params_b, m.active_b)} parameters`,
    m.open_weights === true ? 'open weights' : m.open_weights === false ? 'API only' : '',
    m.license && `licence ${m.license}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function statusText(s: SiteSource): string {
  if (s.terms !== 'allowed') return 'not used';
  if (s.outcome === 'held') return 'held';
  if (s.outcome === 'failed') return 'last check failed';
  if (!s.row_count && !s.catalog) return 'pending';
  return 'ok';
}

const day = (t?: string) => (t ? t.slice(0, 10) : '—');

export function buildPages(d: SiteData, downloads: readonly Download[] = []): Page[] {
  const { index } = d;
  const pages: Page[] = [];
  const sourceName = new Map(index.sources.map((s) => [s.id, s.name]));
  const best = (mi: number, ci: number) => pickBest(d.byCell.get(`${mi}:${ci}`) ?? [], index.columns[ci]!.direction, ALL_RUN_BY);

  // Ranks per column, by each model's best score.
  const rankOf = new Map<string, number>();
  for (const [ci, ms] of d.columnModels) {
    const col = index.columns[ci]!;
    const list = [...ms];
    const vals = list.map((mi) => best(mi, ci)!.best.value);
    ranks(vals, col.direction).forEach((r, i) => rankOf.set(`${list[i]}:${ci}`, r));
  }

  // ---- Explorer -------------------------------------------------------------------------------
  pages.push({ path: '', html: explorerPage(d) });

  // ---- Models ---------------------------------------------------------------------------------
  const sourceOrder = new Map(index.sources.map((s, i) => [s.id, i]));
  index.models.forEach((m, mi) => {
    const u = up(2);
    const cols = [...(d.modelColumns.get(mi) ?? [])].sort((a, b) => {
      const ca = index.columns[a]!;
      const cb = index.columns[b]!;
      return (sourceOrder.get(ca.source) ?? 0) - (sourceOrder.get(cb.source) ?? 0) || cb.coverage - ca.coverage || ca.label.localeCompare(cb.label);
    });
    const bySource = new Map<string, number[]>();
    for (const ci of cols) {
      const s = index.columns[ci]!.source;
      bySource.set(s, [...(bySource.get(s) ?? []), ci]);
    }
    const scoreRows = (cis: number[]) =>
      cis.map((ci) => {
        const col = index.columns[ci]!;
        const list = [...(d.byCell.get(`${mi}:${ci}`) ?? [])].sort((a, b) => (col.direction === 'lower' ? a.value - b.value : b.value - a.value));
        const rank = rankOf.get(`${mi}:${ci}`);
        return list.map(
          (c, k) => html`<tr${k ? raw(' class="sub"') : ''}>
<td>${k ? '' : html`<a href="${colHref(u, col)}">${col.label}</a>`}</td>
<td class="num">${score(c, col)}${c.interval ? html`<span class="ci">${c.interval}</span>` : ''}</td>
<td class="num">${k || rank === undefined ? '' : html`${rank}<span class="of"> / ${col.coverage}</span>`}</td>
<td class="date">${c.date || '—'}</td><td>${runByLabel(c.runBy)}</td><td>${c.context}</td><td>${ext(c.url)}</td></tr>`,
        );
      });
    const scoreTable = (cis: number[]) => html`<div class="table-scroll"><table class="data">
<thead><tr><th scope="col">Benchmark</th><th scope="col" class="num">Score</th><th scope="col" class="num">Rank</th><th scope="col">Date</th><th scope="col">Run by</th><th scope="col">Context</th><th scope="col"><span class="sr">Link</span></th></tr></thead>
<tbody>${scoreRows(cis)}</tbody></table></div>`;
    const aliases = [...d.names].flatMap(([sid, list]) => list.filter((n) => n.model === mi).map((n) => ({ sid, ...n })));
    const changes = [...d.history]
      .flatMap(([sid, list]) => list.filter((e) => e.modelIndex === mi).map((e) => ({ ...e, sid })))
      .sort((a, b) => (a.t < b.t ? 1 : -1))
      .slice(0, 50);
    const repo = safeUrl(m.model_repo);
    const body = html`
<p class="crumbs"><a href="${u}">Explorer</a> › Models</p>
<h1>${m.name}</h1>
${m.unlisted
  ? html`<div class="notice soft"><p>Not in the model catalogue yet, so its maker, release date and size are unknown. These are names from the sources that agree with each other. If this is a catalogue model under another name, one line in <a href="https://github.com/jshahbazi/llmbench/blob/main/curation/aliases.csv">curation/aliases.csv</a> moves its scores there; to add it, use <a href="https://github.com/jshahbazi/llmbench/blob/main/curation/models.yaml">curation/models.yaml</a>.</p></div>`
  : html`<p class="meta">${modelMeta(m)}</p>`}
<p class="links">${repo ? html`<a href="${repo}" rel="noopener">Model repository</a> · ` : ''}${m.origin === 'whatmodel' ? html`<a href="https://whatmodel.sh/model/${m.id}" rel="noopener">whatmodel.sh page</a> (memory needed, how to run it) · ` : m.origin && sourceName.has(m.origin) ? html`Model details from <a href="${u}sources/${m.origin}/">${sourceName.get(m.origin)!}</a> · ` : ''}<a href="${explorerHref(u, { q: m.name, min: '1' })}">Show in the explorer</a> · <a href="${explorerHref(u, { m: m.id, view: 'compare' })}">Compare with other models</a></p>
<p>${cols.length} benchmark scores from ${bySource.size} source${bySource.size === 1 ? '' : 's'}. Rank is among every model with a score in that column, using each model's best score.</p>
${[...bySource].map(([sid, cis]) => {
  const main = cis.filter((ci) => index.columns[ci]!.headline);
  const subs = cis.filter((ci) => !index.columns[ci]!.headline);
  return html`
<h2>${sourceName.get(sid) ?? sid}</h2>
${main.length ? scoreTable(main) : ''}
${subs.length ? html`<details class="subscores"${main.length ? '' : raw(' open')}><summary>${subs.length} sub-score${subs.length === 1 ? '' : 's'}</summary>${scoreTable(subs)}</details>` : ''}`;
})}
<h2>Names in the sources</h2>
<ul class="names">${aliases.map((a) => html`<li><a href="${u}sources/${a.sid}/#names">${sourceName.get(a.sid) ?? a.sid}</a>: “${a.raw}” <span class="muted">(${methodText(a.method)}${a.qualifiers ? `; context: ${a.qualifiers}` : ''})</span></li>`)}</ul>
${changes.length ? html`<h2>Recent changes</h2><ul class="history">${changes.map((e) => html`<li>${day(e.t)} · ${sourceName.get(e.sid) ?? e.sid} · ${e.column !== undefined ? index.columns[e.column]!.label : e.metric}: ${changeText(e.op, e.from, e.to)}</li>`)}</ul>` : ''}
`;
    pages.push({
      path: `models/${m.id}/`,
      html: layout({ title: `${m.name} — benchmark scores · llmbench`, description: `Every benchmark score for ${m.name}, from ${bySource.size} sources, with links to each original.`, depth: 2, active: 'explorer', body, path: `models/${m.id}/` }),
    });
  });

  // ---- Benchmark columns ----------------------------------------------------------------------
  index.columns.forEach((col, ci) => {
    const u = up(3);
    const entries = [...(d.columnModels.get(ci) ?? [])]
      .map((mi) => ({ mi, b: best(mi, ci)!, all: d.byCell.get(`${mi}:${ci}`)!.length }))
      .sort((a, b) => (col.direction === 'lower' ? a.b.best.value - b.b.best.value : b.b.best.value - a.b.best.value));
    const siblings = col.family ? index.columns.filter((c) => c.family === col.family && c.id !== col.id) : [];
    const href = safeUrl(col.url);
    const body = html`
<p class="crumbs"><a href="${u}benchmarks/">Benchmarks</a> › <a href="${u}sources/${col.source}/">${sourceName.get(col.source) ?? col.source}</a></p>
<h1>${col.label}</h1>
<p class="meta">From <a href="${u}sources/${col.source}/">${sourceName.get(col.source) ?? col.source}</a> · ${unitWords(col.unit)} · ${col.direction === 'lower' ? 'lower is better' : 'higher is better'} · ${col.coverage} models${col.tags?.length ? html` · ${col.tags.join(', ')}` : ''}</p>
${col.description ? html`<p>${col.description}</p>` : ''}
<p class="links">${href ? html`<a href="${href}" rel="noopener">About this benchmark</a> · ` : ''}<a href="${explorerHref(u, { c: col.id, sort: col.id, min: '1' })}">Open in the explorer</a>${col.metric !== col.label ? html` · source's name for it: “${col.metric}”` : ''}</p>
${siblings.length ? html`<p>Same benchmark elsewhere: ${siblings.map((s, k) => html`${k ? ', ' : ''}<a href="${colHref(u, s)}">${s.label}</a> (${sourceName.get(s.source) ?? s.source})`)}</p>` : ''}
<div class="table-scroll"><table class="data">
<thead><tr><th scope="col" class="num">#</th><th scope="col">Model</th><th scope="col" class="num">Score</th><th scope="col">Date</th><th scope="col">Run by</th><th scope="col">Context</th><th scope="col"><span class="sr">Link</span></th></tr></thead>
<tbody>${entries.map(({ mi, b, all }) => {
    const m = index.models[mi]!;
    const rank = rankOf.get(`${mi}:${ci}`);
    return html`<tr${m.unlisted ? raw(' class="unlisted"') : ''}><td class="num">${rank ?? ''}</td>
<td><a href="${modelHref(u, m)}">${m.name}</a>${m.unlisted ? html` <span class="muted">(not in the catalogue)</span>` : ''}</td>
<td class="num">${score(b.best, col)}${b.best.interval ? html`<span class="ci">${b.best.interval}</span>` : ''}${all > 1 ? html`<span class="muted" title="${all} scores for this model; best shown"> +${all - 1}</span>` : ''}</td>
<td class="date">${b.best.date || '—'}</td><td>${runByLabel(b.best.runBy)}</td><td>${b.best.context}</td><td>${ext(b.best.url)}</td></tr>`;
  })}</tbody></table></div>
`;
    pages.push({
      path: `benchmarks/${col.source}/${col.slug}/`,
      html: layout({ title: `${col.label} (${sourceName.get(col.source)}) — llmbench`, description: `${col.label} scores for ${col.coverage} models, from ${sourceName.get(col.source)}.`, depth: 3, active: 'benchmarks', body, path: `benchmarks/${col.source}/${col.slug}/` }),
    });
  });

  // ---- Benchmarks directory -------------------------------------------------------------------
  {
    const u = up(1);
    const body = html`
<h1>Benchmarks</h1>
<p>Every metric from every source: ${index.columns.length} columns. Each source's metrics stay separate, because the same benchmark run by two sources is not always the same measurement. Headline metrics are marked ★; the rest are sub-scores.</p>
<p><label>Filter <input type="search" id="filter" placeholder="Name, source or tag" autocomplete="off"></label></p>
${index.sources
  .filter((s) => s.metric_count)
  .map((s) => {
    const cols = index.columns.filter((c) => c.source === s.id).sort((a, b) => Number(b.headline) - Number(a.headline) || b.coverage - a.coverage);
    return html`<section class="bench-group"><h2><a href="${u}sources/${s.id}/">${s.name}</a> <span class="muted">${cols.length}</span></h2>
<div class="table-scroll"><table class="data"><thead><tr><th scope="col">Metric</th><th scope="col" class="num">Models</th><th scope="col">Tags</th><th scope="col">Better</th></tr></thead><tbody>
${cols.map((c) => html`<tr data-search="${`${c.label} ${c.metric} ${s.name} ${(c.tags ?? []).join(' ')}`.toLowerCase()}"><td>${c.headline ? '★ ' : ''}<a href="${colHref(u, c)}">${c.label}</a></td><td class="num">${c.coverage}</td><td>${(c.tags ?? []).join(', ')}</td><td>${c.direction === 'lower' ? 'lower' : 'higher'}</td></tr>`)}
</tbody></table></div></section>`;
  })}
<script>
const f = document.getElementById('filter');
f.addEventListener('input', () => {
  const q = f.value.trim().toLowerCase();
  for (const tr of document.querySelectorAll('tr[data-search]')) tr.hidden = !!q && !tr.dataset.search.includes(q);
  for (const g of document.querySelectorAll('.bench-group')) g.hidden = !!q && !g.querySelector('tr[data-search]:not([hidden])');
});
</script>
`;
    pages.push({ path: 'benchmarks/', html: layout({ title: 'Benchmarks — llmbench', description: `All ${index.columns.length} benchmark metrics from every source.`, depth: 1, active: 'benchmarks', body, path: 'benchmarks/' }) });
  }

  // ---- Sources ----------------------------------------------------------------------------------
  {
    const u = up(1);
    const body = html`
<h1>Sources</h1>
<p>Everything llmbench pulls from, listed in <a href="https://github.com/jshahbazi/llmbench/blob/main/sources.yaml">sources.yaml</a>. Each source is checked on its own schedule. If new data fails a check, the last good data stays up and an issue is opened.</p>
<div class="table-scroll"><table class="data">
<thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col" class="num">Rows</th><th scope="col" class="num">Metrics</th><th scope="col" class="num">Names matched</th><th scope="col">Licence</th><th scope="col">Checked</th><th scope="col">Changed</th></tr></thead>
<tbody>${index.sources.map(
      (s) => html`<tr><td><a href="${u}sources/${s.id}/">${s.name}</a></td><td class="status-${statusText(s).split(' ')[0]}">${statusText(s)}</td><td class="num">${s.row_count || (s.catalog ? html`<span class="muted">${s.catalog.models} models</span>` : '')}</td><td class="num">${s.metric_count || ''}</td><td class="num">${s.names ? `${s.matched_names} / ${s.names}` : ''}</td><td>${s.license ?? ''}${s.terms === 'allowed' && dataReuse(s.license) === 'noncommercial' ? html` <span class="muted">(non-commercial)</span>` : ''}</td><td>${day(s.checked_at)}</td><td>${day(s.changed_at)}</td></tr>`,
    )}</tbody></table></div>
`;
    pages.push({ path: 'sources/', html: layout({ title: 'Sources — llmbench', description: 'Every leaderboard and dataset llmbench pulls from, with status and licence.', depth: 1, active: 'sources', body, path: 'sources/' }) });
  }

  const firstFeed = index.sources.find((x) => x.catalog && !x.catalog.fill_only)?.id;
  for (const s of index.sources) {
    const u = up(2);
    const cols = index.columns.filter((c) => c.source === s.id).sort((a, b) => Number(b.headline) - Number(a.headline) || b.coverage - a.coverage);
    const names = d.names.get(s.id) ?? [];
    const events = (d.history.get(s.id) ?? []).slice(-100).reverse();
    const where = fetchUrl(s.fetch);
    const headline = cols.filter((c) => c.headline).map((c) => c.id);
    const body = html`
<p class="crumbs"><a href="${u}sources/">Sources</a></p>
<h1>${s.name}</h1>
<p class="meta">Status: ${statusText(s)} · checked ${day(s.checked_at)} · last changed ${day(s.changed_at)}${s.every ? ` · checked every ${s.every}` : ''}</p>
${s.reasons?.length ? html`<div class="notice"><p>${s.outcome === 'held' ? 'The latest data was held at the last good version:' : 'The latest check failed:'}</p><ul>${s.reasons.map((r) => html`<li>${r}</li>`)}</ul></div>` : ''}
${s.warnings?.length ? html`<div class="notice soft"><ul>${s.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
<p class="links"><a href="${safeUrl(s.homepage) ?? '#'}" rel="noopener">Website</a>${where ? html` · <a href="${where}" rel="noopener">Data we read</a>` : ''}${s.upstream_revision && /^[0-9a-f]{40}$/.test(s.upstream_revision) ? html` · pinned to upstream commit <code>${s.upstream_revision.slice(0, 7)}</code>` : ''}${headline.length ? html` · <a href="${explorerHref(u, { c: headline, min: '1' })}">Open its headline metrics in the explorer</a>` : ''}</p>
<p>Licence: ${s.license ?? 'not recorded'}.${s.attribution ? html` ${sentence(s.attribution)}` : ''}${s.terms !== 'allowed' ? '' : dataReuse(s.license) === 'licensed' ? '' : html` <strong>${REUSE_TEXT[dataReuse(s.license)]}</strong>`}${s.terms_note ? html` <span class="muted">${s.terms_note}</span>` : ''}</p>
${s.catalog ? catalogSection(s, s.id === firstFeed, u) : ''}
${s.terms !== 'allowed' ? html`<p>This source is listed for the record and is not fetched.</p>` : !s.row_count && s.catalog ? '' : html`
<h2>Metrics <span class="muted">${cols.length}</span></h2>
<div class="table-scroll"><table class="data"><thead><tr><th scope="col">Metric</th><th scope="col" class="num">Models</th><th scope="col">Tags</th></tr></thead><tbody>
${cols.map((c) => html`<tr><td>${c.headline ? '★ ' : ''}<a href="${colHref(u, c)}">${c.label}</a>${c.label !== c.metric ? html` <span class="muted">${c.metric}</span>` : ''}</td><td class="num">${c.coverage}</td><td>${(c.tags ?? []).join(', ')}</td></tr>`)}
</tbody></table></div>
<h2 id="names">Model names <span class="muted">${s.matched_names} of ${s.names} in the catalogue</span></h2>
<p>How each name in this source was matched to a model (see the <a href="${u}method/#matching">method</a>). Names that match no catalogue model are shown as models of their own, joined with the same name from other sources. A wrong or missing match is one line in <a href="https://github.com/jshahbazi/llmbench/blob/main/curation/aliases.csv">curation/aliases.csv</a>.</p>
<div class="table-scroll"><table class="data"><thead><tr><th scope="col">Name in the source</th><th scope="col">Model</th><th scope="col">Matched by</th><th scope="col" class="num">Scores</th><th scope="col">Set aside as context</th></tr></thead><tbody>
${names.map((n) => {
  const m = index.models[n.model]!;
  return html`<tr${m.unlisted ? raw(' class="unlisted"') : ''}><td>${n.raw}</td><td><a href="${u}models/${m.id}/">${m.name}</a></td><td>${methodText(n.method)}</td><td class="num">${n.scores}</td><td>${n.qualifiers}</td></tr>`;
})}
</tbody></table></div>
<h2>Recent changes</h2>
${events.length ? html`<ul class="history">${events.map((e) => {
  const m = e.modelIndex !== undefined ? index.models[e.modelIndex] : undefined;
  return html`<li>${day(e.t)} · ${m ? html`<a href="${u}models/${m.id}/">${m.name}</a>` : e.model} · ${e.column !== undefined ? index.columns[e.column]!.label : e.metric}: ${changeText(e.op, e.from, e.to)}</li>`;
})}</ul>` : html`<p class="muted">No changes recorded since this source was first imported on ${day(s.changed_at)}.</p>`}
`}
`;
    pages.push({ path: `sources/${s.id}/`, html: layout({ title: `${s.name} — llmbench`, description: `${s.name}: status, metrics, model names and recent changes.`, depth: 2, active: 'sources', body, path: `sources/${s.id}/` }) });
  }

  pages.push({ path: 'method/', html: methodPage() });
  pages.push({ path: 'data/', html: dataPage(d, downloads) });
  pages.push({ path: 'sql/', html: sqlPage(d, downloads) });
  pages.push({
    path: '404.html',
    html: layout({ title: 'Not found — llmbench', description: 'Page not found.', depth: 0, active: '', path: '404.html', body: html`<h1>Not found</h1><p>That page does not exist. Try the <a href="/">explorer</a> or the <a href="/benchmarks/">list of benchmarks</a>.</p>` }),
  });
  return pages;
}

/** What a catalogue feed gave the catalogue, on its source page. */
function catalogSection(s: SiteSource, first: boolean, u: string): Html {
  const c = s.catalog!;
  const file = `https://github.com/jshahbazi/llmbench/blob/main/data/catalog/${s.id}.jsonl`;
  const what = c.fill_only
    ? html`It only fills in details for models already in the catalogue, and never adds one: it gave ${c.filled} catalogue models at least one detail they lacked.`
    : first
      ? html`This is the first catalogue feed: its ${c.models} models are the base of the catalogue, and the other feeds only fill in details it leaves empty.`
      : html`Of its ${c.models} models, ${c.added} were added to the catalogue and ${c.filled} catalogue models got details from it that earlier feeds lacked (release date, open weights, licence, size, context window, repository). ${c.left_out ? html`${c.left_out} were left out because a model already in the catalogue shares their core name; they are listed in <a href="https://github.com/jshahbazi/llmbench/blob/main/data/reports/catalog-left-out.csv">data/reports/catalog-left-out.csv</a>.` : ''}`;
  return html`<h2 id="catalogue">Model catalogue <span class="muted">${c.models} models</span></h2>
<p>${s.row_count ? '' : 'This source describes models and has no scores. '}${what} How the feeds are merged is on the <a href="${u}method/#catalogue">method page</a>; this feed's models are in <a href="${file}">data/catalog/${s.id}.jsonl</a>.</p>`;
}

const METHODS: Record<string, string> = {
  alias: 'curation file',
  link: 'repository link',
  exact: 'exact name',
  variant: 'name minus qualifiers',
  maker: 'name minus maker',
  unlisted: 'not in the catalogue',
  blocked: 'kept apart by curation',
};
const methodText = (method: string) => METHODS[method] ?? (method || 'not matched');

function changeText(op: string, from: unknown, to: unknown): string {
  const v = (x: unknown) => (x === undefined || x === null ? '' : String(x));
  if (op === 'add') return `added ${v(to)}`;
  if (op === 'remove') return `removed (was ${v(from)})`;
  if (op === 'return') return `back, ${v(to)}`;
  return `${v(from)} → ${v(to)}`;
}

function explorerPage(d: SiteData): string {
  const makers = new Map<string, number>();
  for (const m of d.index.models) if (m.provider) makers.set(m.provider, (makers.get(m.provider) ?? 0) + 1);
  const body = html`
<h1 class="sr">llmbench explorer</h1>
<p class="lede">Benchmark results from every listed source, side by side. Pick any columns, sort by any of them, and click a score to see where it came from.</p>
<p id="stats" class="stats">Loading…</p>

<div class="toolbar" role="toolbar" aria-label="Columns">
  <button type="button" id="pick" aria-haspopup="dialog">Choose columns</button>
  <span class="presets" id="presets"></span>
  <label class="auto-only">Show <select id="ncols"><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select> most covered</label>
  <button type="button" id="reset-cols" class="link" hidden>Back to most covered</button>
</div>

<form id="filters" class="filters" onsubmit="return false">
  <label class="search"><span>Model</span> <input id="q" type="search" placeholder="Name or maker" autocomplete="off"></label>
  <label><span>Released</span> <select id="since"><option value="0">any time</option><option value="6">last 6 months</option><option value="12">last 12 months</option><option value="24">last 24 months</option><option value="36">last 36 months</option></select></label>
  <label><span>Size</span> <select id="size"><option value="0">any</option><option value="4">≤ 4B</option><option value="14">≤ 14B</option><option value="36">≤ 36B</option><option value="80">≤ 80B</option><option value="250">≤ 250B</option><option value="-250">over 250B</option></select></label>
  <label><span>Maker</span> <select id="maker"><option value="">any</option>${[...makers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p, n]) => html`<option value="${p}">${p} (${n})</option>`)}</select></label>
  <label><input id="open" type="checkbox"> Open weights</label>
  <label><input id="perm" type="checkbox"> Permissive licence</label>
  <fieldset class="runby"><legend>Run by</legend>
    <label><input type="checkbox" data-runby="0" checked> independent</label>
    <label><input type="checkbox" data-runby="1" checked> submitted</label>
    <label><input type="checkbox" data-runby="2" checked> lab</label>
  </fieldset>
  <label><input id="um" type="checkbox" checked> <span id="um-label">Models not in the catalogue</span></label>
  <label title="Leave out scores from quantized models and from runs with web search or grounding"><input id="plain" type="checkbox"> Plain runs only</label>
  <label><span>Hide models with fewer than</span> <select id="min"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="10">10</option></select> <span>scores in view</span></label>
</form>

<div class="viewbar">
  <p id="viewstats" class="stats" aria-live="polite"></p>
  <span class="actions">
    <span id="chart-axes" class="chart-axes" hidden><label>Y <select id="y-axis"></select></label> <label>X <select id="x-axis"></select></label></span>
    <button type="button" id="chart">Chart</button>
    <button type="button" id="compare" disabled>Compare</button>
    <button type="button" id="export">Download CSV</button>
    <button type="button" id="share">Copy link</button>
  </span>
</div>

<div id="table-wrap" class="table-wrap" tabindex="0" aria-label="Benchmark table"></div>

<dialog id="picker" aria-labelledby="picker-title">
  <form method="dialog" class="picker-head">
    <h2 id="picker-title">Choose columns</h2>
    <button type="submit" class="link">Done</button>
  </form>
  <p class="muted">Tick any metric from any source. Numbers are how many models have a score, given the current filters.</p>
  <p><input id="picker-q" type="search" placeholder="Search metrics" autocomplete="off"> <label><input id="picker-sub" type="checkbox"> Include sub-scores</label></p>
  <div id="picker-list"></div>
</dialog>

<div id="popover" class="popover" role="dialog" aria-modal="false" hidden></div>
`;
  return layout({
    title: 'llmbench — LLM benchmark results from every leaderboard, side by side',
    description: 'Compare language models across every benchmark leaderboard: pick any columns, filter by size, licence and maker, and see where every number came from.',
    depth: 0,
    active: 'explorer',
    body,
    path: '',
    script: 'js/explorer.js',
  });
}

function methodPage(): string {
  const body = html`
<h1>Method</h1>
<p>llmbench collects published benchmark results. It does not run evaluations, and it does not combine scores into an overall ranking.</p>
<h2>Where the numbers come from</h2>
<p>Every source is listed in <a href="https://github.com/jshahbazi/llmbench/blob/main/sources.yaml">sources.yaml</a> with its licence. A source is only fetched after its terms have been checked. Every few hours a scheduled job reads each source, stores each score exactly as the source wrote it, and records anything that changed. Every score on the site links back to the page or file it came from.</p>
<h2>One column per source</h2>
<p>The same benchmark run by two sources is often not the same measurement: different prompts, settings, versions of the question set or scoring. So each source's metric is its own column, labelled with the source. Where two columns measure the same benchmark, the benchmark page links them.</p>
<h2>Which score a cell shows</h2>
<p>A model can have several scores in one column: re-runs, reasoning efforts, agent set-ups, or several entries in the source. The cell shows the best one that passes your filters, and a small number when there are others. Click the cell to see all of them, each with how the model was run. “Plain runs only” leaves out scores from quantized models and from runs with web search or grounding.</p>
<h2>Who ran it</h2>
<ul>
<li><strong>Independent</strong>: someone other than the model's maker ran the evaluation (for example Epoch AI, or Arena's human votes).</li>
<li><strong>Submitted</strong>: the score was submitted to a leaderboard by whoever built the model or agent, and who executed it is not established.</li>
<li><strong>Lab</strong>: reported by the model's maker, for example in a model card or release post.</li>
</ul>
<h2 id="catalogue">The model catalogue</h2>
<p>Each model's maker, release date, size, licence and context window come from the catalogue, which is merged from several feeds in order: <a href="https://whatmodel.sh">whatmodel.sh</a> first, then <a href="https://models.dev">models.dev</a> and <a href="https://epoch.ai/data/ai-models">Epoch AI's models database</a>, which add models released since, then the <a href="https://huggingface.co/models">Hugging Face Hub</a>, which only fills in parameter counts and licences for open-weights models. The first feed to describe a model wins; a later feed only fills details the earlier ones left empty. A later feed's model is added only when nothing in the catalogue shares its core name: “GPT-4o (Aug 2024)” or “Grok 4 Fast Non-Reasoning” from a later feed is left out where the catalogue already has GPT-4o or Grok 4 Fast, so adding a feed never moves a name that already matched. Left-out models are listed in <a href="https://github.com/jshahbazi/llmbench/blob/main/data/reports/catalog-left-out.csv">data/reports/catalog-left-out.csv</a>; one that is a release of its own is taken by a line with its id in <a href="https://github.com/jshahbazi/llmbench/blob/main/curation/models.yaml">curation/models.yaml</a>.</p>
<h2 id="matching">Matching model names</h2>
<p>Sources name the same model differently: “o1-2024-12-17_high”, “o1 (high)” and “o1 (2024-12-17)” are one model. Each name is matched to a model in the catalogue, and only on exact agreement, tried in this order:</p>
<ol>
<li><strong>Curation file.</strong> A line in <a href="https://github.com/jshahbazi/llmbench/blob/main/curation/aliases.csv">curation/aliases.csv</a> decides. It can also keep a name from being matched.</li>
<li><strong>Repository link.</strong> The source links to the model's Hugging Face repository, and the catalogue knows that repository.</li>
<li><strong>Exact name.</strong> The name equals a catalogue model's id, name or repository name, ignoring case and punctuation. A separator between two numbers still counts, so “OPT-1.3B” never matches “OPT-13B”, and so does “+”, so “Command R+” never matches “Command R”.</li>
<li><strong>Name minus qualifiers.</strong> Qualifiers come off the name: reasoning effort (“High”, “_xhigh”), thinking budget (“_32K”), thinking on or off, quantization (“FP8”, “NVFP4”), calling mode (“FC”, “Prompt”), web search or grounding, release stage (“Preview”, “Beta”) and snapshot date. What is left must fit exactly one catalogue model, and a stated snapshot date must agree with that model's own. So “GPT-4o (Aug 2024)” is GPT-4o 2024-08-06, and “Mistral Large (2411)” is never Mistral Large 2402.</li>
<li><strong>Name minus maker.</strong> The same, after a leading maker name such as “NVIDIA-” or “Amazon”, when the catalogue model is by that maker.</li>
</ol>
<p>Qualifiers that were set aside stay with each score as its context, so a high-effort and a low-effort run of one model remain distinguishable in the same cell. There is no fuzzy matching. When a name could be two models, such as “GPT-4o” with three dated releases in the catalogue, it is not matched at all, because a wrong merge would silently mix two models' scores.</p>
<p>A name that matches no catalogue model still gets a row of its own, shared with the same name from other sources, and is marked “not in the catalogue”. Each source's page lists every name, the model it went to and how. Fixing a match is one line in curation/aliases.csv, and adding or correcting a model is a few lines in <a href="https://github.com/jshahbazi/llmbench/blob/main/curation/models.yaml">curation/models.yaml</a>. Names not in the catalogue, with near misses to check, are in <a href="https://github.com/jshahbazi/llmbench/blob/main/data/reports/unmatched.csv">data/reports/unmatched.csv</a>.</p>
<h2>Dates</h2>
<p>A score's date is the date the source gives for the evaluation. When the source gives none, no date is shown; the site never substitutes the day it first saw a score.</p>
<h2>When a source breaks</h2>
<p>New data is checked before it is published: missing columns, far fewer rows than before, many scores changing at once, numbers turning into text, or repeated rows. If a check fails, the last good data stays up and an issue is opened on GitHub.</p>
<h2>Sizes and licences</h2>
<p>Size filters use total parameters, because that sets the memory a model needs. For mixture-of-experts models the active parameter count is shown too. “Permissive licence” means Apache, MIT, BSD and similar; custom model licences are not counted, even when they allow commercial use.</p>
`;
  return layout({ title: 'Method — llmbench', description: 'How llmbench collects, matches and shows benchmark results.', depth: 1, active: 'method', body, path: 'method/' });
}

function size(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** Tables and views in a schema, with their columns, for the SQL page. */
export function schemaTables(sql: string): Array<{ name: string; kind: 'table' | 'view'; columns: string[] }> {
  const out: Array<{ name: string; kind: 'table' | 'view'; columns: string[] }> = [];
  for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([^;]*)\);/g)) {
    const columns = m[2]!
      .split(/,(?![^(]*\))/)
      .map((c) => c.trim().split(/\s+/)[0]!)
      .filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c));
    out.push({ name: m[1]!, kind: 'table', columns });
  }
  for (const m of sql.matchAll(/CREATE VIEW (\w+) AS\s+SELECT ([\s\S]*?)\s+FROM/g)) {
    out.push({ name: m[1]!, kind: 'view', columns: m[2]!.split(',').map((c) => c.trim().split(/\s+AS\s+|\./i).pop()!.trim()) });
  }
  return out;
}

export const SQL_EXAMPLES: Array<[string, string]> = [
  ['Benchmarks with the most models', `SELECT id, label, source, models\nFROM benchmarks\nORDER BY models DESC\nLIMIT 20;`],
  ['Best score per model on one benchmark', `SELECT m.name AS model, max(s.value) AS best, count(*) AS runs\nFROM scores s JOIN models m ON m.id = s.model_id\nWHERE s.benchmark_id = 'cais:hle'\nGROUP BY m.id\nORDER BY best DESC\nLIMIT 20;`],
  ["One model's scores everywhere", `SELECT source, benchmark, value, unit, run_by, context\nFROM scores_named\nWHERE model = 'Claude Opus 5.5'\nORDER BY source, benchmark;`],
  ['Makers\' own numbers next to an independent run', `-- Humanity's Last Exam: model makers' reports (via whatmodel, 0-1) against CAIS's runs (0-100)\nSELECT m.name AS model,\n  round(max(CASE WHEN s.benchmark_id = 'whatmodel:hle' THEN s.value * 100 END), 1) AS reported,\n  round(max(CASE WHEN s.benchmark_id = 'cais:hle' THEN s.value END), 1) AS cais\nFROM scores s JOIN models m ON m.id = s.model_id\nWHERE s.benchmark_id IN ('whatmodel:hle', 'cais:hle')\nGROUP BY m.id\nHAVING reported IS NOT NULL AND cais IS NOT NULL\nORDER BY cais DESC;`],
  ['Models with the most benchmarks', `SELECT m.name, m.provider, count(DISTINCT s.benchmark_id) AS benchmarks\nFROM scores s JOIN models m ON m.id = s.model_id\nGROUP BY m.id\nORDER BY benchmarks DESC\nLIMIT 20;`],
  ['Sources and how their data may be reused', `SELECT id, name, license, reuse, rows\nFROM sources\nORDER BY rows DESC;`],
];

function sqlPage(d: SiteData, downloads: readonly Download[]): string {
  const u = up(1);
  const db = downloads.find((f) => f.file === 'llmbench.sqlite');
  const tables = schemaTables(SQLITE_SCHEMA);
  const first = SQL_EXAMPLES[0]![1];
  const body = html`
<h1>SQL console</h1>
<p>Query everything llmbench holds with SQL, in your browser. The first query loads SQLite (about 1 MB) and the <a href="${u}data/#downloads">database download</a>${db ? html` (${size(db.bytes)}, a few MB compressed)` : ''}, built ${day(d.index.generated_at)}. Nothing you type leaves your browser, and any changes you make stay in this tab.</p>
<noscript><p class="notice">The SQL console needs JavaScript. The <a href="${u}data/#downloads">SQLite file</a> works with any SQLite tool.</p></noscript>
<form id="sql-form" class="sql" data-db="${u}downloads/llmbench.sqlite" data-vendor="${u}vendor/sql.js/">
<label for="sql-q">Query</label>
<textarea id="sql-q" name="q" rows="9" spellcheck="false" autocapitalize="off" autocomplete="off">${first}</textarea>
<p class="sql-actions"><button type="submit" id="sql-run">Run</button> <span class="muted">or Ctrl+Enter</span>
<button type="button" id="sql-csv" disabled>Download CSV</button>
<button type="button" id="sql-link">Copy link</button></p>
</form>
<p id="sql-status" class="muted" role="status" aria-live="polite"></p>
<div id="sql-out" class="table-scroll"></div>
<h2>Examples</h2>
<ul class="sql-examples">${SQL_EXAMPLES.map(([label, q]) => html`<li><button type="button" class="link" data-q="${q}">${label}</button></li>`)}</ul>
<h2>Tables</h2>
<p>Scores are on each source's own scale (unit <code>fraction</code> is 0 to 1, <code>percent</code> 0 to 100). Benchmark ids are <code>source:metric</code>, as in the explorer's links. <code>scores_named</code> joins the names in for you.</p>
<div class="table-scroll"><table class="data"><thead><tr><th scope="col">Table</th><th scope="col">Columns</th></tr></thead><tbody>
${tables.map((t) => html`<tr><td><code>${t.name}</code>${t.kind === 'view' ? html` <span class="muted">view</span>` : ''}</td><td>${t.columns.map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}</td></tr>`)}
</tbody></table></div>
`;
  return layout({ title: 'SQL console — llmbench', description: 'Query every llmbench score with SQL in your browser.', depth: 1, active: 'sql', body, path: 'sql/', script: 'js/sql.js' });
}

function dataPage(d: SiteData, downloads: readonly Download[]): string {
  const u = up(1);
  const body = html`
<h1>Data</h1>
<h2 id="downloads">Downloads</h2>
${downloads.length
  ? html`<p>Rebuilt with the site on every update, last on ${day(d.index.generated_at)}. Every score is included, not only the best one per cell, with its model, benchmark, source, date and how the model was run.</p>
<div class="table-scroll"><table class="data"><thead><tr><th scope="col">File</th><th scope="col">Format</th><th scope="col" class="num">Rows</th><th scope="col" class="num">Size</th><th scope="col">Contents</th></tr></thead><tbody>
${downloads.map((f) => html`<tr><td><a href="${u}downloads/${f.file}" download>${f.file}</a></td><td>${f.format}</td><td class="num">${f.rows.toLocaleString('en')}</td><td class="num">${size(f.bytes)}</td><td>${f.description}</td></tr>`)}
</tbody></table></div>
<p>Values are on each source's own scale: unit “fraction” runs from 0 to 1, “percent” from 0 to 100, and “elo” is a rating. A model can have several scores for one benchmark (re-runs, reasoning efforts, agent set-ups); <code>context</code> says how each was run. Models not in the catalogue have <code>in_catalogue</code> false and no maker, date or size.</p>
<p>To query everything in your browser, use the <a href="${u}sql/">SQL console</a>. Or, for example, with <a href="https://duckdb.org">DuckDB</a>:</p>
<pre><code>SELECT model, benchmark, max(value) AS best
FROM 'https://llmbench.site/downloads/llmbench-scores.parquet'
WHERE source = 'bfcl' AND benchmark = 'Overall Acc'
GROUP BY ALL ORDER BY best DESC LIMIT 10;</code></pre>`
  : html`<p>The downloads are built with the site.</p>`}
<h2>Source files</h2>
<p>All data is in the <a href="https://github.com/jshahbazi/llmbench/tree/main/data">data/ folder on GitHub</a> as plain text, updated by the scheduled job. Git history is the full record of every change.</p>
<ul>
<li><code>data/sources/&lt;source&gt;/rows.jsonl</code>: every row exactly as the source published it.</li>
<li><code>data/sources/&lt;source&gt;/history.jsonl</code>: every score that was added, changed or removed after the first import.</li>
<li><code>data/catalog/&lt;source&gt;.jsonl</code>: the models each catalogue feed describes (whatmodel.sh, models.dev, Epoch AI's models database, Hugging Face), merged into one catalogue in that order. <code>curation/models.yaml</code> adds to it and corrects it.</li>
<li><code>data/resolved/aliases.csv</code>: every name in every source, the model it was matched to, how, and the qualifiers set aside. <code>data/resolved/unlisted.csv</code>: the models not in the catalogue.</li>
<li><code>data/reports/unmatched.csv</code>: names not in the catalogue, most used first, with near misses to check. <code>data/reports/catalog-left-out.csv</code>: models a feed has that the merge left out, to add by hand where they are new.</li>
</ul>
<p>The files this site loads are also public: <a href="${u}data/index.json">index.json</a> and one <code>data/cells/&lt;source&gt;.json</code> per source.</p>
<h2>Licence</h2>
<p>The compilation (the selection, matching and arrangement) is licensed under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, because it builds on the whatmodel.sh compilation. Each source's scores keep that source's own licence, which every download carries on every row (<code>source_license</code>):</p>
<ul>${d.index.sources
    .filter((s) => s.terms === 'allowed')
    .map((s) => html`<li><a href="${u}sources/${s.id}/">${s.name}</a>: ${s.license ?? 'not recorded'}.${s.attribution ? html` ${sentence(s.attribution)}` : ''}${dataReuse(s.license) === 'licensed' ? '' : html` <strong>${REUSE_TEXT[dataReuse(s.license)]}</strong>`}</li>`)}</ul>
<p>llmbench is a non-commercial project. If you reuse the downloads commercially, leave out the rows from non-commercial sources (filter on <code>source_license</code>). If you run a source and want it credited differently or removed, <a href="https://github.com/jshahbazi/llmbench/issues">open an issue</a>.</p>
<p>No source endorses this project.</p>
`;
  return layout({ title: 'Data — llmbench', description: 'Where llmbench data lives, and its licences.', depth: 1, active: 'data', body, path: 'data/' });
}

export function sitemap(pages: readonly Page[]): string {
  const urls = pages.filter((p) => !p.path.endsWith('.html')).map((p) => `<url><loc>${SITE_URL}/${p.path}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
