/**
 * Fetches each due source in sources.yaml, checks the result, and writes it under data/.
 *
 *   npm run scrape                       every due source
 *   npm run scrape -- --source <id>      one source, due or not
 *   npm run scrape -- --force            ignore "unchanged upstream" and "not due"
 *   npm run scrape -- --accept <id>      publish a held source's data despite its guards
 *
 * For each source: fetch → extract → diff against the last good rows → guards → write.
 * A held or failed source keeps its last good data. Outcomes go to .cache/last-run.json, which
 * scripts/report-issues.ts turns into GitHub issues.
 */
import { parseArgs } from 'node:util';
import { intervalMs, loadSources } from './lib/config.ts';
import { diffRows, historyIndex } from './lib/diff.ts';
import { extract, mappingFrom } from './lib/extract.ts';
import { fetchSource } from './lib/fetchers.ts';
import { checkGuards } from './lib/guards.ts';
import { detectFormat, parseRecords, type Rec } from './lib/parse.ts';
import {
  duplicateKeys,
  readHistory,
  readRows,
  readRunCache,
  readState,
  writeCatalog,
  writeRunCache,
  writeSource,
} from './lib/store.ts';
import type { ExtractResult, Plugin, PluginContext, RunEntry, SourceConfig } from './lib/types.ts';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    force: { type: 'boolean', default: false },
    accept: { type: 'string' },
  },
});
const only = values.source || process.env['ONLY_SOURCE'] || undefined;
const accept = values.accept || process.env['ACCEPT_SOURCE'] || undefined;
const force = values.force ?? false;
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** Runs the field-mapping path: fetch, parse every file, apply the mapping. */
async function runMapping(ctx: PluginContext): Promise<ExtractResult | 'unchanged'> {
  const spec = mappingFrom(ctx.source.options, `source "${ctx.source.id}"`);
  const fetched = await fetchSource(ctx);
  if (fetched === 'unchanged') return 'unchanged';
  const format = ctx.source.options['format'] as Parameters<typeof parseRecords>[1] | undefined;
  const rowsPath = ctx.source.options['rows'] === undefined ? undefined : String(ctx.source.options['rows']);
  const records: Rec[] = [];
  for (const f of fetched.files) {
    const fmt = format ?? detectFormat(f.path, f.contentType);
    if (!fmt) throw new Error(`cannot tell the format of ${f.path}; set "format"`);
    for (const r of await parseRecords(f.bytes, fmt, rowsPath, f.path)) records.push(f.columns ? { ...r, ...f.columns } : r);
  }
  const out = extract(records, spec);
  return { ...out, revision: fetched.revision, revisionDate: fetched.revisionDate, etag: fetched.etag, lastModified: fetched.lastModified };
}

async function runSource(source: SourceConfig, cache: RunEntry | undefined): Promise<RunEntry> {
  const base = { checked_at: now, last_success_at: cache?.last_success_at, etag: cache?.etag, last_modified: cache?.last_modified };
  const previous = await readState(source.id);
  const ctx: PluginContext = { source, previous, cache, force };

  let result: ExtractResult | 'unchanged';
  if (source.plugin) {
    const mod = (await import(`./sources/${source.plugin}.ts`)) as { default: Plugin };
    result = await mod.default(ctx);
  } else {
    result = await runMapping(ctx);
  }
  if (result === 'unchanged') return { ...base, outcome: 'unchanged', last_success_at: now };

  const validators = { etag: result.etag ?? base.etag, last_modified: result.lastModified ?? base.last_modified };
  const prevRows = await readRows(source.id);
  const history = historyIndex(await readHistory(source.id));
  const rolling = source.options['rolling'] === true;
  const { events, stats } = diffRows(prevRows, result.rows, {
    now,
    rev: result.revision,
    history,
    rollingDays: rolling ? 7 : undefined,
    baselineAt: previous?.baseline_at ?? previous?.changed_at,
  });
  const summary = previous
    ? `${result.rows.length} rows; ${stats.added} added, ${stats.changed} changed, ${stats.removed} removed` +
      (stats.returned ? `, ${stats.returned} returned` : '')
    : `baseline: ${result.rows.length} rows, ${stats.added} scores`;
  const warnings = result.warnings?.length ? result.warnings : undefined;

  const reasons = checkGuards({
    prevRows,
    nextRows: result.rows,
    stats,
    problems: [...(result.problems ?? []), ...duplicateKeys(result.rows)],
    minRows: Number(source.options['min_rows'] ?? 1),
    rolling,
  });
  if (reasons.length && accept !== source.id) {
    // Validators are not saved, so the next run fetches again and re-checks.
    return { ...base, outcome: 'held', reasons, summary, warnings };
  }

  const written = await writeSource(
    source.id,
    { rows: result.rows, metrics: result.metrics, events, upstreamSources: result.upstreamSources, revision: result.revision, revisionDate: result.revisionDate },
    now,
  );
  if (result.catalog) await writeCatalog(result.catalog);
  return {
    ...base,
    ...validators,
    outcome: written.changed ? 'ingested' : 'unchanged',
    last_success_at: now,
    summary: written.changed ? summary + (accept === source.id && reasons.length ? ' (accepted despite guards)' : '') : undefined,
    warnings,
  };
}

const sources = await loadSources();
for (const id of [only, accept]) {
  if (id && !sources.some((s) => s.id === id)) throw new Error(`no source with id "${id}" in sources.yaml`);
}

const cache = await readRunCache();
const next: Record<string, RunEntry> = {};
let failures = 0;

for (const source of sources) {
  const prev = cache[source.id];
  if (only && source.id !== only) {
    if (prev) next[source.id] = prev;
    continue;
  }
  if (source.terms !== 'allowed') {
    console.log(`- ${source.id}: terms ${source.terms}, not fetched`);
    continue;
  }
  const due = force || only === source.id || accept === source.id || !prev ||
    Date.parse(now) - Date.parse(prev.checked_at) >= intervalMs(source.every) - 5 * 60_000;
  if (!due) {
    next[source.id] = prev;
    console.log(`- ${source.id}: not due (checked ${prev.checked_at}, every ${source.every})`);
    continue;
  }

  const started = Date.now();
  try {
    const entry = await runSource(source, prev);
    next[source.id] = entry;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const detail = entry.reasons ? `: ${entry.reasons.join('; ')}` : entry.summary ? ` — ${entry.summary}` : '';
    console.log(`${entry.outcome === 'held' ? '!' : '-'} ${source.id}: ${entry.outcome}${detail} (${secs}s)`);
    for (const w of entry.warnings ?? []) console.log(`  note: ${w}`);
  } catch (e) {
    failures++;
    next[source.id] = {
      checked_at: now,
      outcome: 'failed',
      reasons: [(e as Error).message],
      last_success_at: prev?.last_success_at,
      etag: prev?.etag,
      last_modified: prev?.last_modified,
    };
    console.error(`! ${source.id}: failed: ${(e as Error).message}`);
  }
}

await writeRunCache(next);
// A failed source is reported through an issue; the run itself still succeeds so the rest publishes.
if (failures && process.env['CI'] !== 'true') process.exitCode = 1;
