/**
 * Turns fetched bytes into records: CSV, TSV, JSON, JSON Lines, YAML, Parquet, a Markdown or HTML
 * table, or a value assigned in a JavaScript file (read as data, never run).
 */
import { parquetReadObjects } from 'hyparquet';
import { parse as parseYaml } from 'yaml';

export type Rec = Record<string, unknown>;
export type Format = 'csv' | 'tsv' | 'json' | 'jsonl' | 'yaml' | 'parquet' | 'markdown' | 'js' | 'html';

const EXT: Record<string, Format> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  yml: 'yaml',
  yaml: 'yaml',
  parquet: 'parquet',
  md: 'markdown',
  markdown: 'markdown',
  js: 'js',
  mjs: 'js',
  html: 'html',
  htm: 'html',
};

export function detectFormat(name: string, contentType?: string | null): Format | undefined {
  const ext = /\.([a-z0-9]+)(?:$|[?#])/i.exec(name.split('/').pop() ?? '')?.[1]?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext];
  const ct = contentType?.toLowerCase() ?? '';
  if (ct.includes('csv')) return 'csv';
  if (ct.includes('tab-separated')) return 'tsv';
  if (ct.includes('ndjson') || ct.includes('jsonl')) return 'jsonl';
  if (ct.includes('json')) return 'json';
  if (ct.includes('yaml')) return 'yaml';
  if (ct.includes('parquet')) return 'parquet';
  if (ct.includes('markdown')) return 'markdown';
  if (ct.includes('javascript')) return 'js';
  if (ct.includes('html')) return 'html';
  return undefined;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, embedded newlines. Returns rows of cells. */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Header row plus data rows to records. Duplicate header names get a numeric suffix. */
export function tableToRecords(table: string[][]): Rec[] {
  const [header, ...body] = table;
  if (!header) return [];
  const seen = new Map<string, number>();
  const names = header.map((h) => {
    const name = h.trim();
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
  return body.map((cells) => {
    const r: Rec = {};
    names.forEach((n, i) => {
      r[n] = cells[i] ?? '';
    });
    return r;
  });
}

/** Follows a dot path such as "data.leaderboard" ("$." and "[*]" are accepted and ignored). */
export function atPath(doc: unknown, path: string | undefined): unknown {
  if (!path) return doc;
  const parts = path.replace(/^\$\.?/, '').replace(/\[\*\]/g, '').split('.').filter(Boolean);
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** An array of objects, or an object of objects (the map key becomes `_key`). */
function toRecords(value: unknown, where: string): Rec[] {
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: item ${i} is not an object`);
      return v as Rec;
    });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: "${k}" is not an object`);
      return { _key: k, ...(v as Rec) };
    });
  }
  throw new Error(`${where}: expected a list of rows`);
}

/** Parquet values can be bigint or Date; turn them into JSON-friendly values. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}

export interface MarkdownTable {
  /** The nearest heading above the table, without the leading #s. */
  heading: string;
  header: string[];
  rows: string[][];
}

const DELIMITER_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitPipes(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let code = false;
  const s = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Every GitHub-style pipe table in a Markdown document, with the heading above it. */
export function markdownTables(text: string): MarkdownTable[] {
  const lines = text.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      heading = h[1]!;
      continue;
    }
    if (!line.includes('|') || !DELIMITER_ROW.test(lines[i + 1] ?? '')) continue;
    const header = splitPipes(line);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.includes('|') && lines[j]!.trim(); j++) rows.push(splitPipes(lines[j]!));
    tables.push({ heading, header, rows });
    i = j - 1;
  }
  return tables;
}

/** A Markdown cell as plain text: links keep their text, emphasis, code marks and tags go. */
function cellText(cell: string): { text: string; url?: string } {
  let url: string | undefined;
  const text = cell
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_m, t: string, u: string) => {
      url ??= u;
      return t;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, '$2');
  return { text: decodeEntities(text).trim(), ...(url && { url }) };
}

/** Named and numeric HTML character references. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mu: 'μ', sigma: 'σ', alpha: 'α', beta: 'β',
  plusmn: '±', times: '×', minus: '−', ndash: '–', mdash: '—', le: '≤', ge: '≥', deg: '°', hellip: '…',
};

/**
 * Picks a table from a Markdown document: by position (0 is the first) or by the text of the
 * heading above it. A cell's link becomes a "<column> url" field.
 */
export function markdownRecords(text: string, table: string | number | undefined, where: string): Rec[] {
  const tables = markdownTables(text);
  if (!tables.length) throw new Error(`${where}: no Markdown table found`);
  let t: MarkdownTable | undefined;
  if (table === undefined) t = tables[0];
  else if (typeof table === 'number' || /^\d+$/.test(table)) t = tables[Number(table)];
  else t = tables.find((x) => x.heading.toLowerCase().includes(String(table).toLowerCase()));
  if (!t) throw new Error(`${where}: no Markdown table matches "table: ${table}" (${tables.length} tables, headings: ${tables.map((x) => JSON.stringify(x.heading)).join(', ')})`);
  // A repeated header gets a suffix, as in CSV, instead of overwriting the earlier column.
  const seen = new Map<string, number>();
  const header = t.header.map((h) => {
    const name = cellText(h).text;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
  return t.rows.map((cells) => {
    const rec: Rec = {};
    header.forEach((h, k) => {
      const c = cellText(cells[k] ?? '');
      rec[h] = c.text;
      if (c.url) rec[`${h} url`] = c.url;
    });
    return rec;
  });
}

export async function parseRecords(bytes: Uint8Array, format: Format, rowsPath?: string, where = 'payload'): Promise<Rec[]> {
  if (format === 'parquet') {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const rows = (await parquetReadObjects({ file: ab })) as Rec[];
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
  }
  const text = new TextDecoder().decode(bytes);
  switch (format) {
    case 'csv':
      return tableToRecords(parseDelimited(text, ','));
    case 'tsv':
      return tableToRecords(parseDelimited(text, '\t'));
    case 'jsonl':
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => toRecords([JSON.parse(l)], `${where} line ${i + 1}`)[0]!);
    case 'json':
      return toRecords(atPath(JSON.parse(text), rowsPath), where);
    case 'yaml':
      return toRecords(atPath(parseYaml(text), rowsPath), where);
    case 'markdown':
      // For Markdown, the "rows" selector is the table to read.
      return markdownRecords(text, rowsPath, where);
    case 'js':
      return scriptRecords(text, rowsPath, where);
    case 'html':
      return htmlRecords(text, rowsPath, where);
  }
}

/** Undo a JavaScript string literal's escapes. */
export function unescapeJs(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e: string) => {
    if (e[0] === 'u' || e[0] === 'x') return String.fromCodePoint(parseInt(e.replace(/[ux{}]/g, ''), 16));
    if (e === '\n' || e === '\r\n' || e === '\r') return ''; // a line continuation
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[e] ?? e;
  });
}

/**
 * Reads a JavaScript literal (object, array, string, template without ${…}, number, true, false,
 * null) starting at `start`. Data only: anything else is an error, and nothing is evaluated.
 */
export function readJsLiteral(src: string, start: number): unknown {
  let i = start;
  const fail = (what: string): never => {
    const line = src.slice(0, i).split('\n').length;
    throw new Error(`${what} at line ${line} (only plain data can be read from a script)`);
  };
  const ws = () => {
    for (;;) {
      const m = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\//y;
      m.lastIndex = i;
      const r = m.exec(src);
      if (!r || !r[0]) return;
      i += r[0].length;
    }
  };
  const quoted = (q: string): string => {
    let j = i + 1;
    for (; j < src.length && src[j] !== q; j++) {
      if (src[j] === '\\') j++;
      else if (q === '`' && src[j] === '$' && src[j + 1] === '{') fail('a template with ${…} expressions');
      else if (q !== '`' && src[j] === '\n') fail('an unterminated string');
    }
    if (j >= src.length) fail('an unterminated string');
    const raw = src.slice(i + 1, j);
    i = j + 1;
    return unescapeJs(raw);
  };
  const token = (re: RegExp): string | undefined => {
    re.lastIndex = i;
    const r = re.exec(src);
    if (!r) return undefined;
    i += r[0].length;
    return r[0];
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return out;
        }
        const k = src[i] === '"' || src[i] === "'" ? quoted(src[i]!) : (token(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/y) ?? fail('an unreadable object key'));
        ws();
        if (src[i] !== ':') fail('a missing ":" in an object');
        i++;
        out[k] = value();
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') fail('a missing "," in an object');
      }
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') {
          i++;
          return out;
        }
        out.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail('a missing "," in a list');
      }
    }
    if (c === '"' || c === "'" || c === '`') return quoted(c);
    const num = token(/[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?![\w$])/y);
    if (num !== undefined) return Number(num.replaceAll('_', ''));
    const word = token(/(?:true|false|null|undefined|NaN|Infinity)(?![\w$])/y);
    if (word !== undefined) return ({ true: true, false: false, null: null, undefined: null, NaN: null, Infinity: null } as Record<string, unknown>)[word];
    return fail('a value that is not plain data');
  };
  return value();
}

/** The value assigned to a top-level name in a script: `const name = …`, `let`, `var` or `name = …`. */
export function scriptValue(src: string, name: string): unknown {
  const esc = name.replace(/[$]/g, '\\$');
  const m = new RegExp(String.raw`(?:^|[^\w$.])${esc}\s*=(?![=>])\s*`, 'm').exec(src);
  if (!m) throw new Error(`no assignment to "${name}" in the script`);
  return readJsLiteral(src, m.index + m[0].length);
}

/**
 * Records from a script. `rows` is the variable, optionally followed by a path into it
 * ("EQBENCH4_DATA.models"). A string value is read as CSV (or TSV when its header has tabs and no
 * commas); a list or object is read like JSON.
 */
export function scriptRecords(text: string, rowsPath: string | undefined, where: string): Rec[] {
  if (!rowsPath) throw new Error(`${where}: for a script, "rows" names the variable that holds the data`);
  const [name, ...rest] = rowsPath.split('.');
  const value = atPath(scriptValue(text, name!), rest.join('.'));
  if (typeof value === 'string') {
    const body = value.replace(/^\s*\n/, '').trimEnd();
    const head = body.split('\n', 1)[0] ?? '';
    return tableToRecords(parseDelimited(body, head.includes('\t') && !head.includes(',') ? '\t' : ','));
  }
  return toRecords(value, where);
}

export interface HtmlCell {
  text: string;
  attrs: Record<string, string>;
}
export interface HtmlTable {
  header: string[];
  rows: Array<{ attrs: Record<string, string>; cells: HtmlCell[] }>;
}

const attrsOf = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map((m) => [m[1]!.toLowerCase(), decodeEntities(m[3] ?? m[4] ?? '')]));

/** An element's visible text: tags go, tooltips (role="tooltip") and scripts are left out. */
export function htmlText(fragment: string): string {
  const text = fragment
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\w+)\b[^>]*\brole\s*=\s*["']tooltip["'][^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** Every <table> in a page: its header cells and its body rows, with each row's and cell's attributes. */
export function htmlTables(html: string): HtmlTable[] {
  const out: HtmlTable[] = [];
  for (const t of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    let header: string[] = [];
    const rows: HtmlTable['rows'] = [];
    for (const tr of t[1]!.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[2]!.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((c) => ({ kind: c[1]!.toLowerCase(), text: htmlText(c[3]!), attrs: attrsOf(c[2]!) }));
      if (!cells.length) continue;
      if (!header.length && cells.every((c) => c.kind === 'th')) header = cells.map((c) => c.text);
      else rows.push({ attrs: attrsOf(tr[1]!), cells: cells.map(({ text, attrs }) => ({ text, attrs })) });
    }
    out.push({ header, rows });
  }
  return out;
}

/**
 * Records from an HTML page's table, picked by position (`rows: 0` is the first, the default).
 * Columns are named by the header row; a row's data-* attributes are kept as fields of the same name.
 */
export function htmlRecords(text: string, table: string | undefined, where: string): Rec[] {
  const tables = htmlTables(text).filter((t) => t.header.length);
  if (!tables.length) throw new Error(`${where}: no HTML table with a header row found`);
  const t = tables[table === undefined ? 0 : Number(table)];
  if (!t) throw new Error(`${where}: no HTML table at position ${table} (${tables.length} tables)`);
  const names = t.header.map((h, i) => {
    const base = h || `column ${i + 1}`;
    const before = t.header.slice(0, i).filter((x) => (x || '') === h).length;
    return before ? `${base} (${before + 1})` : base;
  });
  return t.rows.map((r) => {
    const rec: Rec = {};
    for (const [k, v] of Object.entries(r.attrs)) if (k.startsWith('data-')) rec[k] = v;
    names.forEach((n, i) => (rec[n] = r.cells[i]?.text ?? ''));
    return rec;
  });
}
