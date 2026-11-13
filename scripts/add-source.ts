/**
 * Drafts a sources.yaml entry for a leaderboard's data file, and shows what it would import.
 *
 *   npm run add-source -- <location> [--id my-board] [--table 0] [--rows path.to.list] [--format csv]
 *                                    [--ai] [--model claude-opus-5-5]
 *
 * <location> is anything "fetch" accepts: https://..., github:owner/repo/path (globs allowed) or
 * hf:owner/dataset. The draft is printed, not written: check it, set the licence, read the
 * source's terms, then paste it into sources.yaml and try it with
 * `npm run scrape -- --source <id> --dry-run`.
 *
 * --ai has Claude draft the mapping from the columns, a sample of rows and the rule-based draft,
 * and checks Claude's draft on every record (scripts/lib/ai-draft.ts). It sends that sample to the
 * Claude API, so it needs credentials: ANTHROPIC_API_KEY, or a profile from `ant auth login`.
 */
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { stringify } from 'yaml';
import { aiDraft, claudeSender, DEFAULT_MODEL, promptFor } from './lib/ai-draft.ts';
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
    ai: { type: 'boolean', default: false },
    model: { type: 'string', default: DEFAULT_MODEL },
  },
});
const location = positionals[0];
if (!location) {
  console.error('usage: npm run add-source -- <https://... | github:owner/repo/path | hf:owner/dataset> [--id id] [--table n] [--rows path] [--format csv] [--ai] [--model id]');
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
const yamlOf = (e: Record<string, unknown>) =>
  stringify([e], { lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
console.log('Columns:');
for (const c of columns) {
  const kind = c.nested ? 'nested' : c.numeric >= c.filled * 0.8 && c.filled ? 'number' : c.urls >= c.filled * 0.8 && c.filled ? 'link' : 'text';
  console.log(`  ${c.name.padEnd(32)} ${kind.padEnd(7)} ${String(c.filled).padStart(5)} filled  e.g. ${c.sample.map((s) => JSON.stringify(s.slice(0, 40))).join(', ')}`);
}

let final = entry;
let finalNotes = notes;
let heading = 'Draft entry for sources.yaml (check every line):';
if (values.ai) {
  const model = values.model ?? DEFAULT_MODEL;
  console.log(`\nAsking ${model} to draft the mapping (it sees the columns, the first rows and the draft below)…`);
  try {
    const base = { id: source.id, name: source.name, homepage, fetch: location, ...options };
    const out = await aiDraft({ send: claudeSender(new Anthropic(), model), base, records, prompt: promptFor({ location, records, columns, draftYaml: yamlOf(entry) }) });
    const minRows = Math.max(1, Math.floor(out.check.rows * 0.8));
    final = { ...out.entry, min_rows: minRows };
    heading = `Draft entry by ${out.model}, run on all ${records.length} records (check every line):`;
    finalNotes = [
      ...out.notes,
      out.check.ok
        ? `the draft gives ${out.check.rows} rows and ${out.check.metrics} metrics`
        : `the draft still has problems after ${out.rounds} tries: ${out.check.problems.join('; ')}`,
      ...out.check.warnings,
      `Claude: ${out.rounds} ${out.rounds === 1 ? 'answer' : 'answers'}, ${out.inputTokens.toLocaleString('en')} input and ${out.outputTokens.toLocaleString('en')} output tokens`,
    ];
  } catch (e) {
    const why =
      e instanceof Anthropic.AuthenticationError || /authentication method/i.test((e as Error).message)
        ? 'no working Claude API credentials (set ANTHROPIC_API_KEY, or run `ant auth login`)'
        : e instanceof Anthropic.APIError
          ? `the Claude API returned ${e.status ?? 'an error'}: ${e.message}`
          : (e as Error).message;
    console.log(`Claude's draft failed: ${why}. Showing the rule-based draft instead.`);
  }
}

console.log(`\n${heading}\n`);
console.log(yamlOf(final));
console.log(`    license: ${licence ?? 'TODO'}${licence ? '            # from the repository; check it covers the data' : ''}`);
console.log('    terms: blocked              # set to allowed once you have read the source\'s terms');
console.log('\nNotes:');
for (const n of finalNotes) console.log(`  - ${n}`);
console.log(`\nNext: paste the entry into sources.yaml, then run: npm run scrape -- --source ${source.id} --dry-run`);
