import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ConfigError, parseSources } from '../scripts/lib/config.ts';
import { parseScore } from '../scripts/lib/scores.ts';

const minimal = `
defaults: { every: 12h }
sources:
  - id: board
    name: Board
    homepage: https://example.org
    fetch: https://example.org/data.csv
    model: Model
    ignore: [Rank]
    license: MIT
    terms: allowed
  - id: nope
    name: Nope
    homepage: https://example.com
    terms: blocked
`;

test('parses entries, applies defaults and keeps unknown keys as options', () => {
  const [a, b] = parseSources(minimal);
  assert.equal(a?.every, '12h');
  assert.equal(a?.run_by, 'independent');
  assert.deepEqual(a?.options, { model: 'Model', ignore: ['Rank'] });
  assert.equal(b?.terms, 'blocked');
  assert.equal(b?.fetch, undefined);
});

test('rejects bad entries with the source id in the message', () => {
  const bad = (yaml: string, pattern: RegExp) => assert.throws(() => parseSources(yaml), (e: unknown) => e instanceof ConfigError && pattern.test(e.message));
  bad(minimal.replace('terms: allowed', 'terms: maybe'), /source "board": terms/);
  bad(minimal.replace('    model: Model\n', ''), /source "board": needs either "model"/);
  bad(minimal.replace('id: nope', 'id: board'), /duplicate id/);
  bad(minimal.replace('    license: MIT\n', ''), /source "board": missing "license"/);
  bad(minimal.replace('id: board', 'id: Board!'), /lowercase/);
});

test('the real sources.yaml is valid', async () => {
  assert.ok(parseSources(await readFile('sources.yaml', 'utf8')).length > 0);
});

test('parseScore reads the common ways sources write numbers', () => {
  assert.equal(parseScore(0.873), 0.873);
  assert.equal(parseScore('78.4%'), 78.4);
  assert.equal(parseScore('1,312'), 1312);
  assert.equal(parseScore('1312 (+5/-4)'), 1312);
  assert.equal(parseScore('.5'), 0.5);
  assert.equal(parseScore('N/A'), null);
  assert.equal(parseScore(Number.NaN), null);
});
