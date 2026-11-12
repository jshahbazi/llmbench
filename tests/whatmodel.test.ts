import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metricFromBench, rowKeys, toRow, transform, type WmResult } from '../scripts/sources/whatmodel.ts';

const r = (over: Partial<WmResult>): WmResult => ({
  model: 'm1',
  bench: 'gpqa-diamond',
  score: 0.5,
  source: 'https://example.org/a',
  by: 'independent',
  source_id: 'src',
  ...over,
});

test('row keys are model|bench|source|mode when unique', () => {
  assert.deepEqual(rowKeys([r({}), r({ mode: 'thinking' })]), ['m1|gpqa-diamond|src|-', 'm1|gpqa-diamond|src|thinking']);
});

test('colliding keys are split by source URL, ignoring pinned commit ids', () => {
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  const a = r({ source: `https://github.com/o/r/blob/${sha1}/x.md` });
  const b = r({ source: `https://github.com/o/r/blob/${sha1}/y.md` });
  const [ka, kb] = rowKeys([a, b]);
  assert.notEqual(ka, kb);
  // Re-pinning the same file to a new commit keeps its key.
  const [ka2] = rowKeys([r({ source: `https://github.com/o/r/blob/${sha2}/x.md` }), b]);
  assert.equal(ka2, ka);
});

test('toRow keeps the value verbatim and moves unknown fields to extra', () => {
  const row = toRow(r({ mode: 'thinking', date: '2026-01-02', note: 'n', invalid: 'why' }), 'k');
  assert.deepEqual(row, {
    key: 'k',
    model: 'm1',
    context: { mode: 'thinking' },
    date: '2026-01-02',
    scores: { 'gpqa-diamond': 0.5 },
    run_by: 'independent',
    upstream_url: 'https://example.org/a',
    upstream_source: 'src',
    extra: { note: 'n', invalid: 'why' },
  });
  assert.equal(toRow(r({ by: 'someone' }), 'k').extra?.['by'], 'someone');
});

test('metric direction and unit follow the benchmark kind', () => {
  assert.deepEqual(
    [metricFromBench({ id: 'a', name: 'A', kind: 'acc' }), metricFromBench({ id: 'w', name: 'W', kind: 'err' })].map(
      (m) => [m.direction, m.unit],
    ),
    [['higher', 'fraction'], ['lower', 'fraction']],
  );
  assert.equal(metricFromBench({ id: 'f', name: 'F', kind: 'linear', direction: 'lower', unit: 'FID' }).direction, 'lower');
  assert.equal(metricFromBench({ id: 'e', name: 'E', kind: 'elo' }).unit, 'elo');
});

test('transform keeps only the requested model categories and the sources they cite', () => {
  const out = transform(
    {
      results: [r({}), r({ model: 'img', bench: 'geneval', source_id: 'other' })],
      models: [
        { id: 'm1', name: 'M1' },
        { id: 'img', name: 'Img', category: 'image' },
      ],
      benchmarks: [
        { id: 'gpqa-diamond', name: 'GPQA Diamond', kind: 'acc' },
        { id: 'geneval', name: 'GenEval', kind: 'acc' },
      ],
      sources: [
        { id: 'src', license: 'CC BY 4.0' },
        { id: 'other', license: 'MIT' },
      ],
    },
    ['llm'],
  );
  assert.deepEqual(out.rows.map((x) => x.model), ['m1']);
  assert.deepEqual(out.metrics.map((m) => m.id), ['gpqa-diamond']);
  assert.deepEqual(out.catalog?.map((m) => m.id), ['m1']);
  assert.deepEqual(out.upstreamSources, [{ id: 'src', license: 'CC BY 4.0' }]);
});
