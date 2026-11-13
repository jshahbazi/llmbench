import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnOf, fromMaker, placeOf, scoresFrom, type MdModel } from '../scripts/sources/models-dev.ts';

test("a maker's own places: hosts and subdomains, Hugging Face and GitHub organisations", () => {
  assert.equal(placeOf('https://www.anthropic.com/news/x'), 'anthropic.com');
  assert.equal(placeOf('https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro'), 'hf:deepseek-ai');
  assert.equal(placeOf('https://github.com/meituan-longcat/LongCat'), 'gh:meituan-longcat');
  assert.equal(placeOf('not a url'), '');
  assert.ok(fromMaker('anthropic', 'https://www.anthropic.com/claude-fable-and-mythos-5-2'));
  assert.ok(fromMaker('google', 'https://deepmind.google/models/gemini/'));
  assert.ok(fromMaker('deepseek', 'https://api-docs.deepseek.com/news'), 'a subdomain');
  assert.ok(fromMaker('deepseek', 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro'));
  assert.ok(!fromMaker('anthropic', 'https://openai.com/index/gpt-5'), "another maker's comparison");
  assert.ok(!fromMaker('openai', 'https://artificialanalysis.ai/models/gpt-5'));
  assert.ok(!fromMaker('alibaba', 'https://labs.scale.com/leaderboard'));
  assert.ok(!fromMaker('mistral', 'https://openrouter.ai/mistralai/x'));
  assert.ok(!fromMaker('zhipuai', 'https://huggingface.co/someone-else/GLM-5.3'), 'another organisation on Hugging Face');
  assert.ok(!fromMaker('unknown-lab', 'https://unknown-lab.ai/post'));
  assert.ok(!fromMaker('openai', 'https://fakeopenai.com/x'), 'a host only ends with the domain after a dot');
});

test('columns: benchmark, version, subset, tools and scale; the rest is context', () => {
  assert.deepEqual(columnOf({ name: 'Terminal-Bench', version: '2.0', score: 1 }), { id: 'terminal-bench/v2', label: 'Terminal-Bench 2.0', direction: 'higher' });
  assert.equal(columnOf({ name: 'Terminal-Bench 2.1', score: 1 }).id, 'terminal-bench/v2.1');
  assert.equal(columnOf({ name: 'LiveCodeBench v6', score: 1 }).id, 'livecodebench/v6');
  assert.equal(columnOf({ name: 'AIME 2025', score: 1 }).id, 'aime-2025', 'a year stays in the name');
  assert.deepEqual(columnOf({ name: "Humanity's Last Exam", variant: 'with tools; max effort', score: 1 }), {
    id: 'humanitys-last-exam/with-tools',
    label: "Humanity's Last Exam, with tools",
    direction: 'higher',
  });
  assert.equal(columnOf({ name: "Humanity's Last Exam", variant: 'no tools', score: 1 }).id, 'humanitys-last-exam');
  assert.equal(columnOf({ name: "Humanity's Last Exam", dataset: 'text-only subset', score: 1 }).id, 'humanitys-last-exam/text-only');
  assert.equal(columnOf({ name: 'FrontierMath', version: 'v2', dataset: 'Tier 4', score: 1 }).id, 'frontiermath/v2/tier-4');
  assert.equal(columnOf({ name: 'τ²-Bench Telecom', score: 1 }).id, 'tau2-bench-telecom');
  assert.deepEqual(columnOf({ name: 'Codeforces', metric: 'rating', score: 3000 }), { id: 'codeforces/rating', label: 'Codeforces rating', direction: 'higher', unit: 'rating', metric: 'rating' });
  assert.equal(columnOf({ name: 'OmniDocBench', version: '1.5', metric: 'overall edit distance', score: 0.12 }).direction, 'lower');
});

test("scores: only a maker's own reports, no Artificial Analysis benchmarks, run by the lab", () => {
  const text = { input: ['text'], output: ['text'] };
  const doc: Record<string, MdModel> = {
    'anthropic/claude-fable-5-2': {
      id: 'anthropic/claude-fable-5-2',
      name: 'Claude Fable 5.2',
      modalities: text,
      benchmarks: [
        { name: 'SWE-Bench Verified', score: 88.1, metric: 'resolved', variant: 'max effort', source: 'https://www.anthropic.com/claude-fable-and-mythos-5-2', date: '2026-11-09' },
        { name: "Humanity's Last Exam", score: 74.2, variant: 'with tools; highest available effort', metric: 'score', source: 'https://www.anthropic.com/claude-fable-and-mythos-5-2' },
        { name: 'OSWorld', version: '2.1', score: 89.3, metric: 'partial score', source: 'https://www.anthropic.com/claude-fable-and-mythos-5-2' },
        { name: 'AA-Briefcase', score: 1785, metric: 'Elo', source: 'https://www.anthropic.com/claude-fable-and-mythos-5-2' },
        { name: 'GDPval', score: 1846, metric: 'Elo', source: 'https://www.anthropic.com/claude-fable-and-mythos-5-2' },
        { name: 'SWE-Bench Pro', score: 60, source: 'https://labs.scale.com/leaderboard/swe_bench_pro' },
        { name: 'Artificial Analysis Intelligence Index', score: 70, source: 'https://artificialanalysis.ai/' },
      ],
    },
    'openai/gpt-5-5': {
      id: 'openai/gpt-5-5',
      name: 'GPT-5.5',
      modalities: text,
      benchmarks: [
        { name: 'SWE-Bench Verified', score: 85, metric: 'percent resolved', source: 'https://openai.com/index/gpt-5-5' },
        { name: 'SWE-Bench Verified', score: 85, metric: 'percent resolved', source: 'https://openai.com/index/gpt-5-5' },
        { name: 'SWE-Bench Verified', score: 80, source: 'https://www.anthropic.com/claude-fable-and-mythos-5-2' },
      ],
    },
    'newlab/model-x': { id: 'newlab/model-x', name: 'Model X', modalities: text, benchmarks: [{ name: 'GPQA Diamond', score: 80, source: 'https://newlab.ai/x' }] },
    'openai/gpt-image-3': { id: 'openai/gpt-image-3', name: 'GPT Image 3', type: 'image', modalities: { input: ['text'], output: ['image'] }, benchmarks: [{ name: 'GenEval', score: 90, source: 'https://openai.com/x' }] },
  };
  const { rows, metrics, warnings } = scoresFrom(doc);
  assert.deepEqual(
    rows.map((r) => [r.model, Object.keys(r.scores)[0], Object.values(r.scores)[0]]),
    [
      ['anthropic/claude-fable-5-2', 'swe-bench-verified', 88.1],
      ['anthropic/claude-fable-5-2', 'humanitys-last-exam/with-tools', 74.2],
      ['anthropic/claude-fable-5-2', 'osworld/v2.1', 89.3],
      ['openai/gpt-5-5', 'swe-bench-verified', 85],
    ],
    "Scale's and Artificial Analysis's numbers, AA benchmarks, GDPval Elo, a rival's report and a duplicate are left out",
  );
  const fable = rows[0]!;
  assert.deepEqual(
    { label: fable.model_label, context: fable.context, date: fable.date, run_by: fable.run_by, url: fable.upstream_url },
    { label: 'Claude Fable 5.2', context: { setting: 'max effort' }, date: '2026-11-09', run_by: 'lab', url: 'https://www.anthropic.com/claude-fable-and-mythos-5-2' },
    '"resolved" says nothing the column does not',
  );
  assert.deepEqual(rows[1]!.context, { setting: 'highest available effort' }, 'the tools part is in the column');
  assert.deepEqual(rows[2]!.context, { metric: 'partial score' });
  assert.deepEqual(
    metrics.map((m) => [m.id, m.unit, m.headline]).sort(),
    [
      ['humanitys-last-exam/with-tools', 'percent', false],
      ['osworld/v2.1', 'percent', false],
      ['swe-bench-verified', 'percent', false],
    ],
  );
  assert.deepEqual(warnings, ['1 scores for models by "newlab" left out: no sites listed for that maker in MAKER_SOURCES (scripts/sources/models-dev.ts)']);
});
