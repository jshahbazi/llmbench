/**
 * Claude drafts a source's field mapping, for `npm run add-source -- <location> --ai`.
 *
 * Claude gets where the data comes from, a profile of every column, the first rows and the
 * rule-based draft, and answers with a mapping in a fixed JSON shape (structured outputs). The
 * mapping is then run on every record exactly as an update run would. If it does not run, or the
 * run reports problems (a missing column, rows that repeat), the problems go back to Claude for
 * another try, a few times at most. Licence and terms are never Claude's call: a person sets them.
 */
import Anthropic from '@anthropic-ai/sdk';
import { extract, mappingFrom } from './extract.ts';
import type { ColumnProfile } from './draft.ts';
import type { Rec } from './parse.ts';
import { RUN_BY } from './types.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** Models that accept `fallbacks: "default"`: a refusal is retried on a fallback model server-side. */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const TAGS = ['coding', 'agents', 'math', 'knowledge', 'chat', 'vision', 'search'] as const;

// ---- The answer's shape. Every field is required and nullable: structured outputs needs
// additionalProperties false on every object, and null says "leave this out".
const STR = { type: 'string' };
const orNull = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const object = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: object) => ({ type: 'array', items });
const columnValues = orNull(list(object({ column: STR, values: list(STR) })));

export const PROPOSAL_SCHEMA = object({
  name: STR,
  mapping: object({
    model: STR,
    model_label: orNull(STR),
    model_url: orNull(STR),
    model_match: orNull(STR),
    key: orNull(list(STR)),
    context: orNull(list(STR)),
    date: orNull(STR),
    scores: orNull(list(STR)),
    metric: orNull(list(STR)),
    value: orNull(STR),
    ci: orNull(list(object({ score: orNull(STR), low: STR, high: STR }))),
    ignore: orNull(list(STR)),
    filter: columnValues,
    exclude: columnValues,
    lower_is_better: orNull(list(STR)),
    labels: orNull(list(object({ column: STR, label: STR }))),
    unit: orNull(STR),
    units: orNull(list(object({ column: STR, unit: STR }))),
    headline: orNull(list(STR)),
    tags: orNull(list({ type: 'string', enum: [...TAGS] })),
    duplicates: orNull({ type: 'string', enum: ['hold', 'drop'] }),
    run_by: orNull({ type: 'string', enum: [...RUN_BY] }),
    run_by_from: orNull(object({ column: STR, values: list(object({ value: STR, run_by: { type: 'string', enum: [...RUN_BY] } })) })),
  }),
  notes: list(STR),
});

type Pairs<K extends string, V extends string> = Array<Record<K | V, string>> | null;
export interface Proposal {
  name: string;
  mapping: {
    model: string;
    model_label: string | null;
    model_url: string | null;
    model_match: string | null;
    key: string[] | null;
    context: string[] | null;
    date: string | null;
    scores: string[] | null;
    metric: string[] | null;
    value: string | null;
    ci: Array<{ score: string | null; low: string; high: string }> | null;
    ignore: string[] | null;
    filter: Array<{ column: string; values: string[] }> | null;
    exclude: Array<{ column: string; values: string[] }> | null;
    lower_is_better: string[] | null;
    labels: Pairs<'column', 'label'>;
    unit: string | null;
    units: Pairs<'column', 'unit'>;
    headline: string[] | null;
    tags: string[] | null;
    duplicates: 'hold' | 'drop' | null;
    run_by: string | null;
    run_by_from: { column: string; values: Array<{ value: string; run_by: string }> } | null;
  };
  notes: string[];
}

export const SYSTEM = `You map leaderboard data into llmbench's sources.yaml. llmbench imports benchmark results for language models from many leaderboards and shows them side by side; a source's entry tells a generic reader which columns hold what. You get where the data comes from, a profile of every column, the first rows and a draft made by simple rules. Answer with the mapping in the given JSON shape; null means "leave this field out".

Fields:
- name: the leaderboard's name as people know it.
- model: the column naming the model, exactly as the source writes it. model_label: a second column with a display name, when "model" is an identifier. model_url: a column linking to the model.
- model_match: a regular expression whose first group is the model name, only when names carry flags or decorations that are not part of the name (e.g. "^[*!]*(.+)$").
- scores: the columns holding a measured result for the model on a benchmark. For a long table (one row per model and metric), use metric (the column or columns naming the metric) and value (the column with the number) instead, and leave scores null.
- context: columns describing how the model was run (reasoning effort, agent or scaffold, quantization, prompt format). key: columns that make each row unique when the model name alone does not.
- date: the column with when the result was produced or published.
- ci: confidence-interval columns. One item with score null for a long table or a table with one score; otherwise one item per score column.
- ignore: columns to drop (ranks, row numbers). Columns not named anywhere are kept with each row as details, which is usually right for sizes, counts and notes.
- filter keeps only rows where a column has one of the values; exclude drops them. Use exclude for rows that are not models: human or random baselines, averages.
- lower_is_better: scores where lower is better (error and hallucination rates, cost, time).
- labels: a short label for a score whose column name would not mean much next to columns from other leaderboards, naming the benchmark ("SimpleBench score", not "score"). Leave clear names alone.
- unit for every score, or units per score: percent (0-100), fraction (0-1), elo (a rating), USD, seconds, or score for anything else. Decide from the values, not the names.
- headline: the one or few overall scores. Sub-scores stay out of it.
- tags: the kinds of task the scores measure, from the list.
- duplicates: "drop" only when the source repeats rows with nothing to tell them apart; otherwise null.
- run_by: independent when the leaderboard's maintainers ran every evaluation, submitted when entrants ran their own and sent results in, lab when the numbers are what model makers reported. run_by_from: when a column says who ran each row.

Rules:
- Name only columns from the profile, spelled exactly as there.
- Ranks, counts, sample sizes, vote totals, model sizes and release dates are not scores.
- Prefer null to a guess. Put what a person should check in notes, as short sentences: what you were unsure of and why.
- Say nothing about licences or terms of use; a person checks those.
- When told what went wrong running your mapping, fix it and give the whole answer again.`;

const clip = (v: unknown, n = 160): unknown => {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…` : v;
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : v;
  }
  return v;
};

/** The first message: where the data is from, its columns, a sample and the rule-based draft. */
export function promptFor(o: { location: string; records: readonly Rec[]; columns: readonly ColumnProfile[]; draftYaml: string; sample?: number }): string {
  const n = o.sample ?? 25;
  const cols = o.columns.map((c) => {
    const kind = c.nested ? 'nested' : c.filled && c.numeric >= c.filled * 0.8 ? 'number' : c.filled && c.urls >= c.filled * 0.8 ? 'link' : 'text';
    return `- ${JSON.stringify(c.name)}: ${kind}, ${c.filled} filled, ${c.distinct} distinct; e.g. ${c.sample.map((s) => JSON.stringify(clip(s, 60))).join(', ')}`;
  });
  const rows = o.records.slice(0, n).map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)]))));
  return [
    `Location: ${o.location}`,
    `Records: ${o.records.length}`,
    '',
    'Columns:',
    ...cols,
    '',
    `First ${rows.length} records:`,
    ...rows,
    '',
    'Draft by the rules (a starting point; it may be wrong):',
    o.draftYaml,
  ].join('\n');
}

/** A proposal as a sources.yaml entry, on top of the entry's fixed fields (id, fetch, selectors). */
export function entryFrom(base: Record<string, unknown>, p: Proposal): Record<string, unknown> {
  const m = p.mapping;
  const entry: Record<string, unknown> = { ...base };
  if (p.name?.trim() && (!base['name'] || base['name'] === base['id'])) entry['name'] = p.name.trim();
  const set = (k: string, v: unknown) => {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return;
    entry[k] = v;
  };
  const record = <T>(items: Array<{ [k: string]: T }> | null, key: string, val: string) => (items?.length ? Object.fromEntries(items.map((i) => [i[key] as unknown as string, i[val]])) : null);
  set('model', m.model);
  set('model_label', m.model_label);
  set('model_url', m.model_url);
  set('model_match', m.model_match);
  set('key', m.key);
  set('context', m.context);
  set('date', m.date);
  set('scores', m.scores);
  set('metric', m.metric?.length === 1 ? m.metric[0] : m.metric);
  set('value', m.value);
  if (m.ci?.length) {
    const single = m.ci.length === 1 && (m.ci[0]!.score === null || (m.scores?.length ?? 0) <= 1 || !!m.metric);
    entry['ci'] = single ? [m.ci[0]!.low, m.ci[0]!.high] : Object.fromEntries(m.ci.filter((c) => c.score).map((c) => [c.score!, [c.low, c.high]]));
  }
  set('ignore', m.ignore);
  const values = (items: Array<{ column: string; values: string[] }> | null) => (items?.length ? Object.fromEntries(items.map((i) => [i.column, i.values.length === 1 ? i.values[0]! : i.values])) : null);
  set('filter', values(m.filter));
  set('exclude', values(m.exclude));
  set('lower_is_better', m.lower_is_better);
  set('labels', record(m.labels, 'column', 'label'));
  set('unit', m.unit);
  set('units', record(m.units, 'column', 'unit'));
  set('headline', m.headline);
  set('tags', m.tags);
  set('duplicates', m.duplicates);
  set('run_by', m.run_by);
  if (m.run_by_from?.values.length) entry['run_by_from'] = { column: m.run_by_from.column, values: Object.fromEntries(m.run_by_from.values.map((v) => [v.value, v.run_by])) };
  return entry;
}

export interface CheckResult {
  ok: boolean;
  rows: number;
  metrics: number;
  /** What went wrong, for Claude and for the person. */
  problems: string[];
  warnings: string[];
}

/** Runs an entry on every record, the way an update run would. */
export function check(records: readonly Rec[], entry: Record<string, unknown>): CheckResult {
  try {
    const out = extract([...records], mappingFrom(entry, 'draft'));
    const problems = [...out.problems];
    if (!out.rows.length) problems.push('the mapping gives no rows');
    else if (!out.metrics.length) problems.push('the mapping gives no scores');
    return { ok: !problems.length, rows: out.rows.length, metrics: out.metrics.length, problems, warnings: out.warnings };
  } catch (e) {
    return { ok: false, rows: 0, metrics: 0, problems: [(e as Error).message], warnings: [] };
  }
}

/** One turn with Claude: the full reply (to send back on the next turn) and its text. */
export interface Reply {
  content: Anthropic.Beta.BetaContentBlock[];
  text: string;
  stopReason: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
export type Send = (messages: Anthropic.Beta.BetaMessageParam[]) => Promise<Reply>;

/** Sends turns to the Claude API. Streams, so a long think does not hit a request timeout. */
export function claudeSender(client: Anthropic, model = DEFAULT_MODEL): Send {
  return async (messages) => {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32000,
      ...(FALLBACK_MODELS.has(model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      system: SYSTEM,
      output_config: { effort: 'high', format: { type: 'json_schema', schema: PROPOSAL_SCHEMA } },
      messages,
    });
    const msg = await stream.finalMessage();
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { content: msg.content, text, stopReason: msg.stop_reason, model: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
  };
}

export interface AiDraft {
  entry: Record<string, unknown>;
  check: CheckResult;
  notes: string[];
  rounds: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Asks Claude for a mapping and checks it on every record; problems go back for another try, up
 * to `rounds` answers in all. Returns the last answer, with its check, even when it still fails.
 */
export async function aiDraft(o: { send: Send; base: Record<string, unknown>; records: readonly Rec[]; prompt: string; rounds?: number }): Promise<AiDraft> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: o.prompt }];
  const max = o.rounds ?? 3;
  let inputTokens = 0;
  let outputTokens = 0;
  let last: AiDraft | undefined;
  for (let round = 1; round <= max; round++) {
    const reply = await o.send(messages);
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    if (reply.stopReason === 'refusal') throw new Error('Claude declined to draft this mapping');
    if (reply.stopReason === 'max_tokens') throw new Error('Claude ran out of room before finishing the mapping');
    let proposal: Proposal;
    try {
      proposal = JSON.parse(reply.text) as Proposal;
    } catch {
      throw new Error('Claude\'s answer was not the expected JSON');
    }
    const entry = entryFrom(o.base, proposal);
    const result = check(o.records, entry);
    last = { entry, check: result, notes: proposal.notes ?? [], rounds: round, model: reply.model, inputTokens, outputTokens };
    if (result.ok) return last;
    messages.push({ role: 'assistant', content: reply.content as Anthropic.Beta.BetaContentBlockParam[] });
    messages.push({
      role: 'user',
      content: `Running that mapping on all ${o.records.length} records went wrong:\n${result.problems.map((p) => `- ${p}`).join('\n')}\nFix the mapping and give the whole answer again.`,
    });
  }
  return last!;
}
