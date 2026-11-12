import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aliasMap, Matcher, splitQualifiers, toCsv } from '../scripts/lib/match.ts';
import type { CatalogModel } from '../scripts/lib/types.ts';

test('qualifiers come off the end of a name', () => {
  assert.deepEqual(splitQualifiers('Gemini 4 Carbon (High)'), { base: 'Gemini 4 Carbon', qualifiers: ['High'] });
  assert.deepEqual(splitQualifiers('Claude-Opus-4-5-20251101 (FC)'), { base: 'Claude-Opus-4-5', qualifiers: ['FC', '20251101'] });
  assert.deepEqual(splitQualifiers('GPT-4.1 (2025-04-14)'), { base: 'GPT-4.1', qualifiers: ['2025-04-14'] });
  assert.deepEqual(splitQualifiers('Qwen/Qwen3-32B'), { base: 'Qwen3-32B', qualifiers: [] });
  // Short numeric suffixes can be versions, not dates.
  assert.deepEqual(splitQualifiers('ERNIE-5.0-Preview-1203'), { base: 'ERNIE-5.0-Preview-1203', qualifiers: [] });
  assert.deepEqual(splitQualifiers('(weird)'), { base: '(weird)', qualifiers: [] });
});

const cat = (id: string, name: string, repo?: string): CatalogModel => ({
  id,
  name,
  category: 'llm',
  origin: 'test',
  ...(repo && { model_repo: `https://huggingface.co/${repo}` }),
});
const catalog = [
  cat('claude-opus-4-5', 'Claude Opus 4.5'),
  cat('qwen3-32b', 'Qwen3 32B', 'Qwen/Qwen3-32B'),
  cat('gpt-4-1', 'GPT-4.1'),
  // Two models that normalise to the same key must not match either.
  cat('mini-a', 'Mini'),
  cat('mini-b', 'mini'),
];
const m = new Matcher(catalog, aliasMap([{ source: 's', raw_name: 'Opus thing', model_id: 'claude-opus-4-5' }]));

test('exact id, normalised name, base name and repo name match', () => {
  assert.deepEqual(m.match('s', 'qwen3-32b'), { modelId: 'qwen3-32b', method: 'id', qualifiers: [] });
  assert.equal(m.match('s', 'Qwen3-32B')?.modelId, 'qwen3-32b');
  assert.deepEqual(m.match('s', 'Claude-Opus-4-5-20251101 (FC)'), { modelId: 'claude-opus-4-5', method: 'base_name', qualifiers: ['FC', '20251101'] });
  assert.equal(m.match('s', 'GPT-4.1 (2025-04-14)')?.modelId, 'gpt-4-1');
});

test('a display label is tried after the raw identifier', () => {
  assert.deepEqual(m.match('s', 'opus_internal_id', 'Claude Opus 4.5 (max)'), { modelId: 'claude-opus-4-5', method: 'base_label', qualifiers: ['max'] });
});

test('ambiguous keys and near misses do not match', () => {
  assert.equal(m.match('s', 'MINI'), undefined);
  assert.equal(m.match('s', 'Claude Opus 4.6'), undefined);
  assert.equal(m.match('s', 'Qwen3 32B Instruct'), undefined);
});

test('curation aliases win, per source', () => {
  assert.equal(m.match('s', 'Opus thing')?.method, 'alias');
  assert.equal(m.match('other', 'Opus thing'), undefined);
});

test('CSV output quotes only where needed', () => {
  assert.equal(toCsv(['a', 'b'], [['x, y', 'say "hi"'], ['plain', 3]]), 'a,b\n"x, y","say ""hi"""\nplain,3\n');
});
