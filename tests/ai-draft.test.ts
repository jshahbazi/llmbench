import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { aiDraft, check, claudeSender, entryFrom, PROPOSAL_SCHEMA, promptFor, type Proposal, type Reply } from '../scripts/lib/ai-draft.ts';
import { profile } from '../scripts/lib/draft.ts';

const RECORDS = [
  { rank: '-', model: 'Highest Human Score*', score: '95.4%', organization: '', dateAdded: null },
  { rank: '1st', model: 'Claude Fable 5.2', score: '94.9%', organization: 'Anthropic', dateAdded: '2026-11-10' },
  { rank: '2nd', model: 'Gemini 4 Carbon', score: '92.6%', organization: 'Google', dateAdded: '2026-11-10' },
  { rank: '-', model: 'Human Baseline*', score: '83.7%', organization: '', dateAdded: null },
  { rank: '3rd', model: 'GPT-6 Astra', score: '83.6%', organization: 'OpenAI', dateAdded: '2026-09-07' },
];
const BASE = { id: 'simplebench', name: 'simplebench', homepage: 'https://simple-bench.com', fetch: 'https://simple-bench.com/x.js', rows: 'leaderboardData' };

const empty: Proposal['mapping'] = {
  model: 'model', model_label: null, model_url: null, model_match: null, key: null, context: null, date: null, scores: null, metric: null, value: null, ci: null,
  ignore: null, filter: null, exclude: null, lower_is_better: null, labels: null, unit: null, units: null, headline: null, tags: null, duplicates: null, run_by: null, run_by_from: null,
};
const proposal = (m: Partial<Proposal['mapping']>, notes: string[] = []): Proposal => ({ name: 'SimpleBench', mapping: { ...empty, ...m }, notes });
const reply = (p: Proposal, stopReason = 'end_turn'): Reply => ({
  content: [{ type: 'text', text: JSON.stringify(p), citations: null } as Anthropic.Beta.BetaTextBlock],
  text: JSON.stringify(p),
  stopReason,
  model: 'claude-opus-5-5',
  inputTokens: 1000,
  outputTokens: 200,
});

test('AI draft: the answer schema suits structured outputs', () => {
  const walk = (s: unknown, path: string): void => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (o['type'] === 'object') {
      assert.equal(o['additionalProperties'], false, `${path} allows other properties`);
      assert.deepEqual(o['required'], Object.keys(o['properties'] as object), `${path} has optional fields`);
    }
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`));
      else walk(v, `${path}.${k}`);
    }
  };
  walk(PROPOSAL_SCHEMA, 'answer');
});

test('AI draft: the prompt has the columns, a sample and the rule-based draft', () => {
  const text = promptFor({ location: BASE.fetch, records: RECORDS, columns: profile(RECORDS), draftYaml: '  - id: simplebench', sample: 2 });
  assert.match(text, /Records: 5/);
  assert.match(text, /- "score": number, 5 filled/);
  assert.match(text, /First 2 records:/);
  assert.ok(text.includes('"model":"Claude Fable 5.2"'));
  assert.ok(!text.includes('Gemini 4 Carbon"}'), 'only the sample is sent');
  assert.match(text, /Draft by the rules[\s\S]*- id: simplebench/);
});

test('AI draft: answers become sources.yaml fields', () => {
  const e = entryFrom(BASE, {
    name: 'SimpleBench',
    mapping: {
      ...empty,
      scores: ['score', 'other'],
      metric: null,
      ci: [{ score: 'score', low: 'lo', high: 'hi' }],
      exclude: [{ column: 'rank', values: ['-'] }],
      filter: [{ column: 'split', values: ['a', 'b'] }],
      labels: [{ column: 'score', label: 'SimpleBench score' }],
      units: [{ column: 'score', unit: 'percent' }],
      run_by_from: { column: 'src', values: [{ value: 'Lab', run_by: 'independent' }] },
      ignore: [],
    },
    notes: [],
  });
  assert.equal(e['name'], 'SimpleBench', 'a placeholder name is replaced');
  assert.deepEqual(e['ci'], { score: ['lo', 'hi'] });
  assert.deepEqual(e['exclude'], { rank: '-' });
  assert.deepEqual(e['filter'], { split: ['a', 'b'] });
  assert.deepEqual(e['labels'], { score: 'SimpleBench score' });
  assert.deepEqual(e['units'], { score: 'percent' });
  assert.deepEqual(e['run_by_from'], { column: 'src', values: { Lab: 'independent' } });
  assert.ok(!('ignore' in e) && !('model_label' in e), 'empty and null fields are left out');
  const long = entryFrom({ ...BASE, name: 'Kept' }, proposal({ metric: ['benchmark'], value: 'v', ci: [{ score: null, low: 'lo', high: 'hi' }] }));
  assert.deepEqual([long['name'], long['metric'], long['ci']], ['Kept', 'benchmark', ['lo', 'hi']]);
});

test('AI draft: every answer is run on all records', () => {
  const good = check(RECORDS, entryFrom(BASE, proposal({ scores: ['score'], exclude: [{ column: 'rank', values: ['-'] }] })));
  assert.deepEqual([good.ok, good.rows, good.metrics], [true, 3, 1]);
  const missing = check(RECORDS, entryFrom(BASE, proposal({ scores: ['Score %'] })));
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(' '), /missing column "Score %"/);
  const invalid = check(RECORDS, entryFrom(BASE, proposal({ scores: ['score'], model_match: '(' })));
  assert.match(invalid.problems[0]!, /not a valid regular expression/);
});

test('AI draft: problems go back to Claude until the mapping runs', async () => {
  const sent: Anthropic.Beta.BetaMessageParam[][] = [];
  const answers = [
    proposal({ scores: ['Score'] }),
    proposal({ scores: ['score'], exclude: [{ column: 'rank', values: ['-'] }], labels: [{ column: 'score', label: 'SimpleBench score' }], unit: 'percent' }, ['Two rows are human baselines; left out.']),
  ];
  const out = await aiDraft({
    send: async (m) => {
      sent.push(structuredClone(m));
      return reply(answers[sent.length - 1]!);
    },
    base: BASE,
    records: RECORDS,
    prompt: 'first',
  });
  assert.equal(out.rounds, 2);
  assert.ok(out.check.ok);
  assert.deepEqual(out.entry['exclude'], { rank: '-' });
  assert.deepEqual(out.notes, ['Two rows are human baselines; left out.']);
  assert.deepEqual([out.inputTokens, out.outputTokens], [2000, 400]);
  // The second turn carries Claude's first answer unchanged, then what went wrong.
  assert.equal(sent[1]!.length, 3);
  assert.equal(sent[1]![1]!.role, 'assistant');
  assert.match(String(sent[1]![2]!.content), /all 5 records went wrong:\n- missing column "Score"/);
});

test('AI draft: gives up after a few tries, and stops on a refusal', async () => {
  let calls = 0;
  const stuck = await aiDraft({ send: async () => (calls++, reply(proposal({ scores: ['nope'] }))), base: BASE, records: RECORDS, prompt: 'p', rounds: 2 });
  assert.deepEqual([calls, stuck.rounds, stuck.check.ok], [2, 2, false]);
  await assert.rejects(aiDraft({ send: async () => reply(proposal({}), 'refusal'), base: BASE, records: RECORDS, prompt: 'p' }), /declined/);
  await assert.rejects(aiDraft({ send: async () => ({ ...reply(proposal({})), text: 'not json' }), base: BASE, records: RECORDS, prompt: 'p' }), /not the expected JSON/);
});

test('AI draft: the request uses structured outputs, high effort and server-side fallbacks', async () => {
  const params: Array<Record<string, unknown>> = [];
  const fake = {
    beta: {
      messages: {
        stream: (p: Record<string, unknown>) => {
          params.push(p);
          return { finalMessage: async () => ({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', model: p['model'], usage: { input_tokens: 5, output_tokens: 7 } }) };
        },
      },
    },
  } as unknown as Anthropic;
  const r = await claudeSender(fake)([{ role: 'user', content: 'x' }]);
  assert.deepEqual([r.text, r.inputTokens, r.outputTokens, r.model], ['{}', 5, 7, 'claude-opus-5-5']);
  const p = params[0]!;
  assert.equal(p['model'], 'claude-opus-5-5');
  assert.deepEqual(p['betas'], ['server-side-fallback-2026-07-01']);
  assert.equal(p['fallbacks'], 'default');
  assert.deepEqual((p['output_config'] as { effort: string }).effort, 'high');
  assert.equal((p['output_config'] as { format: { type: string } }).format.type, 'json_schema');
  assert.ok(!('thinking' in p), 'thinking is left at the model default');
  await claudeSender(fake, 'claude-haiku-5-5')([{ role: 'user', content: 'x' }]);
  assert.ok(!('fallbacks' in params[1]!), 'no fallbacks for a model without them');
});
