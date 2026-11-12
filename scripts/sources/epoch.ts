/**
 * Epoch AI Benchmarking Hub (epoch.ai/benchmarks): one zip of CSVs, one per benchmark.
 *
 * benchmark_metadata.csv names each benchmark's file, score column and scale, so the plugin reads
 * that instead of guessing. Each (benchmark, model) becomes one row. Also imports the Epoch
 * Capabilities Index (epoch_capabilities_index/eci_scores.csv).
 *
 * Options in sources.yaml:
 *   include_external: false   The *_external.csv files are Epoch's copies of other leaderboards.
 *                             Epoch asks users to credit those original sources, whose terms we
 *                             have not reviewed, so they are off by default.
 */
import { unzipSync } from 'fflate';
import { isMissing, orderRow } from '../lib/extract.ts';
import { fetchOk } from '../lib/http.ts';
import { parseDelimited, tableToRecords, type Rec } from '../lib/parse.ts';
import type { ExtractResult, Metric, Plugin, Row } from '../lib/types.ts';

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

function csv(files: Record<string, Uint8Array>, name: string): Rec[] | undefined {
  const bytes = files[name];
  return bytes ? tableToRecords(parseDelimited(new TextDecoder().decode(bytes))) : undefined;
}

function unitFor(scale: string): string {
  const s = Number(scale);
  if (s === 1) return 'fraction';
  if (s === 0.01) return 'percent';
  return 'score';
}

export function transform(files: Record<string, Uint8Array>, includeExternal: boolean): Omit<ExtractResult, 'etag' | 'lastModified'> {
  const problems: string[] = [];
  const meta = csv(files, 'benchmark_metadata.csv');
  if (!meta) return { rows: [], metrics: [], problems: ['missing file "benchmark_metadata.csv"'] };

  const display = new Map<string, string>();
  for (const m of csv(files, 'model_metadata.csv') ?? []) {
    const id = text(m['model_version']);
    const name = text(m['display_name']);
    if (id && name) display.set(id, name);
  }

  const rows: Row[] = [];
  const metrics: Metric[] = [];
  for (const b of meta) {
    const file = text(b['source_file']);
    if (!file || (!includeExternal && file.includes('_external'))) continue;
    const records = csv(files, file);
    if (!records) continue;
    const scoreCol = text(b['score_column']);
    if (records.length && !(scoreCol in records[0]!)) {
      problems.push(`missing column "${scoreCol}" in ${file}`);
      continue;
    }
    const id = file.replace(/\.csv$/, '');
    const notes = [
      b['random_baseline'] && `random baseline ${text(b['random_baseline'])}`,
      b['release_date'] && `benchmark released ${text(b['release_date'])}`,
      text(b['superseded_by']) && `superseded by ${text(b['superseded_by'])}`,
    ].filter(Boolean);
    metrics.push({
      id,
      label: text(b['benchmark']) || id,
      direction: 'higher',
      unit: unitFor(text(b['scale'])),
      ...(notes.length && { description: notes.join('; ') }),
    });
    for (const r of records) {
      const model = text(r['Model version']);
      const score = r[scoreCol];
      if (!model || isMissing(score)) continue;
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k !== 'Model version' && k !== scoreCol && k !== 'Started at' && !isMissing(v)) extra[k] = v;
      }
      const label = display.get(model);
      rows.push(
        orderRow({
          key: `${id}|${model}`,
          model,
          ...(label && label !== model && { model_label: label }),
          ...(text(r['Started at']) && { date: text(r['Started at']) }),
          scores: { [id]: text(score) },
          ...(Object.keys(extra).length && { extra }),
        }),
      );
    }
  }

  const eci = csv(files, 'epoch_capabilities_index/eci_scores.csv');
  if (eci?.length) {
    metrics.push({
      id: 'eci',
      label: 'Epoch Capabilities Index',
      direction: 'higher',
      unit: 'score',
      description: "Epoch's combined capability score, fitted across many benchmarks",
    });
    for (const r of eci) {
      const model = text(r['Model']);
      if (!model || isMissing(r['eci'])) continue;
      const label = text(r['Display name']);
      rows.push(
        orderRow({
          key: `eci|${model}`,
          model,
          ...(label && label !== model && { model_label: label }),
          ...(text(r['date']) && { date: text(r['date']) }),
          scores: { eci: text(r['eci']) },
          ...(!isMissing(r['eci_ci_low']) && !isMissing(r['eci_ci_high']) && { ci: { eci: [text(r['eci_ci_low']), text(r['eci_ci_high'])] } }),
        }),
      );
    }
  }
  return { rows, metrics, problems };
}

const epoch: Plugin = async ({ source, previous, cache, force }) => {
  const headers: Record<string, string> = {};
  if (!force && previous) {
    if (cache?.etag) headers['if-none-match'] = cache.etag;
    if (cache?.last_modified) headers['if-modified-since'] = cache.last_modified;
  }
  const res = await fetchOk(source.fetch ?? 'https://epoch.ai/data/benchmark_data.zip', { headers });
  if (res.status === 304) return 'unchanged';
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return {
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    ...transform(files, source.options['include_external'] === true),
  };
};

export default epoch;
