/**
 * Matches a source's model name to a catalogue model. Exact matches only, after normalising case
 * and punctuation and setting aside qualifiers the name carries. No fuzzy matching: a wrong merge
 * silently mixes two models' scores, which is worse than a missing one.
 *
 *   "Gemini 4 Carbon (High)"           -> base "Gemini 4 Carbon", qualifier "High"
 *   "Claude-Opus-4-5-20251101 (FC)"    -> base "Claude-Opus-4-5", qualifiers "FC", "20251101"
 *   "Qwen/Qwen3-32B"                   -> base "Qwen3-32B"
 */
import type { CatalogModel } from './types.ts';

export interface Split {
  base: string;
  qualifiers: string[];
}

const DATE_SUFFIX = /[-_ .@]((?:19|20)\d{2}-?\d{2}-?\d{2}|\d{4}|\d{2}-\d{2})$/;

/** Takes trailing "(…)" / "[…]" groups and a trailing snapshot date off a name. */
export function splitQualifiers(raw: string): Split {
  let base = raw.trim();
  const qualifiers: string[] = [];
  for (;;) {
    const m = /\s*[([]([^()[\]]*)[)\]]\s*$/.exec(base);
    if (!m || m.index === 0) break;
    qualifiers.unshift(m[1]!.trim());
    base = base.slice(0, m.index).trim();
  }
  const slash = base.lastIndexOf('/');
  if (slash > 0 && slash < base.length - 1) base = base.slice(slash + 1);
  const d = DATE_SUFFIX.exec(base);
  // Only a full date (YYYYMMDD or YYYY-MM-DD) is a snapshot; "0905" or "2507" may be a version.
  if (d && /^(?:19|20)\d{2}-?\d{2}-?\d{2}$/.test(d[1]!)) {
    qualifiers.push(d[1]!);
    base = base.slice(0, d.index);
  }
  return { base, qualifiers };
}

export const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface Match {
  modelId: string;
  method: 'alias' | 'id' | 'name' | 'base_name' | 'label' | 'base_label';
  qualifiers: string[];
}

export class Matcher {
  private readonly ids = new Set<string>();
  private readonly byKey = new Map<string, Set<string>>();
  /** source id -> raw name -> model id, from curation/aliases.csv */
  private readonly aliases: Map<string, Map<string, string>>;

  constructor(catalog: readonly CatalogModel[], aliases: Map<string, Map<string, string>> = new Map()) {
    this.aliases = aliases;
    for (const m of catalog) {
      this.ids.add(m.id);
      const keys = new Set([normalize(m.id), normalize(m.name)]);
      const repo = m.model_repo && /huggingface\.co\/[^/]+\/([^/?#]+)/.exec(m.model_repo)?.[1];
      if (repo) keys.add(normalize(repo));
      for (const k of keys) {
        if (!k) continue;
        let set = this.byKey.get(k);
        if (!set) this.byKey.set(k, (set = new Set()));
        set.add(m.id);
      }
    }
  }

  /** The catalogue model for a normalised key, unless two models share it. */
  private unique(key: string): string | undefined {
    const set = this.byKey.get(key);
    return set && set.size === 1 ? [...set][0] : undefined;
  }

  match(source: string, raw: string, label?: string): Match | undefined {
    const alias = this.aliases.get(source)?.get(raw);
    if (alias) return { modelId: alias, method: 'alias', qualifiers: [] };
    if (this.ids.has(raw)) return { modelId: raw, method: 'id', qualifiers: [] };

    const tries: Array<[string | undefined, Match['method']]> = [];
    const s = splitQualifiers(raw);
    tries.push([normalize(raw), 'name'], [normalize(s.base), 'base_name']);
    let labelSplit: Split | undefined;
    if (label) {
      labelSplit = splitQualifiers(label);
      tries.push([normalize(label), 'label'], [normalize(labelSplit.base), 'base_label']);
    }
    for (const [key, method] of tries) {
      const id = key ? this.unique(key) : undefined;
      if (!id) continue;
      const qualifiers = method === 'base_name' ? s.qualifiers : method === 'base_label' ? labelSplit!.qualifiers : [];
      return { modelId: id, method, qualifiers };
    }
    return undefined;
  }
}

/** Parses curation/aliases.csv rows (source, raw_name, model_id) into a lookup. */
export function aliasMap(rows: ReadonlyArray<Record<string, unknown>>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
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
