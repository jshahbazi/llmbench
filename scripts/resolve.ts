/**
 * Matches every source's model names to the catalogue and writes the result for review.
 *
 *   data/resolved/aliases.csv    every name: source, raw name, model, how it matched, qualifiers
 *   data/resolved/unlisted.csv   models not in the catalogue, each gathering the names that agree
 *   data/reports/unmatched.csv   names not in the catalogue, most-used first, with near misses
 *
 * A name that matches no catalogue model still gets a model: names from any source whose core name
 * agrees exactly ("Gemini 3 Pro", "gemini-3-pro", "Gemini 3 Pro (Grounding)") share one, so they
 * sit on one row. Fixes go in curation/aliases.csv and curation/models.yaml. The build reads
 * data/resolved/, so any change in matching shows up as a diff in the data commit.
 */
import { join } from 'node:path';
import { loadSources } from './lib/config.ts';
import { loadAliases, loadCatalog } from './lib/curation.ts';
import { Matcher, slugifyModel, toCsv } from './lib/match.ts';
import { formatQualifiers, normalize, parseName } from './lib/names.ts';
import { DATA_DIR, readRows, writeText } from './lib/store.ts';

export const RESOLVED_PATH = join(DATA_DIR, 'resolved', 'aliases.csv');
export const UNLISTED_PATH = join(DATA_DIR, 'resolved', 'unlisted.csv');
export const UNMATCHED_PATH = join(DATA_DIR, 'reports', 'unmatched.csv');

interface NameInfo {
  source: string;
  raw: string;
  label?: string;
  url?: string;
  rows: number;
  scores: number;
}

const sources = await loadSources();
const catalog = await loadCatalog();
const catalogIds = new Set(catalog.map((m) => m.id));
const matcher = new Matcher(catalog, await loadAliases());

const resolved: string[][] = [];
const unmatched: NameInfo[] = [];
const perSource: string[] = [];

for (const s of sources) {
  if (s.terms !== 'allowed') continue;
  const rows = await readRows(s.id);
  if (!rows.length) continue;
  const names = new Map<string, NameInfo>();
  for (const r of rows) {
    const n = names.get(r.model) ?? { source: s.id, raw: r.model, label: r.model_label, url: r.model_url, rows: 0, scores: 0 };
    n.rows++;
    n.scores += Object.keys(r.scores).length;
    n.url ??= r.model_url;
    names.set(r.model, n);
  }
  let hit = 0;
  for (const n of names.values()) {
    const m = matcher.match(s.id, n.raw, { label: n.label, url: n.url });
    if (m && !catalogIds.has(m.modelId)) {
      console.warn(`curation/aliases.csv sends "${n.raw}" (${s.id}) to "${m.modelId}", which is not in the catalogue`);
    } else if (m) {
      hit++;
      resolved.push([s.id, n.raw, m.modelId, m.method, formatQualifiers(m.qualifiers)]);
      continue;
    }
    unmatched.push(n);
  }
  perSource.push(`${s.id} ${hit}/${names.size}`);
}

// Names with no catalogue model: one model per core name and snapshot, across sources.
const groupName = (raw: string): string => {
  const p = parseName(raw);
  if (p.pair) return raw;
  return p.snapshot ? `${p.core} (${p.snapshot.text})` : p.core;
};
const groups = new Map<string, NameInfo[]>();
for (const n of unmatched) {
  const p = parseName(n.raw);
  const d = p.snapshot;
  const k = p.pair ? normalize(n.raw) : `${normalize(p.core)}@${d ? `${d.y ?? ''}-${d.m ?? ''}-${d.d ?? ''}-${d.four ?? ''}` : ''}`;
  groups.set(k, [...(groups.get(k) ?? []), n]);
}
const display = (list: NameInfo[]): string => {
  const weight = new Map<string, number>();
  for (const n of list) {
    const core = groupName(n.raw);
    weight.set(core, (weight.get(core) ?? 0) + n.scores);
  }
  const looksNamed = (s: string) => Number(/[A-Z]/.test(s)) + Number(/ /.test(s));
  // A written-out name ("Mistral Large") over an identifier ("mistral-large"), then the most used.
  return [...weight].sort((a, b) => looksNamed(b[0]) - looksNamed(a[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
};
const taken = new Set(catalogIds);
const unlisted: string[][] = [];
const groupOf = new Map<NameInfo, string>();
for (const list of [...groups.values()].sort((a, b) => display(a).localeCompare(display(b)))) {
  const name = display(list);
  const slug = slugifyModel(name) || 'model';
  let id = taken.has(slug) ? `${slug}-unlisted` : slug;
  for (let k = 2; taken.has(id); k++) id = `${slug}-unlisted-${k}`;
  taken.add(id);
  const srcs = [...new Set(list.map((n) => n.source))];
  unlisted.push([id, name, srcs.join(' '), String(list.reduce((t, n) => t + n.scores, 0))]);
  for (const n of list) {
    groupOf.set(n, id);
    const p = parseName(n.raw);
    resolved.push([n.source, n.raw, id, matcher.blocked(n.source, n.raw) ? 'blocked' : 'unlisted', p.pair ? '' : formatQualifiers(p.qualifiers)]);
  }
}

const byKey = (a: string[], b: string[]) => (a[0]! + '\0' + a[1]! < b[0]! + '\0' + b[1]! ? -1 : 1);
resolved.sort(byKey);
unlisted.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
const report = unmatched
  .sort((a, b) => b.scores - a.scores || (a.source + '\0' + a.raw < b.source + '\0' + b.raw ? -1 : 1))
  .map((n) => [n.source, n.raw, groupOf.get(n)!, n.rows, n.scores, matcher.suggest(n.raw, n.label).join(' ')]);

await writeText(RESOLVED_PATH, toCsv(['source', 'raw_name', 'model_id', 'method', 'qualifiers'], resolved));
await writeText(UNLISTED_PATH, toCsv(['model_id', 'name', 'sources', 'scores'], unlisted));
await writeText(UNMATCHED_PATH, toCsv(['source', 'raw_name', 'unlisted_as', 'rows', 'scores', 'suggestions'], report));

const shared = unlisted.filter((u) => u[2]!.includes(' ')).length;
console.log(`matched model names: ${perSource.join(', ')}`);
console.log(`${unmatched.length} names not in the catalogue, as ${unlisted.length} unlisted models (${shared} named by more than one source)`);
