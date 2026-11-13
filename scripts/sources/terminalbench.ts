/**
 * Terminal-Bench (tbench.ai): agents completing hard tasks in a terminal. The leaderboards are served
 * by an open JSON endpoint (POST {package, name}); the versions to read are listed in sources.yaml
 * under "boards", newest first, because the site only lists them in its own script.
 *
 * Every entry is a system: an agent and one or more models. One column per version, with the agent
 * kept as context, so a model's cell shows its best published system and says which agent it was.
 * Columns: <version>/accuracy (with its 95% interval) and <version>/cost_per_trial (total cost over
 * trials, where the entry reports cost).
 *
 * Names: an entry naming exactly one model is filed under that model's name (2.0 writes "gpt-5.5",
 * 4.1 writes the display label). 4.1 writes Anthropic models without "Claude" ("Opus 5.5"); the raw
 * name is kept and "Claude Opus 5.5" is given as its display name. An entry using several models is
 * filed under the agent and its models together, which never matches a single model.
 */
import { orderRow } from '../lib/extract.ts';
import { fetchOk } from '../lib/http.ts';
import type { ExtractResult, Metric, Plugin, Row, Value } from '../lib/types.ts';

export interface Board {
  package: string;
  name: string;
  version: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A display field that is either "text" or { label, url }. */
const label = (v: unknown) => str(v) ?? str(obj(v)['label']);
const CLAUDE_TIER = /^(Opus|Sonnet|Haiku|Fable)\b/;

export function boardsFrom(options: Record<string, unknown>): { boards: Board[]; problem?: string } {
  const list = Array.isArray(options['boards']) ? options['boards'].map(obj) : [];
  const boards = list
    .map((b) => ({ package: str(b['package']) ?? '', name: str(b['name']) ?? '', version: str(b['version']) ?? '' }))
    .filter((b) => b.package && b.name && b.version);
  return boards.length === list.length && boards.length ? { boards } : { boards, problem: '"boards" must be a list of { package, name, version }' };
}

export function metricsFor(b: Board, latest: boolean, cost: boolean): Metric[] {
  const out: Metric[] = [
    {
      id: `${b.version}/accuracy`,
      label: `Terminal-Bench ${b.version} accuracy`,
      direction: 'higher',
      unit: 'percent',
      headline: latest,
      tags: ['agents', 'coding'],
      family: 'terminal-bench-accuracy',
      description: 'Share of task trials solved by an agent and model together; the agent is shown with each score.',
    },
  ];
  if (cost) {
    out.push({
      id: `${b.version}/cost_per_trial`,
      label: `Terminal-Bench ${b.version} cost per trial ($)`,
      direction: 'lower',
      unit: 'USD',
      headline: false,
      tags: ['agents', 'coding'],
      description: 'Total cost of the run divided by its number of trials.',
    });
  }
  return out;
}

/** One leaderboard row as a row of ours. */
export function entryRow(b: Board, entry: Record<string, unknown>): { row?: Row; problem?: string } {
  const meta = obj(entry['metadata']);
  const metrics = obj(entry['metrics']);
  const acc = metrics['accuracy'];
  const key = str(entry['id']) ?? str(meta['key']);
  if (!key) return { problem: `a Terminal-Bench ${b.version} entry has no id` };
  if (typeof acc !== 'number' || !Number.isFinite(acc)) return { problem: `Terminal-Bench ${b.version} entry ${key} has no accuracy` };

  const agent = label(meta['agent_display']) ?? str(meta['agent_name']) ?? 'unknown agent';
  const display = label(meta['model_display']);
  const names = Array.isArray(meta['model_names']) ? meta['model_names'].map(String).filter(Boolean) : [];
  const org = label(meta['model_org']);
  const several = names.length > 1 || /^multiple$/i.test(display ?? '');
  let model: string;
  let modelLabel: string | undefined;
  if (several) model = [agent, ...(names.length ? names : ['several models'])].join(' + ');
  else if (names.length === 1) {
    model = names[0]!;
    if (display && display !== model) modelLabel = display;
  } else if (display && !/^undisclosed$/i.test(display)) {
    model = display;
    if (org === 'Anthropic' && CLAUDE_TIER.test(display)) modelLabel = `Claude ${display}`;
  } else model = agent;

  const scores: Record<string, Value> = { [`${b.version}/accuracy`]: acc };
  const ci: Record<string, [Value, Value]> = {};
  const hw = metrics['accuracy_ci95_half_width'];
  if (typeof hw === 'number' && Number.isFinite(hw)) ci[`${b.version}/accuracy`] = [Number((acc - hw).toFixed(2)), Number((acc + hw).toFixed(2))];
  const cost = metrics['total_cost_usd'];
  const trials = metrics['n_trials'] ?? entry['n_trials'];
  if (typeof cost === 'number' && cost > 0 && typeof trials === 'number' && trials > 0) scores[`${b.version}/cost_per_trial`] = Math.round((cost / trials) * 10_000) / 10_000;

  const context: Record<string, string> = { agent };
  const effort = str(meta['reasoning_effort']);
  if (effort && effort !== 'none') context['reasoning_effort'] = `${effort} effort`;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    agent_org: label(meta['agent_org']),
    model_org: org,
    verified: meta['verified'],
    n_trials: trials,
    total_cost_usd: cost,
    pass_at_5: metrics['pass_at_5'],
    integration_method: str(meta['integration_method']),
  })) {
    if (v !== undefined && v !== null && v !== '') extra[k] = v;
  }
  const modelUrl = str(obj(meta['model_display'])['url']);
  const row: Row = {
    key,
    model,
    ...(modelLabel && { model_label: modelLabel }),
    ...(modelUrl?.startsWith('https://') && { model_url: modelUrl }),
    context,
    ...(str(meta['date']) && { date: str(meta['date'])! }),
    scores,
    ...(Object.keys(ci).length && { ci }),
    run_by: 'submitted',
    upstream_url: str(meta['source_url'])?.startsWith('https://') ? str(meta['source_url'])! : 'https://www.tbench.ai/leaderboard',
    ...(Object.keys(extra).length && { extra }),
  };
  return { row: orderRow(row) };
}

const terminalbench: Plugin = async ({ source }) => {
  const { boards, problem } = boardsFrom(source.options);
  const problems: string[] = problem ? [problem] : [];
  const rows: Row[] = [];
  const metrics: Metric[] = [];
  let latest = '';
  for (const [i, b] of boards.entries()) {
    try {
      const res = await fetchOk(String(source.fetch), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ package: b.package, name: b.name }),
      });
      const doc = obj(await res.json());
      const list = Array.isArray(doc['rows']) ? doc['rows'].map(obj).filter((r) => (r['status'] ?? 'display') === 'display') : [];
      if (!list.length) problems.push(`Terminal-Bench ${b.version}: no rows`);
      const mine: Row[] = [];
      for (const entry of list) {
        const out = entryRow(b, entry);
        if (out.problem) problems.push(out.problem);
        if (out.row) mine.push(out.row);
        const t = str(entry['updated_at']);
        if (t && t > latest) latest = t;
      }
      // Keys only need to be unique within a version.
      for (const r of mine) r.key = `${b.version}/${r.key}`;
      rows.push(...mine);
      metrics.push(...metricsFor(b, i === 0, mine.some((r) => `${b.version}/cost_per_trial` in r.scores)));
    } catch (e) {
      problems.push(`Terminal-Bench ${b.version}: ${(e as Error).message}`);
    }
  }
  const result: ExtractResult = { ...(latest && { revision: latest }), rows, metrics, problems };
  return result;
};

export default terminalbench;
