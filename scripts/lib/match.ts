/**
 * Matches a source's model name to a catalogue model. Exact matches only: no fuzzy matching, because
 * a wrong merge silently mixes two models' scores, which is worse than a missing one. In order:
 *
 *   alias    a line in curation/aliases.csv
 *   link     the row links to a Hugging Face repository the catalogue knows
 *   exact    the whole name equals a catalogue id, name or repository name, ignoring case and
 *            punctuation
 *   variant  the name minus its qualifiers (effort, snapshot, "Preview", "(FC)"...) equals one, and
 *            exactly one catalogue model fits: a stated snapshot date must agree with the model's
 *   maker    the same, after a leading maker name ("NVIDIA-", "Amazon ") that agrees with the
 *            model's provider
 *
 * Qualifiers set aside to make a match are kept as the score's context.
 */
import { normalize, parseName, readSnapshot, sameSnapshot, type ParsedName, type Qualifier, type Snapshot } from './names.ts';
import type { CatalogModel } from './types.ts';

export type MatchMethod = 'alias' | 'link' | 'exact' | 'variant' | 'maker';

export interface Match {
  modelId: string;
  method: MatchMethod;
  qualifiers: Qualifier[];
}

export interface NameHints {
  /** The source's display name, when its model field is an identifier. */
  label?: string;
  /** A link the row gives for the model. */
  url?: string;
}

/** source id (or "*") -> raw name -> model id, or "-" for "never match". */
export type Aliases = Map<string, Map<string, string>>;
export const NO_MATCH = '-';

interface Member {
  id: string;
  snapshot?: Snapshot;
  stage: string[];
  provider: string;
}

const hfRepo = (url: string | undefined): string | undefined => {
  const m = url && /^https?:\/\/huggingface\.co\/([^/?#]+)\/([^/?#]+)/i.exec(url);
  return m && !['datasets', 'spaces'].includes(m[1]!) ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
};

const add = <K, V>(map: Map<K, Set<V>>, k: K, v: V) => {
  let set = map.get(k);
  if (!set) map.set(k, (set = new Set()));
  set.add(v);
};

const sameStage = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export class Matcher {
  private readonly ids = new Set<string>();
  /** Normalised catalogue id or name -> model ids */
  private readonly exactKeys = new Map<string, Set<string>>();
  /** Normalised repository name -> model ids. Weaker: a preview and its release can share a repo. */
  private readonly repoKeys = new Map<string, Set<string>>();
  /** "org/name" of a Hugging Face repository -> model id */
  private readonly repos = new Map<string, Set<string>>();
  /** Normalised core name (qualifiers removed) -> the models it could be */
  private readonly families = new Map<string, Map<string, Member>>();
  /** Normalised maker word -> normalised provider names it can stand for */
  private readonly makers = new Map<string, Set<string>>();
  /** Model id -> the snapshot and release stage its own name states */
  private readonly own = new Map<string, { snapshot?: Snapshot; stage: string[] }>();
  private readonly aliases: Aliases;

  constructor(catalog: readonly CatalogModel[], aliases: Aliases = new Map()) {
    this.aliases = aliases;
    for (const m of catalog) {
      this.ids.add(m.id);
      add(this.exactKeys, normalize(m.id), m.id);
      add(this.exactKeys, normalize(m.name), m.id);
      const repo = hfRepo(m.model_repo);
      const repoName = repo?.split('/')[1];
      if (repo) add(this.repos, repo, m.id);
      if (repoName) add(this.repoKeys, normalize(repoName), m.id);

      const provider = normalize(m.provider ?? '');
      const parses = [m.name, m.id, ...(repoName ? [repoName] : [])].map(parseName);
      const snapshot = parses.find((p) => p.snapshot)?.snapshot;
      const stage = [...new Set(parses.flatMap((p) => p.stage))];
      this.own.set(m.id, { ...(snapshot && { snapshot }), stage });
      for (const p of parses) {
        // "Kimi K2 Thinking" and "qwen3-235b-a22b-thinking-2507" are models of their own, not
        // thinking-mode runs of Kimi K2 or Qwen3 235B; they stay out of those families.
        if (p.qualifiers.some((q) => q.kind === 'reasoning')) continue;
        const key = normalize(p.core);
        if (!key) continue;
        let fam = this.families.get(key);
        if (!fam) this.families.set(key, (fam = new Map()));
        fam.set(m.id, { id: m.id, ...(snapshot && { snapshot }), stage, provider });
      }
      if (m.provider) {
        const first = normalize(m.provider.split(/[\s(/,&]+/)[0] ?? '');
        for (const k of new Set([provider, first])) if (k.length >= 3) add(this.makers, k, provider);
      }
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** A curation line for this name, or for the name without its organisation ("mistralai/..."). */
  private aliasFor(source: string, raw: string): string | undefined {
    const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : undefined;
    for (const name of bare ? [raw, bare] : [raw]) {
      const hit = this.aliases.get(source)?.get(name) ?? this.aliases.get('*')?.get(name);
      if (hit) return hit;
    }
    return undefined;
  }

  /** True when curation says this name must not be matched. */
  blocked(source: string, raw: string): boolean {
    return this.aliasFor(source, raw) === NO_MATCH;
  }

  private unique(map: Map<string, Set<string>>, key: string): string | undefined {
    const set = key ? map.get(key) : undefined;
    return set && set.size === 1 ? [...set][0] : undefined;
  }

  /**
   * The model whose id or name is this key, else whose repository name is. When the two disagree,
   * neither: "Gemma 2B" is the id of the instruct model but the repository name of the base one.
   */
  private exactId(key: string): string | undefined {
    const byName = this.exactKeys.get(key);
    const byRepo = this.repoKeys.get(key);
    if (byName) return byName.size === 1 && (!byRepo || byRepo.has([...byName][0]!)) ? [...byName][0] : undefined;
    return this.unique(this.repoKeys, key);
  }

  /**
   * The one catalogue model a parsed name can be, or undefined. Candidates share its core name; a
   * stated snapshot must agree; then the release stage, then "no snapshot either", break ties.
   */
  private pick(p: ParsedName, key: string, provider?: Set<string>): string | undefined {
    const fam = this.families.get(key);
    if (!fam) return undefined;
    let list = [...fam.values()].filter((m) => sameSnapshot(p.snapshot, m.snapshot) && (!provider || provider.has(m.provider)));
    if (p.snapshot && list.some((m) => m.snapshot)) list = list.filter((m) => m.snapshot);
    if (list.length > 1) {
      const staged = list.filter((m) => sameStage(m.stage, p.stage));
      if (staged.length) list = staged;
    }
    if (list.length > 1 && !p.snapshot) {
      const undated = list.filter((m) => !m.snapshot);
      if (undated.length) list = undated;
    }
    return list.length === 1 ? list[0]!.id : undefined;
  }

  /**
   * Leaves out qualifiers the model's own name already states: "Ministral-8B-2410" matched to
   * "Ministral 8B (2410)" needs no "snapshot 2410" on every score.
   */
  private trim(m: Match): Match {
    const own = this.own.get(m.modelId);
    if (!own) return m;
    const qualifiers = m.qualifiers.filter(
      (q) =>
        !(q.kind === 'snapshot' && own.snapshot && sameSnapshot(readSnapshot(q.value), own.snapshot)) &&
        !(q.kind === 'stage' && own.stage.includes(q.value)),
    );
    return qualifiers.length === m.qualifiers.length ? m : { ...m, qualifiers };
  }

  match(source: string, raw: string, hints: NameHints = {}): Match | undefined {
    const m = this.find(source, raw, hints);
    return m && this.trim(m);
  }

  private find(source: string, raw: string, hints: NameHints): Match | undefined {
    const parsed = parseName(raw);
    const context = parsed.pair ? [] : parsed.qualifiers;

    const alias = this.aliasFor(source, raw);
    if (alias === NO_MATCH) return undefined;
    if (alias) return { modelId: alias, method: 'alias', qualifiers: context };
    if (parsed.pair) return undefined;

    const repo = hfRepo(hints.url);
    const linked = repo ? this.repos.get(repo) : undefined;
    if (linked?.size === 1) return { modelId: [...linked][0]!, method: 'link', qualifiers: context };

    if (this.ids.has(raw)) return { modelId: raw, method: 'exact', qualifiers: [] };
    const names = [raw, ...(parsed.org ? [raw.slice(parsed.org.length + 1)] : []), ...(hints.label ? [hints.label] : [])];
    for (const n of names) {
      const id = this.exactId(normalize(n));
      if (id) return { modelId: id, method: 'exact', qualifiers: [] };
    }

    const parses = [parsed, ...(hints.label ? [parseName(hints.label)] : [])].filter((p) => !p.pair);
    for (const p of parses) {
      // A model literally named "<core> Thinking" (Kimi K2 Thinking, Qwen3 235B-A22B Thinking 2507)
      // comes before the base model run in thinking mode, unless it is a dated release and the name
      // states no date: LiveBench lists "qwen3-235b-a22b-thinking" (the original model in thinking
      // mode) next to "qwen3-235b-a22b-thinking-2507".
      const thinking = p.qualifiers.find((q) => q.kind === 'reasoning' && /thinking/.test(q.value) && !/^non/.test(q.value));
      if (thinking) {
        const id = this.pick(p, normalize(`${p.core} thinking`));
        if (id && (p.snapshot || !this.own.get(id)?.snapshot)) return { modelId: id, method: 'variant', qualifiers: p.qualifiers.filter((q) => q !== thinking) };
      }
      const id = this.pick(p, normalize(p.core));
      if (id) return { modelId: id, method: 'variant', qualifiers: p.qualifiers };
    }

    for (const p of parses) {
      const words = p.core.split(/[-_ ]+|(?<=[a-z])\.(?=[a-z])/i).filter(Boolean);
      for (let i = 1; i <= 2 && i < words.length; i++) {
        const providers = this.makers.get(normalize(words.slice(0, i).join(' ')));
        if (!providers) continue;
        const rest = normalize(words.slice(i).join(' '));
        if (rest.length < 3) continue;
        const id = this.pick(p, rest, providers);
        if (id) return { modelId: id, method: 'maker', qualifiers: p.qualifiers };
      }
    }
    return undefined;
  }

  /**
   * Catalogue models a name nearly matches, for the unmatched report: models sharing its core name
   * (where the match was ambiguous), then names that start with it or differ by a character or two.
   */
  suggest(raw: string, label?: string, limit = 3): string[] {
    const scored = new Map<string, number>();
    const note = (id: string, score: number) => {
      if (!scored.has(id) || scored.get(id)! > score) scored.set(id, score);
    };
    for (const p of [parseName(raw), ...(label ? [parseName(label)] : [])]) {
      const key = normalize(p.pair ? p.raw : p.core);
      if (key.length < 3) continue;
      for (const id of this.families.get(key)?.keys() ?? []) note(id, 0);
      for (const map of [this.families, this.exactKeys]) {
        for (const [k, ids] of map) {
          let score: number | undefined;
          if (k !== key && k.length >= 4 && (k.startsWith(key) || key.startsWith(k))) score = 1 + Math.abs(k.length - key.length) / 100;
          else if (key.length >= 5 && Math.abs(k.length - key.length) <= 2) {
            const d = editDistance(k, key, 2);
            if (d > 0 && d <= 2) score = 2 + d;
          }
          if (score !== undefined) for (const id of ids instanceof Map ? ids.keys() : ids) note(id, score);
        }
      }
    }
    return [...scored].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
  }
}

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Parses curation/aliases.csv rows (source, raw_name, model_id) into a lookup. */
export function aliasMap(rows: ReadonlyArray<Record<string, unknown>>): Aliases {
  const out: Aliases = new Map();
  for (const r of rows) {
    const source = String(r['source'] ?? '').trim();
    const raw = String(r['raw_name'] ?? '');
    const id = String(r['model_id'] ?? '').trim();
    if (!source || !raw || !id) continue;
    let m = out.get(source);
    if (!m) out.set(source, (m = new Map()));
    m.set(raw, id);
  }
  return out;
}

/** CSV with quoting where needed. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

/** A URL path segment for a model with no catalogue id. */
export function slugifyModel(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, '-plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
