/**
 * Drafts a sources.yaml entry from a sample of records, for `npm run add-source`. Everything here
 * is a guess about the table's structure, made from column names and values; the draft is printed
 * for a person to check, and nothing is written. Scores are never invented: the draft only says
 * which columns hold them.
 */
import { extract, isMissing, looksNumeric, mappingFrom } from './extract.ts';
import type { Rec } from './parse.ts';

export interface ColumnProfile {
  name: string;
  filled: number;
  numeric: number;
  distinct: number;
  urls: number;
  dates: number;
  nested: number;
  sample: string[];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim());
const isDate = (s: string) => /^(19|20)\d{2}-\d{2}(-\d{2})?([T ][\d:.]+Z?)?$/.test(s) || /^[A-Z][a-z]{2,8} \d{1,2}, (19|20)\d{2}$/.test(s);

export function profile(records: readonly Rec[]): ColumnProfile[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (seen.has(k)) continue;
      seen.add(k);
      order.push(k);
    }
  }
  return order.map((name) => {
    const values = records.map((r) => r[name]).filter((v) => !isMissing(v) && text(v) !== '');
    const strings = values.map(text);
    return {
      name,
      filled: values.length,
      numeric: values.filter(looksNumeric).length,
      distinct: new Set(strings).size,
      urls: strings.filter((s) => /^https?:\/\//i.test(s)).length,
      dates: strings.filter(isDate).length,
      nested: values.filter((v) => typeof v === 'object').length,
      sample: [...new Set(strings)].slice(0, 3),
    };
  });
}

const MODEL_NAMES = /^(model|model[ _-]?name|model[ _-]?id|name|llm|system|agent|submission)$/i;
const RANK = /^(#|rank|ranking|position|place|no\.?|index|idx|id|unnamed: ?0)$/i;
const NOT_A_SCORE = /^#|param|size|tokens?\b|context|window|year|votes?\b|samples?|count|\bn\b|num_|length|words|version|release|matchups|\bgames\b|\bcases\b|coverage/i;
const LOWER = /cost|price|\$|latency|time|seconds|\(s\)|duration|error|loss|hallucinat|perplexity|ttft|sensitivity|deviation/i;
const SETTING = /(^|[^a-z])(effort|reasoning|mode|format|settings?|scaffold|agent|harness|quant|quantization|precision|temperature|variant|config)([^a-z]|$)/i;
const DATE_NAME = /date|time|submitted|updated|evaluated|created/i;

export interface Draft {
  entry: Record<string, unknown>;
  notes: string[];
  columns: ColumnProfile[];
}

/** Guesses a field mapping for these records. `base` holds id, name, fetch and selector options. */
export function draftEntry(records: readonly Rec[], base: Record<string, unknown>): Draft {
  const notes: string[] = [];
  const cols = profile(records);
  const n = records.length;
  const byName = new Map(cols.map((c) => [c.name, c]));
  const usable = cols.filter((c) => !c.name.startsWith('_') || c.name === '_file' || c.name === '_config');
  for (const c of cols.filter((c) => c.nested)) notes.push(`"${c.name}" holds nested values; a plugin can read them (see scripts/sources/tau2.ts)`);

  // The model column: a named one if there is one, else the most varied text column.
  const textCols = usable.filter((c) => c.filled && c.numeric < c.filled / 2 && !c.nested && c.urls < c.filled / 2);
  const model =
    textCols.find((c) => MODEL_NAMES.test(c.name)) ??
    textCols.find((c) => /model|name/i.test(c.name)) ??
    [...textCols].sort((a, b) => b.distinct - a.distinct)[0];
  if (!model) {
    notes.push('no column looks like model names; set "model" by hand');
    return { entry: { ...base, model: '?' }, notes, columns: cols };
  }
  const entry: Record<string, unknown> = { ...base, model: model.name };

  const link = usable.find((c) => c.urls && c.urls >= c.filled * 0.8 && /link|url|href|model/i.test(c.name));
  if (link) entry['model_url'] = link.name;
  const date = usable.find((c) => c.dates && c.dates >= c.filled * 0.8 && DATE_NAME.test(c.name));
  if (date) entry['date'] = date.name;

  // Repeated model names need a key; a column describing how the model was run is the usual one.
  const settings = usable.filter((c) => c !== model && c !== link && c !== date && c.numeric < c.filled / 2 && !c.nested && SETTING.test(c.name));
  if (model.distinct < model.filled) {
    const unique = (cols2: string[]) => new Set(records.map((r) => cols2.map((k) => text(r[k])).join('\u0000'))).size === n;
    const extra = [...settings, ...(date ? [date] : []), ...textCols.filter((c) => c !== model)].find((c) => unique([model.name, c.name]));
    if (extra) {
      entry['key'] = [model.name, extra.name];
      if (SETTING.test(extra.name)) entry['context'] = [extra.name];
    } else {
      notes.push(`model names repeat (${model.filled - model.distinct} times) and no single column tells the rows apart; set "key" or "duplicates: drop"`);
    }
  }
  if (settings.length && !entry['context']) entry['context'] = settings.map((c) => c.name);

  const named = new Set([model.name, link?.name, date?.name, ...((entry['context'] as string[] | undefined) ?? [])]);
  const numeric = usable.filter((c) => !named.has(c.name) && c.filled && c.numeric >= c.filled * 0.8 && !c.nested);
  const ranks = numeric.filter((c) => RANK.test(c.name));
  const meta = numeric.filter((c) => !ranks.includes(c) && NOT_A_SCORE.test(c.name));
  const scores = numeric.filter((c) => !ranks.includes(c) && !meta.includes(c));
  if (!scores.length) notes.push('no numeric score columns found; long tables need "metric" and "value"');
  entry['scores'] = scores.map((c) => c.name);
  if (ranks.length) entry['ignore'] = ranks.map((c) => c.name);
  if (meta.length) notes.push(`left out as not scores (kept with each row): ${meta.map((c) => `"${c.name}"`).join(', ')}`);
  const lower = scores.filter((c) => LOWER.test(c.name)).map((c) => c.name);
  if (lower.length) entry['lower_is_better'] = lower;
  if (scores.length > 8) notes.push(`${scores.length} score columns; consider "headline" for the few shown by default`);
  entry['min_rows'] = Math.max(1, Math.floor(n * 0.8));

  // Try the draft the same way an update run would.
  try {
    const out = extract([...records], mappingFrom(entry, 'draft'));
    notes.push(`the draft gives ${out.rows.length} rows and ${out.metrics.length} metrics${out.problems.length ? `; problems: ${out.problems.join('; ')}` : ''}`);
    for (const w of out.warnings) notes.push(w);
  } catch (e) {
    notes.push(`the draft does not run yet: ${(e as Error).message}`);
  }
  if (byName.has('_file')) notes.push('rows come from several files; each row has its file in "_file"');
  return { entry, notes, columns: cols };
}
