/**
 * The downloads: every score with its model, source and context, as CSV, Parquet and SQLite.
 * Written into site/dist/downloads/ by the build; nothing here is committed.
 */
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { toCsv } from '../../site/src/select.ts';
import type { SiteData } from './data.ts';

export interface Download {
  file: string;
  format: 'CSV' | 'Parquet' | 'SQLite';
  description: string;
  rows: number;
  bytes: number;
}

const LICENCE_NOTE =
  'llmbench compilation, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). ' +
  'Each source keeps its own licence; see https://llmbench.site/data/ and the sources table.';

const num = (s: string): number | null => {
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : null;
};
const orNull = <T>(v: T | undefined | ''): T | null => (v === undefined || v === '' ? null : v);

/** The flat score table shared by the CSV and Parquet files. */
function scoreTable(d: SiteData) {
  const { models, columns } = d.index;
  return d.scores.map((s) => {
    const m = models[s.model]!;
    const c = columns[s.column]!;
    return {
      model_id: m.id,
      model: m.name,
      in_catalogue: !m.unlisted,
      source: c.source,
      column_id: c.id,
      benchmark: c.label,
      metric: c.metric,
      value: s.value,
      unit: c.unit,
      higher_is_better: c.direction === 'higher',
      raw_value: s.raw,
      run_by: s.runBy,
      date: s.date,
      context: s.context,
      source_model_name: s.rawName,
      ci_low: num(s.ciLow),
      ci_high: num(s.ciHigh),
      url: s.url,
    };
  });
}

export async function writeDownloads(d: SiteData, dir: string): Promise<Download[]> {
  const { index } = d;
  const out: Download[] = [];
  const sizeOf = async (file: string) => (await stat(join(dir, file))).size;
  const csv = async (file: string, description: string, header: string[], rows: Array<Array<string | number | boolean | null | undefined>>) => {
    const text = toCsv([header, ...rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : v)))]);
    await writeFile(join(dir, file), text);
    out.push({ file, format: 'CSV', description, rows: rows.length, bytes: await sizeOf(file) });
  };

  const scores = scoreTable(d);
  const scoreCols = Object.keys(scores[0] ?? {}) as Array<keyof (typeof scores)[number]>;
  await csv('llmbench-scores.csv', 'Every score, one per row, with its model, benchmark, source and context.', scoreCols, scores.map((s) => scoreCols.map((k) => s[k])));

  const modelRows = index.models.map((m) => [m.id, m.name, !m.unlisted, m.provider, m.released, m.open_weights, m.license, m.params_b, m.active_b, m.model_repo]);
  await csv('llmbench-models.csv', 'Every model, with maker, release month, size and licence where known.', ['id', 'name', 'in_catalogue', 'provider', 'released', 'open_weights', 'license', 'params_b', 'active_b', 'model_repo'], modelRows);

  const columnRows = index.columns.map((c) => [c.id, c.source, c.metric, c.label, c.unit, c.direction === 'higher', c.headline, c.family, (c.tags ?? []).join(' '), c.coverage, c.url]);
  await csv('llmbench-benchmarks.csv', 'Every benchmark column: its source, unit, direction and how many models have a score.', ['id', 'source', 'metric', 'label', 'unit', 'higher_is_better', 'headline', 'family', 'tags', 'models', 'url'], columnRows);

  const nameRows = [...d.names].flatMap(([source, list]) => list.map((n) => [source, n.raw, index.models[n.model]!.id, n.method, n.qualifiers, n.scores]));
  await csv('llmbench-names.csv', "Each source's name for each model, and how it was matched.", ['source', 'source_model_name', 'model_id', 'method', 'qualifiers', 'scores'], nameRows);

  const sourceRows = index.sources.filter((s) => s.terms === 'allowed').map((s) => [s.id, s.name, s.homepage, s.license, s.attribution, s.row_count, s.changed_at, s.checked_at]);
  await csv('llmbench-sources.csv', 'Every source with its licence and attribution.', ['id', 'name', 'homepage', 'license', 'attribution', 'rows', 'changed_at', 'checked_at'], sourceRows);

  // ---- Parquet: the score table, typed.
  const types: Record<string, 'STRING' | 'DOUBLE' | 'BOOLEAN'> = { value: 'DOUBLE', ci_low: 'DOUBLE', ci_high: 'DOUBLE', in_catalogue: 'BOOLEAN', higher_is_better: 'BOOLEAN' };
  const buffer = parquetWriteBuffer({
    columnData: scoreCols.map((k) => ({
      name: k,
      type: types[k] ?? 'STRING',
      data: scores.map((s) => (types[k] ? s[k] : orNull(s[k] as string))),
    })),
    kvMetadata: [
      { key: 'license', value: LICENCE_NOTE },
      { key: 'generated_at', value: index.generated_at },
    ],
    createdBy: 'llmbench',
  });
  await writeFile(join(dir, 'llmbench-scores.parquet'), new Uint8Array(buffer));
  out.push({ file: 'llmbench-scores.parquet', format: 'Parquet', description: 'The score table, typed, for DuckDB, pandas, Polars or Spark.', rows: scores.length, bytes: await sizeOf('llmbench-scores.parquet') });

  // ---- SQLite: normalised tables plus a convenience view.
  const dbFile = join(dir, 'llmbench.sqlite');
  await rm(dbFile, { force: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      CREATE TABLE about (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT, license TEXT, attribution TEXT, rows INTEGER, changed_at TEXT, checked_at TEXT);
      CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT NOT NULL, in_catalogue INTEGER NOT NULL, provider TEXT, released TEXT, open_weights INTEGER, license TEXT, params_b REAL, active_b REAL, model_repo TEXT);
      CREATE TABLE benchmarks (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES sources(id), metric TEXT NOT NULL, label TEXT NOT NULL, unit TEXT, higher_is_better INTEGER NOT NULL, headline INTEGER NOT NULL, family TEXT, tags TEXT, models INTEGER, url TEXT);
      CREATE TABLE names (source TEXT NOT NULL REFERENCES sources(id), source_model_name TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES models(id), method TEXT, qualifiers TEXT, scores INTEGER, PRIMARY KEY (source, source_model_name));
      CREATE TABLE scores (model_id TEXT NOT NULL REFERENCES models(id), benchmark_id TEXT NOT NULL REFERENCES benchmarks(id), value REAL NOT NULL, raw_value TEXT, run_by TEXT, date TEXT, context TEXT, source_model_name TEXT, ci_low REAL, ci_high REAL, url TEXT);
      CREATE INDEX scores_model ON scores (model_id);
      CREATE INDEX scores_benchmark ON scores (benchmark_id);
      CREATE VIEW scores_named AS
        SELECT m.name AS model, b.label AS benchmark, b.source, s.value, b.unit, b.higher_is_better, s.run_by, s.date, s.context, s.url
        FROM scores s JOIN models m ON m.id = s.model_id JOIN benchmarks b ON b.id = s.benchmark_id;
    `);
    const insert = (sql: string, rows: Array<Array<string | number | boolean | null | undefined>>) => {
      const st = db.prepare(sql);
      for (const r of rows) st.run(...r.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)));
    };
    db.exec('BEGIN');
    insert('INSERT INTO about VALUES (?, ?)', [
      ['license', LICENCE_NOTE],
      ['generated_at', index.generated_at],
      ['site', 'https://llmbench.site'],
      ['note', 'Values are as the source scaled them: unit "fraction" is 0-1, "percent" is 0-100. Several scores can exist per model and benchmark (re-runs, settings); context says how each was run.'],
    ]);
    insert('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sourceRows);
    insert('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', modelRows);
    insert('INSERT INTO benchmarks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', columnRows.map((r) => r.map((v) => (v === '' ? null : v))));
    insert('INSERT INTO names VALUES (?, ?, ?, ?, ?, ?)', nameRows);
    insert(
      'INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      scores.map((s) => [s.model_id, s.column_id, s.value, s.raw_value, s.run_by, orNull(s.date), orNull(s.context), s.source_model_name, s.ci_low, s.ci_high, orNull(s.url)]),
    );
    db.exec('COMMIT');
    db.exec('VACUUM');
  } finally {
    db.close();
  }
  out.push({ file: 'llmbench.sqlite', format: 'SQLite', description: 'Sources, models, benchmarks, names and scores as joined tables, with a scores_named view.', rows: scores.length, bytes: await sizeOf('llmbench.sqlite') });
  return out;
}
