/** Turns fetched bytes into records: CSV, TSV, JSON, JSON Lines, YAML, Parquet or a Markdown table. */
import { parquetReadObjects } from 'hyparquet';
import { parse as parseYaml } from 'yaml';

export type Rec = Record<string, unknown>;
export type Format = 'csv' | 'tsv' | 'json' | 'jsonl' | 'yaml' | 'parquet' | 'markdown';

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
    .replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, '$2')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .trim();
  return { text, ...(url && { url }) };
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
  }
}
