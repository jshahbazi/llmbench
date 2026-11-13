/**
 * τ²-bench (taubench.com): customer-service agents talking to a simulated user, in four domains
 * (airline, retail, telecom, banking_knowledge). Each leaderboard entry is a submission.json in the
 * sierra-research/tau2-bench repository; web/leaderboard/public/submissions/manifest.json lists the
 * ones the current text leaderboard shows. The voice and legacy boards are left out: they measure
 * different things, and legacy scores predate grading fixes.
 *
 * One row per submission, with pass^1 to pass^4 and cost per task for each domain. Submissions run
 * by Sierra, the benchmark's authors, are "independent"; the rest are "submitted". Contact details
 * in the files are never copied into rows.
 */
import { orderRow } from '../lib/extract.ts';
import { githubBlobUrl, githubFile, latestCommit, parseGithubRef } from '../lib/http.ts';
import type { ExtractResult, Metric, Plugin, Row, Value } from '../lib/types.ts';

const DIR = 'web/leaderboard/public/submissions';
const DOMAINS: Record<string, string> = { airline: 'Airline', retail: 'Retail', telecom: 'Telecom', banking_knowledge: 'Banking knowledge' };
const PASSES = ['pass_1', 'pass_2', 'pass_3', 'pass_4'];
const BENCH_AUTHORS = new Set(['sierra']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function metricList(): Metric[] {
  const out: Metric[] = [];
  for (const [d, label] of Object.entries(DOMAINS)) {
    for (const p of PASSES) {
      out.push({ id: `${d}/${p}`, label: `τ²-bench ${label} pass^${p.slice(-1)}`, direction: 'higher', unit: 'percent', headline: p === 'pass_1', tags: ['agents'] });
    }
    out.push({ id: `${d}/cost`, label: `τ²-bench ${label} cost per task ($)`, direction: 'lower', unit: 'USD', headline: false, tags: ['agents'] });
  }
  return out;
}

/** Turns one submission.json into a row. `id` is the submission's folder name. */
export function submissionRow(id: string, sub: Record<string, unknown>, link: string): { row?: Row; problem?: string } {
  const model = str(sub['model_name']);
  if (!model) return { problem: `submission "${id}" has no model_name` };
  const method = obj(sub['methodology']);
  const scores: Record<string, Value> = {};
  for (const [domain, res] of Object.entries(obj(sub['results']))) {
    if (!DOMAINS[domain]) continue;
    const r = obj(res);
    for (const k of [...PASSES, 'cost']) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v)) scores[`${domain}/${k}`] = v;
    }
  }
  const submitter = str(sub['submitting_organization']);
  const context: Record<string, string> = {};
  const effort = str(sub['reasoning_effort']);
  if (effort) context['reasoning_effort'] = `${effort} effort`;
  if (sub['submission_type'] === 'custom') context['submission_type'] = 'custom agent';
  const simulator = str(method['user_simulator']);
  if (simulator) context['user_simulator'] = `user simulator ${simulator}`;
  const verification = obj(method['verification']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    model_organization: str(sub['model_organization']),
    submitting_organization: submitter,
    submission_date: str(sub['submission_date']),
    tau2_bench_version: str(method['tau2_bench_version']),
    trajectories_available: sub['trajectories_available'],
    modified_prompts: verification['modified_prompts'],
    omitted_questions: verification['omitted_questions'],
  })) {
    if (v !== undefined) extra[k] = v;
  }
  const row: Row = {
    key: id,
    model,
    ...(str(obj(sub['model_release'])['announcement_url']) && { model_url: str(obj(sub['model_release'])['announcement_url'])! }),
    ...(Object.keys(context).length && { context }),
    ...(str(method['evaluation_date']) ?? str(sub['submission_date']) ? { date: (str(method['evaluation_date']) ?? str(sub['submission_date']))! } : {}),
    scores,
    run_by: submitter && BENCH_AUTHORS.has(submitter.toLowerCase()) ? 'independent' : 'submitted',
    upstream_url: link,
    ...(Object.keys(extra).length && { extra }),
  };
  return { row: orderRow(row) };
}

const tau2: Plugin = async ({ source, previous, force }) => {
  const { owner, repo } = parseGithubRef(String(source.fetch));
  const head = await latestCommit(owner, repo, DIR);
  if (!force && previous?.upstream_revision === head.sha) return 'unchanged';

  const manifest = obj(await (await githubFile(owner, repo, head.sha, `${DIR}/manifest.json`)).json());
  const ids = Array.isArray(manifest['submissions']) ? manifest['submissions'].map(String) : [];
  const problems: string[] = [];
  if (!ids.length) problems.push('manifest.json lists no submissions');
  const rows: Row[] = [];
  for (const id of ids) {
    const path = `${DIR}/${id}/submission.json`;
    let sub: Record<string, unknown>;
    try {
      sub = obj(await (await githubFile(owner, repo, head.sha, path)).json());
    } catch (e) {
      problems.push(`could not read ${path}: ${(e as Error).message}`);
      continue;
    }
    const { row, problem } = submissionRow(id, sub, githubBlobUrl(owner, repo, head.sha, path));
    if (problem) problems.push(problem);
    if (row && Object.keys(row.scores).length) rows.push(row);
  }
  const result: ExtractResult = { revision: head.sha, revisionDate: head.date, rows, metrics: metricList(), problems };
  return result;
};

export default tau2;
