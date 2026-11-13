/**
 * Vals AI (vals.ai): an independent evaluator that runs every model itself, on public benchmarks
 * (SWE-bench, Terminal-Bench, GPQA, MMLU-Pro, LiveCodeBench…) and its own (legal, finance, tax,
 * medical, coding agents) and composite indexes.
 *
 * There is no index of the data. The benchmarks page lists every benchmark; each benchmark's page
 * names its data file (/_astro/benchmark_view_<id>.<hash>.json, content-hashed), which holds every
 * task's accuracy, standard error, cost, latency and run settings for every model. The sorted list
 * of data-file names is the revision, so a run where none changed stops before downloading them.
 *
 * Columns per benchmark: <slug>/overall (headline unless Vals has retired the benchmark), one per
 * task, <slug>/cost_per_test and <slug>/latency (overall only). The interval on overall is ±1.96
 * standard errors as Vals reports them. One row per benchmark and model, so the run settings
 * (effort, harness) stay with the scores they produced.
 */
import { createHash } from 'node:crypto';
import { orderRow } from '../lib/extract.ts';
import { fetchOk } from '../lib/http.ts';
import type { ExtractResult, Metric, Plugin, Row } from '../lib/types.ts';

const BASE = 'https://www.vals.ai';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/</g, 'under-')
    .replace(/>/g, 'over-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'task';

/** Existing families on other sources that a Vals benchmark's overall score belongs with. */
const FAMILY: Record<string, string> = {
  swebench: 'swe-bench-verified',
  swebench_multimodal: 'swe-bench-multimodal',
  terminal_bench: 'terminal-bench-accuracy',
};

export function tagsFor(meta: Record<string, unknown>, slug: string): string[] {
  const tags = new Set<string>();
  const industry = str(meta['industry']);
  if (industry === 'coding') tags.add('coding');
  if (industry === 'math') tags.add('math');
  if (industry === 'academic' || industry === 'science') tags.add('knowledge');
  if (str(meta['mode']) === 'agentic') tags.add('agents');
  if (/mmmu|multimodal/.test(slug)) tags.add('vision');
  if (slug === 'web_search') tags.add('search');
  return [...tags];
}

/** The benchmark slugs on the benchmarks page. */
export function slugsFrom(page: string): string[] {
  return [...new Set([...page.matchAll(/href="\/benchmarks\/([a-z0-9_-]+)"/g)].map((m) => m[1]!))];
}

/** The data file a benchmark page names, if any. */
export function dataFileFrom(page: string): string | undefined {
  return /(benchmark_view_[\w-]+\.[\w-]+\.json)/.exec(page)?.[1];
}

/** How a model was run, from its overall entry. */
export function contextFor(entry: Record<string, unknown>, meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const effort = str(entry['reasoning_effort']) ?? str(entry['compute_effort']);
  if (effort) out['reasoning_effort'] = `${effort} effort`;
  const harness = str(entry['harness']) ?? str(meta['harness']);
  if (harness) out['agent'] = harness;
  return out;
}

/**
 * One benchmark's data file as rows and metrics. `label` is the benchmark's display name, already
 * given a version where Vals has several versions under one name.
 */
export function benchmarkRows(slug: string, doc: unknown, label?: string): { rows: Row[]; metrics: Metric[]; problems: string[] } {
  const d = obj(doc);
  const meta = obj(d['metadata']);
  const tasks = obj(d['tasks']);
  const problems: string[] = [];
  if (meta['visible'] === false) return { rows: [], metrics: [], problems };
  const name = label ?? str(meta['benchmark']) ?? slug;
  const taskLabels = Object.fromEntries(Object.entries(obj(meta['tasks'])).map(([k, v]) => [k, str(v) ?? k]));
  const taskIds = [...new Set(['overall', ...Object.keys(taskLabels), ...Object.keys(tasks)])].filter((t) => t in tasks);
  if (!taskIds.includes('overall')) return { rows: [], metrics: [], problems: [`Vals ${slug}: no overall scores`] };

  const ids = new Map<string, string>();
  const used = new Set(['overall', 'cost_per_test', 'latency']);
  for (const t of taskIds) {
    if (t === 'overall') {
      ids.set(t, `${slug}/overall`);
      continue;
    }
    let id = slugify(t);
    for (let k = 2; used.has(id); k++) id = `${slugify(t)}-${k}`;
    used.add(id);
    ids.set(t, `${slug}/${id}`);
  }

  const overall = obj(tasks['overall']);
  const accs = Object.values(overall).map((e) => num(obj(e)['accuracy'])).filter((v): v is number => v !== undefined);
  const unit = accs.some((a) => a > 100 || a < 0) ? 'score' : 'percent';
  const archived = meta['archived'] === true;
  const url = `${BASE}/benchmarks/${slug}`;
  const rows = new Map<string, Row>();
  const has = new Set<string>();

  for (const t of taskIds) {
    for (const [model, raw] of Object.entries(obj(tasks[t]))) {
      const e = obj(raw);
      const acc = num(e['accuracy']);
      if (acc === undefined || !model.trim()) continue;
      let row = rows.get(model);
      if (!row) {
        const ctx = contextFor(model in overall ? obj(overall[model]) : e, meta);
        row = {
          key: `${slug}/${model}`,
          model,
          ...(Object.keys(ctx).length && { context: ctx }),
          ...(str(meta['updated']) && { date: str(meta['updated'])! }),
          scores: {},
          run_by: 'independent',
          upstream_url: url,
        };
        rows.set(model, row);
      }
      const id = ids.get(t)!;
      row.scores[id] = acc;
      has.add(id);
      if (t !== 'overall') continue;
      const se = num(e['stderr']);
      if (se !== undefined && se > 0) (row.ci ??= {})[id] = [Number((acc - 1.96 * se).toFixed(3)), Number((acc + 1.96 * se).toFixed(3))];
      const cost = num(e['cost_per_test']);
      if (cost !== undefined && cost > 0 && meta['use_cost_per_test'] !== false) {
        row.scores[`${slug}/cost_per_test`] = Number(cost.toFixed(6));
        has.add(`${slug}/cost_per_test`);
      }
      const latency = num(e['latency']);
      if (latency !== undefined && latency > 0) {
        row.scores[`${slug}/latency`] = Number(latency.toFixed(2));
        has.add(`${slug}/latency`);
      }
      const extra: Record<string, unknown> = {};
      for (const k of ['provider', 'temperature', 'max_output_tokens', 'stderr'] as const) if (e[k] !== null && e[k] !== undefined && e[k] !== '') extra[k] = e[k];
      if (Object.keys(extra).length) row.extra = extra;
    }
  }

  const description = [str(meta['description']), archived ? 'Vals has retired this version.' : undefined, 'Run by Vals AI.']
    .filter(Boolean)
    .map((s) => s!.replace(/\.?$/, '.'))
    .join(' ');
  const tags = tagsFor(meta, slug);
  const family = str(meta['family']);
  const metrics: Metric[] = [];
  for (const t of taskIds) {
    const id = ids.get(t)!;
    if (!has.has(id)) continue;
    metrics.push({
      id,
      label: t === 'overall' ? name : `${name}: ${taskLabels[t] ?? t}`,
      direction: 'higher',
      unit,
      headline: t === 'overall' && !archived,
      ...(tags.length && { tags }),
      ...(t === 'overall' && family && { family: FAMILY[family] ?? `vals-${family.replaceAll('_', '-')}` }),
      url,
      ...(t === 'overall' && { description: `${description} The interval is ±1.96 standard errors as Vals reports them.` }),
    });
  }
  if (has.has(`${slug}/cost_per_test`)) {
    metrics.push({ id: `${slug}/cost_per_test`, label: `${name} cost per test ($)`, direction: 'lower', unit: 'USD', headline: false, ...(tags.length && { tags }), url, description: 'Average cost of one test, in US dollars, as Vals measured it.' });
  }
  if (has.has(`${slug}/latency`)) {
    metrics.push({ id: `${slug}/latency`, label: `${name} time per test (s)`, direction: 'lower', unit: 'seconds', headline: false, ...(tags.length && { tags }), url, description: 'Average time to complete one test, in seconds, as Vals measured it.' });
  }
  return { rows: [...rows.values()].map(orderRow), metrics, problems };
}

/** Display names, with the version added where Vals has more than one version under one name. */
export function labelsFor(docs: Array<{ slug: string; doc: unknown }>): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const { slug, doc } of docs) {
    const name = str(obj(obj(doc)['metadata'])['benchmark']) ?? slug;
    byName.set(name, [...(byName.get(name) ?? []), slug]);
  }
  const out = new Map<string, string>();
  for (const { slug, doc } of docs) {
    const meta = obj(obj(doc)['metadata']);
    const name = str(meta['benchmark']) ?? slug;
    const version = str(meta['version']);
    out.set(slug, byName.get(name)!.length > 1 && version && !name.includes(version) ? `${name} v${version}` : name);
  }
  return out;
}

const vals: Plugin = async ({ source, previous, force }) => {
  const base = String(source.fetch ?? `${BASE}/benchmarks`);
  const text = async (url: string) => (await fetchOk(url)).text();
  const slugs = slugsFrom(await text(base));
  if (!slugs.length) return { rows: [], metrics: [], problems: ['the benchmarks page lists no benchmarks; the reader needs updating'] };

  const warnings: string[] = [];
  const files: Array<{ slug: string; file: string }> = [];
  const noData: string[] = [];
  for (const slug of slugs) {
    try {
      const file = dataFileFrom(await text(`${BASE}/benchmarks/${slug}`));
      if (file) files.push({ slug, file });
      else noData.push(slug);
    } catch (e) {
      warnings.push(`${slug}: ${(e as Error).message}`);
    }
  }
  if (noData.length) warnings.push(`benchmark pages with no data file, left out: ${noData.join(', ')}`);
  const revision = `vals:${files.length}:${createHash('sha256').update(files.map((f) => f.file).sort().join('\n')).digest('hex').slice(0, 16)}`;
  if (!force && previous?.upstream_revision === revision) return 'unchanged';

  const docs: Array<{ slug: string; doc: unknown }> = [];
  for (const { slug, file } of files) {
    try {
      docs.push({ slug, doc: await (await fetchOk(`${BASE}/_astro/${file}`)).json() });
    } catch (e) {
      warnings.push(`${slug}: ${(e as Error).message}`);
    }
  }
  const labels = labelsFor(docs);
  const rows: Row[] = [];
  const metrics: Metric[] = [];
  const problems: string[] = [];
  for (const { slug, doc } of docs) {
    const out = benchmarkRows(slug, doc, labels.get(slug));
    rows.push(...out.rows);
    metrics.push(...out.metrics);
    problems.push(...out.problems);
  }
  if (docs.length < files.length * 0.9) problems.push(`only ${docs.length} of ${files.length} data files could be read`);
  const result: ExtractResult = { revision, rows, metrics, problems, ...(warnings.length && { warnings }) };
  return result;
};

export default vals;
