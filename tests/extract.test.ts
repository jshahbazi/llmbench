import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, looksNumeric, mappingFrom } from '../scripts/lib/extract.ts';
import { atPath, detectFormat, parseDelimited, parseRecords, tableToRecords } from '../scripts/lib/parse.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('CSV: quotes, doubled quotes, embedded newlines and commas, CRLF, BOM', () => {
  const t = parseDelimited('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",2\n');
  assert.deepEqual(t, [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '2']]);
});

test('duplicate header names get a suffix instead of overwriting', () => {
  assert.deepEqual(tableToRecords([['Score', 'Score'], ['1', '2']]), [{ Score: '1', 'Score (2)': '2' }]);
});

test('format detection and dot paths', () => {
  assert.equal(detectFormat('/a/b/data.yml'), 'yaml');
  assert.equal(detectFormat('/data_overall', 'text/csv; charset=utf-8'), 'csv');
  assert.equal(detectFormat('/x.parquet'), 'parquet');
  assert.deepEqual(atPath({ data: { rows: [1] } }, '$.data.rows[*]'), [1]);
});

test('JSON objects keyed by name become records with _key', async () => {
  const recs = await parseRecords(enc('{"board":{"m1":{"s":1},"m2":{"s":2}}}'), 'json', 'board');
  assert.deepEqual(recs, [{ _key: 'm1', s: 1 }, { _key: 'm2', s: 2 }]);
});

test('looksNumeric accepts score formats and rejects names with digits', () => {
  for (const v of ['77.47%', '1,312', '0.5', '.5', '1312 (+5/-4)', '45.2 ± 1.1', 3]) assert.ok(looksNumeric(v), String(v));
  for (const v of ['GPT-4o', 'Claude-Opus-4-5 (FC)', 'N/A', '2024-12-21']) assert.ok(!looksNumeric(v), String(v));
});

const wide = [
  { Rank: '1', Model: 'A (FC)', Link: 'https://a', 'Overall Acc': '77.47%', Cost: '86.5', Org: 'X' },
  { Rank: '2', Model: 'B', Link: 'N/A', 'Overall Acc': '70.00%', Cost: 'N/A', Org: 'Y' },
];

test('wide tables take every numeric column when scores are not listed', () => {
  const out = extract(wide, mappingFrom({ model: 'Model', model_url: 'Link', ignore: ['Rank'], lower_is_better: ['Cost'] }, 't'));
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.rows[0], {
    key: 'A (FC)',
    model: 'A (FC)',
    model_url: 'https://a',
    scores: { 'Overall Acc': '77.47%', Cost: '86.5' },
    extra: { Org: 'X' },
  });
  assert.deepEqual(out.rows[1]?.scores, { 'Overall Acc': '70.00%' });
  assert.deepEqual(
    out.metrics.map((m) => [m.id, m.direction, m.unit]),
    [['Cost', 'lower', 'score'], ['Overall Acc', 'higher', 'percent']],
  );
});

test('a column named in the mapping but missing upstream is a problem', () => {
  const out = extract(wide, mappingFrom({ model: 'Model Name' }, 't'));
  assert.deepEqual(out.problems, ['missing column "Model Name"']);
  assert.equal(out.rows.length, 0);
});

test('repeated rows hold by default, or are left out with duplicates: drop', () => {
  const recs = [...wide, { ...wide[0], 'Overall Acc': '60%' }];
  assert.match(extract(recs, mappingFrom({ model: 'Model' }, 't')).problems[0]!, /duplicate rows: "A \(FC\)"/);
  const dropped = extract(recs, mappingFrom({ model: 'Model', duplicates: 'drop' }, 't'));
  assert.deepEqual(dropped.problems, []);
  assert.deepEqual(dropped.rows.map((r) => r.model), ['B']);
  assert.equal(dropped.warnings.length, 1);
});

test('key and context make repeated model names distinct', () => {
  const recs = [
    { dirname: 'run1', model: 'm', edit_format: 'whole', pass: 10 },
    { dirname: 'run2', model: 'm', edit_format: 'diff', pass: 20 },
  ];
  const out = extract(recs, mappingFrom({ model: 'model', key: 'dirname', context: ['edit_format'], scores: ['pass'] }, 't'));
  assert.deepEqual(out.rows.map((r) => [r.key, r.context?.['edit_format'], r.scores['pass']]), [['run1', 'whole', 10], ['run2', 'diff', 20]]);
});

const long = [
  { m: 'A', cfg: 'text', cat: 'overall', r: 1500.04, lo: 1490.01, hi: 1510.09, votes: 100, org: 'x', d: '2026-11-09' },
  { m: 'A', cfg: 'text', cat: 'coding', r: 1490.96, lo: 1480, hi: 1500, votes: 50, org: 'x', d: '2026-11-09' },
  { m: 'B', cfg: 'text', cat: 'overall', r: 1400, lo: 1390, hi: 1410, votes: 80, org: 'y', d: '2026-11-09' },
];

test('long tables group into one row per model, with intervals and per-metric extras', () => {
  const out = extract(
    long,
    mappingFrom({ model: 'm', key: ['m', 'cfg'], metric: ['cfg', 'cat'], value: 'r', ci: ['lo', 'hi'], date: 'd', unit: 'elo', round: 1, headline: ['text/overall'] }, 't'),
  );
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.rows[0], {
    key: 'A|text',
    model: 'A',
    date: '2026-11-09',
    scores: { 'text/overall': 1500, 'text/coding': 1491 },
    ci: { 'text/overall': [1490, 1510.1], 'text/coding': [1480, 1500] },
    extra: { org: 'x', per_metric: { 'text/overall': { votes: 100 }, 'text/coding': { votes: 50 } } },
  });
  assert.deepEqual(out.metrics.map((m) => [m.id, m.unit, m.headline]), [['text/coding', 'elo', false], ['text/overall', 'elo', true]]);
});

test('filter keeps only matching records', () => {
  const out = extract(long, mappingFrom({ model: 'm', metric: 'cat', value: 'r', filter: { cat: 'overall' } }, 't'));
  assert.deepEqual(out.rows.map((r) => Object.keys(r.scores)), [['overall'], ['overall']]);
});

test('mapping errors are reported with the source', () => {
  assert.throws(() => mappingFrom({}, 'source "x"'), /source "x": "model" must name a column/);
  assert.throws(() => mappingFrom({ model: 'm', metric: 'c' }, 's'), /"metric" and "value" go together/);
  assert.throws(() => mappingFrom({ model: 'm', ci: ['a'] }, 's'), /two columns/);
  assert.throws(() => mappingFrom({ model: 'm', duplicates: 'keep' }, 's'), /"hold" or "drop"/);
});

test('run_by_from reads who ran each row from a column', () => {
  const spec = mappingFrom({ model: 'm', scores: ['s'], run_by_from: { column: 'src', values: { Lab: 'independent', 'Self-Reported': 'lab' } } }, 't');
  const out = extract(
    [
      { m: 'a', s: '1', src: 'Lab' },
      { m: 'b', s: '2', src: 'Self-Reported' },
      { m: 'c', s: '3', src: 'Somebody' },
    ],
    spec,
  );
  assert.deepEqual(out.rows.map((r) => r.run_by), ['independent', 'lab', undefined]);
  assert.equal(out.rows[0]!.extra, undefined, 'the column is used, not kept as extra');
  assert.throws(() => mappingFrom({ model: 'm', run_by_from: { column: 'src', values: { x: 'maybe' } } }, 't'), /must map to one of/);
});
