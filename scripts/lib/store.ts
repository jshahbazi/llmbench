import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CatalogModel, Metric, Row, SourceState, UpstreamSource } from './types.ts';

export const DATA_DIR = 'data';
export const CACHE_DIR = '.cache';

export const sourceDir = (id: string): string => join(DATA_DIR, 'sources', id);
export const CATALOG_PATH = join(DATA_DIR, 'catalog', 'models.jsonl');

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function write(path: string, text: string): Promise<void> {
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

/** Throws if two rows share a key. A missing `key` mapping is the usual cause. */
export function assertUniqueKeys(sourceId: string, rows: readonly Row[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) throw new Error(`${sourceId}: two rows share the key "${r.key}"`);
    seen.add(r.key);
  }
}

export interface WriteResult {
  changed: boolean;
  state: SourceState;
}

/** Writes a source's files. State changes only when the rows or metrics change. */
export async function writeSource(
  id: string,
  data: { rows: Row[]; metrics: Metric[]; upstreamSources?: UpstreamSource[]; revision?: string; revisionDate?: string },
  now: string,
): Promise<WriteResult> {
  const dir = sourceDir(id);
  const rowsText = toJsonl(data.rows, (r) => r.key);
  const metricsText = JSON.stringify([...data.metrics].sort((a, b) => a.id.localeCompare(b.id)), null, 1) + '\n';
  const hash = sha256(rowsText + metricsText);
  const previous = await readJson<SourceState>(join(dir, 'state.json'));

  if (previous && previous.payload_hash === hash) {
    // Same data. Record a new upstream revision only if it moved, so the pin stays accurate.
    if (data.revision && data.revision !== previous.upstream_revision) {
      const state = { ...previous, upstream_revision: data.revision, upstream_revision_date: data.revisionDate };
      await write(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
      return { changed: false, state };
    }
    return { changed: false, state: previous };
  }

  await write(join(dir, 'rows.jsonl'), rowsText);
  await write(join(dir, 'metrics.json'), metricsText);
  if (data.upstreamSources) {
    await write(join(dir, 'upstream-sources.jsonl'), toJsonl(data.upstreamSources, (s) => s.id));
  }
  const state: SourceState = {
    upstream_revision: data.revision,
    upstream_revision_date: data.revisionDate,
    payload_hash: hash,
    row_count: data.rows.length,
    changed_at: now,
    status: 'healthy',
  };
  await write(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  return { changed: true, state };
}

export async function writeCatalog(models: readonly CatalogModel[]): Promise<void> {
  await write(CATALOG_PATH, toJsonl(models, (m) => m.id));
}

/** Per-run facts (when each source was last checked) live outside data/ so they are not committed. */
export async function recordRun(entries: Record<string, { checked_at: string; outcome: string }>): Promise<void> {
  const path = join(CACHE_DIR, 'last-run.json');
  const prev = (await readJson<Record<string, unknown>>(path)) ?? {};
  await write(path, JSON.stringify({ ...prev, ...entries }, null, 2) + '\n');
}
