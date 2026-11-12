/**
 * Turns data/ into the files the site loads, and copies the site's static files.
 *
 *   site/dist/data/index.json           sources, columns (one per source metric), models
 *   site/dist/data/cells/<source>.json  every score from that source, as compact tuples
 *
 * Model names are joined to the catalogue through data/resolved/aliases.csv (written by
 * `npm run resolve`). Names with no match become their own rows, flagged "unmatched".
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSources } from './lib/config.ts';
import { parseDelimited, tableToRecords } from './lib/parse.ts';
import { parseScore } from './lib/scores.ts';
import { CATALOG_PATH, readJson, readJsonl, readRows, readRunCache, readState, sourceDir } from './lib/store.ts';
import type { CatalogModel, Metric, RunBy } from './lib/types.ts';

const OUT = join('site', 'dist');
const RUN_BY_CODE: Record<RunBy, number> = { independent: 0, submitted: 1, lab: 2 };

interface SiteColumn {
  id: string;
  source: string;
  metric: string;
  label: string;
  direction: Metric['direction'];
  unit: string;
  headline: boolean;
  category?: string;
  family?: string;
  url?: string;
  description?: string;
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
  /** Set for names no catalogue model matched: the source they came from. */
  unmatched?: string;
}

async function resolved(): Promise<Map<string, { modelId: string; qualifiers: string }>> {
  const out = new Map<string, { modelId: string; qualifiers: string }>();
  let text: string;
  try {
    text = await readFile(join('data', 'resolved', 'aliases.csv'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('data/resolved/aliases.csv not found; run `npm run resolve` first. Every name will be unmatched.');
      return out;
    }
    throw e;
  }
  for (const r of tableToRecords(parseDelimited(text))) {
    out.set(`${r['source']}\u0000${r['raw_name']}`, { modelId: String(r['model_id']), qualifiers: String(r['qualifiers'] ?? '') });
  }
  return out;
}

const sources = await loadSources();
const catalog = await readJsonl<CatalogModel>(CATALOG_PATH);
const byId = new Map(catalog.map((m) => [m.id, m]));
const aliases = await resolved();
const runs = await readRunCache();

const models: SiteModel[] = [];
const modelIndex = new Map<string, number>();

function modelFor(sourceId: string, raw: string): { index: number; qualifiers: string } {
  const hit = aliases.get(`${sourceId}\u0000${raw}`);
  const cat = hit ? byId.get(hit.modelId) : undefined;
  const id = cat ? cat.id : `unmatched:${sourceId}:${raw}`;
  let i = modelIndex.get(id);
  if (i === undefined) {
    const m: SiteModel = cat
      ? {
          id: cat.id,
          name: cat.name,
          provider: cat.provider,
          released: cat.released,
          open_weights: cat.open_weights,
          license: cat.license,
          params_b: cat.params_b,
          active_b: cat.active_b,
          model_repo: cat.model_repo,
        }
      : { id, name: raw, unmatched: sourceId };
    i = models.push(m) - 1;
    modelIndex.set(id, i);
  }
  return { index: i, qualifiers: cat ? hit!.qualifiers : '' };
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'data', 'cells'), { recursive: true });

const columns: SiteColumn[] = [];
const siteSources: Array<Record<string, unknown>> = [];
let invalidExcluded = 0;
let unparsable = 0;

for (const s of sources) {
  const state = await readState(s.id);
  const run = runs[s.id];
  siteSources.push({
    id: s.id,
    name: s.name,
    homepage: s.homepage,
    terms: s.terms,
    terms_note: s.terms_note,
    license: s.license,
    attribution: s.attribution,
    every: s.every,
    row_count: state?.row_count ?? 0,
    upstream_revision: state?.upstream_revision,
    changed_at: state?.changed_at,
    checked_at: run?.checked_at,
    outcome: run?.outcome,
    reasons: run?.outcome === 'held' || run?.outcome === 'failed' ? run.reasons : undefined,
  });
  if (!state) continue;

  const rows = await readRows(s.id);
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
      headline: m.headline !== false,
      category: m.category,
      family: m.family,
      url: m.url,
      description: m.description,
    });
  }

  const urls: string[] = [];
  const urlIndex = new Map<string, number>();
  // [model, column, value, runBy, date, context, url index, interval]
  const cells: Array<[number, number, number, number, string, string, number, string]> = [];
  for (const r of rows) {
    if (r.extra && typeof r.extra['invalid'] === 'string') {
      invalidExcluded++;
      continue;
    }
    const { index: mi, qualifiers } = modelFor(s.id, r.model);
    const runBy = RUN_BY_CODE[r.run_by ?? s.run_by];
    const link = r.upstream_url ?? r.model_url;
    let ui = -1;
    if (link) {
      ui = urlIndex.get(link) ?? -1;
      if (ui < 0) {
        ui = urls.push(link) - 1;
        urlIndex.set(link, ui);
      }
    }
    const context = [...Object.values(r.context ?? {}), ...(qualifiers ? qualifiers.split('; ') : [])].join(' · ');
    for (const [metric, raw] of Object.entries(r.scores)) {
      const ci = colIndex.get(metric);
      const value = parseScore(raw);
      if (ci === undefined || value === null) {
        unparsable++;
        continue;
      }
      const interval = r.ci?.[metric];
      cells.push([mi, ci, value, runBy, r.date?.slice(0, 10) ?? '', context, ui, interval ? `${interval[0]}–${interval[1]}` : '']);
    }
  }
  await writeFile(join(OUT, 'data', 'cells', `${s.id}.json`), JSON.stringify({ source: s.id, urls, cells }));
  console.log(`- ${s.id}: ${cells.length} scores, ${metrics.length} columns`);
}

const unmatchedModels = models.filter((m) => m.unmatched).length;
const index = {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  sources: siteSources,
  columns,
  models,
  stats: { invalid_excluded: invalidExcluded, unparsable, unmatched_models: unmatchedModels },
};
await writeFile(join(OUT, 'data', 'index.json'), JSON.stringify(index));
await cp(join('site', 'static'), OUT, { recursive: true });

console.log(
  `site/dist: ${models.length} models (${unmatchedModels} unmatched names), ${columns.length} columns, ` +
    `${invalidExcluded} results excluded as flagged invalid upstream, ${unparsable} unparsable`,
);
