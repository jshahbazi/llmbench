/**
 * Decides which GitHub issues to open, update or close from a run's outcomes.
 * One issue per source with a problem; it closes itself when the source next succeeds.
 */
import type { RunEntry, SourceConfig } from './types.ts';

export const TITLE_PREFIX = 'Source problem: ';

export interface OpenIssue {
  number: number;
  title: string;
  body: string;
}

export type IssueAction =
  | { kind: 'open'; source: string; title: string; body: string }
  | { kind: 'update'; number: number; source: string; body: string }
  | { kind: 'close'; number: number; source: string; comment: string };

export function issueBody(source: SourceConfig, run: RunEntry): string {
  const what =
    run.outcome === 'held'
      ? 'The latest data from this source failed a check, so it was **held**. The site still shows its last good data.'
      : 'The latest check of this source **failed**. The site still shows its last good data.';
  const lines = [
    what,
    '',
    `**Source:** ${source.name} (\`${source.id}\`), ${source.homepage}`,
    `**Checked:** ${run.checked_at}`,
    ...(run.last_success_at ? [`**Last success:** ${run.last_success_at}`] : []),
    ...(run.summary ? [`**This run:** ${run.summary}`] : []),
    '',
    '**Why:**',
    ...(run.reasons ?? ['(no reason recorded)']).map((r) => `- ${r}`),
    '',
    '**What to do:**',
    run.outcome === 'held'
      ? '- If the source changed its layout, fix this source\'s entry in `sources.yaml`; the next run re-checks it.\n' +
        '- If the change is real (for example a big re-scoring), run the **update** workflow by hand with `accept` set to `' +
        source.id +
        '`.'
      : '- Often temporary; the next scheduled run retries. If it keeps failing, check the `fetch` location in `sources.yaml`.',
    '',
    '_Opened and closed automatically by the update workflow._',
  ];
  return lines.join('\n');
}

export function planIssues(sources: readonly SourceConfig[], runs: Record<string, RunEntry>, open: readonly OpenIssue[]): IssueAction[] {
  const actions: IssueAction[] = [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const openBySource = new Map<string, OpenIssue>();
  for (const i of open) if (i.title.startsWith(TITLE_PREFIX)) openBySource.set(i.title.slice(TITLE_PREFIX.length).trim(), i);

  for (const s of sources) {
    const run = runs[s.id];
    const issue = openBySource.get(s.id);
    if (!run) continue;
    if (run.outcome === 'held' || run.outcome === 'failed') {
      const body = issueBody(s, run);
      if (!issue) actions.push({ kind: 'open', source: s.id, title: TITLE_PREFIX + s.id, body });
      else if (issue.body.trim() !== body.trim()) actions.push({ kind: 'update', number: issue.number, source: s.id, body });
    } else if (issue && (run.outcome === 'ingested' || run.outcome === 'unchanged')) {
      actions.push({
        kind: 'close',
        number: issue.number,
        source: s.id,
        comment: `Recovered: checked ${run.checked_at}, ${run.outcome}${run.summary ? ` (${run.summary})` : ''}.`,
      });
    }
  }
  for (const [id, issue] of openBySource) {
    if (!byId.has(id) || byId.get(id)!.terms !== 'allowed') {
      actions.push({ kind: 'close', number: issue.number, source: id, comment: 'This source is no longer fetched.' });
    }
  }
  return actions;
}
