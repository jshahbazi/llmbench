/** Who ran an evaluation. See the plan, section 6.3. */
export type RunBy = 'independent' | 'submitted' | 'lab';
export const RUN_BY: readonly RunBy[] = ['independent', 'submitted', 'lab'];

/** One source entry from sources.yaml, after defaults are applied. */
export interface SourceConfig {
  id: string;
  name: string;
  homepage: string;
  terms: 'allowed' | 'blocked';
  terms_note?: string;
  fetch?: string;
  plugin?: string;
  license?: string;
  attribution?: string;
  every: string;
  run_by: RunBy;
  /** Every other key in the entry: field mappings, guard settings and plugin options. */
  options: Record<string, unknown>;
}

export type Value = string | number;

/**
 * One upstream row, stored verbatim. Written to data/sources/<id>/rows.jsonl.
 * `model` and the keys of `scores` are exactly what the source wrote.
 */
export interface Row {
  key: string;
  model: string;
  /** The source's display name for the model, when it also has an identifier. */
  model_label?: string;
  model_url?: string;
  context?: Record<string, string>;
  date?: string;
  scores: Record<string, Value>;
  /** Confidence interval per metric: [low, high]. */
  ci?: Record<string, [Value, Value]>;
  run_by?: RunBy;
  upstream_url?: string;
  upstream_source?: string;
  extra?: Record<string, unknown>;
}

/** Describes one score column of a source. Written to data/sources/<id>/metrics.json. */
export interface Metric {
  id: string;
  label: string;
  direction: 'higher' | 'lower';
  /** 'fraction' (0-1, shown as a percentage), 'percent', 'elo', or a free-form unit. */
  unit: string;
  /** Shown in the default "most covered" column choice. Others need "All columns". */
  headline?: boolean;
  /** Task tags used by the explorer's presets: agents, coding, chat, math, vision, search, knowledge. */
  tags?: string[];
  category?: string;
  family?: string;
  url?: string;
  description?: string;
}

/** A canonical model. Written to data/catalog/models.jsonl. */
export interface CatalogModel {
  id: string;
  name: string;
  provider?: string;
  category: string;
  released?: string;
  open_weights?: boolean;
  license?: string;
  params_b?: number;
  active_b?: number;
  context_k?: number;
  model_repo?: string;
  origin: string;
}

/** Licence record for a source that reached us through an aggregator. */
export interface UpstreamSource {
  id: string;
  name?: string;
  kind?: string;
  license?: string;
  license_url?: string;
  terms_url?: string;
  attribution?: string;
  verdict?: string;
}

/** Committed per-source state. Changes only when the data changes. */
export interface SourceState {
  upstream_revision?: string;
  upstream_revision_date?: string;
  payload_hash: string;
  row_count: number;
  /** When this source was first imported. Cells present then have no "add" event. */
  baseline_at?: string;
  changed_at: string;
}

/** One line of data/sources/<id>/history.jsonl. */
export interface HistoryEvent {
  t: string;
  key: string;
  model: string;
  metric: string;
  op: 'add' | 'change' | 'remove' | 'return';
  from?: Value;
  to?: Value;
  rev?: string;
}

export type Outcome = 'ingested' | 'unchanged' | 'held' | 'failed' | 'skipped' | 'not_due';

/** Per-run facts kept in .cache/last-run.json, which the workflow carries between runs. */
export interface RunEntry {
  checked_at: string;
  outcome: Outcome;
  /** Why a run was held or failed. */
  reasons?: string[];
  warnings?: string[];
  summary?: string;
  last_success_at?: string;
  etag?: string;
  last_modified?: string;
}

export interface ExtractResult {
  revision?: string;
  revisionDate?: string;
  rows: Row[];
  metrics: Metric[];
  /** Problems the guards should hold the run for: missing columns, duplicate rows. */
  problems?: string[];
  /** Worth reporting, not a reason to hold: e.g. ambiguous duplicates that were left out. */
  warnings?: string[];
  catalog?: CatalogModel[];
  upstreamSources?: UpstreamSource[];
  /** Conditional-request validators for plain URLs, kept in the run cache. */
  etag?: string;
  lastModified?: string;
}

export interface PluginContext {
  source: SourceConfig;
  previous?: SourceState;
  cache?: RunEntry;
  force: boolean;
}

/** A plugin returns 'unchanged' when the upstream revision or ETag matches the previous run. */
export type Plugin = (ctx: PluginContext) => Promise<ExtractResult | 'unchanged'>;
