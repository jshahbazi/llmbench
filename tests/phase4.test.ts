import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftEntry } from '../scripts/lib/draft.ts';
import { extract as caisExtract, modelsFromScript, rliFromScript, runSetting } from '../scripts/sources/cais.ts';
import { markdownRecords, markdownTables, parseRecords } from '../scripts/lib/parse.ts';
import { metricList, submissionRow } from '../scripts/sources/tau2.ts';
import { boardsFrom, entryRow as tbRow } from '../scripts/sources/terminalbench.ts';
import { logTicks, niceTicks, yearTicks } from '../site/src/chart.ts';
import { DEFAULTS, parseState, serializeState } from '../site/src/state.ts';

const README = `# Board

Intro with a | pipe that is not a table.

## Results

|Model|Hallucination Rate|Answer Rate|Notes|
|----|----:|:---:|---|
|openai/gpt-x|1.8 %|99.5 %|**bold** and [a link](https://example.org/x)|
|org/model \\| odd|3.1 %|100.0 %|\`code | pipe\`|

## Older

| Model | Score |
| --- | --- |
| a | 1 |
`;

test('Markdown: pipe tables with their headings, escaped pipes, links and emphasis', async () => {
  const tables = markdownTables(README);
  assert.deepEqual(tables.map((t) => [t.heading, t.header.length, t.rows.length]), [['Results', 4, 2], ['Older', 2, 1]]);
  const recs = markdownRecords(README, undefined, 'readme');
  assert.deepEqual(recs[0], { Model: 'openai/gpt-x', 'Hallucination Rate': '1.8 %', 'Answer Rate': '99.5 %', Notes: 'bold and a link', 'Notes url': 'https://example.org/x' });
  assert.equal(recs[1]!['Model'], 'org/model | odd');
  assert.equal(recs[1]!['Notes'], 'code | pipe');
  assert.deepEqual(markdownRecords(README, 'older', 'readme'), [{ Model: 'a', Score: '1' }]);
  assert.deepEqual(markdownRecords(README, '1', 'readme'), [{ Model: 'a', Score: '1' }]);
  assert.throws(() => markdownRecords(README, 'missing', 'readme'), /no Markdown table matches "table: missing"/);
  assert.throws(() => markdownRecords('no tables here', undefined, 'x'), /no Markdown table found/);
  const parsed = await parseRecords(new TextEncoder().encode(README), 'markdown', '0', 'readme');
  assert.equal(parsed.length, 2);
});

test('τ²-bench: one row per submission, no contact details, who ran it from the submitter', () => {
  const sub = {
    model_name: 'Claude Opus 4.5',
    model_organization: 'Anthropic',
    submitting_organization: 'Sierra',
    submission_date: '2026-02-26',
    contact_info: { email: 'someone@example.org', name: 'A Person' },
    submission_type: 'standard',
    reasoning_effort: 'high',
    results: {
      airline: { pass_1: 84, pass_2: 77.67, cost: 0.39 },
      banking_knowledge: { pass_1: 24.74, cost: null, retrieval_config: 'alltools' },
      unknown_domain: { pass_1: 50 },
    },
    methodology: { evaluation_date: '2026-05-05', user_simulator: 'gpt-5.2', tau2_bench_version: '1.0.1' },
    model_release: { announcement_url: 'https://www.anthropic.com/news/claude-opus-4-5' },
  };
  const { row } = submissionRow('claude-opus-4-5_sierra_2026-02-26', sub, 'https://github.com/x/y/blob/sha/sub.json');
  assert.deepEqual(row!.scores, { 'airline/pass_1': 84, 'airline/pass_2': 77.67, 'airline/cost': 0.39, 'banking_knowledge/pass_1': 24.74 });
  assert.equal(row!.run_by, 'independent');
  assert.equal(row!.date, '2026-05-05');
  assert.deepEqual(row!.context, { reasoning_effort: 'high effort', user_simulator: 'user simulator gpt-5.2' });
  assert.ok(!JSON.stringify(row).includes('example.org'), 'contact details are never copied');
  assert.equal(submissionRow('x', { ...sub, submitting_organization: 'Some Lab', submission_type: 'custom' }, '').row!.run_by, 'submitted');
  assert.match(submissionRow('x', {}, '').problem!, /no model_name/);
  const metrics = metricList();
  assert.equal(metrics.filter((m) => m.headline).length, 4);
  assert.equal(metrics.find((m) => m.id === 'airline/cost')?.direction, 'lower');
});

test('add-source drafts a mapping from column names and values', () => {
  const records = [
    { Rank: '1', Model: 'Alpha 7B', 'Model Link': 'https://hf.co/a', 'Edit Format': 'diff', 'Overall Acc': '81.2%', 'Total Cost ($)': '1.20', Params: '7', Date: '2026-01-02' },
    { Rank: '2', Model: 'Alpha 7B', 'Model Link': 'https://hf.co/a', 'Edit Format': 'whole', 'Overall Acc': '79.0%', 'Total Cost ($)': '0.90', Params: '7', Date: '2026-01-03' },
    { Rank: '3', Model: 'Beta', 'Model Link': 'https://hf.co/b', 'Edit Format': 'diff', 'Overall Acc': '70.1%', 'Total Cost ($)': '3.10', Params: '70', Date: '2026-02-01' },
  ];
  const { entry, notes } = draftEntry(records, { id: 'x', fetch: 'https://example.org/x.csv' });
  assert.equal(entry['model'], 'Model');
  assert.equal(entry['model_url'], 'Model Link');
  assert.equal(entry['date'], 'Date');
  assert.deepEqual(entry['key'], ['Model', 'Edit Format']);
  assert.deepEqual(entry['context'], ['Edit Format']);
  assert.deepEqual(entry['scores'], ['Overall Acc', 'Total Cost ($)']);
  assert.deepEqual(entry['ignore'], ['Rank']);
  assert.deepEqual(entry['lower_is_better'], ['Total Cost ($)']);
  assert.ok(notes.some((n) => /"Params"/.test(n)), 'sizes are not scores');
  assert.ok(notes.some((n) => /gives 3 rows and 2 metrics/.test(n)));
});

test('chart ticks: round steps, 1-3-10 on log scales, whole years', () => {
  assert.deepEqual(niceTicks(0, 100), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(1203.4, 1471.9), [1250, 1300, 1350, 1400, 1450]);
  assert.deepEqual(logTicks(2, 1500), [3, 10, 30, 100, 300, 1000]);
  assert.deepEqual(yearTicks(2023.2, 2026.9), [2024, 2025, 2026]);
});

test('chart axes round-trip through the URL and are left out of other views', () => {
  const s = { ...DEFAULTS, view: 'chart' as const, x: 'params', y: 'arena:text/overall' };
  assert.deepEqual(parseState(serializeState(s)), s);
  assert.equal(serializeState({ ...DEFAULTS, x: 'params' }), '');
  assert.equal(parseState('?view=chart').x, 'released');
});

test('Markdown cells decode HTML entities', () => {
  const recs = markdownRecords('| Model | &mu; | &sigma; &amp; more | &#956; |\n|---|---|---|---|\n| A | 1 | 2 | 3 |\n', 0, 't');
  assert.deepEqual(Object.keys(recs[0]!), ['Model', 'μ', 'σ & more', 'μ (2)']);
});

test('Terminal-Bench: both row shapes, agent as context, Claude display names', () => {
  const b = { package: 'p', name: 'n', version: '4.1' };
  const v41 = tbRow(b, {
    id: 'u1',
    metadata: { date: '2026-09-22', agent_display: { label: 'Claude Code' }, model_display: { label: 'Opus 5.5', url: 'https://www.anthropic.com/claude-opus-5-5' }, model_org: { label: 'Anthropic' }, reasoning_effort: 'max' },
    metrics: { accuracy: 65.76, accuracy_ci95_half_width: 3.11, total_cost_usd: 4718.65, n_trials: 330 },
  }).row!;
  assert.deepEqual([v41.model, v41.model_label, v41.context], ['Opus 5.5', 'Claude Opus 5.5', { agent: 'Claude Code', reasoning_effort: 'max effort' }]);
  assert.deepEqual(v41.scores, { '4.1/accuracy': 65.76, '4.1/cost_per_trial': 14.2989 });
  assert.deepEqual(v41.ci, { '4.1/accuracy': [62.65, 68.87] });
  const b2 = { ...b, version: '2.0' };
  const one = tbRow(b2, { id: 'u2', metadata: { agent_display: { label: 'Terminus 2' }, model_display: 'GPT-5.5', model_names: ['gpt-5.5'] }, metrics: { accuracy: 60 } }).row!;
  assert.deepEqual([one.model, one.model_label], ['gpt-5.5', 'GPT-5.5']);
  const many = tbRow(b2, { id: 'u3', metadata: { agent_display: { label: 'Warp' }, model_display: 'Multiple', model_names: ['gpt-5', 'claude-haiku-4-5'] }, metrics: { accuracy: 50 } }).row!;
  assert.equal(many.model, 'Warp + gpt-5 + claude-haiku-4-5');
  assert.match(tbRow(b2, { id: 'u4', metadata: {}, metrics: {} }).problem!, /no accuracy/);
  assert.ok(boardsFrom({ boards: [{ package: 'p' }] }).problem);
});

test('CAIS dashboard: model list and RLI list from scripts, settings, skipped and unknown scores', () => {
  const blob = JSON.stringify([
    { name: 'Opus 5.5', id: 'claude-opus-5-5-high', provider: 'anthropic', scores: { hle: 55.36, masks: 89.4, swebench_pro: null, arc_agi_2: 20, new_bench: 3 }, modelCardUrl: 'https://www.anthropic.com/claude-opus-5-5', scoreNotes: { hle: 'Refuses <b>~1%</b>.<br>Falls back.' } },
    { name: "Kimi K2.6", id: 'kimi-k2.6-64k', provider: 'moonshot', scores: { hle: 35.48, pct: null } },
    { name: 'Empty', id: 'empty', provider: 'x', scores: { hle: null } },
  ]).replace(/'/g, "\\'");
  const js = `x,26974,e=>{e.v(JSON.parse('${blob}'))},63754,e=>{e.v([{name:"Fable 5.2",provider:"anthropic",rate:41.25},{name:"Gemini 2.5 Pro",provider:"google",rate:.83}])}`;
  const models = modelsFromScript(js)!;
  assert.equal(models.length, 3);
  assert.deepEqual(rliFromScript(js), [
    { name: 'Fable 5.2', provider: 'anthropic', rate: 41.25 },
    { name: 'Gemini 2.5 Pro', provider: 'google', rate: 0.83 },
  ]);
  assert.equal(modelsFromScript('JSON.parse(\'[{"a":1}]\')'), undefined);

  assert.deepEqual(runSetting('sonnet-4-6-adaptive-64k'), { reasoning: 'adaptive thinking, 64k budget' });
  assert.deepEqual(runSetting('haiku-4-5-thinking-32k'), { reasoning: 'thinking, 32k budget' });
  assert.deepEqual(runSetting('kimi-k2.6-64k'), { reasoning: '64k thinking budget' });
  assert.deepEqual(runSetting('gpt-6-astra-high'), { reasoning_effort: 'high effort' });
  assert.deepEqual(runSetting('o1'), {});

  const out = caisExtract(models, rliFromScript(js)!);
  assert.equal(out.rows.length, 4); // the model with no scores is left out
  const opus = out.rows.find((r) => r.key === 'claude-opus-5-5-high')!;
  assert.deepEqual([opus.model, opus.model_label, opus.context], ['claude-opus-5-5-high', 'Claude Opus 5.5', { reasoning_effort: 'high effort' }]);
  assert.deepEqual(opus.scores, { hle: 55.36, masks: 89.4 }); // SWE-bench Pro and ARC-AGI-2 are skipped
  assert.equal(opus.extra!['notes'], "Humanity's Last Exam (CAIS run): Refuses ~1%. Falls back.");
  const fable = out.rows.find((r) => r.key === 'rli/Fable 5.2')!;
  assert.deepEqual([fable.model, fable.model_label, fable.scores], ['Fable 5.2', 'Claude Fable 5.2', { rli: 41.25 }]);
  assert.deepEqual(out.metrics.map((m) => [m.id, m.direction, m.unit]), [
    ['hle', 'higher', 'percent'],
    ['masks', 'higher', 'percent'],
    ['rli', 'higher', 'percent'],
  ]);
  assert.deepEqual(out.metrics.filter((m) => m.headline).map((m) => m.id), ['hle', 'rli']);
  assert.deepEqual(out.problems, []);
  assert.match(out.warnings![0]!, /new_bench/);
});
