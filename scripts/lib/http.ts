/**
 * HTTP helpers. The User-Agent is generic by default; the deployed workflow sets
 * LLMBENCH_USER_AGENT to one that names the project and how to reach it.
 */
const USER_AGENT = process.env['LLMBENCH_USER_AGENT'] ?? 'llmbench-scraper/0.1';

export async function fetchOk(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
  const res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return (await (await fetchOk(url, init)).json()) as T;
}

/** Parses "github:owner/repo/path/inside/repo". */
export function parseGithubRef(ref: string): { owner: string; repo: string; path: string } {
  const m = /^github:([^/\s]+)\/([^/\s]+)\/(.+)$/.exec(ref);
  if (!m) throw new Error(`not a github: reference: ${ref}`);
  return { owner: m[1]!, repo: m[2]!, path: m[3]! };
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) h['authorization'] = `Bearer ${token}`;
  return h;
}

/** The newest commit on the default branch that touched `path`. */
export async function latestCommit(owner: string, repo: string, path: string): Promise<{ sha: string; date: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  const list = await fetchJson<Array<{ sha: string; commit: { committer: { date: string } } }>>(url, {
    headers: githubHeaders(),
  });
  const c = list[0];
  if (!c) throw new Error(`no commits found for ${owner}/${repo}/${path}`);
  return { sha: c.sha, date: c.commit.committer.date };
}

/** A file's contents at a pinned commit. */
export async function githubFile(owner: string, repo: string, sha: string, path: string): Promise<Response> {
  return fetchOk(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`);
}

/** URL of a file at a pinned commit, for linking. */
export function githubBlobUrl(owner: string, repo: string, sha: string, path: string): string {
  return `https://github.com/${owner}/${repo}/blob/${sha}/${path}`;
}
