import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeQualifier, formatQualifiers, normalize, parseName, qualifierFlags, readQualifiers, readSnapshot, sameSnapshot } from '../scripts/lib/names.ts';

const parsed = (raw: string) => {
  const p = parseName(raw);
  return [p.core, formatQualifiers(p.qualifiers)];
};

test('qualifiers in brackets, including lists, come off the end', () => {
  assert.deepEqual(parsed('Gemini 4 Carbon (High)'), ['Gemini 4 Carbon', 'effort:high']);
  assert.deepEqual(parsed('Gemini 2.5 Flash-Lite Preview (Thinking, 06-17)'), ['Gemini 2.5 Flash-Lite', 'reasoning:thinking; stage:preview; snapshot:06-17']);
  assert.deepEqual(parsed('Claude Opus 4.5 (High, 32K, 20251101)'), ['Claude Opus 4.5', 'effort:high; budget:32K; snapshot:20251101']);
  assert.deepEqual(parsed('Reka Flash 21B (Online, 20240226)'), ['Reka Flash 21B', 'search:search; snapshot:20240226']);
  assert.deepEqual(parsed('DeepSeek-V3.2-Exp (Prompt + Thinking)'), ['DeepSeek-V3.2', 'reasoning:thinking; mode:Prompt; stage:exp']);
  assert.deepEqual(parsed('Gemini Pro (Dev API)'), ['Gemini Pro', 'other:Dev API']);
});

test('qualifiers written into the name come off too', () => {
  assert.deepEqual(parsed('o1-2024-12-17_high'), ['o1', 'effort:high; snapshot:2024-12-17']);
  assert.deepEqual(parsed('claude-opus-4-1-20250805_27K'), ['claude-opus-4-1', 'budget:27K; snapshot:20250805']);
  assert.deepEqual(parsed('doubao-seed-2.0-pro-260215_high'), ['doubao-seed-2.0-pro', 'effort:high; snapshot:260215']);
  assert.deepEqual(parsed('Llama-4-Maverick-17B-128E-Instruct-FP8 (FC)'), ['Llama-4-Maverick-17B-128E-Instruct', 'mode:FC; quant:FP8']);
  assert.deepEqual(parsed('gpt-5-mini-high'), ['gpt-5-mini', 'effort:high']);
  assert.deepEqual(parsed('kimi-k2-0905'), ['kimi-k2', 'snapshot:0905']);
  assert.deepEqual(parsed('Gemini 3.1 Flash-Lite Preview'), ['Gemini 3.1 Flash-Lite', 'stage:preview']);
  assert.deepEqual(parsed('openai/gpt-oss-120b_high'), ['gpt-oss-120b', 'effort:high']);
});

test('model names that look like qualifiers are left alone', () => {
  // "Medium" and "Max" are model names; "16K" after a hyphen is a context length; "-3-2501" follows a version number.
  assert.deepEqual(parsed('Mistral Medium'), ['Mistral Medium', '']);
  assert.deepEqual(parsed('Qwen2.5-Max'), ['Qwen2.5-Max', '']);
  assert.deepEqual(parsed('Yi-1.5-9B-Chat-16K'), ['Yi-1.5-9B-Chat-16K', '']);
  assert.deepEqual(parsed('mistral-small-3-2501'), ['mistral-small-3-2501', '']);
  assert.deepEqual(parsed('Kimi K2 Thinking'), ['Kimi K2 Thinking', '']);
  assert.deepEqual(parsed('(weird)'), ['(weird)', '']);
});

test('two models working together are a pair, and never a qualifier', () => {
  assert.equal(parseName('o3 (high) + gpt-4.1').pair, true);
  assert.equal(parseName('DeepSeek R1 + claude-3-5-sonnet-20241022').pair, true);
  assert.equal(parseName('DeepSeek-V3.2-Exp (Prompt + Thinking)').pair, false);
});

test('snapshots compare by whatever parts of the date they state', () => {
  const s = (t: string) => readSnapshot(t);
  assert.ok(sameSnapshot(s('Aug 2024'), s('2024-08-06')));
  assert.ok(sameSnapshot(s('Jun 2023'), s('0613')));
  assert.ok(sameSnapshot(s('2411'), s('20241118')));
  assert.ok(sameSnapshot(s('October 2024'), s('20241022')));
  assert.ok(!sameSnapshot(s('2411'), s('2402')));
  assert.ok(!sameSnapshot(s('Jul 2025'), s('Apr 2025')));
  assert.ok(sameSnapshot(undefined, s('0905')));
  assert.equal(readSnapshot('2048'), undefined);
  assert.equal(readSnapshot('1.5'), undefined);
});

test('normalised keys keep numbers apart and read "+" as "plus"', () => {
  assert.equal(normalize('Claude-Opus-4-5'), normalize('Claude Opus 4.5'));
  assert.equal(normalize('o1 2024-12-17'), normalize('o1-20241217'));
  assert.notEqual(normalize('OPT-1.3B'), normalize('OPT-13B'));
  assert.notEqual(normalize('Qwen2.5-7B'), normalize('Qwen2-57B'));
  assert.notEqual(normalize('Command R+'), normalize('Command R'));
  assert.equal(normalize('Command R+'), normalize('Command R Plus'));
});

test('qualifiers round-trip through the resolved file and read well', () => {
  const qs = parseName('Llama-3-70B-AWQ (FC, Search)').qualifiers;
  const asText = (list: typeof qs) => new Set(list.map((q) => `${q.kind}:${q.value}`));
  assert.deepEqual(asText(readQualifiers(formatQualifiers(qs))), asText(qs));
  assert.equal(formatQualifiers(qs), 'mode:FC; search:search; quant:AWQ');
  assert.deepEqual(readQualifiers('mode:FC; search:search; quant:AWQ').map(describeQualifier), ['FC', 'with web search', 'AWQ']);
  assert.equal(qualifierFlags(qs), 3);
  assert.deepEqual(readQualifiers(''), []);
});
