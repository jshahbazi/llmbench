/**
 * SWE-bench (swebench.com): language-model agents fixing real GitHub issues. Every board's results
 * are in one file, data/leaderboards.json in SWE-bench/swe-bench.github.io, licensed CC BY-NC 4.0.
 *
 * Each entry is a system: an agent scaffold and one or more models. Two kinds are kept apart, so a
 * model's score never silently becomes the best of whatever scaffold someone built around it:
 *
 *   <board>/bash-only  runs by the SWE-bench team, every model in the same minimal agent
 *                      (mini-SWE-agent). These compare models on equal terms. "independent".
 *   <board>/agents     systems submitted by their builders. The agent is kept as context. "submitted".
 *
 * A system that names exactly one model is filed under that model's name as SWE-bench tags it
 * ("claude-opus-4-5-20251101"); one that uses several models, or does not say, is filed under the
 * system's own name and shows as a row of its own. Cost per task is kept where the entry reports it.
 */
import { orderRow } from '../lib/extract.ts';
import { githubFile, latestCommit, parseGithubRef } from '../lib/http.ts';
import type { ExtractResult, Metric, Plugin, Row, Value } from '../lib/types.ts';

const FILE = 'data/leaderboards.json';
const EXPERIMENTS = 'https://github.com/SWE-bench/experiments/tree/main/evaluation';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const boardId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The models an entry names in its tags ("Model: gpt-5"). */
export function modelTags(entry: Record<string, unknown>): string[] {
  const tags = Array.isArray(entry['tags']) ? entry['tags'] : [];
  return tags.map(String).flatMap((t) => (/^Model:\s*(.+)$/.exec(t)?.[1]?.trim() ?? []));
}

export function isBashOnly(entry: Record<string, unknown>): boolean {
  return entry['agent'] === 'mini-SWE-agent';
}

function metricsFor(board: string, label: string, kind: 'bash-only' | 'agents', cost: boolean): Metric[] {
  const what = kind === 'bash-only' ? 'bash only, same agent for every model' : 'agent submissions';
  const out: Metric[] = [
    {
      id: `${board}/${kind}`,
      label: `SWE-bench ${label} (${what})`,
      direction: 'higher',
      unit: 'percent',
      headline: board === 'verified',
      tags: ['coding', 'agents'],
      family: `swe-bench-${board}`,
      description:
        kind === 'bash-only'
          ? 'Share of issues resolved. Every model run by the SWE-bench team in the same minimal agent (mini-SWE-agent), so models are compared on equal terms.'
          : 'Share of issues resolved by systems their builders submitted, each with its own agent; the agent is shown with each score.',
    },
  ];
  if (cost) {
    out.push({ id: `${board}/${kind}-cost`, label: `SWE-bench ${label} (${what}) cost per task ($)`, direction: 'lower', unit: 'USD', headline: false, tags: ['coding', 'agents'] });
  }
  return out;
}

/** One leaderboard entry as a row. */
export function entryRow(board: string, entry: Record<string, unknown>): { row?: Row; problem?: string } {
  const folder = str(entry['folder']);
  const name = str(entry['name']);
  if (!folder || !name) return { problem: `an entry on the ${board} board has no ${folder ? 'name' : 'folder'}` };
  const resolved = entry['resolved'];
  if (typeof resolved !== 'number' || !Number.isFinite(resolved)) return { problem: `${board}/${folder} has no "resolved" number` };
  const bash = isBashOnly(entry);
  const kind = bash ? 'bash-only' : 'agents';
  const scores: Record<string, Value> = { [`${board}/${kind}`]: resolved };
  const cost = entry['instance_cost'];
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) scores[`${board}/${kind}-cost`] = Number(cost.toFixed(4));

  const models = modelTags(entry);
  const display = str(entry['model_display']);
  const context: Record<string, string> = {};
  const agent = str(entry['agent']);
  const version = str(entry['mini-swe-agent_version']);
  if (agent) context['agent'] = bash && version ? `${agent} ${version}` : agent;
  const effort = str(entry['reasoning_effort']);
  if (effort) context['reasoning_effort'] = `${effort} effort`;
  if (models.length > 1) context['models'] = models.join(' + ');

  const extra: Record<string, unknown> = {};
  for (const k of ['agent_org', 'model_org', 'checked', 'os_model', 'os_system', 'instance_calls', 'cost']) {
    const v = entry[k];
    if (v !== undefined && v !== null && v !== '') extra[k] = typeof v === 'number' ? Number(v.toFixed(4)) : v;
  }
  extra['folder'] = folder;
  const row: Row = {
    key: `${board}/${folder}`,
    model: models.length === 1 ? models[0]! : name,
    ...(models.length === 1 && display && !/^(multiple|undisclosed)$/i.test(display) && { model_label: display }),
    ...(str(entry['site'])?.startsWith('http') && { model_url: str(entry['site'])! }),
    ...(Object.keys(context).length && { context }),
    ...(str(entry['date']) && { date: str(entry['date'])! }),
    scores,
    run_by: bash ? 'independent' : 'submitted',
    upstream_url: `${EXPERIMENTS}/${board}/${folder}`,
    extra,
  };
  return { row: orderRow(row) };
}

/** Rows and metrics for the whole file. */
export function readLeaderboards(doc: unknown): { rows: Row[]; metrics: Metric[]; problems: string[] } {
  const boards = Array.isArray(obj(doc)['leaderboards']) ? (obj(doc)['leaderboards'] as unknown[]) : [];
  const problems: string[] = [];
  if (!boards.length) problems.push(`${FILE} has no "leaderboards" list`);
  const rows: Row[] = [];
  const metrics: Metric[] = [];
  for (const b of boards.map(obj)) {
    const label = str(b['name']);
    if (!label) continue;
    const board = boardId(label);
    const results = Array.isArray(b['results']) ? b['results'].map(obj) : [];
    const boardRows: Row[] = [];
    for (const entry of results) {
      const { row, problem } = entryRow(board, entry);
      if (problem) problems.push(problem);
      if (row) boardRows.push(row);
    }
    for (const kind of ['bash-only', 'agents'] as const) {
      const mine = boardRows.filter((r) => `${board}/${kind}` in r.scores);
      if (mine.length) metrics.push(...metricsFor(board, label, kind, mine.some((r) => `${board}/${kind}-cost` in r.scores)));
    }
    rows.push(...boardRows);
  }
  return { rows, metrics, problems };
}

const swebench: Plugin = async ({ source, previous, force }) => {
  const { owner, repo } = parseGithubRef(String(source.fetch));
  const head = await latestCommit(owner, repo, FILE);
  if (!force && previous?.upstream_revision === head.sha) return 'unchanged';
  const doc = await (await githubFile(owner, repo, head.sha, FILE)).json();
  const { rows, metrics, problems } = readLeaderboards(doc);
  const result: ExtractResult = { revision: head.sha, revisionDate: head.date, rows, metrics, problems };
  return result;
};

export default swebench;
