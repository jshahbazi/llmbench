import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRows, historyIndex } from '../scripts/lib/diff.ts';
import { checkGuards } from '../scripts/lib/guards.ts';
import type { HistoryEvent, Row } from '../scripts/lib/types.ts';

const row = (key: string, scores: Row['scores']): Row => ({ key, model: key, scores });
const now = '2026-11-20T00:00:00Z';

test('diff finds added, changed, removed and returning cells', () => {
  const prev = [row('a', { s: '1', t: '2' }), row('b', { s: '3' })];
  const next = [row('a', { s: '1', t: '2.5' }), row('c', { s: '4' }), row('d', { s: '5' })];
  const history = historyIndex([{ t: '2026-01-01T00:00:00Z', key: 'd', model: 'd', metric: 's', op: 'remove', from: '5' }]);
  const { events, stats } = diffRows(prev, next, { now, rev: 'abc', history });
  assert.deepEqual(stats, { prevCells: 3, added: 1, changed: 1, removed: 1, returned: 1 });
  assert.deepEqual(
    events.map((e) => [e.key, e.metric, e.op, e.from, e.to]),
    [
      ['a', 't', 'change', '2', '2.5'],
      ['c', 's', 'add', undefined, '4'],
      ['d', 's', 'return', undefined, '5'],
      ['b', 's', 'remove', '3', undefined],
    ],
  );
  assert.equal(events[0]!.rev, 'abc');
});

test('numbers and text with the same digits are not a change', () => {
  assert.equal(diffRows([row('a', { s: 1.5 })], [row('a', { s: '1.5' })], { now, history: new Map() }).events.length, 0);
});

test('rolling sources record a change at most once a week per cell', () => {
  const prev = [row('a', { r: 1500 }), row('b', { r: 1400 })];
  const next = [row('a', { r: 1501 }), row('b', { r: 1401 })];
  const recent: HistoryEvent = { t: '2026-11-18T00:00:00Z', key: 'a', model: 'a', metric: 'r', op: 'change', from: 1499, to: 1500 };
  const { events, stats } = diffRows(prev, next, {
    now,
    history: historyIndex([recent]),
    rollingDays: 7,
    baselineAt: '2026-11-01T00:00:00Z',
  });
  assert.equal(stats.changed, 2);
  assert.deepEqual(events.map((e) => e.key), ['b']);
});

const stats = (over: Partial<Parameters<typeof checkGuards>[0]['stats']> = {}) => ({
  prevCells: 0,
  added: 0,
  changed: 0,
  removed: 0,
  returned: 0,
  ...over,
});
const many = (n: number, v = '1') => Array.from({ length: n }, (_, i) => row(`m${i}`, { s: v }));

test('guards pass a normal run', () => {
  assert.deepEqual(checkGuards({ prevRows: many(40), nextRows: many(41), stats: stats({ prevCells: 40, changed: 2 }), problems: [], minRows: 10, rolling: false }), []);
});

test('row drop: below the minimum, or under half the previous run', () => {
  assert.match(checkGuards({ prevRows: [], nextRows: many(3), stats: stats(), problems: [], minRows: 10, rolling: false })[0]!, /fewer than the minimum of 10/);
  assert.match(checkGuards({ prevRows: many(40), nextRows: many(15), stats: stats(), problems: [], minRows: 1, rolling: false })[0]!, /under half of the previous 40/);
});

test('mass change holds static sources but not rolling ones', () => {
  const g = { prevRows: many(40), nextRows: many(40, '2'), stats: stats({ prevCells: 40, changed: 40 }), problems: [], minRows: 1 };
  assert.match(checkGuards({ ...g, rolling: false })[0]!, /mass change: 40 of 40/);
  assert.deepEqual(checkGuards({ ...g, rolling: true }), []);
});

test('type flip: a numeric column that turns into text', () => {
  const reasons = checkGuards({ prevRows: many(10, '5'), nextRows: many(10, 'see note'), stats: stats(), problems: [], minRows: 1, rolling: true });
  assert.match(reasons[0]!, /type flip: "s"/);
});

test('extractor problems are reasons', () => {
  assert.deepEqual(checkGuards({ prevRows: [], nextRows: many(5), stats: stats(), problems: ['missing column "Model"'], minRows: 1, rolling: false }), [
    'missing column "Model"',
  ]);
});
