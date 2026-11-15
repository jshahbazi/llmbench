import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryFile, type SiteData } from '../scripts/site/data.ts';
import { buildPages } from '../scripts/site/pages.ts';
import {
  BASIS_ESTIMATED,
  BASIS_INDEPENDENT,
  BASIS_LAB,
  computeSummary,
  fitAbilities,
  MAX_PASSES,
  parseSummaryYaml,
  type SummaryCandidate,
  type SummaryColumn,
  type SummarySpec,
} from '../scripts/lib/summary.ts';

const sigmoid = (y: number) => 1 / (1 + Math.exp(-y));

/** A spec with one column per benchmark: areas "A" (b0..) and "B". */
function spec(areas: Record<string, string[]>, minBenchmarks = 2, minAreas = 1): SummarySpec {
  return {
    id: 'coding',
    label: 'Coding score',
    description: '',
    minBenchmarks,
    minAreas,
    areas: Object.entries(areas).map(([name, ids]) => ({ name, benchmarks: ids.map((id) => ({ name: id, columns: [`s:${id}`] })) })),
  };
}

type Table = Record<string, Record<number, SummaryCandidate[] | number>>;

/** Columns and a cells() reader from { columnId: { model: value | candidates } }. */
function data(table: Table, units: Record<string, string> = {}) {
  const ids = Object.keys(table);
  const columns: SummaryColumn[] = ids.map((id) => ({ id, unit: units[id] ?? 'percent', direction: 'higher' }));
  const cells = (ci: number) =>
    Object.entries(table[ids[ci]!]!).map(([m, v]) => [Number(m), typeof v === 'number' ? [{ value: v, runBy: 0, flags: 0 }] : v] as const);
  return { columns, cells };
}

/**
 * Twenty models of rising ability on four benchmarks of rising difficulty, exactly as the fit
 * models them. `has(model, benchmark)` says which results exist.
 */
function world(has: (m: number, b: number) => boolean) {
  const difficulty = [-2, -0.5, 0.5, 2];
  const ability = (m: number) => -2 + (4 * m) / 19;
  const truth = (m: number, b: number) => 100 * sigmoid(1.5 * (ability(m) - difficulty[b]!));
  const table: Table = {};
  for (let b = 0; b < 4; b++) {
    table[`s:b${b}`] = {};
    for (let m = 0; m < 20; m++) if (has(m, b)) table[`s:b${b}`]![m] = truth(m, b);
  }
  return { table, truth };
}

test('summary file: areas, benchmarks, thresholds, and every problem reported', () => {
  const ok = parseSummaryYaml(`
coding:
  label: Coding score
  description: Writing software.
  min_benchmarks: 2
  min_areas: 1
  areas:
    Repositories:
      SWE-bench Verified: [whatmodel:swe-bench-verified, vals:swebench/overall]
    Apps:
      Arena WebDev: ["arena:webdev/overall"]
`);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.specs, [
    {
      id: 'coding',
      label: 'Coding score',
      description: 'Writing software.',
      minBenchmarks: 2,
      minAreas: 1,
      areas: [
        { name: 'Repositories', benchmarks: [{ name: 'SWE-bench Verified', columns: ['whatmodel:swe-bench-verified', 'vals:swebench/overall'] }] },
        { name: 'Apps', benchmarks: [{ name: 'Arena WebDev', columns: ['arena:webdev/overall'] }] },
      ],
    },
  ]);
  assert.deepEqual(parseSummaryYaml(undefined), { specs: [], problems: [] });

  const bad = parseSummaryYaml(`
Coding: { label: x, min_benchmarks: 2, min_areas: 1, areas: { A: { b: ["s:b"] } } }
one:
  label: One
  weight: 3
  min_benchmarks: 5
  min_areas: 0
  areas:
    A:
      First: ["s:a", "nocolon"]
      Second: ["s:a"]
    B:
      First: []
`).problems.join('\n');
  assert.match(bad, /Coding: a score id must be lower case/);
  assert.match(bad, /one: unknown field "weight"/);
  assert.match(bad, /"First": "nocolon" must be <source>:<metric>/);
  assert.match(bad, /column s:a is listed twice/);
  assert.match(bad, /"First" needs a list of columns/);
  assert.match(bad, /"min_benchmarks" is 5 but the score has only 2 benchmarks/);
  assert.match(bad, /"min_areas" must be a whole number, at least 1/);
});

test('the fit recovers values it was not shown', () => {
  // Every model is missing one benchmark, in rotation.
  const { table, truth } = world((m, b) => m % 4 !== b);
  const { columns, cells } = data(table);
  const r = computeSummary(spec({ A: ['b0', 'b1'], B: ['b2', 'b3'] }, 3, 2), columns, cells);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.scored, 20);
  for (const e of r.models) {
    e.parts.forEach((p, b) => {
      assert.equal(p!.basis, e.model % 4 === b ? BASIS_ESTIMATED : BASIS_INDEPENDENT);
      // An estimate stops at the best and worst values models actually scored on the benchmark.
      const scored = Object.values(table[`s:b${b}`]!) as number[];
      const expected = Math.min(Math.max(...scored), Math.max(Math.min(...scored), truth(e.model, b)));
      assert.ok(Math.abs(p!.value - expected) < 1.5, `model ${e.model} benchmark ${b}: ${p!.value} vs ${expected}`);
    });
    assert.equal(e.measured, 3);
  }
  // Best first, ranked from 1.
  assert.deepEqual(r.models.map((e) => e.model), [...Array(20).keys()].reverse());
  assert.deepEqual(r.models.map((e) => e.rank), [...Array(20).keys()].map((i) => i + 1));

  const values = [0, 1, 2, 3].map((b) => new Map(Object.entries(table[`s:b${b}`]!).map(([m, v]) => [Number(m), Math.log((v as number) / (100 - (v as number)))])));
  assert.ok(fitAbilities(values, [1, 1, 1, 1]).passes < MAX_PASSES, 'the fit settles');
});

test('a model tested only on easy benchmarks does not outrank an abler one tested only on hard ones', () => {
  // Model 10 has only the two easy benchmarks; model 15 only the two hard ones. The rest have all four.
  const { table, truth } = world((m, b) => (m === 10 ? b < 2 : m === 15 ? b >= 2 : true));
  const { columns, cells } = data(table);
  const r = computeSummary(spec({ A: ['b0', 'b2'], B: ['b1', 'b3'] }, 2, 2), columns, cells);
  const of = (m: number) => r.models.find((e) => e.model === m)!;
  const plain = (m: number) => {
    const have = of(m).parts.filter((p) => p!.basis !== BASIS_ESTIMATED).map((p) => p!.value);
    return have.reduce((s, v) => s + v, 0) / have.length;
  };
  assert.ok(plain(10) > plain(15), 'averaging only what exists puts the weaker model ahead');
  assert.ok(of(15).value! > of(10).value!, 'the summary score does not');
  for (const m of [10, 15]) {
    const whole = [0, 1, 2, 3].reduce((s, b) => s + truth(m, b), 0) / 4;
    assert.ok(Math.abs(of(m).value! - whole) < 2, `model ${m}: ${of(m).value} vs ${whole} over all four`);
  }
});

test('independent runs come first, flagged runs are not used, and several columns feed one value', () => {
  const others = Object.fromEntries([...Array(12).keys()].map((m) => [m + 10, 40 + 3 * m]));
  const table: Table = {
    's:lab': { ...others, 1: [{ value: 0.9, runBy: 2, flags: 0 }], 2: [{ value: 0.95, runBy: 2, flags: 0 }] },
    's:run': {
      1: [
        { value: 70, runBy: 0, flags: 0 },
        { value: 74, runBy: 0, flags: 0 },
        { value: 99, runBy: 0, flags: 2 },
      ],
      3: [{ value: 55, runBy: 1, flags: 0 }],
    },
    's:other': { ...others, 1: 60, 2: 60, 3: 60 },
  };
  const s: SummarySpec = {
    ...spec({}),
    areas: [{ name: 'A', benchmarks: [{ name: 'Bench', columns: ['s:lab', 's:run'] }, { name: 'Other', columns: ['s:other'] }] }],
  };
  const { columns, cells } = data(table, { 's:lab': 'fraction' });
  const r = computeSummary(s, columns, cells);
  const part = (m: number) => r.models.find((e) => e.model === m)!.parts[0]!;
  // The maker reports 90%, an independent run got 74: the independent run is used, and its best.
  assert.deepEqual(part(1), { value: 74, basis: BASIS_INDEPENDENT, column: 1 });
  // With only the maker's number, that is used, as a percentage.
  assert.deepEqual(part(2), { value: 95, basis: BASIS_LAB, column: 0 });
  assert.equal(part(3).basis, 2);
  assert.equal(r.benchmarks[0]!.models, 15);
  assert.equal(r.benchmarks[0]!.independent, 13);
});

test('Elo ratings become the expected share of wins against the median model', () => {
  const ratings = Object.fromEntries([...Array(11).keys()].map((m) => [m, 1000 + 40 * m]));
  const { columns, cells } = data({ 's:elo': ratings, 's:pct': Object.fromEntries([...Array(11).keys()].map((m) => [m, 30 + 5 * m])) }, { 's:elo': 'elo' });
  const r = computeSummary(spec({ A: ['elo', 'pct'] }), columns, cells);
  const b = r.benchmarks[0]!;
  assert.equal(b.elo, true);
  assert.equal(b.reference, 1200);
  assert.equal(b.topTenSpread, 360);
  const part = (m: number) => r.models.find((e) => e.model === m)!.parts[0]!;
  assert.equal(part(5).value, 50);
  assert.equal(part(5).rating, 1200);
  assert.ok(Math.abs(part(10).value - 100 / (1 + 10 ** (-200 / 400))) < 1e-9);
  assert.equal(r.benchmarks[1]!.topTenSpread, 45);
});

test('too little evidence gives no score, and an estimate stays within what models have scored', () => {
  const { table } = world((m, b) => (m === 19 ? b === 0 || b === 1 : m === 0 ? b === 0 : true));
  const { columns, cells } = data(table);
  const r = computeSummary(spec({ A: ['b0', 'b1'], B: ['b2', 'b3'] }, 2, 2), columns, cells);
  // Model 19, the ablest, has two results but in one area; model 0 has one result.
  for (const m of [19, 0]) {
    const e = r.models.find((x) => x.model === m)!;
    assert.equal(e.value, undefined);
    assert.equal(e.rank, undefined);
    assert.ok(e.parts.every((p) => p === null || p.basis !== BASIS_ESTIMATED), 'no estimates without a score');
  }
  assert.equal(r.scored, 18);
  assert.equal(r.models.at(-1)!.model, 0);

  // Asked for one area only, model 19 gets a score.
  const one = computeSummary(spec({ A: ['b0', 'b1'], B: ['b2', 'b3'] }, 2, 1), columns, cells);
  assert.equal(one.scored, 19);
  assert.ok(one.models.find((x) => x.model === 19)!.value! > 80);

  // Twelve ordinary models, one far above them and one far below, both with no result on b1. Their
  // estimates for it stop at the best and the worst score any model has there.
  const field = (base: number) => Object.fromEntries([...Array(12).keys()].map((m) => [m, base + 3 * m]));
  const far = data({ 's:b0': { ...field(20), 98: 2, 99: 90 }, 's:b1': field(25), 's:b2': { ...field(30), 98: 3, 99: 92 } });
  const r2 = computeSummary(spec({ A: ['b0', 'b1', 'b2'] }), far.columns, far.cells);
  const b1 = (m: number) => r2.models.find((x) => x.model === m)!.parts[1]!;
  assert.deepEqual(b1(99), { value: 58, basis: BASIS_ESTIMATED });
  assert.deepEqual(b1(98), { value: 25, basis: BASIS_ESTIMATED });
  assert.deepEqual([r2.models[0]!.model, r2.models.at(-1)!.model], [99, 98]);
});

test('problems in the data are reported, not fatal', () => {
  const many = (base: number) => Object.fromEntries([...Array(12).keys()].map((m) => [m, base + 2 * m]));
  const { columns, cells } = data(
    { 's:ok': many(40), 's:ok2': many(30), 's:few': { 0: 50, 1: 60 }, 's:low': many(10), 's:scaled': Object.fromEntries([...Array(12).keys()].map((m) => [m, 0.4 + 0.02 * m])) },
    { 's:low': 'percent' },
  );
  columns[3]!.direction = 'lower';
  const s: SummarySpec = {
    ...spec({}),
    areas: [
      { name: 'A', benchmarks: [{ name: 'Ok', columns: ['s:ok', 's:scaled'] }, { name: 'Ok2', columns: ['s:ok2'] }, { name: 'Few', columns: ['s:few'] }] },
      { name: 'B', benchmarks: [{ name: 'Gone', columns: ['s:missing'] }, { name: 'Low', columns: ['s:low'] }] },
    ],
  };
  const r = computeSummary(s, columns, cells);
  const w = r.warnings.join('\n');
  assert.match(w, /Few is left out: 2 models have a result, and it takes 10/);
  assert.match(w, /Gone: no column s:missing in the data/);
  assert.match(w, /Low: s:low is not a higher-is-better percentage or Elo rating/);
  // s:scaled is a 0-1 fraction labelled as a percentage: it disagrees with s:ok by about 50 points.
  assert.match(w, /Ok: s:ok and s:scaled differ by a median of \d+\.\d over 12 models/);
  assert.match(w, /area "B" has no usable benchmark and is left out/);
  assert.deepEqual(r.areas, ['A']);
  assert.deepEqual(r.benchmarks.map((b) => b.name), ['Ok', 'Ok2']);
  assert.equal(r.scored, 12);
});

test('the site shows a summary score with its parts, and says why a model has none', () => {
  const { table } = world((m, b) => (m === 3 ? b === 0 : m % 4 !== b || m < 3));
  const { columns, cells } = data(table);
  const summary = computeSummary(spec({ Easy: ['b0', 'b1'], Hard: ['b2', 'b3'] }, 3, 2), columns, cells);
  const d: SiteData = {
    index: {
      generated_at: '2026-11-14T00:00:00Z',
      sources: [{ id: 's', name: 'Source', homepage: 'https://s.example', terms: 'allowed', every: '6h', row_count: 1, metric_count: 4, names: 20, matched_names: 20 }],
      columns: columns.map((c, i) => ({ id: c.id, source: 's', metric: `b${i}`, label: `Bench ${i}`, direction: 'higher' as const, unit: 'percent', headline: true, slug: `b${i}`, coverage: 20 })),
      models: [...Array(20).keys()].map((m) => ({ id: `m${m}`, name: `Model ${m}` })),
      tags: [],
      stats: { invalid_excluded: 0, unparsable: 0, unlisted_models: 0 },
    },
    cells: [],
    byCell: new Map(),
    modelColumns: new Map(),
    columnModels: new Map(),
    names: new Map(),
    history: new Map(),
    scores: [],
    summaries: [summary],
    config: [],
  };
  const file = summaryFile(d);
  assert.equal(file.scores[0]!.rows.length, 19);
  const [mi, value, measured, areaValues, values, basis] = file.scores[0]!.rows[0]!;
  assert.equal(mi, 19);
  assert.equal(measured, 3);
  assert.equal(areaValues.length, 2);
  assert.equal(values.length, 4);
  assert.deepEqual(basis, [1, 1, 1, 0]);
  assert.equal(value, Math.round(((areaValues[0]! + areaValues[1]!) / 2) * 10) / 10);

  const pages = buildPages(d);
  const page = (path: string) => pages.find((p) => p.path === path)!.html;
  const board = page('summary/');
  assert.match(board, /<h2 id="coding">Coding score <span class="muted">19 models<\/span>/);
  assert.match(board, /needs results on at least 3 of them across at least 2 areas/);
  assert.ok(board.indexOf('Model 19') < board.indexOf('Model 18'), 'best first');
  assert.ok(!board.includes('>Model 3<'), 'a model without a score is not ranked');

  const scored = page('models/m19/');
  assert.match(scored, /<h3 id="summary-coding">Coding score: \d+\.\d <span class="muted">rank 1 of 19<\/span>/);
  assert.match(scored, /Measured on 3 of its 4 benchmarks; the other 1 is estimated/);
  assert.match(scored, /<tr class="est"><td><\/td>\n<td><a href="[^"]+">b3<\/a><\/td>\n<td class="num">\d+\.\d<\/td>\n<td>estimated<\/td>/);
  assert.match(page('models/m3/'), /No <a href="..\/..\/summary\/">summary score<\/a>: it has results on 1 of the 4 benchmarks behind the coding score \(it takes 3 across 2 areas\)/);
  assert.match(page(''), /llmbench's own <a href="summary\/">summary scores<\/a>/);
});
