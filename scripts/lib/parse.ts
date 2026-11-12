/** Turns fetched bytes into records: CSV, TSV, JSON, JSON Lines, YAML or Parquet. */
import { parquetReadObjects } from 'hyparquet';
import { parse as parseYaml } from 'yaml';

export type Rec = Record<string, unknown>;
export type Format = 'csv' | 'tsv' | 'json' | 'jsonl' | 'yaml' | 'parquet';

const EXT: Record<string, Format> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  yml: 'yaml',
  yaml: 'yaml',
  parquet: 'parquet',
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
  }
}
