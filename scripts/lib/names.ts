/**
 * Reads a source's model name into the model it names and the qualifiers it carries: how the model
 * was run (reasoning effort, thinking budget, quantization, calling mode, web search) and which
 * snapshot or release stage it was.
 *
 *   "o1-2024-12-17_high"                      core "o1", snapshot 2024-12-17, effort high
 *   "Gemini 2.5 Flash-Lite Preview (Thinking, 06-17)"
 *                                             core "Gemini 2.5 Flash-Lite", stage preview,
 *                                             reasoning on, snapshot 06-17
 *   "NVIDIA-Nemotron-3-Ultra-550B-A55B (NVFP4)"  core "NVIDIA-Nemotron-3-Ultra-550B-A55B", quant NVFP4
 *   "Qwen/Qwen3-32B"                          org "Qwen", core "Qwen3-32B"
 *
 * The matcher always tries the whole name first; the parse only decides what it may fall back to.
 */
import { FLAG_QUANTIZED, FLAG_SEARCH } from '../../site/src/select.ts';

export type QualifierKind = 'snapshot' | 'stage' | 'effort' | 'budget' | 'reasoning' | 'quant' | 'mode' | 'search' | 'other';

export interface Qualifier {
  kind: QualifierKind;
  value: string;
}

/** A snapshot date, as far as the name states it. A 4-digit tag ("0905", "2411") is kept as `four`. */
export interface Snapshot {
  text: string;
  y?: number;
  m?: number;
  d?: number;
  four?: string;
}

export interface ParsedName {
  raw: string;
  org?: string;
  /** The name with the organisation and every qualifier removed. */
  core: string;
  snapshot?: Snapshot;
  stage: string[];
  qualifiers: Qualifier[];
  /** "A + B" outside brackets: two models working together, such as an architect and an editor. Never matched. */
  pair: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const validM = (m: number) => m >= 1 && m <= 12;
const validD = (d: number) => d >= 1 && d <= 31;

/** Reads a date-like token as a snapshot, or returns undefined. */
export function readSnapshot(text: string): Snapshot | undefined {
  const t = text.trim();
  let m = /^((?:19|20)\d{2})[-_. /]?(\d{2})[-_. /]?(\d{2})$/.exec(t);
  if (m && validM(+m[2]!) && validD(+m[3]!)) return { text: t, y: +m[1]!, m: +m[2]!, d: +m[3]! };
  m = /^(2\d)(\d{2})(\d{2})$/.exec(t); // YYMMDD, as in doubao-seed-2.0-pro-260215
  if (m && +m[1]! >= 22 && validM(+m[2]!) && validD(+m[3]!)) return { text: t, y: 2000 + +m[1]!, m: +m[2]!, d: +m[3]! };
  m = /^((?:19|20)\d{2})-(\d{2})$/.exec(t);
  if (m && validM(+m[2]!)) return { text: t, y: +m[1]!, m: +m[2]! };
  m = /^(\d{2})-((?:19|20)\d{2})$/.exec(t); // 09-2025
  if (m && validM(+m[1]!)) return { text: t, y: +m[2]!, m: +m[1]! };
  m = /^(\d{2})-(\d{2})$/.exec(t); // 06-17
  if (m && validM(+m[1]!) && validD(+m[2]!)) return { text: t, m: +m[1]!, d: +m[2]! };
  m = /^([a-z]{3,9})\.?,? ((?:19|20)\d{2})$/i.exec(t); // Jul 2025, Sept 2024, October 2024
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (mi >= 0 && MONTHS[mi]!.length <= m[1]!.length) return { text: t, y: +m[2]!, m: mi + 1 };
  }
  m = /^(\d{2})(\d{2})$/.exec(t); // 0905 (MMDD) or 2411 (YYMM)
  if (m && ((validM(+m[1]!) && validD(+m[2]!)) || (+m[1]! >= 22 && +m[1]! <= 39 && validM(+m[2]!)))) return { text: t, four: t };
  return undefined;
}

/** Every reading of a snapshot as a partial date. A 4-digit tag may be MMDD or YYMM. */
function readings(s: Snapshot): Array<{ y?: number; m?: number; d?: number }> {
  if (!s.four) return [{ ...(s.y && { y: s.y }), ...(s.m && { m: s.m }), ...(s.d && { d: s.d }) }];
  const a = +s.four.slice(0, 2);
  const b = +s.four.slice(2);
  const out: Array<{ y?: number; m?: number; d?: number }> = [];
  if (validM(a) && validD(b)) out.push({ m: a, d: b });
  if (a >= 22 && a <= 39 && validM(b)) out.push({ y: 2000 + a, m: b });
  return out;
}

/** True when two snapshots could be the same release: no stated part of the date disagrees. */
export function sameSnapshot(a: Snapshot | undefined, b: Snapshot | undefined): boolean {
  if (!a || !b) return true;
  for (const x of readings(a)) {
    for (const y of readings(b)) {
      let shared = 0;
      let clash = false;
      for (const k of ['y', 'm', 'd'] as const) {
        if (x[k] === undefined || y[k] === undefined) continue;
        shared++;
        if (x[k] !== y[k]) clash = true;
      }
      if (!clash && shared > 0) return true;
    }
  }
  return false;
}

const EFFORT = /^(none|minimal|low|medium|high|xhigh|x-high|max|maximum)$/i;
const QUANT_WORDS = 'bf16|fp16|fp8|fp4|nvfp4|mxfp4|int4|int8|w4a16|w8a8|w4a8|awq|gptq|gguf|exl2|q[2-8](?:_k(?:_[sml])?|_0|_1)?|[248]-?bit';
const QUANT = new RegExp(`^(${QUANT_WORDS})$`, 'i');
const STAGE = /^(preview|beta|exp|experimental)$/i;

/** Classifies one qualifier, such as the parts of "(Thinking, 06-17)". */
export function classify(part: string): Qualifier {
  const p = part.trim();
  const lower = p.toLowerCase();
  const snap = readSnapshot(p);
  if (snap) return { kind: 'snapshot', value: p };
  let m = /^(none|minimal|low|medium|high|xhigh|x-high|max|maximum)(?:[- ](?:effort|reasoning))?$/i.exec(p);
  if (m) return { kind: 'effort', value: m[1]!.toLowerCase().replace('x-high', 'xhigh').replace('maximum', 'max') };
  m = /^(\d+(?:\.\d+)?)\s?k(?:\s?(?:tokens|thinking|budget))?$/i.exec(p);
  if (m) return { kind: 'budget', value: `${m[1]}K` };
  if (/^(thinking|reasoning|think|extended thinking)$/i.test(p)) return { kind: 'reasoning', value: 'thinking' };
  if (/^(non[- ]?thinking|no[- ]?think(?:ing)?|non[- ]?reasoning|no[- ]?reasoning)$/i.test(p)) return { kind: 'reasoning', value: 'non-thinking' };
  if (QUANT.test(p)) return { kind: 'quant', value: p.toUpperCase().replace(/-?BIT$/, '-bit') };
  if (/^(fc|function calling|native fc)$/i.test(p)) return { kind: 'mode', value: 'FC' };
  if (/^(prompt|prompting)$/i.test(p)) return { kind: 'mode', value: 'Prompt' };
  if (/^(search|web search|with search|grounding|grounded|online|web)$/i.test(p)) return { kind: 'search', value: lower === 'grounding' || lower === 'grounded' ? 'grounding' : 'search' };
  if (STAGE.test(p) || /^public preview$/i.test(p)) return { kind: 'stage', value: lower.replace('experimental', 'exp').replace('public preview', 'preview') };
  return { kind: 'other', value: p };
}

/**
 * Trailing qualifiers written into the name itself rather than in brackets. Each pattern matches the
 * separator and the qualifier, so the name is cut where the match starts.
 */
const SUFFIXES: Array<{ re: RegExp; take: (m: RegExpExecArray) => Qualifier | undefined }> = [
  // Epoch-style run settings: o1-2024-12-17_high, claude-opus-4-1-20250805_27K
  { re: /_(none|minimal|low|medium|high|xhigh|max)$/i, take: (m) => ({ kind: 'effort', value: m[1]!.toLowerCase() }) },
  { re: /_(\d+)K$/i, take: (m) => ({ kind: 'budget', value: `${m[1]}K` }) },
  // gpt-5-mini-high. Not "-medium" or "-max", which are model names (Mistral Medium, Qwen-Max).
  { re: /-(minimal|low|high|xhigh)$/i, take: (m) => ({ kind: 'effort', value: m[1]!.toLowerCase() }) },
  { re: new RegExp(`[-_ ](${QUANT_WORDS})$`, 'i'), take: (m) => ({ kind: 'quant', value: m[1]!.toUpperCase() }) },
  { re: /[-_ ](preview|beta|exp|experimental)$/i, take: (m) => ({ kind: 'stage', value: m[1]!.toLowerCase().replace('experimental', 'exp') }) },
  // Snapshot dates: -2024-12-17, -20250514, -260428, preview-06-17, -0905 (after a word, not a number)
  { re: /[-_ @]((?:19|20)\d{2}-?\d{2}-?\d{2}|2\d{5})$/, take: (m) => snap(m[1]!) },
  { re: /(?<=[A-Za-z])[-_ ](\d{2}-(?:\d{2}|(?:19|20)\d{2}))$/, take: (m) => snap(m[1]!) },
  { re: /(?<=[A-Za-z]\d*)[-_ ](\d{4})$/, take: (m) => snap(m[1]!) },
];
function snap(text: string): Qualifier | undefined {
  return readSnapshot(text) ? { kind: 'snapshot', value: text } : undefined;
}

/** Splits a raw model name into the model it names and its qualifiers. */
export function parseName(raw: string): ParsedName {
  let name = raw.trim();
  const pair = /\s\+\s/.test(name.replace(/[([][^()[\]]*[)\]]/g, ''));
  const qualifiers: Qualifier[] = [];
  let org: string | undefined;

  if (!pair) {
    // Bracketed groups at the end, each possibly a list: "(Thinking, 06-17)".
    for (;;) {
      const m = /\s*[([]([^()[\]]*)[)\]]\s*$/.exec(name);
      if (!m || m.index === 0) break;
      const parts = m[1]!.split(/,|\s\+\s/).map((x) => x.trim()).filter(Boolean);
      qualifiers.unshift(...parts.map(classify));
      name = name.slice(0, m.index).trim();
    }
    const slash = name.lastIndexOf('/');
    if (slash > 0 && slash < name.length - 1) {
      org = name.slice(0, slash);
      name = name.slice(slash + 1);
    }
    // Suffixes, from the end, until none applies.
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of SUFFIXES) {
        const m = s.re.exec(name);
        if (!m) continue;
        const q = s.take(m);
        if (!q) continue;
        const cut = m.index;
        if (cut <= 0) continue;
        qualifiers.unshift(q);
        name = name.slice(0, cut).trim();
        changed = true;
        break;
      }
    }
  }

  const snapQ = qualifiers.find((q) => q.kind === 'snapshot');
  return {
    raw,
    ...(org && { org }),
    core: name,
    ...(snapQ && { snapshot: readSnapshot(snapQ.value)! }),
    stage: qualifiers.filter((q) => q.kind === 'stage').map((q) => q.value),
    qualifiers,
    pair,
  };
}

/**
 * A matching key: lower case, punctuation removed, except that a separator between two numbers is
 * kept as "." so that "OPT-1.3B" and "OPT-13B", or "Qwen2.5-7B" and "Qwen2-57B", stay apart.
 * Full dates are written as YYYYMMDD first, so "2024-12-17" and "20241217" agree, and "+" reads
 * as "plus", so "Command R+" is "Command R Plus" and not "Command R".
 */
export function normalize(s: string): string {
  const dated = s
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/((?:19|20)\d{2})[-_. ](\d{2})[-_. ](\d{2})(?!\d)/g, '$1$2$3');
  const tokens = dated.split(/[^a-z0-9]+/).filter(Boolean);
  let out = '';
  for (const t of tokens) {
    if (out && /\d$/.test(out) && /^\d/.test(t)) out += '.';
    out += t;
  }
  return out;
}

const KIND_ORDER: QualifierKind[] = ['reasoning', 'effort', 'budget', 'mode', 'search', 'quant', 'stage', 'snapshot', 'other'];

/** Qualifiers as stored in data/resolved/aliases.csv: "effort:high; snapshot:2024-12-17". */
export function formatQualifiers(qs: readonly Qualifier[]): string {
  return [...qs]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((q) => `${q.kind}:${q.value}`)
    .join('; ');
}

export function readQualifiers(text: string): Qualifier[] {
  if (!text) return [];
  return text.split('; ').map((p) => {
    const i = p.indexOf(':');
    const kind = p.slice(0, i) as QualifierKind;
    return KIND_ORDER.includes(kind) ? { kind, value: p.slice(i + 1) } : { kind: 'other', value: p };
  });
}

/** How a qualifier reads on the site: "high effort", "32K thinking budget", "snapshot 2024-12-17". */
export function describeQualifier(q: Qualifier): string {
  switch (q.kind) {
    case 'effort':
      return `${q.value} effort`;
    case 'budget':
      return `${q.value} thinking budget`;
    case 'snapshot':
      return `snapshot ${q.value}`;
    case 'search':
      return q.value === 'grounding' ? 'with grounding' : 'with web search';
    default:
      return q.value;
  }
}

/** Flags the explorer filters on. */
export function qualifierFlags(qs: readonly Qualifier[]): number {
  let f = 0;
  for (const q of qs) {
    if (q.kind === 'quant') f |= FLAG_QUANTIZED;
    if (q.kind === 'search') f |= FLAG_SEARCH;
  }
  return f;
}
