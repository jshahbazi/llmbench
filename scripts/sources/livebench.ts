/**
 * LiveBench (livebench.ai): a contamination-limited benchmark whose questions are replaced at each
 * release. The site serves every release as static files, which are read here directly; the GitHub
 * copy (LiveBench/livebench.github.io) stopped being updated in mid-2026. No licence is stated; the
 * scores are reproduced as factual results with credit.
 *
 * Two generations:
 *   LiveBench 1.0  v1/table_<date>.csv (model x task) and v1/categories_<date>.json (category ->
 *                  tasks). Releases 2024-06-24 to 2026-06-25.
 *   LiveBench 2.0  data/<yyyymmdd>/table.csv (model x suite), categories.json (suite -> columns,
 *                  plus "_overall_weights") and cost.csv (cost and task count per suite).
 *
 * The release lists, and each model's display name, maker link and reasoning effort, are only in
 * the site's script, so they are read from it; if the release lists cannot be found the run is held
 * rather than guessed. Releases use different questions, so each release gets
 * its own columns:
 *   v1/<date>/<task>, v1/<date>/<category> (mean of its tasks), v1/<date>/global
 *   v2/<date>/<suite>, v2/<date>/overall, v2/<date>/cost_per_task
 * The averages and the cost are not in the files: the site computes them in the browser ("Overall
 * and everything derived from it are computed in the browser, never stored"), and they are
 * computed here the same way: a category is the mean of its task scores; Overall is the mean of
 * the categories, weighted by "_overall_weights" (default 1), and only when every category has a
 * score; cost per task is total cost over total tasks across the suites. Only the newest 2.0
 * release is a headline.
 */
import { orderRow } from '../lib/extract.ts';
import { fetchOk } from '../lib/http.ts';
import { parseDelimited, tableToRecords } from '../lib/parse.ts';
import type { ExtractResult, Metric, Plugin, Row, Value } from '../lib/types.ts';

const TAGS: Record<string, string[]> = { coding: ['coding'], agentic_coding: ['coding', 'agents'], mathematics: ['math'], long_agentic: ['agents'], browser: ['agents'], research: ['search'] };

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/^if$/, 'instruction_following')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
const round = (x: number) => Math.round(x * 1000) / 1000;
const isoDate = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

export interface Release {
  gen: 'v1' | 'v2';
  /** As the site writes it: 2026-06-25 (1.0) or 20261106 (2.0). */
  id: string;
  /** category name -> its columns, plus an optional "_overall_weights" map */
  categories: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  cost?: Array<Record<string, unknown>>;
  url: string;
}

/** The release lists in the site's script, and the data version it appends to every file URL. */
export function releasesFromScript(js: string): { v1: string[]; v2: string[]; version?: string; problems: string[] } {
  const problems: string[] = [];
  const v1m = /\[((?:"\d{4}-\d{2}-\d{2}",?)+)\]\.map\(\w+=>\(\{id:\w+,label:\w+,gen:"v1"\}\)\)/.exec(js);
  const v1 = v1m ? [...v1m[1]!.matchAll(/"([\d-]+)"/g)].map((m) => m[1]!) : [];
  if (!v1.length) problems.push('the LiveBench 1.0 release list was not found in the site script');
  const v2 = [...new Set([...js.matchAll(/\[((?:"20\d{6}",?)+)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"(\d{8})"/g)].map((x) => x[1]!)))].sort();
  if (!v2.length) problems.push('the LiveBench 2.0 release list was not found in the site script');
  const version = /\?v=(\d+)/.exec(js)?.[1];
  return { v1, v2, ...(version && { version }), problems };
}

export interface ModelInfo {
  displayName?: string;
  url?: string;
  huggingface?: string;
  effort?: string;
}

/**
 * The site script's entry for a model: `"gpt-6-astra-max":{url:"…",displayName:"GPT-6 Astra Max
 * Effort",…}`. Read field by field, so a change in the order or a new field does not matter.
 */
export function modelInfo(js: string, model: string): ModelInfo | undefined {
  const at = js.indexOf(`${JSON.stringify(model)}:{`);
  if (at < 0) return undefined;
  let i = at + JSON.stringify(model).length + 1;
  let depth = 0;
  let quote = '';
  const start = i;
  for (; i < js.length; i++) {
    const c = js[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  const body = js.slice(start, i + 1);
  const field = (k: string) => {
    const m = new RegExp(`(?:^|[{,])${k}:"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
    return m ? (JSON.parse(`"${m[1]}"`) as string) : undefined;
  };
  const out: ModelInfo = {};
  for (const k of ['displayName', 'url', 'huggingface', 'effort'] as const) {
    const v = field(k);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

const num = (v: unknown): number | undefined => {
  const s = String(v ?? '').trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : undefined;
};

/** Rows and metrics for one release. */
export function releaseRows(r: Release, latest: boolean, info: (model: string) => ModelInfo | undefined = () => undefined): { rows: Row[]; metrics: Metric[]; problems: string[] } {
  const problems: string[] = [];
  const date = isoDate(r.id);
  const p = `${r.gen}/${date}`;
  const name = `LiveBench ${r.gen === 'v1' ? '1.0' : '2.0'} (${date})`;
  const weights = (r.categories['_overall_weights'] ?? {}) as Record<string, number>;
  const cats = Object.entries(r.categories)
    .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
    .map(([k, v]) => [k, (v as unknown[]).map(String)] as const);
  const header = Object.keys(r.records[0] ?? {});
  if (!header.includes('model')) problems.push(`${p}: the table has no "model" column`);
  for (const t of new Set(cats.flatMap(([, list]) => list))) if (!header.includes(t)) problems.push(`${p}: the table has no column "${t}"`);

  const overallId = r.gen === 'v1' ? 'global' : 'overall';
  const metrics: Metric[] = [
    {
      id: `${p}/${overallId}`,
      label: `${name} ${r.gen === 'v1' ? 'global average' : 'overall'}`,
      direction: 'higher',
      unit: 'percent',
      headline: latest,
      family: `livebench-${r.gen}-overall`,
      description: `The mean of the ${r.gen === 'v1' ? 'category averages' : 'suite scores'}${Object.keys(weights).length ? `, weighted ${Object.entries(weights).map(([k, w]) => `${k} ×${w}`).join(', ')}` : ''}, computed as LiveBench's site does.`,
    },
  ];
  for (const [cat, list] of cats) {
    const c = slug(cat);
    const single = list.length === 1;
    metrics.push({
      id: `${p}/${c}`,
      label: `${name} ${cat}${single ? '' : ' average'}`,
      direction: 'higher',
      unit: 'percent',
      headline: latest,
      family: `livebench-${r.gen}-${c}`,
      ...(TAGS[c] && { tags: TAGS[c] }),
      ...(!single && { description: `The mean of ${list.join(', ')}, computed as LiveBench's site does.` }),
    });
    if (single) continue;
    for (const t of list) {
      metrics.push({ id: `${p}/${t}`, label: `${name} ${t}`, direction: 'higher', unit: 'percent', headline: false, family: `livebench-${r.gen}-task-${t}`, ...(TAGS[c] && { tags: TAGS[c] }) });
    }
  }
  const costBy = new Map((r.cost ?? []).map((c) => [String(c['model'] ?? '').trim(), c]));
  if (r.cost) {
    metrics.push({
      id: `${p}/cost_per_task`,
      label: `${name} cost per task ($)`,
      direction: 'lower',
      unit: 'USD',
      headline: false,
      family: `livebench-${r.gen}-cost`,
      description: 'Total cost over the total number of tasks across the suites, as LiveBench computes it. Its "cost per successful task" is this divided by Overall, times 100.',
    });
  }

  const rows: Row[] = [];
  for (const rec of r.records) {
    const model = String(rec['model'] ?? '').trim();
    if (!model) continue;
    const scores: Record<string, Value> = {};
    let total = 0;
    let weightSum = 0;
    let complete = cats.length > 0;
    for (const [cat, list] of cats) {
      const vals = list.map((t) => num(rec[t])).filter((n): n is number => n !== undefined);
      if (list.length > 1) list.forEach((t) => num(rec[t]) !== undefined && (scores[`${p}/${t}`] = num(rec[t])!));
      if (!vals.length) {
        complete = false;
        continue;
      }
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      scores[`${p}/${slug(cat)}`] = list.length > 1 ? round(avg) : avg;
      const w = weights[cat] ?? 1;
      total += w * avg;
      weightSum += w;
    }
    if (complete && weightSum) scores[`${p}/${overallId}`] = round(total / weightSum);
    const c = costBy.get(model);
    if (c && complete) {
      const suites = cats.flatMap(([, list]) => list);
      const spent = suites.map((s) => num(c[s]));
      const tasks = suites.map((s) => num(c[`nq_${s}`]));
      if (spent.every((x) => x !== undefined) && tasks.every((x) => x !== undefined)) {
        const n = tasks.reduce((a, b) => a! + b!, 0)!;
        if (n > 0) scores[`${p}/cost_per_task`] = Math.round((spent.reduce((a, b) => a! + b!, 0)! / n) * 10_000) / 10_000;
      }
    }
    if (!Object.keys(scores).length) continue;
    const about = info(model);
    const link = [about?.huggingface, about?.url].find((u) => u?.startsWith('https://'));
    rows.push(
      orderRow({
        key: `${p}/${model}`,
        model,
        ...(about?.displayName && about.displayName !== model && { model_label: about.displayName }),
        ...(link && { model_url: link }),
        ...(about?.effort && { context: { effort: `${about.effort} effort` } }),
        date,
        scores,
        run_by: 'independent',
        upstream_url: r.url,
      }),
    );
  }
  return { rows, metrics, problems };
}

const csv = (text: string) => tableToRecords(parseDelimited(text));

const livebench: Plugin = async ({ source, previous, force }) => {
  const base = String(source.fetch).replace(/\/?$/, '/');
  const page = await (await fetchOk(base)).text();
  const script = /src="\.?\/?(static\/js\/main\.[\w]+\.js)"/.exec(page)?.[1];
  if (!script) return { rows: [], metrics: [], problems: ['the site page no longer loads a main script; the reader needs updating'] };
  const js = await (await fetchOk(base + script)).text();
  const found = releasesFromScript(js);
  const revision = `${script}?v=${found.version ?? ''}`;
  if (!force && previous?.upstream_revision === revision) return 'unchanged';

  const problems = [...found.problems];
  const rows: Row[] = [];
  const metrics: Metric[] = [];
  const get = async (path: string) => (await fetchOk(base + path)).text();
  const releases: Array<{ gen: 'v1' | 'v2'; id: string }> = [...found.v1.map((id) => ({ gen: 'v1' as const, id })), ...found.v2.map((id) => ({ gen: 'v2' as const, id }))];
  for (const { gen, id } of releases) {
    try {
      const stem = id.replaceAll('-', '_');
      const [table, cats, cost] =
        gen === 'v1'
          ? [await get(`v1/table_${stem}.csv`), await get(`v1/categories_${stem}.json`), undefined]
          : [await get(`data/${id}/table.csv`), await get(`data/${id}/categories.json`), await get(`data/${id}/cost.csv`).catch(() => undefined)];
      const release: Release = { gen, id, categories: JSON.parse(cats) as Record<string, unknown>, records: csv(table), ...(cost && { cost: csv(cost) }), url: `${base}#/release/${isoDate(id)}` };
      const out = releaseRows(release, gen === 'v2' && id === found.v2.at(-1), (m) => modelInfo(js, m));
      rows.push(...out.rows);
      metrics.push(...out.metrics);
      problems.push(...out.problems);
    } catch (e) {
      problems.push(`${gen} release ${id}: ${(e as Error).message}`);
    }
  }
  const result: ExtractResult = { revision, rows, metrics, problems };
  return result;
};

export default livebench;
