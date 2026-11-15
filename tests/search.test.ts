import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesModelSearch } from '../site/src/search.ts';

test('model search ignores spaces and hyphens in names and queries', () => {
  const model = { id: 'qwen3-8-flash-next', name: 'Qwen3.8-Flash-Next', provider: 'Alibaba' };
  for (const q of ['Qwen 3.8 Flash Next', 'qwen3.8-flash-next', 'QWEN3.8FLASHNEXT', ' Flash   Next ', 'Flash–Next', 'Alibaba', 'qwen3 8 flash next']) {
    assert.ok(matchesModelSearch(model, q), q);
  }
  assert.ok(matchesModelSearch({ id: 'other', name: 'Qwen 3.8 Flash Next' }, 'qwen3.8-flash-next'));
  assert.ok(!matchesModelSearch(model, 'Qwen 3.8 Max'));
  assert.ok(!matchesModelSearch({ id: 'other', name: model.name }, 'Qwen 38 Flash Next'), 'decimal points are preserved');
});
