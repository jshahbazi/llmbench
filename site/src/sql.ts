/**
 * The SQL console: loads sql.js (SQLite in WebAssembly, served from vendor/) and the SQLite
 * download on the first query, then runs queries in the page. The query is kept in the URL (?q=)
 * so a link reproduces it.
 */
import { $, el } from './dom.ts';

interface Result {
  columns: string[];
  values: unknown[][];
}
interface Database {
  exec(sql: string): Result[];
}
interface SqlJs {
  Database: new (data?: Uint8Array) => Database;
}
type InitSqlJs = (config: { locateFile: (file: string) => string }) => Promise<SqlJs>;

/** Rows shown in the page; the CSV has them all. */
const SHOWN = 1000;

const form = $<HTMLFormElement>('sql-form');
const box = $<HTMLTextAreaElement>('sql-q');
const runButton = $<HTMLButtonElement>('sql-run');
const csvButton = $<HTMLButtonElement>('sql-csv');
const linkButton = $<HTMLButtonElement>('sql-link');
const status = $('sql-status');
const out = $('sql-out');
const dbUrl = form.dataset['db']!;
const vendor = form.dataset['vendor']!;

let db: Promise<Database> | undefined;
let last: Result | undefined;

const say = (text: string, error = false) => {
  status.textContent = text;
  status.className = error ? 'notice' : 'muted';
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

function openDb(): Promise<Database> {
  db ??= (async () => {
    say('Loading SQLite…');
    await loadScript(`${vendor}sql-wasm.js`);
    const init = (window as unknown as { initSqlJs?: InitSqlJs }).initSqlJs;
    if (!init) throw new Error('SQLite did not load');
    const SQL = await init({ locateFile: (f) => `${vendor}${f}` });
    say('Downloading the database…');
    const res = await fetch(dbUrl);
    if (!res.ok) throw new Error(`the database download failed (${res.status})`);
    return new SQL.Database(new Uint8Array(await res.arrayBuffer()));
  })();
  db.catch(() => (db = undefined)); // let the next query try again
  return db;
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : v instanceof Uint8Array ? `(${v.length} bytes)` : String(v));

function render(r: Result | undefined, ms: number): void {
  out.replaceChildren();
  last = r;
  csvButton.disabled = !r;
  if (!r) {
    say(`Done in ${ms} ms; the statement returned no rows.`);
    return;
  }
  const rows = r.values.slice(0, SHOWN);
  const table = el(
    'table',
    { class: 'data' },
    el('thead', {}, el('tr', {}, ...r.columns.map((c) => el('th', { scope: 'col' }, c)))),
    el(
      'tbody',
      {},
      ...rows.map((row) => el('tr', {}, ...row.map((v) => el('td', typeof v === 'number' ? { class: 'num' } : v === null ? { class: 'muted' } : {}, v === null ? 'null' : cellText(v))))),
    ),
  );
  out.append(table);
  const n = r.values.length;
  say(`${n.toLocaleString('en')} row${n === 1 ? '' : 's'} in ${ms} ms${n > SHOWN ? `; showing the first ${SHOWN.toLocaleString('en')} (the CSV has them all)` : ''}.`);
}

async function run(): Promise<void> {
  const sql = box.value.trim();
  if (!sql) return;
  const url = new URL(location.href);
  url.searchParams.set('q', sql);
  history.replaceState(null, '', url);
  runButton.disabled = true;
  try {
    const database = await openDb();
    say('Running…');
    // Let the status paint before a long query blocks the page.
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const results = database.exec(sql);
    render(results.at(-1), Math.round(performance.now() - t0));
  } catch (e) {
    out.replaceChildren();
    last = undefined;
    csvButton.disabled = true;
    say(`Error: ${(e as Error).message}`, true);
  } finally {
    runButton.disabled = false;
  }
}

function csv(r: Result): string {
  const q = (v: unknown) => {
    const t = cellText(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [r.columns.map(q).join(','), ...r.values.map((row) => row.map(q).join(','))].join('\n') + '\n';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void run();
});
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void run();
  }
});
csvButton.addEventListener('click', () => {
  if (!last) return;
  const a = el('a', { href: URL.createObjectURL(new Blob([csv(last)], { type: 'text/csv' })), download: 'llmbench-query.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
linkButton.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('q', box.value.trim());
  try {
    await navigator.clipboard.writeText(url.href);
    say('Link copied.');
  } catch {
    say(url.href);
  }
});
for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-q]')) {
  b.addEventListener('click', () => {
    box.value = b.dataset['q']!;
    box.focus();
    void run();
  });
}

const fromUrl = new URLSearchParams(location.search).get('q');
if (fromUrl) {
  box.value = fromUrl;
  void run();
}
