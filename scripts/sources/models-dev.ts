/**
 * models.dev (MIT, github.com/anomalyco/models.dev): an open database of AI models, updated most
 * days. Its models.json describes each model apart from where it is served: name, maker, release
 * date, open weights, licence, context window and links to the weights. It is a catalogue feed (it
 * adds models and fills in fields), and a source of model makers' own benchmark scores.
 *
 * Kept: text-in, text-out models with no specialised type (image, speech, embedding, reranking...).
 * Maker names come from api.json, where a lab that serves its own models is also a provider.
 *
 * Scores: each model lists benchmark results with the page they came from. Only a model maker's own
 * report counts (run by "lab"): the source must be one of that maker's sites or Hugging Face or
 * GitHub organisations (MAKER_SOURCES). Left out: scores from other places (Artificial Analysis,
 * Scale's leaderboard, OpenRouter, aggregators, leaderboards llmbench reads directly, another
 * maker's comparison), and benchmarks that are Artificial Analysis's (AA-*, *-AA, its indexes,
 * GDPval Elo). A maker missing from MAKER_SOURCES is reported in the run's warnings.
 */
import { licenseId } from '../lib/catalog.ts';
import { fetchJson, fetchOk } from '../lib/http.ts';
import { slugifyModel } from '../lib/match.ts';
import { sha256 } from '../lib/store.ts';
import type { CatalogModel, Metric, Plugin, Row } from '../lib/types.ts';

export interface MdModel {
  id: string;
  name: string;
  type?: string;
  release_date?: string;
  open_weights?: boolean;
  license?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  weights?: Array<{ label?: string; url?: string }>;
  benchmarks?: MdScore[];
}

export interface MdScore {
  name: string;
  score: number;
  source?: string;
  metric?: string;
  variant?: string;
  version?: string;
  dataset?: string;
  harness?: string;
  date?: string;
}

/**
 * Where each maker publishes its own results: hosts (a subdomain counts), "hf:<org>" for a Hugging
 * Face organisation and "gh:<org>" for a GitHub one. Keyed by models.dev's lab id.
 */
export const MAKER_SOURCES: Record<string, readonly string[]> = {
  alibaba: ['qwen.ai', 'alibabacloud.com', 'qwenlm.github.io', 'hf:qwen'],
  anthropic: ['anthropic.com', 'claude.com'],
  cohere: ['cohere.com', 'hf:coherelabs', 'hf:cohereforai'],
  deepreinforce: ['hf:deepreinforce-ai'],
  deepseek: ['deepseek.com', 'hf:deepseek-ai'],
  google: ['blog.google', 'deepmind.google', 'ai.google.dev', 'hf:google'],
  inclusionai: ['hf:inclusionai'],
  lightonai: ['lighton.ai', 'hf:lightonai'],
  meituan: ['gh:meituan-longcat', 'hf:meituan-longcat'],
  meta: ['ai.meta.com', 'research.meta.ai', 'hf:meta-models', 'hf:meta-llama'],
  microsoft: ['microsoft.ai', 'microsoft.com', 'hf:microsoft'],
  minimax: ['minimax.io', 'hf:minimaxai'],
  mistral: ['mistral.ai', 'hf:mistralai'],
  moonshotai: ['kimi.com', 'moonshot.ai', 'hf:moonshotai'],
  nvidia: ['nvidia.com', 'hf:nvidia'],
  openai: ['openai.com'],
  poolside: ['poolside.ai'],
  reflection: ['reflection.ai', 'hf:reflection'],
  sakana: ['sakana.ai'],
  stepfun: ['stepfun.com', 'hf:stepfun-ai'],
  tencent: ['tencent.com', 'hf:tencent'],
  thinkingmachines: ['thinkingmachines.ai'],
  xai: ['x.ai'],
  xiaomi: ['mimo.xiaomi.com', 'hf:xiaomimimo'],
  zhipuai: ['z.ai', 'zhipuai.cn', 'hf:zai-org'],
};

const MODELS_URL = 'https://models.dev/models.json';
const API_URL = 'https://models.dev/api.json';

const isText = (m: MdModel) => !m.type && (m.modalities?.input ?? []).includes('text') && (m.modalities?.output ?? []).includes('text');

/** The lab's name as a provider in api.json, else its id ("thinkingmachines"). */
const labName = (lab: string, names: ReadonlyMap<string, string>) => names.get(lab) ?? names.get(`${lab}-ai`) ?? lab;

export function catalogFrom(doc: Record<string, MdModel>, labNames: ReadonlyMap<string, string>): CatalogModel[] {
  const out = new Map<string, CatalogModel>();
  for (const [key, m] of Object.entries(doc)) {
    if (!isText(m) || !m.name) continue;
    const slash = key.indexOf('/');
    const lab = slash > 0 ? key.slice(0, slash) : '';
    const id = slugifyModel(slash > 0 ? key.slice(slash + 1) : key);
    if (!id || out.has(id)) continue; // two labs with one model id: the first (in key order) is kept
    const repo = m.weights?.map((w) => w.url).find((u) => u && /^https:\/\/huggingface\.co\/[^/]+\/[^/?#]+/.test(u));
    const license = licenseId(m.license);
    const context = m.limit?.context;
    out.set(id, {
      id,
      // A few names are written like ids with a maker ("X-Ai/Grok-4-Fast-Reasoning").
      name: m.name.slice(m.name.lastIndexOf('/') + 1).trim(),
      category: 'llm',
      origin: 'models-dev',
      ...(lab && { provider: labName(lab, labNames) }),
      ...(m.release_date && /^\d{4}-\d{2}/.test(m.release_date) && { released: m.release_date }),
      ...(typeof m.open_weights === 'boolean' && { open_weights: m.open_weights }),
      ...(license && { license }),
      ...(typeof context === 'number' && context > 0 && { context_k: context / 1000 }),
      ...(repo && { model_repo: repo }),
    });
  }
  return [...out.values()];
}

/** "hf:<org>", "gh:<org>" or the host (without "www."), for comparing with MAKER_SOURCES. */
export function placeOf(url: string | undefined): string {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const org = u.pathname.split('/')[1]?.toLowerCase() ?? '';
  if (host === 'huggingface.co') return `hf:${org}`;
  if (host === 'github.com') return `gh:${org}`;
  return host;
}

/** True when the url is one of the maker's own places. */
export function fromMaker(lab: string, url: string | undefined): boolean {
  const place = placeOf(url);
  return (MAKER_SOURCES[lab] ?? []).some((p) => place === p || (!p.includes(':') && place.endsWith(`.${p}`)));
}

/** Artificial Analysis's own benchmarks and indexes, which llmbench leaves out (its terms). */
const isAA = (s: MdScore) => /artificial analysis|\bAA-|-AA\b/i.test(s.name) || (/gdpval/i.test(s.name) && /\belo\b/i.test(s.metric ?? ''));

const WITH_TOOLS = /\bwith (tools|code interpreter|search|python)\b/i;
const NO_TOOLS = /\b(no|without) (tools|code interpreter|search|python)\b/i;

/** Metrics that are a scale of their own, and so a column of their own. */
const SCALES: ReadonlyArray<{ re: RegExp; unit: string; direction?: 'lower' }> = [
  { re: /\belo\b/i, unit: 'elo' },
  { re: /\brating\b/i, unit: 'rating' },
  { re: /usd|\$|dollar|balance/i, unit: 'USD' },
  { re: /edit distance/i, unit: 'score', direction: 'lower' },
  { re: /tasks solved/i, unit: 'tasks' },
];

/** "v2" and "2.0" as "2", "v1.1" as "1.1". */
const versionOf = (v: string | undefined) => v?.trim().replace(/^v(?=\d)/i, '').replace(/^(\d+)\.0$/, '$1') || undefined;
/** "text-only subset" as "text-only". */
const datasetOf = (d: string | undefined) => d?.trim().replace(/\b(subset|set|split)\b/gi, '').replace(/\s+/g, ' ').replace(/[\s,;]+$/, '').trim() || undefined;

/** Metric names that only say "the score": not worth keeping as context. */
const PLAIN_METRIC = /^(score|accuracy|acc|percent|%|pass@1|resolved|resolve rate|percent resolved|percent correct|success rate|pass rate)$/i;

export interface ScoreColumn {
  id: string;
  label: string;
  unit?: string;
  direction: 'higher' | 'lower';
  /** The metric name, when it is a scale of its own and so not part of the context. */
  metric?: string;
}

/**
 * The column a score goes in: the benchmark, its version and subset, with or without tools, and the
 * metric where it is a scale of its own. How the model was run (effort, harness, the metric's
 * name otherwise) is context, not a column.
 */
export function columnOf(s: MdScore): ScoreColumn {
  let name = s.name.trim();
  let version = versionOf(s.version);
  // "Terminal-Bench 2.1" or "LiveCodeBench v6" with no version is the benchmark at that version.
  // A bare year ("AIME 2025") is part of the name.
  const trailing = /^(.*\S)[\s-]+(?:v(\d+(?:\.\d+)*)|(\d+\.\d+))$/i.exec(name);
  if (!version && trailing) {
    name = trailing[1]!;
    version = versionOf(trailing[2] ?? trailing[3]);
  }
  const dataset = datasetOf(s.dataset);
  const tools = WITH_TOOLS.test(s.variant ?? '');
  const scale = SCALES.find((x) => x.re.test(s.metric ?? ''));
  const slugName = name.replace(/['’]/g, '').replace(/τ²/g, 'tau2').replace(/τ³/g, 'tau3');
  const id = [slugifyModel(slugName), version && `v${version}`, dataset && slugifyModel(dataset), tools && 'with-tools', scale && slugifyModel(s.metric!)]
    .filter(Boolean)
    .join('/');
  // Shown "2.0" where the id says "v2", as most benchmarks write their versions.
  const shown = version && /^\d+$/.test(version) ? `${version}.0` : version;
  const label = `${name}${shown ? ` ${shown}` : ''}${dataset ? ` (${dataset})` : ''}${tools ? ', with tools' : ''}${scale ? ` ${s.metric}` : ''}`;
  return { id, label, direction: scale?.direction ?? 'higher', ...(scale && { unit: scale.unit, metric: s.metric }) };
}

/** Model makers' own scores from models.json, as rows and metrics, with what was left out. */
export function scoresFrom(doc: Record<string, MdModel>): { rows: Row[]; metrics: Metric[]; warnings: string[] } {
  const rows: Row[] = [];
  const columns = new Map<string, ScoreColumn & { values: number[]; models: Set<string> }>();
  const unknownMakers = new Map<string, number>();
  for (const [key, m] of Object.entries(doc)) {
    if (!isText(m) || !m.name) continue;
    const lab = key.slice(0, key.indexOf('/'));
    for (const s of m.benchmarks ?? []) {
      if (typeof s.score !== 'number' || !Number.isFinite(s.score) || !s.name || isAA(s)) continue;
      if (!fromMaker(lab, s.source)) {
        if (!MAKER_SOURCES[lab]) unknownMakers.set(lab, (unknownMakers.get(lab) ?? 0) + 1);
        continue;
      }
      const col = columnOf(s);
      const entry = columns.get(col.id) ?? { ...col, values: [], models: new Set<string>() };
      entry.values.push(s.score);
      entry.models.add(key);
      columns.set(col.id, entry);
      const setting = (s.variant ?? '').replace(WITH_TOOLS, '').replace(NO_TOOLS, '').replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/\s*[,;]\s*[,;]\s*/g, '; ');
      const context: Record<string, string> = {
        ...(setting && { setting }),
        ...(s.harness && { harness: s.harness }),
        ...(s.metric && !col.metric && !PLAIN_METRIC.test(s.metric.trim()) && { metric: s.metric }),
      };
      rows.push({
        key: `${key}|${col.id}|${sha256(JSON.stringify([context, s.source ?? '', s.date ?? ''])).slice(0, 8)}`,
        model: key,
        model_label: m.name.slice(m.name.lastIndexOf('/') + 1).trim(),
        ...(Object.keys(context).length && { context }),
        ...(s.date && /^\d{4}-\d{2}/.test(s.date) && { date: s.date }),
        scores: { [col.id]: s.score },
        run_by: 'lab',
        ...(s.source && { upstream_url: s.source }),
      });
    }
  }
  // The same report listed twice is one row; two different numbers under one key stay apart.
  const unique = new Map<string, Row>();
  for (const r of rows) {
    const value = Object.values(r.scores)[0];
    let key = r.key;
    for (let n = 2; unique.has(key) && Object.values(unique.get(key)!.scores)[0] !== value; n++) key = `${r.key}~${n}`;
    if (!unique.has(key)) unique.set(key, { ...r, key });
  }
  const metrics: Metric[] = [...columns.values()].map((c) => ({
    id: c.id,
    label: c.label,
    direction: c.direction,
    unit: c.unit ?? (c.values.every((v) => v >= 0 && v <= 100) ? 'percent' : 'score'),
    headline: c.models.size >= 3,
  }));
  const warnings = [...unknownMakers].map(([lab, n]) => `${n} scores for models by "${lab}" left out: no sites listed for that maker in MAKER_SOURCES (scripts/sources/models-dev.ts)`);
  return { rows: [...unique.values()], metrics, warnings };
}

const modelsDev: Plugin = async ({ source, previous, cache, force }) => {
  const headers: Record<string, string> = {};
  if (!force && previous && cache?.etag) headers['if-none-match'] = cache.etag;
  const res = await fetchOk(source.fetch ?? MODELS_URL, { headers });
  if (res.status === 304) return 'unchanged';
  const doc = (await res.json()) as Record<string, MdModel>;
  const providers = await fetchJson<Record<string, { name?: string }>>(String(source.options['providers'] ?? API_URL));
  const labNames = new Map(Object.entries(providers).flatMap(([id, p]) => (p.name ? [[id, p.name] as const] : [])));
  const catalog = catalogFrom(doc, labNames);
  const { rows, metrics, warnings } = scoresFrom(doc);
  if (catalog.length < Object.keys(doc).length / 4) warnings.push(`only ${catalog.length} of ${Object.keys(doc).length} models are text models`);
  return { etag: res.headers.get('etag') ?? undefined, rows, metrics, catalog, ...(warnings.length && { warnings }) };
};

export default modelsDev;
