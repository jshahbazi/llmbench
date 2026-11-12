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
  /** Every other key in the entry: field mappings now, plugin options always. */
  options: Record<string, unknown>;
}

/**
 * One upstream row, stored verbatim. Written to data/sources/<id>/rows.jsonl.
 * `model` and the keys of `scores` are exactly what the source wrote.
 */
export interface Row {
  key: string;
  model: string;
  context?: Record<string, string>;
  date?: string;
  scores: Record<string, string | number>;
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
  etag?: string;
  last_modified?: string;
  payload_hash: string;
  row_count: number;
  changed_at: string;
  status: 'healthy' | 'held' | 'failing';
}

export interface ExtractResult {
  revision?: string;
  revisionDate?: string;
  rows: Row[];
  metrics: Metric[];
  catalog?: CatalogModel[];
  upstreamSources?: UpstreamSource[];
}

export interface PluginContext {
  source: SourceConfig;
  previous?: SourceState;
  force: boolean;
}

/** A plugin returns 'unchanged' when the upstream revision matches the previous run. */
export type Plugin = (ctx: PluginContext) => Promise<ExtractResult | 'unchanged'>;
