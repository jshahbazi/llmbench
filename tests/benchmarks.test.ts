import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkOf, parseBenchmarkLinks } from '../scripts/lib/curation.ts';
import type { SiteData } from '../scripts/site/data.ts';
import { buildPages } from '../scripts/site/pages.ts';
import type { Candidate } from '../site/src/select.ts';
import type { SiteColumn } from '../site/src/types.ts';

test('benchmark links: comments, columns, ids and duplicates', () => {
  const text = [
    '# a comment, then the header',
    'column,benchmark,note',
    'epoch:gpqa_diamond,gpqa-diamond,',
    'vals:gpqa/overall,gpqa-diamond,"averages two prompts, zero- and few-shot"',
    '# comments can sit anywhere',
    'terminal-bench:2.1/accuracy,terminal-bench-2.1,',
    'not a column,gpqa-diamond,',
    'cais:hle,HLE,',
    'epoch:gpqa_diamond,gpqa,',
  ].join('\n');
  const { links, problems } = parseBenchmarkLinks(text);
  assert.deepEqual([...links], [
    ['epoch:gpqa_diamond', 'gpqa-diamond'],
    ['vals:gpqa/overall', 'gpqa-diamond'],
    ['terminal-bench:2.1/accuracy', 'terminal-bench-2.1'],
  ]);
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /must be <source>:<metric>/);
  assert.match(problems[1]!, /\(cais:hle\): "benchmark" must be lower case/);
  assert.match(problems[2]!, /epoch:gpqa_diamond is listed twice/);
});

test("a benchmark links columns: curation lines, and a source's own ids where they are benchmark ids", () => {
  const cols = [
    { id: 'whatmodel:gpqa-diamond', source: 'whatmodel', metric: 'gpqa-diamond' },
    { id: 'whatmodel:mmlu', source: 'whatmodel', metric: 'mmlu' },
    { id: 'epoch:gpqa_diamond', source: 'epoch', metric: 'gpqa_diamond' },
    { id: 'swe-bench:verified/agents', source: 'swe-bench', metric: 'verified/agents' },
    { id: 'vals:swebench/overall', source: 'vals', metric: 'swebench/overall' },
    { id: 'epoch:eci', source: 'epoch', metric: 'eci' },
  ];
  const links = new Map([
    ['epoch:gpqa_diamond', 'gpqa-diamond'],
    ['swe-bench:verified/agents', 'swe-bench-verified'],
    ['vals:swebench/overall', 'swe-bench-verified'],
    ['epoch:eci', 'eci'],
  ]);
  assert.deepEqual(
    [...benchmarkOf(cols, links, new Set(['whatmodel']))],
    [
      ['whatmodel:gpqa-diamond', 'gpqa-diamond'],
      ['epoch:gpqa_diamond', 'gpqa-diamond'],
      ['swe-bench:verified/agents', 'swe-bench-verified'],
      ['vals:swebench/overall', 'swe-bench-verified'],
    ],
    'a benchmark only one column names links nothing',
  );
  assert.equal(benchmarkOf(cols, links, new Set()).get('epoch:gpqa_diamond'), undefined, 'without whatmodel ids, gpqa-diamond has one column');
});

const cand = (value: number): Candidate => ({ value, runBy: 0, date: '', context: '', interval: '', url: null, rawName: '', source: '', history: null, flags: 0 });

test('linked columns sit side by side, with the median gap on both scales', () => {
  const column = (id: string, source: string, unit: string, label: string): SiteColumn => ({
    id,
    source,
    metric: id.split(':')[1]!,
    label,
    direction: 'higher',
    unit,
    headline: true,
    slug: id.split(':')[1]!,
    coverage: 3,
    benchmark: 'gpqa-diamond',
  });
  const d: SiteData = {
    index: {
      generated_at: '2026-11-13T00:00:00Z',
      sources: [
        { id: 'lab', name: 'Makers', homepage: 'https://a.example', terms: 'allowed', every: '6h', row_count: 3, metric_count: 1, names: 3, matched_names: 3 },
        { id: 'ind', name: 'Independent', homepage: 'https://b.example', terms: 'allowed', every: '6h', row_count: 3, metric_count: 1, names: 3, matched_names: 3 },
      ],
      columns: [column('lab:gpqa', 'lab', 'fraction', 'GPQA Diamond'), column('ind:gpqa', 'ind', 'percent', 'GPQA diamond (run)')],
      models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }, { id: 'm3', name: 'Model Three' }],
      tags: [],
      stats: { invalid_excluded: 0, unparsable: 0, unlisted_models: 0 },
    },
    cells: [],
    // The makers report 0-1 fractions; the independent runs are percentages, 4 to 6 points lower.
    byCell: new Map([
      ['0:0', [cand(0.9)]],
      ['1:0', [cand(0.8)]],
      ['2:0', [cand(0.7)]],
      ['0:1', [cand(85)]],
      ['1:1', [cand(76)]],
      ['2:1', [cand(64)]],
    ]),
    modelColumns: new Map([[0, new Set([0, 1])], [1, new Set([0, 1])], [2, new Set([0, 1])]]),
    columnModels: new Map([[0, new Set([0, 1, 2])], [1, new Set([0, 1, 2])]]),
    names: new Map(),
    history: new Map(),
    scores: [],
    config: [],
  };
  const pages = buildPages(d);
  const lab = pages.find((p) => p.path === 'benchmarks/lab/gpqa/')!.html;
  assert.match(lab, /Same benchmark in other sources/);
  assert.match(lab, /3 models have scores in more than one of them/);
  assert.match(lab, /Independent 5\.0 points below Makers, 3 models/);
  const table = lab.slice(lab.indexOf('id="same-benchmark"'));
  assert.ok(table.indexOf('Model One') < table.indexOf('Model Two') && table.indexOf('Model Two') < table.indexOf('Model Three'), "sorted by this column's scores");
  assert.match(pages.find((p) => p.path === 'benchmarks/ind/gpqa/')!.html, /Makers 5\.0 points above Independent/);
  const dir = pages.find((p) => p.path === 'benchmarks/')!.html;
  assert.match(dir, /Benchmarks in several sources <span class="muted">1<\/span>/);
  assert.ok(!dir.includes('points below'), 'the overview gives a gap only where two columns share five models');
});
