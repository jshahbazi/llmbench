/**
 * HTTP helpers. The User-Agent is generic by default; the deployed workflow can set
 * LLMBENCH_USER_AGENT to one that names the project and how to reach it.
 */
const USER_AGENT = process.env['LLMBENCH_USER_AGENT'] || 'llmbench-scraper/0.1';
const RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with a User-Agent, a timeout, and up to three attempts on network errors, 429 and 5xx.
 * Returns 304 responses as-is so callers can do conditional requests.
 */
export async function fetchOk(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
      if (res.ok || res.status === 304) return res;
      lastError = new Error(`GET ${url} -> HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
    if (attempt < RETRIES) await sleep(1000 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return (await (await fetchOk(url, init)).json()) as T;
}

export async function fetchBytes(url: string, init: RequestInit = {}): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchOk(url, init)).arrayBuffer());
}

/** Parses "github:owner/repo/path/inside/repo". The path may contain * and ** globs. */
export function parseGithubRef(ref: string): { owner: string; repo: string; path: string } {
  const m = /^github:([^/\s]+)\/([^/\s]+)\/(.+)$/.exec(ref);
  if (!m) throw new Error(`not a github: reference: ${ref}`);
  return { owner: m[1]!, repo: m[2]!, path: m[3]! };
}

/** Parses "hf:owner/dataset". */
export function parseHfRef(ref: string): { id: string } {
  const m = /^hf:([^/\s]+\/[^/\s]+)$/.exec(ref);
  if (!m) throw new Error(`not an hf: reference: ${ref}`);
  return { id: m[1]! };
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) h['authorization'] = `Bearer ${token}`;
  return h;
}

function hfHeaders(): Record<string, string> {
  const token = process.env['HF_TOKEN'];
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** The newest commit on the default branch that touched `path` (a file or directory). */
export async function latestCommit(owner: string, repo: string, path: string): Promise<{ sha: string; date: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  const list = await fetchJson<Array<{ sha: string; commit: { committer: { date: string } } }>>(url, {
    headers: githubHeaders(),
  });
  const c = list[0];
  if (!c) throw new Error(`no commits found for ${owner}/${repo}/${path}`);
  return { sha: c.sha, date: c.commit.committer.date };
}

/** Every file path in a repository at a commit. */
export async function githubTree(owner: string, repo: string, sha: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
  const tree = await fetchJson<{ tree: Array<{ path: string; type: string }>; truncated: boolean }>(url, {
    headers: githubHeaders(),
  });
  if (tree.truncated) throw new Error(`file list for ${owner}/${repo} is too large for one request`);
  return tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
}

/** A file's contents at a pinned commit. */
export async function githubFile(owner: string, repo: string, sha: string, path: string): Promise<Response> {
  return fetchOk(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
}

/** URL of a file at a pinned commit, for linking. */
export function githubBlobUrl(owner: string, repo: string, sha: string, path: string): string {
  return `https://github.com/${owner}/${repo}/blob/${sha}/${path}`;
}

/** A Hugging Face dataset's current commit and file list. */
export async function hfDataset(id: string): Promise<{ sha: string; lastModified?: string; files: string[] }> {
  const d = await fetchJson<{ sha: string; lastModified?: string; siblings?: Array<{ rfilename: string }> }>(
    `https://huggingface.co/api/datasets/${id}`,
    { headers: hfHeaders() },
  );
  return { sha: d.sha, lastModified: d.lastModified, files: (d.siblings ?? []).map((s) => s.rfilename) };
}

export async function hfFile(id: string, sha: string, path: string): Promise<Uint8Array> {
  return fetchBytes(`https://huggingface.co/datasets/${id}/resolve/${sha}/${path}`, { headers: hfHeaders() });
}

/** Converts a path glob (* within a segment, ** across segments) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
