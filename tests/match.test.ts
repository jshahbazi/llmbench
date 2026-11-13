import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyModels, parseModelsYaml } from '../scripts/lib/curation.ts';
import { aliasMap, editDistance, Matcher, slugifyModel, toCsv } from '../scripts/lib/match.ts';
import { formatQualifiers } from '../scripts/lib/names.ts';
import type { CatalogModel } from '../scripts/lib/types.ts';

const cat = (id: string, name: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, name, category: 'llm', origin: 'test', ...extra });
const hf = (repo: string) => ({ model_repo: `https://huggingface.co/${repo}` });
const catalog = [
  cat('claude-opus-4-5', 'Claude Opus 4.5'),
  cat('qwen3-32b', 'Qwen3 32B', hf('Qwen/Qwen3-32B')),
  cat('gpt-4o-2024-05-13', 'GPT-4o (2024-05-13)'),
  cat('gpt-4o-2024-08-06', 'GPT-4o (2024-08-06)'),
  cat('mistral-large-2402', 'Mistral Large (2402)'),
  cat('command-r-03-2024', 'Command R (03-2024)'),
  cat('command-r-plus-08-2024', 'Command R Plus (08-2024)'),
  cat('opt-1-3b', 'OPT-1.3B'),
  cat('gemma-2b', 'Gemma 2B IT', hf('google/gemma-2b-it')),
  cat('gemma-2b-base', 'Gemma 2B', hf('google/gemma-2b')),
  cat('nemotron-3-ultra', 'Nemotron 3 Ultra 550B-A55B', { provider: 'NVIDIA' }),
  cat('llama-xlam-2-8b-fc-r', 'Llama-xLAM-2-8b-fc-r', hf('Salesforce/Llama-xLAM-2-8b-fc-r')),
  cat('kimi-k2', 'Kimi K2 Instruct (0711)'),
  cat('kimi-k2-0905', 'Kimi K2 Instruct (0905)'),
  cat('ministral-8b', 'Ministral 8B (2410)'),
  cat('gemini-3-pro-preview', 'Gemini 3 Pro (Preview)'),
];
const m = new Matcher(
  catalog,
  aliasMap([
    { source: 's', raw_name: 'Opus thing', model_id: 'claude-opus-4-5' },
    { source: '*', raw_name: 'Command R', model_id: 'command-r-03-2024' },
    { source: 's', raw_name: 'Qwen3 32B', model_id: '-' },
  ]),
);
const match = (raw: string, hints = {}) => {
  const r = m.match('t', raw, hints);
  return r && [r.modelId, r.method, formatQualifiers(r.qualifiers)];
};

test('exact ids and names match, ignoring case and punctuation', () => {
  assert.deepEqual(match('qwen3-32b'), ['qwen3-32b', 'exact', '']);
  assert.deepEqual(match('Qwen3-32B'), ['qwen3-32b', 'exact', '']);
  assert.deepEqual(match('Qwen/Qwen3-32B'), ['qwen3-32b', 'exact', '']);
  assert.deepEqual(match('OPT-1.3B'), ['opt-1-3b', 'exact', '']);
});

test('qualifiers are set aside and kept as context', () => {
  assert.deepEqual(match('Claude-Opus-4-5-20251101 (FC)'), ['claude-opus-4-5', 'variant', 'mode:FC; snapshot:20251101']);
  assert.deepEqual(match('claude-opus-4-5_high'), ['claude-opus-4-5', 'variant', 'effort:high']);
  assert.deepEqual(match('Gemini 3 Pro (Grounding)'), ['gemini-3-pro-preview', 'variant', 'search:grounding']);
});

test('a stated snapshot must agree with the model, and picks between snapshots', () => {
  assert.deepEqual(match('GPT-4o (Aug 2024)'), ['gpt-4o-2024-08-06', 'variant', '']);
  // The snapshot is already in the model's name; "preview" is not, so it stays as context.
  assert.deepEqual(match('Kimi K2 Preview (0905)'), ['kimi-k2-0905', 'variant', 'stage:preview']);
  assert.deepEqual(match('Kimi K2 Preview (0711)'), ['kimi-k2', 'variant', 'stage:preview']);
  assert.equal(match('Mistral Large (2411)'), undefined);
  // The model already says 2410, so the score need not.
  assert.deepEqual(match('Ministral-8B-2410 (FC)'), ['ministral-8b', 'variant', 'mode:FC']);
});

test('ambiguous and near names do not match', () => {
  assert.equal(match('GPT-4o'), undefined, 'two dated releases');
  assert.equal(match('OPT-13B'), undefined);
  assert.equal(match('Command R+')?.[0], 'command-r-plus-08-2024', '"+" is not punctuation');
  assert.equal(match('Claude Opus 4.6'), undefined);
  assert.equal(match('Qwen3 32B Instruct'), undefined);
  // The id says instruct, the repository says base: neither.
  assert.equal(match('Gemma 2B'), undefined);
  assert.equal(match('o3 (high) + Claude Opus 4.5'), undefined, 'pairs never match');
});

test('a Hugging Face link on the row, and a maker prefix, can match', () => {
  assert.deepEqual(match('xLAM-2-8b-fc-r (FC)', { url: 'https://huggingface.co/Salesforce/Llama-xLAM-2-8b-fc-r' }), ['llama-xlam-2-8b-fc-r', 'link', 'mode:FC']);
  assert.deepEqual(match('NVIDIA-Nemotron-3-Ultra (NVFP4)'), ['nemotron-3-ultra', 'maker', 'quant:NVFP4']);
  assert.equal(match('Google-Nemotron-3-Ultra'), undefined, 'maker must agree');
});

test('curation wins: per source, for every source, or "never match"', () => {
  assert.equal(m.match('s', 'Opus thing')?.method, 'alias');
  assert.equal(m.match('other', 'Opus thing'), undefined);
  assert.equal(m.match('any', 'Command R')?.modelId, 'command-r-03-2024');
  assert.equal(m.match('s', 'Qwen3 32B'), undefined);
  assert.ok(m.blocked('s', 'Qwen3 32B'));
  assert.equal(m.match('other', 'Qwen3 32B')?.modelId, 'qwen3-32b');
});

test('near misses are suggested, ambiguous ones first', () => {
  assert.deepEqual(m.suggest('GPT-4o').slice(0, 2), ['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06']);
  assert.ok(m.suggest('Mistral Large (2411)').includes('mistral-large-2402'));
  assert.deepEqual(m.suggest('Something else entirely'), []);
  assert.equal(editDistance('kitten', 'sitting', 5), 3);
  assert.equal(editDistance('abc', 'abcdefg', 2), 3);
});

test('curation/models.yaml adds and corrects models, and reports mistakes', () => {
  const { entries, problems } = parseModelsYaml(`
- id: new-model
  name: New Model
  released: 2026-01
  params_b: 7
- id: qwen3-32b
  provider: Alibaba
- id: Bad Id
- id: other
  colour: blue
`);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /"id" must be/);
  assert.match(problems[1]!, /unknown field "colour"/);
  const out = applyModels(catalog, entries);
  assert.equal(out.find((x) => x.id === 'new-model')?.origin, 'curation');
  assert.equal(out.find((x) => x.id === 'qwen3-32b')?.provider, 'Alibaba');
  assert.equal(out.find((x) => x.id === 'qwen3-32b')?.name, 'Qwen3 32B');
  assert.deepEqual(parseModelsYaml('[]'), { entries: [], problems: [] });
});

test('CSV output quotes only where needed; model slugs', () => {
  assert.equal(toCsv(['a', 'b'], [['x, y', 'say "hi"'], ['plain', 3]]), 'a,b\n"x, y","say ""hi"""\nplain,3\n');
  assert.equal(slugifyModel('Command R+'), 'command-r-plus');
  assert.equal(slugifyModel('Mistral Large (2411)'), 'mistral-large-2411');
});
