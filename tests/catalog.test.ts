import assert from 'node:assert/strict';
import { test } from 'node:test';
import { licenseId, mergeCatalogs, withoutModes } from '../scripts/lib/catalog.ts';
import { applyModels } from '../scripts/lib/curation.ts';
import { checkCatalog } from '../scripts/lib/guards.ts';
import { Matcher } from '../scripts/lib/match.ts';
import { catalogFrom as epochCatalog, openWeights } from '../scripts/sources/epoch-models.ts';
import { fieldsFrom, repoOf } from '../scripts/sources/huggingface.ts';
import { catalogFrom as mdCatalog, type MdModel } from '../scripts/sources/models-dev.ts';
import type { CatalogModel } from '../scripts/lib/types.ts';

const model = (id: string, name: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, name, category: 'llm', origin: 'base', ...extra });

const base: CatalogModel[] = [
  model('gpt-4o-2024-05-13', 'GPT-4o (May 2024)', { provider: 'OpenAI', released: '2024-05' }),
  model('gpt-4o-2024-08-06', 'GPT-4o (Aug 2024)', { provider: 'OpenAI', released: '2024-08' }),
  model('grok-4-fast', 'Grok 4 Fast', { provider: 'xAI', released: '2025-09' }),
  model('claude-fable-5-1', 'Claude Fable 5.1', { provider: 'Anthropic', released: '2026-09', open_weights: false }),
  model('qwen3-8b', 'Qwen3 8B', { provider: 'Alibaba', model_repo: 'https://huggingface.co/Qwen/Qwen3-8B', open_weights: true }),
];

test('the first feed is taken whole; later feeds only fill fields it left empty', () => {
  const { catalog, stats } = mergeCatalogs([
    { source: 'base', models: base },
    {
      source: 'later',
      models: [
        model('claude-fable-5-1', 'Claude Fable 5.1', { released: '2026-09-15', context_k: 1000, open_weights: true }),
        model('qwen3-8b-x', 'Qwen3-8B', { params_b: 8.19, license: 'apache-2.0' }),
      ],
    },
  ]);
  const fable = catalog.find((m) => m.id === 'claude-fable-5-1')!;
  assert.equal(fable.released, '2026-09', 'the earlier feed wins');
  assert.equal(fable.open_weights, false);
  assert.equal(fable.context_k, 1000, 'an empty field is filled');
  assert.equal(fable.origin, 'base');
  const qwen = catalog.find((m) => m.id === 'qwen3-8b')!;
  assert.deepEqual([qwen.params_b, qwen.license], [8.19, 'apache-2.0'], 'matched by name, not id');
  assert.ok(!catalog.some((m) => m.id === 'qwen3-8b-x'));
  assert.deepEqual(stats.get('later'), { models: 2, added: 0, filled: 2, left_out: 0 });
});

test('a later feed adds new models, and leaves out variants of ones already there', () => {
  const { catalog, stats, leftOut } = mergeCatalogs([
    { source: 'base', models: base },
    {
      source: 'later',
      models: [
        model('claude-fable-5-2', 'Claude Fable 5.2', { provider: 'anthropic', released: '2026-11-09' }),
        model('gpt-4o', 'GPT-4o', { provider: 'OpenAI' }), // could be either snapshot
        model('gpt-4o-2024-11-20', 'GPT-4o (Nov 2024)', { provider: 'OpenAI' }), // a third snapshot
        model('grok-4-fast-non-reasoning', 'Grok 4 Fast Non-Reasoning', { provider: 'xAI' }), // a run mode
        model('claude-fable-5-1-preview', 'Claude Fable 5.1 Preview'),
      ],
    },
  ]);
  const fable = catalog.find((m) => m.id === 'claude-fable-5-2')!;
  assert.equal(fable.origin, 'later');
  assert.equal(fable.provider, 'Anthropic', 'maker spelled as the earlier feed spells it');
  assert.deepEqual(stats.get('later'), { models: 5, added: 1, filled: 0, left_out: 4 });
  assert.deepEqual(leftOut.get('later')!.map((m) => m.id).sort(), ['claude-fable-5-1-preview', 'gpt-4o', 'gpt-4o-2024-11-20', 'grok-4-fast-non-reasoning']);
});

test('names that matched before still go to the same model after a merge', () => {
  const before = new Matcher(base);
  const { catalog } = mergeCatalogs([
    { source: 'base', models: base },
    { source: 'later', models: [model('grok-4-fast-reasoning', 'Grok 4 Fast Reasoning'), model('grok-4-fast-non-reasoning', 'X-Ai/Grok-4-Fast-Non-Reasoning')] },
  ]);
  const after = new Matcher(catalog);
  for (const name of ['Grok 4 Fast (Reasoning)', 'Grok 4 Fast (Non-Reasoning)', 'grok-4-fast']) {
    assert.equal(after.match('s', name)?.modelId, before.match('s', name)?.modelId, name);
  }
});

test('a fill-only feed names models by id and never adds one', () => {
  const { catalog, stats } = mergeCatalogs([
    { source: 'base', models: base },
    { source: 'hf', fillOnly: true, models: [model('qwen3-8b', 'x', { params_b: 8.19 }), model('brand-new', 'Brand New', { params_b: 1 }), model('x', 'Qwen3 8B', { license: 'mit' })] },
  ]);
  assert.equal(catalog.length, base.length);
  assert.equal(catalog.find((m) => m.id === 'qwen3-8b')!.params_b, 8.19);
  assert.equal(catalog.find((m) => m.id === 'qwen3-8b')!.license, undefined, 'not by name');
  assert.deepEqual(stats.get('hf'), { models: 3, added: 0, filled: 1, left_out: 0 });
});

test('the matcher knows a core name even where it cannot pick one model', () => {
  const m = new Matcher(base);
  assert.equal(m.match('s', 'GPT-4o'), undefined);
  assert.ok(m.knows('GPT-4o'));
  assert.ok(m.knows('openai/gpt-4o'));
  assert.ok(!m.knows('Claude Fable 5.2'));
});

test('run modes come off the end of a name', () => {
  assert.equal(withoutModes('Grok 4 Fast Non-Reasoning'), 'Grok 4 Fast');
  assert.equal(withoutModes('grok-4-fast-reasoning'), 'grok-4-fast');
  assert.equal(withoutModes('o3 (high)'), 'o3');
  assert.equal(withoutModes('Qwen3 Max Thinking'), 'Qwen3 Max');
  assert.equal(withoutModes('GPT-5.1 Codex Max'), 'GPT-5.1 Codex Max', '"Max" is part of the name');
  assert.equal(withoutModes('Thinking'), 'Thinking');
});

test('licence names are written one way', () => {
  assert.equal(licenseId('Apache 2.0'), 'apache-2.0');
  assert.equal(licenseId('Apache-2.0'), 'apache-2.0');
  assert.equal(licenseId('MIT License'), 'mit');
  assert.equal(licenseId('Proprietary'), 'proprietary');
  assert.equal(licenseId('CC-BY-NC-4.0'), 'cc-by-nc-4.0');
  assert.equal(licenseId('Llama 3.2 Community License'), 'Llama 3.2 Community License');
  assert.equal(licenseId(' '), undefined);
});

test('models.dev: text models only, with maker names from its providers', () => {
  const doc: Record<string, MdModel> = {
    'anthropic/claude-fable-5-2': { id: 'anthropic/claude-fable-5-2', name: 'Claude Fable 5.2', release_date: '2026-11-09', open_weights: false, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1_000_000 } },
    'xai/grok-4-fast-reasoning': { id: 'xai/grok-4-fast-reasoning', name: 'X-Ai/Grok-4-Fast-Reasoning', modalities: { input: ['text'], output: ['text'] } },
    'upstage/solar-10.7b-instruct-v1.0': {
      id: 'upstage/solar-10.7b-instruct-v1.0',
      name: 'SOLAR 10.7B Instruct v1.0',
      open_weights: true,
      license: 'CC-BY-NC-4.0',
      modalities: { input: ['text'], output: ['text'] },
      weights: [{ label: 'Hugging Face', url: 'https://huggingface.co/upstage/SOLAR-10.7B-Instruct-v1.0' }],
    },
    'fireworks/ember-1': { id: 'fireworks/ember-1', name: 'Ember-1', modalities: { input: ['text'], output: ['text'] } },
    'openai/gpt-image-2': { id: 'openai/gpt-image-2', name: 'GPT Image 2', type: 'image', modalities: { input: ['text'], output: ['image'] } },
    'openai/whisper-2': { id: 'openai/whisper-2', name: 'Whisper 2', modalities: { input: ['audio'], output: ['text'] } },
  };
  const names = new Map([['anthropic', 'Anthropic'], ['xai', 'xAI'], ['fireworks-ai', 'Fireworks AI']]);
  const out = mdCatalog(doc, names);
  assert.deepEqual(out.map((m) => m.id), ['claude-fable-5-2', 'grok-4-fast-reasoning', 'solar-10-7b-instruct-v1-0', 'ember-1']);
  assert.deepEqual(out[0], { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', category: 'llm', origin: 'models-dev', provider: 'Anthropic', released: '2026-11-09', open_weights: false, context_k: 1000 });
  assert.equal(out[1]!.name, 'Grok-4-Fast-Reasoning');
  assert.equal(out[2]!.model_repo, 'https://huggingface.co/upstage/SOLAR-10.7B-Instruct-v1.0');
  assert.equal(out[2]!.license, 'cc-by-nc-4.0');
  assert.equal(out[2]!.provider, 'upstage', 'a lab with no provider entry keeps its id');
  assert.equal(out[3]!.provider, 'Fireworks AI');
});

test("Epoch's models: released language models, to the month, with sizes", () => {
  const rec = (Model: string, Domain: string, access: string, date: string, params = '', org = 'Lab') => ({
    Model,
    Domain,
    Organization: org,
    'Publication date': date,
    Parameters: params,
    'Model accessibility': access,
  });
  const { catalog, problems } = epochCatalog([
    rec('Kimi K3.1 Pro', 'Language,Multimodal,Vision', 'Open weights (restricted use)', '2026-10-23', '2800000000000.0', 'Moonshot,Tsinghua'),
    rec('GPT-6.1 Terra', 'Language,Multimodal', 'API access', '2026-10-26'),
    rec('Internal Model', 'Language', 'Unreleased', '2026-01-01'),
    rec('Canva Craft', 'Image generation', 'API access', '2026-10-22'),
    rec('Old LSTM', 'Language', '', '2016-07-01', '37000000'),
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(catalog.map((m) => m.id), ['kimi-k3-1-pro', 'gpt-6-1-terra', 'old-lstm']);
  assert.deepEqual(catalog[0], { id: 'kimi-k3-1-pro', name: 'Kimi K3.1 Pro', category: 'llm', origin: 'epoch-models', provider: 'Moonshot', released: '2026-10', open_weights: true, params_b: 2800 });
  assert.equal(catalog[1]!.open_weights, false);
  assert.equal(catalog[2]!.open_weights, undefined);
  assert.equal(catalog[2]!.params_b, 0.04);
  assert.deepEqual(epochCatalog([{ Model: 'x' }]).problems, ['missing columns: Domain, Organization, Publication date, Parameters, Model accessibility']);
  assert.equal(openWeights('Open weights (non-commercial)'), true);
  assert.equal(openWeights('Hosted access (no API)'), false);
});

test('Hugging Face: parameter counts from safetensors headers, licences from the card', () => {
  assert.equal(repoOf('https://huggingface.co/Qwen/Qwen3-8B'), 'Qwen/Qwen3-8B');
  assert.equal(repoOf('https://huggingface.co/datasets/x/y'), undefined);
  assert.equal(repoOf('https://github.com/x/y'), undefined);
  assert.deepEqual(fieldsFrom({ safetensors: { parameters: { BF16: 8190735360 }, total: 8190735360 }, cardData: { license: 'apache-2.0' } }), { params_b: 8.19, license: 'apache-2.0' });
  assert.deepEqual(fieldsFrom({ safetensors: { parameters: { I32: 1e9, F16: 2e8 }, total: 1.2e9 } }), {}, 'packed GPTQ weights undercount');
  assert.deepEqual(fieldsFrom({ safetensors: { parameters: { BF16: 4e6 }, total: 4e6 } }), {}, 'a partial header');
  assert.deepEqual(fieldsFrom({ cardData: { license: 'other', license_name: 'glm-4' } }), { license: 'glm-4' });
  assert.deepEqual(fieldsFrom({ cardData: { license: ['mit'] } }), { license: 'mit' });
});

test('a catalogue feed is held when its model count collapses', () => {
  assert.deepEqual(checkCatalog(0, 551, 300), []);
  assert.match(checkCatalog(551, 120, 300)[0]!, /fewer than the minimum of 300/);
  assert.match(checkCatalog(551, 250, 0)[0]!, /under half of the previous 551/);
  assert.deepEqual(checkCatalog(5, 0, 0), []);
});

test('curation takes a left-out model by its id, with its own corrections on top', () => {
  const { catalog, leftOut } = mergeCatalogs([
    { source: 'base', models: base },
    { source: 'later', models: [model('claude-fable-5-1-preview', 'Claude Fable 5.1 Preview', { provider: 'anthropic', released: '2026-08' })] },
  ]);
  const out = applyModels(catalog, [{ id: 'claude-fable-5-1-preview', provider: 'Anthropic' }, { id: 'not-left-out' }], leftOut);
  const taken = out.find((m) => m.id === 'claude-fable-5-1-preview')!;
  assert.deepEqual(taken, { id: 'claude-fable-5-1-preview', name: 'Claude Fable 5.1 Preview', category: 'llm', origin: 'later', provider: 'Anthropic', released: '2026-08' });
  assert.ok(!out.some((m) => m.id === 'not-left-out'), 'an id alone adds nothing unless a feed left that model out');
  assert.equal(applyModels(catalog, [{ id: 'claude-fable-5-1-preview' }]).length, catalog.length, 'nothing to take without the left-out list');
});
