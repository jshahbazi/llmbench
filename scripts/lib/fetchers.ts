/**
 * Fetches a source's payload for the field-mapping extractor.
 *
 *   github:owner/repo/path         one file, or a glob (* and **) of files, pinned to a commit
 *   hf:owner/dataset               Parquet files of a Hugging Face dataset, pinned to a commit
 *   https://...                    one file, with conditional requests (ETag / Last-Modified)
 *
 * Returns 'unchanged' when the upstream commit, ETag or Last-Modified says nothing moved.
 */
import {
  fetchOk,
  githubFile,
  githubTree,
  globToRegExp,
  hfDataset,
  hfFile,
  latestCommit,
  parseGithubRef,
  parseHfRef,
} from './http.ts';
import { detectFormat, parseRecords, type Format, type Rec } from './parse.ts';
import type { PluginContext } from './types.ts';

export interface FetchedFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
  /** Columns added to every record from this file, such as _config or _file. */
  columns?: Rec;
}

export interface Fetched {
  revision?: string;
  revisionDate?: string;
  etag?: string;
  lastModified?: string;
  files: FetchedFile[];
}

const list = (v: unknown): string[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v.map(String) : [String(v)];

async function fromGithub(ref: string, ctx: PluginContext): Promise<Fetched | 'unchanged'> {
  const { owner, repo, path } = parseGithubRef(ref);
  const isGlob = /[*?]/.test(path);
  const segments = path.split('/');
  const fixed = isGlob ? segments.slice(0, segments.findIndex((s) => /[*?]/.test(s))).join('/') : path;
  const head = await latestCommit(owner, repo, fixed || '.');
  if (!ctx.force && ctx.previous?.upstream_revision === head.sha) return 'unchanged';

  let paths = [path];
  if (isGlob) {
    const re = globToRegExp(path);
    paths = (await githubTree(owner, repo, head.sha)).filter((p) => re.test(p)).sort();
    if (!paths.length) throw new Error(`no files in ${owner}/${repo} match ${path}`);
  }
  const files = await Promise.all(
    paths.map(async (p) => {
      const res = await githubFile(owner, repo, head.sha, p);
      return {
        path: p,
        bytes: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? undefined,
        columns: isGlob ? { _file: p } : undefined,
      };
    }),
  );
  return { revision: head.sha, revisionDate: head.date, files };
}

/** Picks a dataset's Parquet files for the configured configs and split. */
export function selectHfFiles(all: string[], options: Record<string, unknown>): Array<{ path: string; config?: string }> {
  const globs = list(options['files']);
  const configs = list(options['config'] ?? options['configs']);
  const split = String(options['split'] ?? 'train');
  const parquet = all.filter((f) => f.endsWith('.parquet'));
  if (globs) {
    const res = globs.map(globToRegExp);
    return parquet.filter((f) => res.some((re) => re.test(f))).map((path) => ({ path }));
  }
  if (!configs) {
    const re = new RegExp(`^(data/)?${split}(-[^/]*)?\\.parquet$`);
    return parquet.filter((f) => re.test(f)).map((path) => ({ path }));
  }
  const out: Array<{ path: string; config?: string }> = [];
  for (const config of configs) {
    const re = new RegExp(`^${config.replace(/[.+^${}()|[\]\\]/g, '\\$&')}/(${split}(-[^/]*)?\\.parquet|${split}/[^/]+\\.parquet)$`);
    const hits = parquet.filter((f) => re.test(f));
    if (!hits.length) throw new Error(`no Parquet files for config "${config}", split "${split}"`);
    for (const path of hits) out.push({ path, config });
  }
  return out;
}

async function fromHf(ref: string, ctx: PluginContext): Promise<Fetched | 'unchanged'> {
  const { id } = parseHfRef(ref);
  const ds = await hfDataset(id);
  if (!ctx.force && ctx.previous?.upstream_revision === ds.sha) return 'unchanged';
  const picked = selectHfFiles(ds.files, ctx.source.options);
  if (!picked.length) throw new Error(`no matching Parquet files in ${id}`);
  const files = await Promise.all(
    picked.map(async ({ path, config }) => ({
      path,
      bytes: await hfFile(id, ds.sha, path),
      columns: config !== undefined ? { _config: config } : undefined,
    })),
  );
  return { revision: ds.sha, revisionDate: ds.lastModified, files };
}

async function fromUrl(url: string, ctx: PluginContext): Promise<Fetched | 'unchanged'> {
  const headers: Record<string, string> = {};
  if (!ctx.force && ctx.previous) {
    if (ctx.cache?.etag) headers['if-none-match'] = ctx.cache.etag;
    if (ctx.cache?.last_modified) headers['if-modified-since'] = ctx.cache.last_modified;
  }
  const res = await fetchOk(url, { headers });
  if (res.status === 304) return 'unchanged';
  return {
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    files: [{ path: new URL(url).pathname, bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? undefined }],
  };
}

export async function fetchSource(ctx: PluginContext): Promise<Fetched | 'unchanged'> {
  const ref = ctx.source.fetch;
  if (!ref) throw new Error('no "fetch" location');
  if (ref.startsWith('github:')) return fromGithub(ref, ctx);
  if (ref.startsWith('hf:')) return fromHf(ref, ctx);
  if (/^https:\/\//i.test(ref)) return fromUrl(ref, ctx);
  throw new Error(`unsupported fetch location "${ref}" (use github:, hf: or https://)`);
}

/**
 * Every record in the fetched files, using the entry's `format` and `rows` (JSON, YAML) or `table`
 * (Markdown) options. Columns a file adds, such as _file or _config, are added to its records.
 */
export async function recordsFrom(fetched: Fetched, options: Record<string, unknown>): Promise<Rec[]> {
  const format = options['format'] as Format | undefined;
  const selector = options['table'] ?? options['rows'];
  const records: Rec[] = [];
  for (const f of fetched.files) {
    const fmt = format ?? detectFormat(f.path, f.contentType);
    if (!fmt) {
      const html = /html/i.test(f.contentType ?? '') || /\.html?$/i.test(f.path);
      throw new Error(`cannot tell the format of ${f.path}; set "format"${html ? ' (HTML pages need a plugin for now)' : ''}`);
    }
    for (const r of await parseRecords(f.bytes, fmt, selector === undefined ? undefined : String(selector), f.path)) records.push(f.columns ? { ...r, ...f.columns } : r);
  }
  return records;
}
