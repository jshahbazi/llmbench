import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CatalogModel, HistoryEvent, Metric, Row, RunEntry, SourceState, UpstreamSource } from './types.ts';

export const DATA_DIR = 'data';
export const CACHE_DIR = '.cache';
export const RUN_CACHE = join(CACHE_DIR, 'last-run.json');

export const sourceDir = (id: string): string => join(DATA_DIR, 'sources', id);
export const CATALOG_PATH = join(DATA_DIR, 'catalog', 'models.jsonl');

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** One JSON object per line, sorted by the given key so diffs stay small and stable. */
export function toJsonl<T>(items: readonly T[], sortKey: (item: T) => string): string {
  const sorted = [...items].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return sorted.map((x) => JSON.stringify(x)).join('\n') + (sorted.length ? '\n' : '');
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as T);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Duplicate keys are a guard reason, not a crash: a missing `key` mapping is the usual cause. */
export function duplicateKeys(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) dupes.add(r.key);
    seen.add(r.key);
  }
  return [...dupes].slice(0, 5).map((k) => `duplicate row key "${k}"`);
}

export const readRows = (id: string) => readJsonl<Row>(join(sourceDir(id), 'rows.jsonl'));
export const readHistory = (id: string) => readJsonl<HistoryEvent>(join(sourceDir(id), 'history.jsonl'));
export const readState = (id: string) => readJson<SourceState>(join(sourceDir(id), 'state.json'));

export interface WriteInput {
  rows: Row[];
  metrics: Metric[];
  events: HistoryEvent[];
  upstreamSources?: UpstreamSource[];
  revision?: string;
  revisionDate?: string;
}

/**
 * Writes a source's files and appends its history. On the first import nothing is appended: those
 * cells are the baseline. state.json changes only when the rows or metrics change, or when the
 * upstream revision moves (so the pin stays accurate).
 */
export async function writeSource(id: string, data: WriteInput, now: string): Promise<{ changed: boolean; state: SourceState }> {
  const dir = sourceDir(id);
  const rowsText = toJsonl(data.rows, (r) => r.key);
  const metricsText = JSON.stringify([...data.metrics].sort((a, b) => a.id.localeCompare(b.id)), null, 1) + '\n';
  const hash = sha256(rowsText + metricsText);
  const previous = await readState(id);

  if (previous && previous.payload_hash === hash) {
    if (data.revision && data.revision !== previous.upstream_revision) {
      const state = { ...previous, upstream_revision: data.revision, upstream_revision_date: data.revisionDate };
      await writeText(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
      return { changed: false, state };
    }
    return { changed: false, state: previous };
  }

  await writeText(join(dir, 'rows.jsonl'), rowsText);
  await writeText(join(dir, 'metrics.json'), metricsText);
  if (data.upstreamSources) {
    await writeText(join(dir, 'upstream-sources.jsonl'), toJsonl(data.upstreamSources, (s) => s.id));
  }
  if (previous && data.events.length) {
    await appendFile(join(dir, 'history.jsonl'), data.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const state: SourceState = {
    ...(data.revision && { upstream_revision: data.revision }),
    ...(data.revisionDate && { upstream_revision_date: data.revisionDate }),
    payload_hash: hash,
    row_count: data.rows.length,
    baseline_at: previous ? (previous.baseline_at ?? previous.changed_at) : now,
    changed_at: now,
  };
  await writeText(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  return { changed: true, state };
}

export async function writeCatalog(models: readonly CatalogModel[]): Promise<void> {
  await writeText(CATALOG_PATH, toJsonl(models, (m) => m.id));
}

/** Per-run facts live outside data/ so an unchanged check does not create a commit. */
export async function readRunCache(): Promise<Record<string, RunEntry>> {
  return (await readJson<Record<string, RunEntry>>(RUN_CACHE)) ?? {};
}

export async function writeRunCache(entries: Record<string, RunEntry>): Promise<void> {
  await writeText(RUN_CACHE, JSON.stringify(entries, null, 2) + '\n');
}
