/** The data contract between the build (scripts/build.ts) and the browser. */

export interface SiteSource {
  id: string;
  name: string;
  homepage: string;
  terms: 'allowed' | 'blocked';
  terms_note?: string;
  license?: string;
  attribution?: string;
  fetch?: string;
  every: string;
  row_count: number;
  metric_count: number;
  /** Distinct model names in the source, and how many matched a catalogue model. */
  names: number;
  matched_names: number;
  upstream_revision?: string;
  changed_at?: string;
  checked_at?: string;
  outcome?: string;
  reasons?: string[];
  warnings?: string[];
}

export interface SiteColumn {
  id: string;
  source: string;
  metric: string;
  label: string;
  direction: 'higher' | 'lower';
  unit: string;
  headline: boolean;
  /** URL path segment under benchmarks/<source>/ */
  slug: string;
  /** Matched models with a score in this column. */
  coverage: number;
  tags?: string[];
  family?: string;
  url?: string;
  description?: string;
}

export interface SiteModel {
  id: string;
  name: string;
  provider?: string;
  released?: string;
  open_weights?: boolean;
  license?: string;
  params_b?: number;
  active_b?: number;
  model_repo?: string;
  /**
   * Not in the catalogue: names from the sources that agree with each other but match no catalogue
   * model. No release date, size or licence is known.
   */
  unlisted?: true;
}

export interface SiteIndex {
  generated_at: string;
  sources: SiteSource[];
  columns: SiteColumn[];
  models: SiteModel[];
  tags: Array<{ id: string; label: string }>;
  stats: { invalid_excluded: number; unparsable: number; unlisted_models: number };
}

/** [time, op, from, to] */
export type HistoryEntry = [string, string, string | number | null, string | number | null];

/**
 * One score: [model index, column index, value, run-by code, date, context, url index,
 * interval, raw-name index, history index, flags]. Indexes of -1 mean none. Flags: 1 quantized,
 * 2 run with web search or grounding.
 */
export type CellTuple = [number, number, number, number, string, string, number, string, number, number, number];

export interface CellsFile {
  source: string;
  urls: string[];
  names: string[];
  history: HistoryEntry[][];
  cells: CellTuple[];
}
