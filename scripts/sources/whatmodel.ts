/**
 * whatmodel.sh (github.com/jakemanger/whatmodel): an open compilation of published results.
 *
 * Reads data/results.json, models.json, benchmarks.json and sources.json at one pinned commit.
 * Each result becomes one row (long form: one score per row). The model catalogue is seeded from
 * models.json, and the licence of every upstream source a row cites is kept alongside.
 *
 * Options in sources.yaml:
 *   categories: model categories to import (default [llm]). whatmodel also covers image, video,
 *               tts, stt and decision models.
 */
import { createHash } from 'node:crypto';
import { githubFile, latestCommit, parseGithubRef } from '../lib/http.ts';
import {
  RUN_BY,
  type CatalogModel,
  type ExtractResult,
  type Metric,
  type Plugin,
  type Row,
  type RunBy,
  type UpstreamSource,
} from '../lib/types.ts';

export interface WmResult {
  model: string;
  bench: string;
  score: number;
  source: string;
  by: string;
  date?: string;
  mode?: string;
  source_id?: string;
  [extra: string]: unknown;
}

export interface WmModel {
  id: string;
  name: string;
  provider?: string;
  category?: string;
  released?: string;
  open_weights?: boolean;
  license?: string;
  params_b?: number;
  active_b?: number;
  context_k?: number;
  model_repo?: string;
}

export interface WmBench {
  id: string;
  name: string;
  kind: string;
  category?: string;
  direction?: string;
  unit?: string;
  url?: string;
  description?: string;
  family?: unknown;
  benchmark_family?: unknown;
}

interface WmSource {
  id: string;
  name?: string;
  kind?: string;
  license?: string;
  license_url?: string;
  terms_url?: string;
  attribution?: string;
  verdict?: string;
}

const modelCategory = (m: WmModel | undefined): string => m?.category ?? 'llm';

/** whatmodel's benchmark kinds: acc and err are 0-1 fractions, elo is a rating, linear is anything else. */
export function metricFromBench(b: WmBench): Metric {
  const direction: Metric['direction'] =
    b.direction === 'lower' || b.direction === 'higher' ? b.direction : b.kind === 'err' ? 'lower' : 'higher';
  const unit = b.kind === 'acc' || b.kind === 'err' ? 'fraction' : b.kind === 'elo' ? 'elo' : (b.unit ?? 'score');
  const family = typeof b.benchmark_family === 'string' ? b.benchmark_family : typeof b.family === 'string' ? b.family : undefined;
  const m: Metric = { id: b.id, label: b.name, direction, unit };
  if (b.category) m.category = b.category;
  if (family) m.family = family;
  if (b.url) m.url = b.url;
  if (b.description) m.description = b.description;
  return m;
}

const COMMIT_SHA = /\b[0-9a-f]{40}\b/g;

/**
 * Stable row keys. (model, benchmark, upstream source, mode) is unique for almost every row; the few
 * collisions are told apart by a hash of the source URL with any pinned commit id removed, so a
 * re-pinned URL keeps its key.
 */
export function rowKeys(results: readonly WmResult[]): string[] {
  const base = results.map((r) => [r.model, r.bench, r.source_id ?? '-', r.mode ?? '-'].join('|'));
  const counts = new Map<string, number>();
  for (const k of base) counts.set(k, (counts.get(k) ?? 0) + 1);
  return results.map((r, i) => {
    const k = base[i]!;
    if (counts.get(k)! === 1) return k;
    const h = createHash('sha256').update(r.source.replace(COMMIT_SHA, '')).digest('hex').slice(0, 8);
    return `${k}#${h}`;
  });
}

export function toRow(r: WmResult, key: string): Row {
  const { model, bench, score, source, by, date, mode, source_id, ...rest } = r;
  const extra: Record<string, unknown> = { ...rest };
  const row: Row = { key, model, scores: { [bench]: score } };
  if (mode !== undefined) row.context = { mode: String(mode) };
  if (date) row.date = date;
  if (RUN_BY.includes(by as RunBy)) row.run_by = by as RunBy;
  else extra['by'] = by;
  row.upstream_url = source;
  if (source_id) row.upstream_source = source_id;
  if (Object.keys(extra).length) row.extra = extra;
  // Fixed property order keeps the committed JSON byte-stable.
  return {
    key: row.key,
    model: row.model,
    ...(row.context && { context: row.context }),
    ...(row.date && { date: row.date }),
    scores: row.scores,
    ...(row.run_by && { run_by: row.run_by }),
    upstream_url: row.upstream_url,
    ...(row.upstream_source && { upstream_source: row.upstream_source }),
    ...(row.extra && { extra: row.extra }),
  };
}

export function toCatalogModel(m: WmModel): CatalogModel {
  const out: CatalogModel = { id: m.id, name: m.name, category: modelCategory(m), origin: 'whatmodel' };
  if (m.provider) out.provider = m.provider;
  if (m.released) out.released = m.released;
  if (typeof m.open_weights === 'boolean') out.open_weights = m.open_weights;
  if (m.license) out.license = m.license;
  if (typeof m.params_b === 'number') out.params_b = m.params_b;
  if (typeof m.active_b === 'number') out.active_b = m.active_b;
  if (typeof m.context_k === 'number') out.context_k = m.context_k;
  if (m.model_repo) out.model_repo = m.model_repo;
  return out;
}

/** Pure transform from whatmodel's files to our rows, metrics and catalogue. */
export function transform(
  input: { results: WmResult[]; models: WmModel[]; benchmarks: WmBench[]; sources: WmSource[] },
  categories: readonly string[],
): Omit<ExtractResult, 'revision' | 'revisionDate'> {
  const wanted = new Set(categories);
  const modelsById = new Map(input.models.map((m) => [m.id, m]));
  const results = input.results.filter((r) => wanted.has(modelCategory(modelsById.get(r.model))));
  const keys = rowKeys(results);
  const rows = results.map((r, i) => toRow(r, keys[i]!));

  const benchIds = new Set(results.map((r) => r.bench));
  const metrics = input.benchmarks.filter((b) => benchIds.has(b.id)).map(metricFromBench);
  const missing = [...benchIds].filter((id) => !metrics.some((m) => m.id === id));
  for (const id of missing) metrics.push({ id, label: id, direction: 'higher', unit: 'score' });

  const catalog = input.models.filter((m) => wanted.has(modelCategory(m))).map(toCatalogModel);

  const cited = new Set(results.map((r) => r.source_id).filter((s): s is string => !!s));
  const upstreamSources: UpstreamSource[] = input.sources
    .filter((s) => cited.has(s.id))
    .map((s) => {
      const u: UpstreamSource = { id: s.id };
      for (const k of ['name', 'kind', 'license', 'license_url', 'terms_url', 'attribution', 'verdict'] as const) {
        if (s[k]) u[k] = s[k];
      }
      return u;
    });

  return { rows, metrics, catalog, upstreamSources };
}

const whatmodel: Plugin = async ({ source, previous, force }) => {
  const { owner, repo, path } = parseGithubRef(source.fetch ?? 'github:jakemanger/whatmodel/data');
  const head = await latestCommit(owner, repo, path);
  if (!force && previous?.upstream_revision === head.sha) return 'unchanged';

  const load = async <T>(file: string): Promise<T> =>
    (await (await githubFile(owner, repo, head.sha, `${path}/${file}`)).json()) as T;
  const [results, models, benchmarks, sources] = await Promise.all([
    load<WmResult[]>('results.json'),
    load<WmModel[]>('models.json'),
    load<WmBench[]>('benchmarks.json'),
    load<WmSource[]>('sources.json'),
  ]);

  const opt = source.options['categories'];
  const categories = Array.isArray(opt) && opt.every((c) => typeof c === 'string') ? opt : ['llm'];
  return { revision: head.sha, revisionDate: head.date, ...transform({ results, models, benchmarks, sources }, categories) };
};

export default whatmodel;
