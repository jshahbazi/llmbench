/**
 * The hand-edited files in curation/, applied whenever names are matched or the site is built, so an
 * edit takes effect on the next run without re-reading any source:
 *
 *   curation/aliases.csv   source,raw_name,model_id[,note]: send a source's name for a model to a
 *                          catalogue model. source "*" applies to every source; model_id "-" keeps
 *                          the name from being matched at all.
 *   curation/benchmarks.csv  column,benchmark[,note]: link a source's column to the benchmark it
 *                          measures, so columns from different sources that measure the same thing
 *                          are shown side by side.
 *   curation/models.yaml   models to add to the catalogue, or fields to correct on one already in it.
 *                          An entry with only the id of a model a catalogue feed left out (see
 *                          data/reports/catalog-left-out.csv) takes that feed's entry for it.
 *
 * The catalogue they apply to is merged from the catalogue feeds (lib/catalog.ts).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadFeeds, mergeCatalogs } from './catalog.ts';
import { loadSources } from './config.ts';
import { aliasMap, NO_MATCH, type Aliases } from './match.ts';
import { normalize } from './names.ts';
import { parseDelimited, tableToRecords, type Rec } from './parse.ts';
import { readJson, sourceDir } from './store.ts';
import type { CatalogModel, Metric, SourceConfig } from './types.ts';

export const ALIASES_PATH = join('curation', 'aliases.csv');
export const MODELS_PATH = join('curation', 'models.yaml');
export const BENCHMARKS_PATH = join('curation', 'benchmarks.csv');

const BENCHMARK_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** curation/benchmarks.csv (lines starting with "#" are comments): column id -> benchmark id. */
export function parseBenchmarkLinks(text: string | undefined): { links: Map<string, string>; problems: string[] } {
  const links = new Map<string, string>();
  const problems: string[] = [];
  if (!text) return { links, problems };
  const body = text
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  tableToRecords(parseDelimited(body)).forEach((r, i) => {
    const where = `${BENCHMARKS_PATH} row ${i + 1}`;
    const column = String(r['column'] ?? '').trim();
    const id = String(r['benchmark'] ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]*:./.test(column)) problems.push(`${where}: "column" must be <source>:<metric>`);
    else if (!BENCHMARK_ID.test(id)) problems.push(`${where} (${column}): "benchmark" must be lower case letters, digits, "-" and "."`);
    else if (links.has(column)) problems.push(`${where}: ${column} is listed twice`);
    else links.set(column, id);
  });
  return { links, problems };
}

export async function loadBenchmarkLinks(): Promise<Map<string, string>> {
  const { links, problems } = parseBenchmarkLinks(await readOptional(BENCHMARKS_PATH));
  if (problems.length) throw new Error(problems.join('\n'));
  return links;
}

/**
 * The benchmark each column measures: its line in curation/benchmarks.csv, else its metric id for a
 * source whose metric ids are benchmark ids (`benchmark_ids: true` in sources.yaml). Only benchmarks
 * two or more columns share are kept: a benchmark id is a link between columns.
 */
export function benchmarkOf(
  columns: ReadonlyArray<{ id: string; source: string; metric: string }>,
  links: ReadonlyMap<string, string>,
  idSources: ReadonlySet<string>,
): Map<string, string> {
  const raw = new Map<string, string>();
  for (const c of columns) {
    const b = links.get(c.id) ?? (idSources.has(c.source) ? c.metric : undefined);
    if (b) raw.set(c.id, b);
  }
  const count = new Map<string, number>();
  for (const b of raw.values()) count.set(b, (count.get(b) ?? 0) + 1);
  return new Map([...raw].filter(([, b]) => count.get(b)! >= 2));
}

const MODEL_FIELDS: Record<string, 'string' | 'number' | 'boolean'> = {
  id: 'string',
  name: 'string',
  provider: 'string',
  released: 'string',
  open_weights: 'boolean',
  license: 'string',
  params_b: 'number',
  active_b: 'number',
  context_k: 'number',
  model_repo: 'string',
  note: 'string',
};

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Reads curation/models.yaml into entries, with every problem found. */
export function parseModelsYaml(text: string | undefined): { entries: Array<Partial<CatalogModel> & { id: string }>; problems: string[] } {
  const problems: string[] = [];
  const entries: Array<Partial<CatalogModel> & { id: string }> = [];
  if (!text) return { entries, problems };
  const doc: unknown = parse(text);
  if (doc === null || doc === undefined) return { entries, problems };
  if (!Array.isArray(doc)) return { entries, problems: [`${MODELS_PATH}: expected a list of models`] };
  const seen = new Set<string>();
  doc.forEach((e: unknown, i: number) => {
    const where = `${MODELS_PATH}[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return problems.push(`${where}: expected a mapping`);
    const entry = e as Record<string, unknown>;
    const id = entry['id'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) return problems.push(`${where}: "id" must be lower case letters, digits, "-" and "."`);
    if (seen.has(id)) problems.push(`${where}: "${id}" is listed twice`);
    seen.add(id);
    const out: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(entry)) {
      const type = MODEL_FIELDS[k];
      if (!type) {
        problems.push(`${where} (${id}): unknown field "${k}"`);
        continue;
      }
      // YAML reads "released: 2025-11" as text, but a full date as text too; numbers stay numbers.
      const value = type === 'string' && typeof v === 'number' ? String(v) : v;
      if (typeof value !== type) problems.push(`${where} (${id}): "${k}" must be a ${type}`);
      else if (k !== 'note') out[k] = value;
    }
    if (typeof out['released'] === 'string' && !/^\d{4}(-\d{2}){0,2}$/.test(out['released'])) problems.push(`${where} (${id}): "released" must look like 2025-11`);
    entries.push(out as Partial<CatalogModel> & { id: string });
    return undefined;
  });
  return { entries, problems };
}

/** The catalogue feeds merged, before curation/models.yaml; `before` as in loadFeeds. */
export async function mergedFeeds(
  sources?: readonly SourceConfig[],
  before?: string,
): Promise<ReturnType<typeof mergeCatalogs>> {
  return mergeCatalogs(await loadFeeds(sources ?? (await loadSources()), before));
}

/**
 * The catalogue (every feed merged, with curation/models.yaml applied), the feeds' merge counts, and
 * the models the merge left out that curation did not take.
 */
export async function curatedCatalog(opts: { sources?: readonly SourceConfig[]; before?: string } = {}): Promise<ReturnType<typeof mergeCatalogs>> {
  const merged = await mergedFeeds(opts.sources, opts.before);
  const { entries, problems } = parseModelsYaml(await readOptional(MODELS_PATH));
  if (problems.length) throw new Error(problems.join('\n'));
  const catalog = applyModels(merged.catalog, entries, merged.leftOut);
  const ids = new Set(catalog.map((m) => m.id));
  const leftOut = new Map([...merged.leftOut].map(([source, models]) => [source, models.filter((m) => !ids.has(m.id))] as const));
  for (const [source, st] of merged.stats) st.left_out = leftOut.get(source)?.length ?? 0;
  return { catalog, stats: merged.stats, leftOut };
}

/** The catalogue: every feed merged (data/catalog/), with curation/models.yaml applied. */
export async function loadCatalog(opts: { sources?: readonly SourceConfig[]; before?: string } = {}): Promise<CatalogModel[]> {
  return (await curatedCatalog(opts)).catalog;
}

/**
 * curation/models.yaml applied to a catalogue: an entry for a catalogue model corrects its fields; a
 * new entry with a name adds a model; a new entry with only an id takes the model a feed left out
 * under that id (its fields then correct the feed's).
 */
export function applyModels(
  base: readonly CatalogModel[],
  entries: ReadonlyArray<Partial<CatalogModel> & { id: string }>,
  leftOut: ReadonlyMap<string, readonly CatalogModel[]> = new Map(),
): CatalogModel[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  const fromFeeds = new Map<string, CatalogModel>();
  for (const [source, models] of leftOut) for (const m of models) if (!fromFeeds.has(m.id)) fromFeeds.set(m.id, { ...m, origin: source });
  for (const e of entries) {
    const existing = byId.get(e.id) ?? (e.name ? undefined : fromFeeds.get(e.id));
    if (existing) byId.set(e.id, { ...existing, ...e });
    else if (e.name) byId.set(e.id, { category: 'llm', origin: 'curation', ...e, name: e.name });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function readAliasRows(): Promise<Rec[]> {
  const text = await readOptional(ALIASES_PATH);
  return text ? tableToRecords(parseDelimited(text)) : [];
}

export async function loadAliases(): Promise<Aliases> {
  return aliasMap(await readAliasRows());
}

/**
 * Problems in the curation files: unknown sources, models or columns, duplicates, new models without
 * names.
 */
export async function checkCuration(sources: readonly SourceConfig[]): Promise<string[]> {
  const sourceIds = sources.map((s) => s.id);
  const { catalog: base, leftOut } = await mergedFeeds(sources);
  const { entries, problems } = parseModelsYaml(await readOptional(MODELS_PATH));
  const known = new Set(base.map((m) => m.id));
  const leftOutIds = new Set([...leftOut.values()].flat().map((m) => m.id));
  const keys = new Map<string, string>();
  for (const m of base) for (const k of [normalize(m.id), normalize(m.name)]) keys.set(k, m.id);
  for (const e of entries) {
    if (known.has(e.id)) continue;
    // Taking a model a feed left out is a decision that it is not the catalogue model it resembles.
    if (!e.name && leftOutIds.has(e.id)) continue;
    if (!e.name) problems.push(`${MODELS_PATH}: new model "${e.id}" needs a "name", or the id of a model in data/reports/catalog-left-out.csv`);
    const same = keys.get(normalize(e.id)) ?? (e.name ? keys.get(normalize(e.name)) : undefined);
    if (same) problems.push(`${MODELS_PATH}: new model "${e.id}" looks like catalogue model "${same}"; correct that one instead`);
  }
  const ids = new Set(applyModels(base, entries, leftOut).map((m) => m.id));
  const sourceSet = new Set(sourceIds);
  const seen = new Set<string>();
  (await readAliasRows()).forEach((r, i) => {
    const where = `${ALIASES_PATH} line ${i + 2}`;
    const source = String(r['source'] ?? '').trim();
    const raw = String(r['raw_name'] ?? '');
    const id = String(r['model_id'] ?? '').trim();
    if (!source || !raw || !id) return problems.push(`${where}: needs source, raw_name and model_id`);
    if (source !== '*' && !sourceSet.has(source)) problems.push(`${where}: no source "${source}" in sources.yaml`);
    if (id !== NO_MATCH && !ids.has(id)) problems.push(`${where}: no model "${id}" in the catalogue or ${MODELS_PATH}`);
    const k = `${source}\u0000${raw}`;
    if (seen.has(k)) problems.push(`${where}: "${raw}" is listed twice for ${source}`);
    seen.add(k);
    return undefined;
  });
  const bench = parseBenchmarkLinks(await readOptional(BENCHMARKS_PATH));
  problems.push(...bench.problems);
  const metricIds = new Map<string, Set<string> | undefined>();
  for (const column of bench.links.keys()) {
    const source = column.slice(0, column.indexOf(':'));
    if (!sourceSet.has(source)) {
      problems.push(`${BENCHMARKS_PATH}: ${column}: no source "${source}" in sources.yaml`);
      continue;
    }
    if (!metricIds.has(source)) {
      const metrics = await readJson<Metric[]>(join(sourceDir(source), 'metrics.json'));
      metricIds.set(source, metrics && new Set(metrics.map((m) => m.id)));
    }
    // A source not fetched yet has no metrics to check against.
    const known = metricIds.get(source);
    if (known && !known.has(column.slice(source.length + 1))) problems.push(`${BENCHMARKS_PATH}: ${column}: ${source} has no such metric`);
  }
  return problems;
}
