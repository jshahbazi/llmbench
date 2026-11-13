/**
 * Drafts a sources.yaml entry for a leaderboard's data file, and shows what it would import.
 *
 *   npm run add-source -- <location> [--id my-board] [--table 0] [--rows path.to.list] [--format csv]
 *
 * <location> is anything "fetch" accepts: https://..., github:owner/repo/path (globs allowed) or
 * hf:owner/dataset. The draft is printed, not written: check it, set the licence, read the
 * source's terms, then paste it into sources.yaml and try it with
 * `npm run scrape -- --source <id> --dry-run`.
 */
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { draftEntry } from './lib/draft.ts';
import { fetchSource, recordsFrom } from './lib/fetchers.ts';
import { fetchJson, parseGithubRef, parseHfRef } from './lib/http.ts';
import type { SourceConfig } from './lib/types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    table: { type: 'string' },
    rows: { type: 'string' },
    format: { type: 'string' },
  },
});
const location = positionals[0];
if (!location) {
  console.error('usage: npm run add-source -- <https://... | github:owner/repo/path | hf:owner/dataset> [--id id] [--table n] [--rows path] [--format csv]');
  process.exit(2);
}

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
let homepage = '';
let licence: string | undefined;
let id = values.id;
if (location.startsWith('github:')) {
  const { owner, repo } = parseGithubRef(location);
  homepage = `https://github.com/${owner}/${repo}`;
  id ??= slug(repo);
  licence = (await fetchJson<{ license?: { spdx_id?: string } }>(`https://api.github.com/repos/${owner}/${repo}`).catch(() => ({ license: undefined }))).license?.spdx_id;
} else if (location.startsWith('hf:')) {
  const { id: ds } = parseHfRef(location);
  homepage = `https://huggingface.co/datasets/${ds}`;
  id ??= slug(ds.split('/').pop() ?? ds);
  licence = (await fetchJson<{ cardData?: { license?: string } }>(`https://huggingface.co/api/datasets/${ds}`).catch(() => ({ cardData: undefined }))).cardData?.license;
} else {
  const u = new URL(location);
  homepage = u.origin;
  id ??= slug(u.pathname.split('/').filter(Boolean).pop() ?? u.hostname);
}
if (licence === 'NOASSERTION') licence = undefined;

const options: Record<string, unknown> = {};
for (const k of ['table', 'rows', 'format'] as const) if (values[k] !== undefined) options[k] = values[k];
const source: SourceConfig = { id: id || 'new-source', name: id || 'New source', homepage, terms: 'allowed', fetch: location, every: '6h', run_by: 'independent', options };

const fetched = await fetchSource({ source, force: true });
if (fetched === 'unchanged') throw new Error('unexpected "unchanged" for a forced fetch');
const records = await recordsFrom(fetched, options);
console.log(`Read ${records.length} records from ${fetched.files.length} file${fetched.files.length === 1 ? '' : 's'}.\n`);

const { entry, notes, columns } = draftEntry(records, { id: source.id, name: source.name, homepage, fetch: location, ...options });
const yaml = stringify([entry], { lineWidth: 0 })
  .trimEnd()
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n');
console.log('Columns:');
for (const c of columns) {
  const kind = c.nested ? 'nested' : c.numeric >= c.filled * 0.8 && c.filled ? 'number' : c.urls >= c.filled * 0.8 && c.filled ? 'link' : 'text';
  console.log(`  ${c.name.padEnd(32)} ${kind.padEnd(7)} ${String(c.filled).padStart(5)} filled  e.g. ${c.sample.map((s) => JSON.stringify(s.slice(0, 40))).join(', ')}`);
}
console.log('\nDraft entry for sources.yaml (check every line):\n');
console.log(yaml);
console.log(`    license: ${licence ?? 'TODO'}${licence ? '            # from the repository; check it covers the data' : ''}`);
console.log('    terms: blocked              # set to allowed once you have read the source\'s terms');
console.log('\nNotes:');
for (const n of notes) console.log(`  - ${n}`);
console.log(`\nNext: paste the entry into sources.yaml, then run: npm run scrape -- --source ${source.id} --dry-run`);
