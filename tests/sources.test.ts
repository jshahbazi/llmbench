import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intervalMs } from '../scripts/lib/config.ts';
import { selectHfFiles } from '../scripts/lib/fetchers.ts';
import { globToRegExp } from '../scripts/lib/http.ts';
import { planIssues, TITLE_PREFIX } from '../scripts/lib/issues.ts';
import type { RunEntry, SourceConfig } from '../scripts/lib/types.ts';
import { transform as epoch } from '../scripts/sources/epoch.ts';
import { releaseRows, releasesFromScript, slug } from '../scripts/sources/livebench.ts';
import { entryRow, readLeaderboards } from '../scripts/sources/swebench.ts';

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

test('SWE-bench: same-agent runs and submitted systems are separate columns', () => {
  const doc = {
    leaderboards: [
      {
        name: 'Verified',
        results: [
          { name: 'Claude 4.5 Opus (high)', agent: 'mini-SWE-agent', 'mini-swe-agent_version': '2.0.0', folder: '20260217_mini_opus', resolved: 76.8, instance_cost: 0.75, reasoning_effort: 'high', tags: ['Model: claude-4-5-opus', 'Org: Anthropic'], model_display: 'Claude 4.5 Opus', date: '2026-02-17', site: 'https://www.anthropic.com' },
          { name: 'Sonar Foundation Agent + Claude 4.5 Opus', agent: 'Sonar Foundation Agent', folder: '20251205_sonar_opus', resolved: 79.2, instance_cost: 0, tags: ['Model: claude-opus-4-5'], model_display: 'Claude 4.5 Opus', checked: false },
          { name: 'Warp', agent: 'Warp', folder: '20250901_warp', resolved: 75.6, tags: ['Model: gpt-5', 'Model: claude-sonnet-4-20250514'], model_display: 'Multiple' },
          { name: 'Broken', folder: 'x' },
        ],
      },
    ],
  };
  const { rows, metrics, problems } = readLeaderboards(doc);
  assert.deepEqual(problems, ['verified/x has no "resolved" number']);
  assert.deepEqual(metrics.map((m) => m.id), ['verified/bash-only', 'verified/bash-only-cost', 'verified/agents']);
  const [mini, sonar, warp] = rows;
  assert.deepEqual([mini!.model, mini!.model_label, mini!.run_by, mini!.context], ['claude-4-5-opus', 'Claude 4.5 Opus', 'independent', { agent: 'mini-SWE-agent 2.0.0', reasoning_effort: 'high effort' }]);
  assert.deepEqual(mini!.scores, { 'verified/bash-only': 76.8, 'verified/bash-only-cost': 0.75 });
  assert.deepEqual([sonar!.model, sonar!.run_by, sonar!.scores], ['claude-opus-4-5', 'submitted', { 'verified/agents': 79.2 }]);
  assert.equal(sonar!.upstream_url, 'https://github.com/SWE-bench/experiments/tree/main/evaluation/verified/20251205_sonar_opus');
  // A system using several models is filed under its own name.
  assert.deepEqual([warp!.model, warp!.model_label, warp!.context?.['models']], ['Warp', undefined, 'gpt-5 + claude-sonnet-4-20250514']);
  assert.equal(entryRow('lite', { name: 'n', resolved: 1 }).problem, 'an entry on the lite board has no folder');
});

test('LiveBench: per-release columns, with averages computed as its site does', () => {
  const v1 = releaseRows(
    {
      gen: 'v1',
      id: '2026-06-25',
      categories: { Coding: ['code_generation', 'code_completion'], IF: ['paraphrase', 'simplify'] },
      records: [
        { model: 'model-a', code_generation: '80', code_completion: '60', paraphrase: '50', simplify: '40' },
        { model: 'model-b', code_generation: '70', code_completion: '', paraphrase: '', simplify: 'n/a' },
      ],
      url: 'https://livebench.ai/#/release/2026-06-25',
    },
    false,
  );
  assert.deepEqual(v1.problems, []);
  assert.equal(slug('IF'), 'instruction_following');
  assert.deepEqual(v1.rows[0]!.scores, {
    'v1/2026-06-25/code_generation': 80,
    'v1/2026-06-25/code_completion': 60,
    'v1/2026-06-25/coding': 70,
    'v1/2026-06-25/paraphrase': 50,
    'v1/2026-06-25/simplify': 40,
    'v1/2026-06-25/instruction_following': 45,
    'v1/2026-06-25/global': 57.5,
  });
  // A model missing a whole category gets no global average; a missing task is left out of its category.
  assert.deepEqual(v1.rows[1]!.scores, { 'v1/2026-06-25/code_generation': 70, 'v1/2026-06-25/coding': 70 });
  assert.deepEqual(v1.metrics.filter((m) => m.headline), []);

  // 2.0: one column per suite, a weighted Overall, and cost per task. These are Claude Fable 5.2's
  // numbers from the 2026-11-06 release; LiveBench's site shows Overall 84.9 and $9.850 per
  // successful task for them.
  const v2 = releaseRows(
    {
      gen: 'v2',
      id: '20261106',
      categories: {
        'Long Agentic': ['long_agentic'], Reasoning: ['reasoning'], Coding: ['coding'], Browser: ['browser'],
        'Data Analysis': ['data_analysis'], Research: ['research'], Design: ['design'],
        _overall_weights: { 'Long Agentic': 2, Coding: 1.5, Design: 1.5 },
      },
      records: [{ model: 'claude-fable-5.2', long_agentic: '82.9', reasoning: '88.8', coding: '79.2', browser: '86.9', data_analysis: '81.5', research: '94.5', design: '85.1' }],
      cost: [{ model: 'claude-fable-5.2', design: '180.0986', research: '291.8870', browser: '333.4411', coding: '86.0849', long_agentic: '2896.7024', data_analysis: '74.745184', reasoning: '33.138964', nq_design: '25', nq_research: '22', nq_browser: '25', nq_coding: '24', nq_long_agentic: '18', nq_data_analysis: '150', nq_reasoning: '202' }],
      url: 'https://livebench.ai/#/release/2026-11-06',
    },
    true,
  );
  assert.deepEqual(v2.problems, []);
  const s = v2.rows[0]!.scores;
  assert.equal(s['v2/2026-11-06/overall'], 84.883);
  assert.equal(s['v2/2026-11-06/long_agentic'], 82.9);
  assert.equal(s['v2/2026-11-06/cost_per_task'], 8.3607);
  assert.equal(((s['v2/2026-11-06/cost_per_task'] as number) / (s['v2/2026-11-06/overall'] as number)) * 100 > 9.849, true);
  assert.deepEqual(v2.metrics.filter((m) => m.headline).length, 8);
  assert.equal(v2.metrics.find((m) => m.id === 'v2/2026-11-06/long_agentic')?.label, 'LiveBench 2.0 (2026-11-06) Long Agentic');
});

test('LiveBench: release lists are read from the site script, or the run is held', () => {
  const js = 'x=["20261014","20261025"],en=[...["2024-06-24","2026-06-25"].map(e=>({id:e,label:e,gen:"v1"})),...Jt.map(e=>({id:e,label:Xt(e),gen:"v2"}))];fetch(`${a}/table.csv?v=1794519350`)';
  assert.deepEqual(releasesFromScript(js), { v1: ['2024-06-24', '2026-06-25'], v2: ['20261014', '20261025'], version: '1794519350', problems: [] });
  assert.equal(releasesFromScript('nothing here').problems.length, 2);
});
