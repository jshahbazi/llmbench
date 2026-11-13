/**
 * The explorer's view, kept in the URL so any table can be shared or bookmarked.
 * Only values that differ from the defaults are written.
 */

export interface ViewState {
  /** Explicit columns, or null for "the N most covered" (optionally within a tag). */
  cols: string[] | null;
  n: number;
  tag: string;
  q: string;
  /** Released within this many months (0 = any time). */
  since: number;
  open: boolean;
  permissive: boolean;
  /** Largest total parameter count in billions (0 = any). Negative means "over |size|". */
  size: number;
  maker: string;
  /** Run-by codes to include: 0 independent, 1 submitted, 2 lab. */
  runBy: number[];
  /** Include models that are not in the catalogue. */
  unlisted: boolean;
  /** Leave out quantized runs and runs with web search or grounding. */
  plain: boolean;
  min: number;
  /** A column id, 'name', or '' for newest release first. */
  sort: string;
  dir: 'asc' | 'desc';
  /** Models picked for compare mode. */
  cmp: string[];
  view: 'table' | 'compare';
}

export const DEFAULTS: ViewState = {
  cols: null,
  n: 25,
  tag: '',
  q: '',
  since: 0,
  open: false,
  permissive: false,
  size: 0,
  maker: '',
  runBy: [0, 1, 2],
  unlisted: true,
  plain: false,
  min: 3,
  sort: '',
  dir: 'desc',
  cmp: [],
  view: 'table',
};

const int = (v: string | null, fallback: number): number => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

export function parseState(search: string): ViewState {
  const p = new URLSearchParams(search);
  const cols = p.getAll('c').filter(Boolean);
  // "by=" (empty) means the visitor unticked every box; anything unreadable falls back to the default.
  const byRaw = p.get('by');
  const parsed = [...new Set((byRaw ?? '').split('').map(Number).filter((x) => x === 0 || x === 1 || x === 2))];
  const runBy = byRaw === null || (byRaw !== '' && !parsed.length) ? [...DEFAULTS.runBy] : parsed;
  return {
    cols: cols.length ? cols : null,
    n: Math.max(1, Math.min(500, int(p.get('n'), DEFAULTS.n))),
    tag: p.get('tag') ?? '',
    q: p.get('q') ?? '',
    since: Math.max(0, int(p.get('since'), 0)),
    open: p.get('open') === '1',
    permissive: p.get('perm') === '1',
    size: int(p.get('size'), 0),
    maker: p.get('maker') ?? '',
    runBy: runBy.sort(),
    unlisted: p.get('um') !== '0',
    plain: p.get('plain') === '1',
    min: Math.max(0, int(p.get('min'), DEFAULTS.min)),
    sort: p.get('sort') ?? '',
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
    cmp: p.getAll('m').filter(Boolean).slice(0, 5),
    view: p.get('view') === 'compare' ? 'compare' : 'table',
  };
}

export function serializeState(s: ViewState): string {
  const p = new URLSearchParams();
  for (const c of s.cols ?? []) p.append('c', c);
  if (!s.cols && s.n !== DEFAULTS.n) p.set('n', String(s.n));
  if (s.tag) p.set('tag', s.tag);
  if (s.q) p.set('q', s.q);
  if (s.since) p.set('since', String(s.since));
  if (s.open) p.set('open', '1');
  if (s.permissive) p.set('perm', '1');
  if (s.size) p.set('size', String(s.size));
  if (s.maker) p.set('maker', s.maker);
  const by = [...s.runBy].sort().join('');
  if (by !== DEFAULTS.runBy.join('')) p.set('by', by);
  if (!s.unlisted) p.set('um', '0');
  if (s.plain) p.set('plain', '1');
  if (s.min !== DEFAULTS.min) p.set('min', String(s.min));
  if (s.sort) p.set('sort', s.sort);
  if (s.sort && s.dir !== 'desc') p.set('dir', s.dir);
  for (const m of s.cmp) p.append('m', m);
  if (s.view === 'compare') p.set('view', 'compare');
  const q = p.toString();
  return q ? `?${q}` : '';
}
