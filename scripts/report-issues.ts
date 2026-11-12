/**
 * Opens, updates and closes one GitHub issue per source with a problem, from .cache/last-run.json.
 *
 * In GitHub Actions it uses GITHUB_TOKEN and GITHUB_REPOSITORY. Anywhere else, or with --dry-run,
 * it only prints what it would do.
 */
import { parseArgs } from 'node:util';
import { loadSources } from './lib/config.ts';
import { fetchOk } from './lib/http.ts';
import { planIssues, TITLE_PREFIX, type OpenIssue } from './lib/issues.ts';
import { readRunCache } from './lib/store.ts';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const token = process.env['GITHUB_TOKEN'];
const repo = process.env['GITHUB_REPOSITORY'];
const live = !values['dry-run'] && !!token && !!repo;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchOk(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

const sources = await loadSources();
const runs = await readRunCache();

let open: OpenIssue[] = [];
if (live) {
  const list = await api<Array<{ number: number; title: string; body: string | null; pull_request?: unknown }>>(
    'GET',
    `/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}&per_page=100`,
  );
  open = list.filter((i) => !i.pull_request && i.title.startsWith(TITLE_PREFIX)).map((i) => ({ number: i.number, title: i.title, body: i.body ?? '' }));
}

const actions = planIssues(sources, runs, open);
if (!actions.length) console.log('issues: nothing to do');
for (const a of actions) {
  const label = a.kind === 'open' ? `open "${a.title}"` : `${a.kind} #${a.number} (${a.source})`;
  if (!live) {
    console.log(`issues (dry run): would ${label}`);
    continue;
  }
  if (a.kind === 'open') await api('POST', '/issues', { title: a.title, body: a.body });
  else if (a.kind === 'update') await api('PATCH', `/issues/${a.number}`, { body: a.body });
  else {
    await api('POST', `/issues/${a.number}/comments`, { body: a.comment });
    await api('PATCH', `/issues/${a.number}`, { state: 'closed', state_reason: 'completed' });
  }
  console.log(`issues: ${label}`);
}
