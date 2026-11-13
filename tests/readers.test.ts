import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, mappingFrom } from '../scripts/lib/extract.ts';
import { detectFormat, htmlTables, parseRecords, readJsLiteral, scriptValue } from '../scripts/lib/parse.ts';
import { competitionRows, competitionsFrom } from '../scripts/sources/matharena.ts';
import { SQLITE_SCHEMA } from '../scripts/site/exports.ts';
import { schemaTables, SQL_EXAMPLES } from '../scripts/site/pages.ts';
import { benchmarkRows, contextFor, dataFileFrom, labelsFor, slugsFrom, tagsFor } from '../scripts/sources/vals.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('scripts: plain data is read without running anything', () => {
  const src = `// generated
const leaderboardData = [
  { rank: "1st", model: 'Claude "Fable"', score: "94.9%", n: .5, big: 1_000, neg: -2e3, ok: true, none: null, },
  /* a human baseline */
  { rank: "-", model: "Human*", score: "83.7%", nested: { a: [1, 2,], 'quoted key': 3 } },
];
window.other = 1;`;
  assert.deepEqual(scriptValue(src, 'leaderboardData'), [
    { rank: '1st', model: 'Claude "Fable"', score: '94.9%', n: 0.5, big: 1000, neg: -2000, ok: true, none: null },
    { rank: '-', model: 'Human*', score: '83.7%', nested: { a: [1, 2], 'quoted key': 3 } },
  ]);
  assert.equal(readJsLiteral('`line one\\nstill \\`quoted\\``', 0), 'line one\nstill `quoted`');
  assert.throws(() => scriptValue('const x = `a ${b}`', 'x'), /\$\{…\}/);
  assert.throws(() => scriptValue('const x = fetch("y")', 'x'), /not plain data/);
  assert.throws(() => scriptValue('const y = 1', 'x'), /no assignment to "x"/);
  // An assignment, not a comparison or an arrow.
  assert.equal(scriptValue('if (x == 2) {}\nx = 3;', 'x'), 3);
});

test('scripts: a CSV held in a template, or a path into an object', async () => {
  assert.equal(detectFormat('https://eqbench.com/eqbench3.js?v=1'), 'js');
  const csv = 'leaderboardDataEQBench3 = `\nmodel_name,elo_norm\n*claude-opus-5,2096.4\n!some/model,1500\n`;';
  const recs = await parseRecords(enc(csv), 'js', 'leaderboardDataEQBench3');
  assert.deepEqual(recs, [
    { model_name: '*claude-opus-5', elo_norm: '2096.4' },
    { model_name: '!some/model', elo_norm: '1500' },
  ]);
  const obj = 'const EQBENCH4_DATA = {"generated_at": "x", "models": [{"model": "a", "elo": 1300.5}]};';
  assert.deepEqual(await parseRecords(enc(obj), 'js', 'EQBENCH4_DATA.models'), [{ model: 'a', elo: 1300.5 }]);
  await assert.rejects(parseRecords(enc(obj), 'js', undefined), /"rows" names the variable/);
});

test('mapping: exclude, model_match and a CI per score column', () => {
  const spec = mappingFrom(
    {
      model: 'model_name',
      model_match: '^[*!]*(.+)$',
      scores: ['elo', 'rubric'],
      ci: { elo: ['lo', 'hi'] },
      exclude: { rank: '-' },
    },
    't',
  );
  const out = extract(
    [
      { rank: '1', model_name: '*claude-opus-5', elo: '2096.4', rubric: '76.8', lo: '2017.7', hi: '2175.0' },
      { rank: '-', model_name: 'Human baseline', elo: '1', rubric: '1', lo: '0', hi: '2' },
      { rank: '2', model_name: '!some/model', elo: '1500', rubric: '50', lo: '', hi: '' },
    ],
    spec,
  );
  assert.deepEqual(
    out.rows.map((r) => [r.model, r.scores, r.ci]),
    [
      ['claude-opus-5', { elo: '2096.4', rubric: '76.8' }, { elo: ['2017.7', '2175.0'] }],
      ['some/model', { elo: '1500', rubric: '50' }, undefined],
    ],
  );
  assert.deepEqual(out.problems, []);
  // A [low, high] pair goes on the only score of a wide table.
  const one = extract([{ m: 'a', s: '5', lo: '4', hi: '6' }], mappingFrom({ model: 'm', scores: ['s'], ci: ['lo', 'hi'] }, 't'));
  assert.deepEqual(one.rows[0]!.ci, { s: ['4', '6'] });
  assert.throws(() => mappingFrom({ model: 'm', model_match: '(' }, 't'), /not a valid regular expression/);
  assert.throws(() => mappingFrom({ model: 'm', ci: { s: ['lo'] } }, 't'), /"ci" for "s" must be two columns/);
  assert.throws(() => mappingFrom({ model: 'm', exclude: ['x'] }, 't'), /"exclude" must be a mapping/);
});

test('Vals AI: pages, data files, rows per benchmark and model, versions in labels', () => {
  assert.deepEqual(slugsFrom('<a href="/benchmarks/gpqa">x</a><a href="/benchmarks/gpqa">y</a><a href="/benchmarks/terminal-bench-4">'), ['gpqa', 'terminal-bench-4']);
  assert.equal(dataFileFrom('<script src="/_astro/benchmark_view_terminal_bench_4.B2-ATImw.json">'), 'benchmark_view_terminal_bench_4.B2-ATImw.json');
  assert.equal(dataFileFrom('<html></html>'), undefined);

  const doc = {
    metadata: {
      benchmark: 'Terminal-Bench 4.0',
      slug: 'terminal-bench-4',
      family: 'terminal_bench',
      version: '4.0',
      updated: '2026-11-11',
      industry: 'coding',
      mode: 'agentic',
      harness: 'Mini-SWE-agent',
      archived: false,
      use_cost_per_test: true,
      tasks: { overall: 'Overall', '<15 min fix': '<15 min fix', software: 'Software' },
    },
    tasks: {
      overall: {
        'anthropic/claude-fable-5-2': { accuracy: 65.152, stderr: 2.314, cost_per_test: 14.564414, latency: 3307.186, compute_effort: 'high', provider: 'Anthropic' },
        'openai/gpt-6-astra': { accuracy: 60, stderr: 0, cost_per_test: 0, reasoning_effort: 'xhigh' },
      },
      '<15 min fix': { 'anthropic/claude-fable-5-2': { accuracy: 90 } },
      software: { 'anthropic/claude-fable-5-2': { accuracy: 55.556 }, 'openai/gpt-6-astra': { accuracy: null } },
    },
  };
  const out = benchmarkRows('terminal-bench-4', doc);
  assert.deepEqual(out.problems, []);
  const fable = out.rows[0]!;
  assert.equal(fable.key, 'terminal-bench-4/anthropic/claude-fable-5-2');
  assert.deepEqual(fable.context, { reasoning_effort: 'high effort', agent: 'Mini-SWE-agent' });
  assert.deepEqual(fable.scores, {
    'terminal-bench-4/overall': 65.152,
    'terminal-bench-4/cost_per_test': 14.564414,
    'terminal-bench-4/latency': 3307.19,
    'terminal-bench-4/under-15-min-fix': 90,
    'terminal-bench-4/software': 55.556,
  });
  assert.deepEqual(fable.ci, { 'terminal-bench-4/overall': [60.617, 69.687] });
  assert.deepEqual(out.rows[1]!.scores, { 'terminal-bench-4/overall': 60 }, 'no zero cost, no interval from a zero error');
  const overall = out.metrics.find((m) => m.id === 'terminal-bench-4/overall')!;
  assert.deepEqual([overall.label, overall.unit, overall.headline, overall.family, overall.tags], ['Terminal-Bench 4.0', 'percent', true, 'terminal-bench-accuracy', ['coding', 'agents']]);
  assert.equal(out.metrics.find((m) => m.id === 'terminal-bench-4/under-15-min-fix')!.label, 'Terminal-Bench 4.0: <15 min fix');
  assert.equal(out.metrics.find((m) => m.id === 'terminal-bench-4/cost_per_test')!.direction, 'lower');

  // Retired benchmarks are kept but not headline; a rating scale is not a percentage.
  const poker = benchmarkRows('poker_agent', { metadata: { benchmark: 'Agent Poker Bench', archived: true, tasks: { overall: 'Overall' } }, tasks: { overall: { m: { accuracy: 1131.8 } } } });
  assert.deepEqual([poker.metrics[0]!.unit, poker.metrics[0]!.headline], ['score', false]);
  assert.deepEqual(benchmarkRows('x', { metadata: { visible: false }, tasks: { overall: { m: { accuracy: 1 } } } }).rows, []);
  assert.match(benchmarkRows('x', { metadata: {}, tasks: {} }).problems[0]!, /no overall/);

  const labels = labelsFor([
    { slug: 'code-migration', doc: { metadata: { benchmark: 'Code Migration', version: '1' } } },
    { slug: 'code-migration-v1-1', doc: { metadata: { benchmark: 'Code Migration', version: '1.1' } } },
    { slug: 'gpqa', doc: { metadata: { benchmark: 'GPQA', version: '1' } } },
  ]);
  assert.deepEqual([...labels.values()], ['Code Migration v1', 'Code Migration v1.1', 'GPQA']);
  assert.deepEqual(tagsFor({ industry: 'academic', mode: 'one-shot' }, 'mmmu'), ['knowledge', 'vision']);
  assert.deepEqual(contextFor({}, {}), {});
});

const ARENA_TABLE = `<table class="other-table"><thead><tr>
  <th title="Rank">Rank</th><th>Model Name</th><th>Provider</th><th>Accuracy (± 95% CI)</th><th>Cost</th><th>Open</th>
</tr></thead><tbody>
<tr class="model-row" data-config="openai/gpt-61-sol"><td>1</td><td><a href="/models/x">GPT-6.1 Sol (max)</a></td><td>OpenAI</td>
  <td data-predicted="no"><span>90.43%</span> <span class="small-ci">± 5.95%</span></td><td>$1.21</td><td>❌</td></tr>
<tr class="model-row" data-config="openai/gpt-5"><td>2</td><td>GPT-5 (high) <span class="contamination-warning" title="Model was released after competition release.">⚠️</span></td><td>OpenAI</td>
  <td data-predicted="no">38.10% ± 19.43%</td><td>$8.94</td><td>❌</td></tr>
<tr class="model-row" data-config="x/est"><td>3</td><td>Estimated &amp; Co</td><td>X</td>
  <td data-predicted="yes"><span class="predicted-tooltip"><span>87.66%</span><span class="predicted-tooltip__bubble" role="tooltip">Includes estimated scores</span></span></td><td>$0.10</td><td>✅</td></tr>
</tbody></table>`;

test('HTML tables: header, cells without tooltips, row attributes; the html format', async () => {
  const [t] = htmlTables(ARENA_TABLE);
  assert.deepEqual(t!.header, ['Rank', 'Model Name', 'Provider', 'Accuracy (± 95% CI)', 'Cost', 'Open']);
  assert.equal(t!.rows[0]!.attrs['data-config'], 'openai/gpt-61-sol');
  assert.equal(t!.rows[0]!.cells[3]!.text, '90.43% ± 5.95%');
  assert.equal(t!.rows[2]!.cells[1]!.text, 'Estimated & Co');
  assert.equal(t!.rows[2]!.cells[3]!.text, '87.66%', 'the tooltip text is left out');
  assert.equal(detectFormat('x', 'text/html; charset=utf-8'), 'html');
  const recs = await parseRecords(enc(`<p>intro</p>${ARENA_TABLE}`), 'html', undefined);
  assert.deepEqual(recs[0], { 'data-config': 'openai/gpt-61-sol', Rank: '1', 'Model Name': 'GPT-6.1 Sol (max)', Provider: 'OpenAI', 'Accuracy (± 95% CI)': '90.43% ± 5.95%', Cost: '$1.21', Open: '❌' });
  await assert.rejects(parseRecords(enc('<p>no table</p>'), 'html', undefined), /no HTML table/);
});

test('MathArena: competitions from the home page, measured scores only, flags kept', () => {
  const home = `<button class="button competition-button" data-competition-id="arxiv--october" data-competition-key="arxiv--october" data-default-open="true">10/2026</button>
    <button data-competition-id="overall--final_answer_comps" data-default-open="false">Overall</button>
    <button data-competition-id="aime--aime_2026" data-default-open="false">AIME 2026</button>
    <button data-competition-id="euler--euler" data-default-open="false">Project Euler <select><option>x</option></select></button>`;
  assert.deepEqual(competitionsFrom(home), [
    { id: 'arxiv--october', label: 'ArXivMath 2026-10', headline: true },
    { id: 'overall--final_answer_comps', label: 'Final-answer competitions overall', headline: true },
    { id: 'aime--aime_2026', label: 'AIME 2026', headline: false },
    { id: 'euler--euler', label: 'Project Euler', headline: false },
  ]);
  const out = competitionRows({ id: 'arxiv--october', label: 'ArXivMath 2026-10', headline: true }, { table: ARENA_TABLE, problem_table: '' });
  assert.deepEqual(out.problems, []);
  assert.equal(out.rows.length, 2, 'the estimated-only row has no measured score');
  const [sol, gpt5] = out.rows;
  assert.deepEqual([sol!.key, sol!.model, sol!.scores, sol!.ci], ['arxiv--october/openai/gpt-61-sol', 'GPT-6.1 Sol (max)', { 'arxiv--october/accuracy': 90.43, 'arxiv--october/cost': 1.21 }, { 'arxiv--october/accuracy': [84.48, 96.38] }]);
  assert.equal(gpt5!.model, 'GPT-5 (high)');
  assert.equal(gpt5!.extra!['released_after_competition'], true);
  const acc = out.metrics.find((m) => m.id === 'arxiv--october/accuracy')!;
  assert.deepEqual([acc.label, acc.family, acc.headline, acc.unit], ['MathArena ArXivMath 2026-10', 'matharena-arxivmath', true, 'percent']);
  assert.deepEqual(competitionRows({ id: 'x--y', label: 'X', headline: false }, { table: '<div>legend</div>' }), { rows: [], metrics: [], problems: [] });
});

test('SQL page: tables and columns from the download schema; examples name real tables', () => {
  const t = schemaTables(SQLITE_SCHEMA);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.name}`), ['table:about', 'table:sources', 'table:models', 'table:benchmarks', 'table:names', 'table:scores', 'view:scores_named']);
  assert.deepEqual(t.find((x) => x.name === 'names')!.columns, ['source', 'source_model_name', 'model_id', 'method', 'qualifiers', 'scores']);
  assert.deepEqual(t.at(-1)!.columns, ['model', 'benchmark', 'source', 'value', 'unit', 'higher_is_better', 'run_by', 'date', 'context', 'url', 'source_license']);
  const names = new Set(t.map((x) => x.name));
  for (const [, q] of SQL_EXAMPLES) assert.ok([...q.matchAll(/\bFROM\s+(\w+)/gi)].every((m) => names.has(m[1]!)), q);
});
