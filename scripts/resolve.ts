/**
 * Matches every source's model names to the catalogue and writes the result for review.
 *
 *   data/resolved/aliases.csv    every name that matched: source, raw name, model, how
 *   data/reports/unmatched.csv   names that did not, most-used first
 *
 * Overrides go in curation/aliases.csv (source,raw_name,model_id). The build reads
 * data/resolved/aliases.csv, so a change in matching shows up as a diff in the data commit.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSources } from './lib/config.ts';
import { Matcher, aliasMap, toCsv } from './lib/match.ts';
import { parseDelimited, tableToRecords } from './lib/parse.ts';
import { CATALOG_PATH, DATA_DIR, readJsonl, readRows, writeText } from './lib/store.ts';
import type { CatalogModel } from './lib/types.ts';

export const RESOLVED_PATH = join(DATA_DIR, 'resolved', 'aliases.csv');
export const UNMATCHED_PATH = join(DATA_DIR, 'reports', 'unmatched.csv');

async function curation(): Promise<Map<string, Map<string, string>>> {
  try {
    return aliasMap(tableToRecords(parseDelimited(await readFile(join('curation', 'aliases.csv'), 'utf8'))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw e;
  }
}

const sources = await loadSources();
const catalog = await readJsonl<CatalogModel>(CATALOG_PATH);
const matcher = new Matcher(catalog, await curation());

const matched: Array<[string, string, string, string, string]> = [];
const unmatched: Array<[string, string, number, number]> = [];
const perSource: string[] = [];

for (const s of sources) {
  if (s.terms !== 'allowed') continue;
  const rows = await readRows(s.id);
  if (!rows.length) continue;
  const names = new Map<string, { label?: string; rows: number; scores: number }>();
  for (const r of rows) {
    const n = names.get(r.model) ?? { label: r.model_label, rows: 0, scores: 0 };
    n.rows++;
    n.scores += Object.keys(r.scores).length;
    names.set(r.model, n);
  }
  let hit = 0;
  for (const [raw, n] of names) {
    const m = matcher.match(s.id, raw, n.label);
    if (m) {
      hit++;
      matched.push([s.id, raw, m.modelId, m.method, m.qualifiers.join('; ')]);
    } else {
      unmatched.push([s.id, raw, n.rows, n.scores]);
    }
  }
  perSource.push(`${s.id} ${hit}/${names.size}`);
}

matched.sort((a, b) => (a[0] + '\0' + a[1] < b[0] + '\0' + b[1] ? -1 : 1));
unmatched.sort((a, b) => b[3] - a[3] || (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
await writeText(RESOLVED_PATH, toCsv(['source', 'raw_name', 'model_id', 'method', 'qualifiers'], matched));
await writeText(UNMATCHED_PATH, toCsv(['source', 'raw_name', 'rows', 'scores'], unmatched));
console.log(`matched model names: ${perSource.join(', ')}`);
