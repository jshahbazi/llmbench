import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intervalMs } from '../scripts/lib/config.ts';
import { selectHfFiles } from '../scripts/lib/fetchers.ts';
import { globToRegExp } from '../scripts/lib/http.ts';
import { planIssues, TITLE_PREFIX } from '../scripts/lib/issues.ts';
import type { RunEntry, SourceConfig } from '../scripts/lib/types.ts';
import { transform as epoch } from '../scripts/sources/epoch.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('epoch: score column and scale come from benchmark_metadata.csv; external files are opt-in', () => {
  const files = {
    'benchmark_metadata.csv': enc(
      'benchmark,source_file,score_column,scale,random_baseline,release_date,superseded_by\n' +
        'GPQA diamond,gpqa_diamond.csv,Best score (across scorers),1.0,0.25,2023-11-20,\n' +
        'Aider polyglot,aider_polyglot_external.csv,Percent correct,0.01,0,2024-12-21,\n',
    ),
    'model_metadata.csv': enc('model_version,display_name\nclaude-x_max,Claude X (max)\n'),
    'gpqa_diamond.csv': enc(
      'Model version,mean_score,Best score (across scorers),Started at,stderr\n' +
        'claude-x_max,0.9,0.91,2026-11-06T01:14:45.000Z,0.01\n' +
        'empty,,,,\n',
    ),
    'aider_polyglot_external.csv': enc('Model version,Percent correct\nclaude-x_max,80\n'),
    'epoch_capabilities_index/eci_scores.csv': enc('Model,Display name,eci,eci_ci_low,eci_ci_high,date\nclaude-x_max,Claude X,160,158,162,2026-11-01\n'),
  };
  const out = epoch(files, false);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.rows, [
    {
      key: 'gpqa_diamond|claude-x_max',
      model: 'claude-x_max',
      model_label: 'Claude X (max)',
      date: '2026-11-06T01:14:45.000Z',
      scores: { gpqa_diamond: '0.91' },
      extra: { mean_score: '0.9', stderr: '0.01' },
    },
    {
      key: 'eci|claude-x_max',
      model: 'claude-x_max',
      model_label: 'Claude X',
      date: '2026-11-01',
      scores: { eci: '160' },
      ci: { eci: ['158', '162'] },
    },
  ]);
  assert.deepEqual(out.metrics.map((m) => [m.id, m.label, m.unit]), [['gpqa_diamond', 'GPQA diamond', 'fraction'], ['eci', 'Epoch Capabilities Index', 'score']]);
  assert.equal(epoch(files, true).metrics.find((m) => m.id === 'aider_polyglot_external')?.unit, 'percent');
});

test('epoch: a renamed score column is a problem, not silent data loss', () => {
  const out = epoch(
    {
      'benchmark_metadata.csv': enc('benchmark,source_file,score_column,scale\nX,x.csv,Score,1.0\n'),
      'x.csv': enc('Model version,Accuracy\nm,0.5\n'),
    },
    false,
  );
  assert.deepEqual(out.problems, ['missing column "Score" in x.csv']);
});

test('Hugging Face file selection by config and split', () => {
  const all = ['README.md', 'text/latest-00000-of-00001.parquet', 'text/full-00000-of-00001.parquet', 'webdev/latest-00000-of-00001.parquet', 'data/train-00000-of-00002.parquet'];
  assert.deepEqual(selectHfFiles(all, { configs: ['text', 'webdev'], split: 'latest' }), [
    { path: 'text/latest-00000-of-00001.parquet', config: 'text' },
    { path: 'webdev/latest-00000-of-00001.parquet', config: 'webdev' },
  ]);
  assert.deepEqual(selectHfFiles(all, {}), [{ path: 'data/train-00000-of-00002.parquet' }]);
  assert.throws(() => selectHfFiles(all, { config: 'vision', split: 'latest' }), /no Parquet files for config "vision"/);
});

test('globs and intervals', () => {
  assert.ok(globToRegExp('public/table_*.csv').test('public/table_2026_06_25.csv'));
  assert.ok(!globToRegExp('public/table_*.csv').test('public/sub/table_x.csv'));
  assert.ok(globToRegExp('results/**/score.json').test('results/a/b/score.json'));
  assert.equal(intervalMs('6h'), 21_600_000);
  assert.equal(intervalMs('7d'), 604_800_000);
});

const src = (id: string, terms: 'allowed' | 'blocked' = 'allowed'): SourceConfig => ({
  id,
  name: id.toUpperCase(),
  homepage: `https://${id}.example`,
  terms,
  every: '6h',
  run_by: 'independent',
  options: {},
});
const run = (outcome: RunEntry['outcome'], reasons?: string[]): RunEntry => ({ checked_at: '2026-11-20T00:00:00Z', outcome, reasons });

test('issues: open for a new problem, update when it changes, close on recovery or removal', () => {
  const sources = [src('a'), src('b'), src('c'), src('d', 'blocked')];
  const runs = { a: run('held', ['row drop']), b: run('ingested'), c: run('failed', ['HTTP 500']) };
  const open = [
    { number: 1, title: TITLE_PREFIX + 'b', body: 'old' },
    { number: 2, title: TITLE_PREFIX + 'c', body: 'old' },
    { number: 3, title: TITLE_PREFIX + 'gone', body: 'old' },
    { number: 4, title: 'Unrelated', body: '' },
  ];
  const actions = planIssues(sources, runs, open);
  assert.deepEqual(
    actions.map((a) => [a.kind, a.source, 'number' in a ? a.number : undefined]),
    [
      ['open', 'a', undefined],
      ['close', 'b', 1],
      ['update', 'c', 2],
      ['close', 'gone', 3],
    ],
  );
  const opened = actions[0];
  assert.ok(opened?.kind === 'open' && opened.body.includes('- row drop') && opened.body.includes('`accept` set to `a`'));
  // An unchanged body is not re-sent.
  const again = planIssues(sources, runs, [{ number: 2, title: TITLE_PREFIX + 'c', body: (actions[2] as { body: string }).body }]);
  assert.ok(!again.some((a) => a.source === 'c'));
});
