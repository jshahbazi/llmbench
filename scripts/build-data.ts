/**
 * Turns data/ into the files the site loads, and copies the site's static files.
 *
 *   site/dist/data/index.json          sources, columns (one per source metric), models
 *   site/dist/data/cells/<source>.json  every score from that source, as compact tuples
 *
 * Phase 0 matching: a raw model name matches a catalogue model when it equals the model's id or,
 * ignoring case, its name. Everything else is kept as its own "unmatched" row.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSources } from './lib/config.ts';
import { parseScore } from './lib/scores.ts';
import { CACHE_DIR, CATALOG_PATH, readJson, readJsonl, sourceDir } from './lib/store.ts';
import type { CatalogModel, Metric, Row, RunBy, SourceState } from './lib/types.ts';

const OUT = join('site', 'dist');
const RUN_BY_CODE: Record<RunBy, number> = { independent: 0, submitted: 1, lab: 2 };

interface SiteColumn {
  id: string;
  source: string;
  metric: string;
  label: string;
  direction: Metric['direction'];
  unit: string;
  category?: string;
  family?: string;
  url?: string;
}

interface SiteModel {
  id: string;
  name: string;
  provider?: string;
  released?: string;
  open_weights?: boolean;
  license?: string;
  params_b?: number;
  active_b?: number;
  model_repo?: string;
  unmatched?: true;
}

const sources = await loadSources();
const catalog = await readJsonl<CatalogModel>(CATALOG_PATH);
const lastRun = (await readJson<Record<string, { checked_at: string; outcome: string }>>(join(CACHE_DIR, 'last-run.json'))) ?? {};

const models: SiteModel[] = [];
const modelIndex = new Map<string, number>();
const byId = new Map(catalog.map((m) => [m.id, m]));
const byName = new Map(catalog.map((m) => [m.name.toLowerCase(), m]));

function modelFor(sourceId: string, raw: string): number {
  const hit = byId.get(raw) ?? byName.get(raw.toLowerCase());
  const id = hit ? hit.id : `unmatched:${sourceId}:${raw}`;
  let i = modelIndex.get(id);
  if (i !== undefined) return i;
  const m: SiteModel = hit
    ? {
        id: hit.id,
        name: hit.name,
        provider: hit.provider,
        released: hit.released,
        open_weights: hit.open_weights,
        license: hit.license,
        params_b: hit.params_b,
        active_b: hit.active_b,
        model_repo: hit.model_repo,
      }
    : { id, name: raw, unmatched: true };
  i = models.push(m) - 1;
  modelIndex.set(id, i);
  return i;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'data', 'cells'), { recursive: true });

const columns: SiteColumn[] = [];
const siteSources: Array<Record<string, unknown>> = [];
let invalidExcluded = 0;
let unparsable = 0;

for (const s of sources) {
  const state = await readJson<SourceState>(join(sourceDir(s.id), 'state.json'));
  siteSources.push({
    id: s.id,
    name: s.name,
    homepage: s.homepage,
    terms: s.terms,
    terms_note: s.terms_note,
    license: s.license,
    attribution: s.attribution,
    row_count: state?.row_count ?? 0,
    status: state?.status ?? (s.terms === 'allowed' ? 'pending' : 'blocked'),
    upstream_revision: state?.upstream_revision,
    changed_at: state?.changed_at,
    checked_at: lastRun[s.id]?.checked_at,
  });
  if (!state) continue;

  const rows = await readJsonl<Row>(join(sourceDir(s.id), 'rows.jsonl'));
  const metrics = (await readJson<Metric[]>(join(sourceDir(s.id), 'metrics.json'))) ?? [];
  const colIndex = new Map<string, number>();
  for (const m of metrics) {
    colIndex.set(m.id, columns.length);
    columns.push({
      id: `${s.id}:${m.id}`,
      source: s.id,
      metric: m.id,
      label: m.label,
      direction: m.direction,
      unit: m.unit,
      category: m.category,
      family: m.family,
      url: m.url,
    });
  }

  const urls: string[] = [];
  const urlIndex = new Map<string, number>();
  const cells: Array<[number, number, number, number, string, string, number]> = [];
  for (const r of rows) {
    if (r.extra && typeof r.extra['invalid'] === 'string') {
      invalidExcluded++;
      continue;
    }
    const mi = modelFor(s.id, r.model);
    const runBy = RUN_BY_CODE[r.run_by ?? s.run_by];
    let ui = -1;
    if (r.upstream_url) {
      ui = urlIndex.get(r.upstream_url) ?? -1;
      if (ui < 0) {
        ui = urls.push(r.upstream_url) - 1;
        urlIndex.set(r.upstream_url, ui);
      }
    }
    for (const [metric, raw] of Object.entries(r.scores)) {
      const ci = colIndex.get(metric);
      const value = parseScore(raw);
      if (ci === undefined || value === null) {
        unparsable++;
        continue;
      }
      cells.push([mi, ci, value, runBy, r.date ?? '', r.context ? Object.values(r.context).join(' · ') : '', ui]);
    }
  }
  await writeFile(join(OUT, 'data', 'cells', `${s.id}.json`), JSON.stringify({ source: s.id, urls, cells }));
  console.log(`- ${s.id}: ${cells.length} scores, ${metrics.length} columns`);
}

const index = {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  sources: siteSources,
  columns,
  models,
  stats: { invalid_excluded: invalidExcluded, unparsable, unmatched_models: models.filter((m) => m.unmatched).length },
};
await writeFile(join(OUT, 'data', 'index.json'), JSON.stringify(index));
await cp(join('site', 'static'), OUT, { recursive: true });

console.log(
  `site/dist: ${models.length} models (${index.stats.unmatched_models} unmatched), ${columns.length} columns, ` +
    `${invalidExcluded} results excluded as flagged invalid upstream, ${unparsable} unparsable`,
);
