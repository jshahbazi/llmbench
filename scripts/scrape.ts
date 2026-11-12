/**
 * Fetches every allowed source in sources.yaml and writes its rows under data/.
 *
 *   npm run scrape                     all sources
 *   npm run scrape -- --source <id>    one source
 *   npm run scrape -- --force          re-read even if the upstream revision has not moved
 *
 * Phase 0: plugin sources only. The field-mapping extractor, guards and change history
 * arrive in Phase 1 (see the plan, section 12).
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSources } from './lib/config.ts';
import { assertUniqueKeys, readJson, recordRun, sourceDir, writeCatalog, writeSource } from './lib/store.ts';
import type { Plugin, SourceState } from './lib/types.ts';

const { values } = parseArgs({
  options: { source: { type: 'string' }, force: { type: 'boolean', default: false } },
});
const only = values.source || process.env['ONLY_SOURCE'] || undefined;
const force = values.force ?? false;
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const sources = await loadSources();
if (only && !sources.some((s) => s.id === only)) throw new Error(`no source with id "${only}" in sources.yaml`);

const runs: Record<string, { checked_at: string; outcome: string }> = {};
let failures = 0;

for (const source of sources) {
  if (only && source.id !== only) continue;
  if (source.terms !== 'allowed') {
    console.log(`- ${source.id}: terms ${source.terms}, not fetched`);
    continue;
  }
  if (!source.plugin) {
    console.log(`- ${source.id}: skipped (field-mapping sources are supported from Phase 1)`);
    runs[source.id] = { checked_at: now, outcome: 'skipped' };
    continue;
  }

  const started = Date.now();
  try {
    const mod = (await import(`./sources/${source.plugin}.ts`)) as { default: Plugin };
    const previous = await readJson<SourceState>(join(sourceDir(source.id), 'state.json'));
    const result = await mod.default({ source, previous, force });
    if (result === 'unchanged') {
      console.log(`- ${source.id}: unchanged upstream (${previous?.upstream_revision?.slice(0, 7)})`);
      runs[source.id] = { checked_at: now, outcome: 'unchanged' };
      continue;
    }
    if (result.rows.length === 0) throw new Error('extracted no rows');
    assertUniqueKeys(source.id, result.rows);
    const written = await writeSource(source.id, result, now);
    if (result.catalog) await writeCatalog(result.catalog);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `- ${source.id}: ${written.changed ? 'ingested' : 'unchanged data'} — ${result.rows.length} rows, ` +
        `${result.metrics.length} metrics` +
        (result.catalog ? `, ${result.catalog.length} catalogue models` : '') +
        (result.revision ? ` @ ${result.revision.slice(0, 7)}` : '') +
        ` (${secs}s)`,
    );
    runs[source.id] = { checked_at: now, outcome: written.changed ? 'ingested' : 'unchanged' };
  } catch (e) {
    failures++;
    runs[source.id] = { checked_at: now, outcome: 'failed' };
    console.error(`! ${source.id}: ${(e as Error).message}`);
  }
}

await recordRun(runs);
if (failures) process.exitCode = 1;
