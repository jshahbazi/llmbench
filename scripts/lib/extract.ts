/**
 * The field-mapping extractor: turns records into rows using the keys of a sources.yaml entry.
 *
 * Wide tables (one row per model, one column per metric) use `scores`, or take every numeric
 * column when `scores` is left out. Long tables (one row per model and metric) use `metric` and
 * `value`, and are grouped back into one row per model.
 */
import type { Rec } from './parse.ts';
import type { Metric, Row, Value } from './types.ts';

export interface MappingSpec {
  model: string;
  model_label?: string;
  model_url?: string;
  key?: string | string[];
  context?: string[];
  date?: string;
  scores?: string[];
  metric?: string | string[];
  value?: string;
  ci?: [string, string];
  ignore?: string[];
  filter?: Record<string, Value | Value[]>;
  lower_is_better?: string[];
  labels?: Record<string, string>;
  unit?: string;
  units?: Record<string, string>;
  headline?: string[];
  /**
   * What to do when the source lists the same row (or the same metric for a row) twice with
   * nothing to tell the entries apart. 'hold' (default) holds the run; 'drop' leaves those
   * scores out and reports them as a warning.
   */
  duplicates?: 'hold' | 'drop';
  /**
   * Round numeric scores and intervals to this many decimals. Only for values the source
   * computes to meaningless precision (fitted ratings); text values are never touched.
   */
  round?: number;
}

const asList = (v: unknown): string[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v.map(String) : [String(v)];

/** Reads and checks the mapping keys of a source's options. */
export function mappingFrom(options: Record<string, unknown>, where: string): MappingSpec {
  const model = options['model'];
  if (typeof model !== 'string') throw new Error(`${where}: "model" must name a column`);
  const ci = asList(options['ci']);
  if (ci && ci.length !== 2) throw new Error(`${where}: "ci" must be two columns [low, high]`);
  const metric = options['metric'];
  const value = options['value'];
  if ((metric === undefined) !== (value === undefined)) throw new Error(`${where}: "metric" and "value" go together`);
  if (metric !== undefined && options['scores'] !== undefined) throw new Error(`${where}: use "scores" or "metric"/"value", not both`);
  const record = (k: string): Record<string, string> | undefined => {
    const v = options[k];
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: "${k}" must be a mapping`);
    return Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]));
  };
  const filter = options['filter'];
  if (filter !== undefined && (!filter || typeof filter !== 'object' || Array.isArray(filter))) {
    throw new Error(`${where}: "filter" must be a mapping of column to value(s)`);
  }
  const duplicates = options['duplicates'] ?? 'hold';
  if (duplicates !== 'hold' && duplicates !== 'drop') throw new Error(`${where}: "duplicates" must be "hold" or "drop"`);
  const round = options['round'];
  if (round !== undefined && !(Number.isInteger(round) && (round as number) >= 0 && (round as number) <= 10)) {
    throw new Error(`${where}: "round" must be a whole number of decimals from 0 to 10`);
  }
  return {
    model,
    model_label: options['model_label'] === undefined ? undefined : String(options['model_label']),
    model_url: options['model_url'] === undefined ? undefined : String(options['model_url']),
    key: options['key'] === undefined ? undefined : (asList(options['key']) as string[]),
    context: asList(options['context']),
    date: options['date'] === undefined ? undefined : String(options['date']),
    scores: asList(options['scores']),
    metric: metric === undefined ? undefined : (asList(metric) as string[]),
    value: value === undefined ? undefined : String(value),
    ci: ci as [string, string] | undefined,
    ignore: asList(options['ignore']),
    filter: filter as Record<string, Value | Value[]> | undefined,
    lower_is_better: asList(options['lower_is_better']),
    labels: record('labels'),
    unit: options['unit'] === undefined ? undefined : String(options['unit']),
    units: record('units'),
    headline: asList(options['headline']),
    duplicates,
    round: round as number | undefined,
  };
}

const MISSING = new Set(['', '-', '—', '–', 'n/a', 'na', 'nan', 'null', 'none', 'tbd', '?']);

export function isMissing(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return !Number.isFinite(v);
  if (typeof v === 'string') return MISSING.has(v.trim().toLowerCase());
  return false;
}

/** Strict numeric test for detecting score columns: "77.47%", "1,312", "0.5", "1312 (+5/-4)", "±". */
export function looksNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  return /^\s*[-+]?(\d[\d,]*(\.\d+)?|\.\d+)\s*%?\s*(\(.*\)|±\s*[\d.]+%?)?\s*$/.test(v);
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function scoreValue(v: unknown, round?: number): Value {
  if (typeof v === 'number') return round === undefined ? v : Number(v.toFixed(round));
  return cellText(v).trim();
}

export interface Extraction {
  rows: Row[];
  metrics: Metric[];
  /** Hold the run. */
  problems: string[];
  /** Worth reporting, but not a reason to hold. */
  warnings: string[];
}

/** Applies a mapping to records. Never throws on data problems: they are returned for the guards. */
export function extract(records: Rec[], spec: MappingSpec): Extraction {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) seen.add(k);

  const filtered = records.filter((r) =>
    Object.entries(spec.filter ?? {}).every(([col, want]) =>
      (Array.isArray(want) ? want : [want]).map(String).includes(cellText(r[col])),
    ),
  );

  const keyCols = spec.key ? (Array.isArray(spec.key) ? spec.key : [spec.key]) : undefined;
  const named = [
    spec.model,
    spec.model_label,
    spec.model_url,
    ...(keyCols ?? []),
    ...(spec.context ?? []),
    spec.date,
    ...(Array.isArray(spec.metric) ? spec.metric : spec.metric ? [spec.metric] : []),
    spec.value,
    ...(spec.ci ?? []),
    ...(spec.scores ?? []),
    ...Object.keys(spec.filter ?? {}),
  ].filter((c): c is string => !!c);
  if (records.length) {
    for (const c of new Set(named)) if (!seen.has(c)) problems.push(`missing column "${c}"`);
  }

  const used = new Set([...named, ...(spec.ignore ?? [])]);
  let scoreCols: string[] = [];
  if (!spec.metric) {
    if (spec.scores) scoreCols = spec.scores.filter((c) => seen.has(c));
    else {
      for (const c of seen) {
        if (used.has(c)) continue;
        const present = filtered.map((r) => r[c]).filter((v) => !isMissing(v));
        if (present.length && present.filter(looksNumeric).length / present.length >= 0.8) scoreCols.push(c);
      }
    }
  }
  const scoreSet = new Set(scoreCols);

  const rowsById = new Map<string, Row>();
  const order: string[] = [];
  /** Rows (wide) or row+metric cells (long) that appeared more than once. */
  const dupRows = new Set<string>();
  const dupCells = new Map<string, Set<string>>();
  /** Long tables: the other columns of each (row, metric) record, folded into `extra` at the end. */
  const longExtras = new Map<string, Map<string, Rec>>();

  for (const r of filtered) {
    const model = cellText(r[spec.model]).trim();
    if (!model) continue;
    const context: Record<string, string> = {};
    for (const c of spec.context ?? []) {
      const v = cellText(r[c]).trim();
      if (v && !isMissing(v)) context[c] = v;
    }
    const id = keyCols
      ? keyCols.map((c) => cellText(r[c]).trim()).join('|')
      : [model, ...Object.values(context)].join('|');

    let row = rowsById.get(id);
    if (!row) {
      row = { key: id, model, scores: {} };
      const label = spec.model_label ? cellText(r[spec.model_label]).trim() : '';
      if (label && label !== model) row.model_label = label;
      const url = spec.model_url ? cellText(r[spec.model_url]).trim() : '';
      if (url && !isMissing(url)) row.model_url = url;
      if (Object.keys(context).length) row.context = context;
      const date = spec.date ? cellText(r[spec.date]).trim() : '';
      if (date && !isMissing(date)) row.date = date;
      rowsById.set(id, row);
      order.push(id);
    } else if (!spec.metric) {
      dupRows.add(id);
      continue;
    }

    /** Stores a score; returns false when it is missing or a duplicate. */
    const put = (metric: string, v: unknown): boolean => {
      if (isMissing(v)) return false;
      if (metric in row!.scores) {
        let cells = dupCells.get(id);
        if (!cells) dupCells.set(id, (cells = new Set()));
        cells.add(metric);
        return false;
      }
      row!.scores[metric] = scoreValue(v, spec.round);
      return true;
    };

    if (spec.metric && spec.value) {
      const metric = (Array.isArray(spec.metric) ? spec.metric : [spec.metric]).map((c) => cellText(r[c]).trim()).join('/');
      if (!metric) continue;
      if (put(metric, r[spec.value])) {
        if (spec.ci) {
          const lo = r[spec.ci[0]];
          const hi = r[spec.ci[1]];
          if (!isMissing(lo) && !isMissing(hi)) (row.ci ??= {})[metric] = [scoreValue(lo, spec.round), scoreValue(hi, spec.round)];
        }
        const rest: Rec = {};
        for (const [k, v] of Object.entries(r)) if (!used.has(k) && !isMissing(v)) rest[k] = v;
        let byMetric = longExtras.get(id);
        if (!byMetric) longExtras.set(id, (byMetric = new Map()));
        byMetric.set(metric, rest);
      }
    } else {
      for (const c of scoreCols) put(c, r[c]);
      for (const [k, v] of Object.entries(r)) {
        if (used.has(k) || scoreSet.has(k) || isMissing(v)) continue;
        (row.extra ??= {})[k] = v;
      }
    }
  }

  // Duplicates: hold the run, or leave the ambiguous scores out (we cannot tell which is right).
  const warnings: string[] = [];
  const dupList = [...dupRows, ...[...dupCells].flatMap(([id, ms]) => [...ms].map((m) => `${id}" for "${m}`))];
  if (dupList.length) {
    const shown = dupList.slice(0, 5).map((d) => `"${d}"`).join(', ') + (dupList.length > 5 ? `, and ${dupList.length - 5} more` : '');
    if (spec.duplicates === 'drop') {
      for (const id of dupRows) rowsById.delete(id);
      for (const [id, ms] of dupCells) {
        const row = rowsById.get(id);
        for (const m of ms) {
          if (row) {
            delete row.scores[m];
            if (row.ci) delete row.ci[m];
          }
          longExtras.get(id)?.delete(m);
        }
      }
      warnings.push(`left out ${dupList.length} ambiguous duplicate${dupList.length === 1 ? '' : 's'}: ${shown}`);
    } else {
      problems.push(`duplicate rows: ${shown}`);
    }
  }

  // Columns that are the same for every metric of a row go to `extra`; the rest (vote counts,
  // ranks) go to `extra.per_metric`, so nothing from the source is dropped.
  for (const [id, byMetric] of longExtras) {
    if (!rowsById.has(id) || !byMetric.size) continue;
    const row = rowsById.get(id)!;
    const cols = new Set<string>();
    for (const rest of byMetric.values()) for (const k of Object.keys(rest)) cols.add(k);
    for (const col of [...cols].sort()) {
      const vals = [...byMetric.values()].map((rest) => rest[col]);
      const first = vals[0];
      if (vals.every((v) => v !== undefined && cellText(v) === cellText(first))) {
        (row.extra ??= {})[col] = first;
      } else {
        const per = ((row.extra ??= {})['per_metric'] ??= {}) as Record<string, Rec>;
        for (const [metric, rest] of byMetric) if (rest[col] !== undefined) (per[metric] ??= {})[col] = rest[col];
      }
    }
  }

  const rows = order.flatMap((id) => rowsById.get(id) ?? []).filter((r) => Object.keys(r.scores).length > 0);
  for (const r of rows) {
    if (r.ci && !Object.keys(r.ci).length) delete r.ci;
  }
  const metricValues = new Map<string, Value[]>();
  for (const r of rows) {
    for (const [m, v] of Object.entries(r.scores)) {
      let list = metricValues.get(m);
      if (!list) metricValues.set(m, (list = []));
      list.push(v);
    }
  }
  const lower = new Set(spec.lower_is_better ?? []);
  const headline = spec.headline ? new Set(spec.headline) : undefined;
  const metrics: Metric[] = [...metricValues.keys()].sort().map((id) => {
    const values = metricValues.get(id)!;
    const unit =
      spec.units?.[id] ??
      spec.unit ??
      (values.every((v) => typeof v === 'string' && /%\s*$/.test(v)) ? 'percent' : 'score');
    const m: Metric = { id, label: spec.labels?.[id] ?? id, direction: lower.has(id) ? 'lower' : 'higher', unit };
    if (headline) m.headline = headline.has(id);
    return m;
  });
  return { rows: rows.map(orderRow), metrics, problems: [...new Set(problems)], warnings };
}

/** Fixed property order keeps the committed JSON byte-stable. */
export function orderRow(r: Row): Row {
  return {
    key: r.key,
    model: r.model,
    ...(r.model_label !== undefined && { model_label: r.model_label }),
    ...(r.model_url !== undefined && { model_url: r.model_url }),
    ...(r.context && { context: r.context }),
    ...(r.date !== undefined && { date: r.date }),
    scores: r.scores,
    ...(r.ci && { ci: r.ci }),
    ...(r.run_by && { run_by: r.run_by }),
    ...(r.upstream_url !== undefined && { upstream_url: r.upstream_url }),
    ...(r.upstream_source !== undefined && { upstream_source: r.upstream_source }),
    ...(r.extra && { extra: r.extra }),
  };
}
