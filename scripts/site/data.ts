/**
 * Reads data/ and assembles everything the site needs: the index, one cells file per source, and
 * lookups for the static pages and downloads. Model names are joined to models through
 * data/resolved/ (written by `npm run resolve`); the catalogue has curation/models.yaml applied.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify } from '../../site/src/format.ts';
import type { Candidate } from '../../site/src/select.ts';
import type { CellsFile, CellTuple, HistoryEntry, SiteColumn, SiteIndex, SiteModel, SiteSource } from '../../site/src/types.ts';
import { loadSources } from '../lib/config.ts';
import { fillsOnly } from '../lib/catalog.ts';
import { benchmarkOf, curatedCatalog, loadBenchmarkLinks } from '../lib/curation.ts';
import { slugifyModel } from '../lib/match.ts';
import { describeQualifier, qualifierFlags, readQualifiers } from '../lib/names.ts';
import { parseDelimited, tableToRecords, type Rec } from '../lib/parse.ts';
import { parseScore } from '../lib/scores.ts';
import { readHistory, readJson, readRows, readRunCache, readState, sourceDir } from '../lib/store.ts';
import { presentMetrics, TAGS } from '../lib/tags.ts';
import type { HistoryEvent, Metric, RunBy, SourceConfig } from '../lib/types.ts';

const RUN_BY_CODE: Record<RunBy, number> = { independent: 0, submitted: 1, lab: 2 };

export interface NameEntry {
  raw: string;
  model: number;
  method: string;
  /** How the source's name differs from the model, as shown: "high effort, snapshot 2024-12-17". */
  qualifiers: string;
  rows: number;
  scores: number;
}

/** One score as the downloads list it. */
export interface ScoreRecord {
  model: number;
  column: number;
  value: number;
  /** The score exactly as the source wrote it. */
  raw: string;
  runBy: RunBy;
  date: string;
  context: string;
  rawName: string;
  url: string;
  ciLow: string;
  ciHigh: string;
  rowKey: string;
}

export interface SiteData {
  index: SiteIndex;
  cells: CellsFile[];
  /** `${model}:${column}` -> every score for that cell */
  byCell: Map<string, Candidate[]>;
  /** model index -> column indexes with a score */
  modelColumns: Map<number, Set<number>>;
  /** column index -> model indexes with a score */
  columnModels: Map<number, Set<number>>;
  names: Map<string, NameEntry[]>;
  history: Map<string, Array<HistoryEvent & { column?: number; modelIndex?: number }>>;
  scores: ScoreRecord[];
  config: SourceConfig[];
}

async function readCsv(path: string): Promise<Rec[] | undefined> {
  try {
    return tableToRecords(parseDelimited(await readFile(path, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

interface Resolved {
  modelId: string;
  method: string;
  qualifiers: string;
}

async function resolvedNames(): Promise<{ aliases: Map<string, Resolved>; unlisted: Map<string, string> }> {
  const aliases = new Map<string, Resolved>();
  const unlisted = new Map<string, string>();
  const rows = await readCsv(join('data', 'resolved', 'aliases.csv'));
  if (!rows) console.warn('data/resolved/aliases.csv not found; run `npm run resolve` first. No name will be matched.');
  for (const r of rows ?? []) {
    aliases.set(`${r['source']}\u0000${r['raw_name']}`, {
      modelId: String(r['model_id']),
      method: String(r['method'] ?? ''),
      qualifiers: String(r['qualifiers'] ?? ''),
    });
  }
  for (const r of (await readCsv(join('data', 'resolved', 'unlisted.csv'))) ?? []) unlisted.set(String(r['model_id']), String(r['name']));
  return { aliases, unlisted };
}

export async function loadSiteData(): Promise<SiteData> {
  const config = await loadSources();
  const { catalog, stats: feedStats } = await curatedCatalog({ sources: config });
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const { aliases, unlisted } = await resolvedNames();
  const runs = await readRunCache();

  const models: SiteModel[] = [];
  const modelIndex = new Map<string, number>();
  const idFor = (sourceId: string, raw: string): string =>
    aliases.get(`${sourceId}\u0000${raw}`)?.modelId ?? `unlisted-${slugifyModel(sourceId)}-${slugifyModel(raw)}`;
  const modelFor = (sourceId: string, raw: string): { index: number; resolved?: Resolved } => {
    const hit = aliases.get(`${sourceId}\u0000${raw}`);
    const id = idFor(sourceId, raw);
    let i = modelIndex.get(id);
    if (i === undefined) {
      const cat = byId.get(id);
      const m: SiteModel = cat
        ? {
            id: cat.id,
            name: cat.name,
            provider: cat.provider,
            released: cat.released,
            open_weights: cat.open_weights,
            license: cat.license,
            params_b: cat.params_b,
            active_b: cat.active_b,
            model_repo: cat.model_repo,
            origin: cat.origin,
          }
        : { id, name: unlisted.get(id) ?? raw, unlisted: true };
      i = models.push(m) - 1;
      modelIndex.set(id, i);
    }
    return { index: i, ...(hit && { resolved: hit }) };
  };

  const columns: SiteColumn[] = [];
  const sources: SiteSource[] = [];
  const cellsFiles: CellsFile[] = [];
  const byCell = new Map<string, Candidate[]>();
  const modelColumns = new Map<number, Set<number>>();
  const columnModels = new Map<number, Set<number>>();
  const names = new Map<string, NameEntry[]>();
  const history = new Map<string, Array<HistoryEvent & { column?: number; modelIndex?: number }>>();
  const scores: ScoreRecord[] = [];
  let invalidExcluded = 0;
  let unparsable = 0;

  for (const s of config) {
    const state = await readState(s.id);
    const run = runs[s.id];
    const site: SiteSource = {
      id: s.id,
      name: s.name,
      homepage: s.homepage,
      terms: s.terms,
      terms_note: s.terms_note,
      license: s.license,
      attribution: s.attribution,
      fetch: s.fetch,
      every: s.every,
      row_count: state?.row_count ?? 0,
      metric_count: 0,
      names: 0,
      matched_names: 0,
      upstream_revision: state?.upstream_revision,
      changed_at: state?.changed_at,
      checked_at: run?.checked_at,
      outcome: run?.outcome,
      reasons: run?.outcome === 'held' || run?.outcome === 'failed' ? run.reasons : undefined,
      warnings: run?.warnings,
    };
    const feed = feedStats.get(s.id);
    if (feed) site.catalog = { ...feed, ...(fillsOnly(s) && { fill_only: true }) };
    sources.push(site);
    if (!state) continue;

    const rows = await readRows(s.id);
    const metrics = presentMetrics((await readJson<Metric[]>(join(sourceDir(s.id), 'metrics.json'))) ?? [], s.options);
    site.metric_count = metrics.length;

    const colIndex = new Map<string, number>();
    const slugs = new Set<string>();
    for (const m of metrics) {
      let slug = slugify(m.id);
      for (let k = 2; slugs.has(slug); k++) slug = `${slugify(m.id)}-${k}`;
      slugs.add(slug);
      colIndex.set(m.id, columns.length);
      columns.push({
        id: `${s.id}:${m.id}`,
        source: s.id,
        metric: m.id,
        label: m.label,
        direction: m.direction,
        unit: m.unit,
        headline: m.headline !== false,
        slug,
        coverage: 0,
        ...(m.tags?.length && { tags: m.tags }),
        ...(m.family && { family: m.family }),
        ...(m.url && { url: m.url }),
        ...(m.description && { description: m.description }),
      });
    }

    // History, grouped by cell so each score can show its own changes.
    const events = await readHistory(s.id);
    const histByCell = new Map<string, HistoryEntry[]>();
    for (const e of events) {
      const k = `${e.key}\u0000${e.metric}`;
      let list = histByCell.get(k);
      if (!list) histByCell.set(k, (list = []));
      list.push([e.t, e.op, e.from ?? null, e.to ?? null]);
    }

    const file: CellsFile = { source: s.id, urls: [], names: [], history: [], cells: [] };
    const urlIndex = new Map<string, number>();
    const nameIndex = new Map<string, number>();
    const histIndex = new Map<string, number>();
    const nameStats = new Map<string, NameEntry & { context: string[]; flags: number }>();

    for (const r of rows) {
      if (r.extra && typeof r.extra['invalid'] === 'string') {
        invalidExcluded++;
        continue;
      }
      let ns = nameStats.get(r.model);
      if (!ns) {
        const { index, resolved } = modelFor(s.id, r.model);
        const quals = readQualifiers(resolved?.qualifiers ?? '');
        const context = quals.map(describeQualifier);
        ns = { raw: r.model, model: index, method: resolved?.method ?? '', qualifiers: context.join(', '), rows: 0, scores: 0, context, flags: qualifierFlags(quals) };
        nameStats.set(r.model, ns);
      }
      ns.rows++;
      const mi = ns.model;

      const runByName = r.run_by ?? s.run_by;
      const runBy = RUN_BY_CODE[runByName];
      const link = r.upstream_url ?? r.model_url;
      let ui = -1;
      if (link) {
        ui = urlIndex.get(link) ?? -1;
        if (ui < 0) urlIndex.set(link, (ui = file.urls.push(link) - 1));
      }
      let ni = nameIndex.get(r.model);
      if (ni === undefined) nameIndex.set(r.model, (ni = file.names.push(r.model) - 1));
      const context = [...Object.values(r.context ?? {}), ...ns.context].join(' · ');

      for (const [metric, rawValue] of Object.entries(r.scores)) {
        const ci = colIndex.get(metric);
        const value = parseScore(rawValue);
        if (ci === undefined || value === null) {
          unparsable++;
          continue;
        }
        ns.scores++;
        const interval = r.ci?.[metric];
        const hk = `${r.key}\u0000${metric}`;
        const hist = histByCell.get(hk);
        let hi = -1;
        if (hist) {
          hi = histIndex.get(hk) ?? -1;
          if (hi < 0) histIndex.set(hk, (hi = file.history.push(hist) - 1));
        }
        const date = r.date?.slice(0, 10) ?? '';
        const intervalText = interval ? `${interval[0]}–${interval[1]}` : '';
        const tuple: CellTuple = [mi, ci, value, runBy, date, context, ui, intervalText, ni, hi, ns.flags];
        file.cells.push(tuple);
        scores.push({
          model: mi,
          column: ci,
          value,
          raw: String(rawValue),
          runBy: runByName,
          date,
          context,
          rawName: r.model,
          url: link ?? '',
          ciLow: interval ? String(interval[0]) : '',
          ciHigh: interval ? String(interval[1]) : '',
          rowKey: r.key,
        });

        const key = `${mi}:${ci}`;
        let list = byCell.get(key);
        if (!list) byCell.set(key, (list = []));
        list.push({ value, runBy, date, context, url: link ?? null, interval: intervalText, rawName: r.model, source: s.id, history: hist ?? null, flags: ns.flags });
        let mc = modelColumns.get(mi);
        if (!mc) modelColumns.set(mi, (mc = new Set()));
        mc.add(ci);
        let cm = columnModels.get(ci);
        if (!cm) columnModels.set(ci, (cm = new Set()));
        cm.add(mi);
      }
    }

    const nameList: NameEntry[] = [...nameStats.values()]
      .map(({ raw, model, method, qualifiers, rows: n, scores: k }) => ({ raw, model, method, qualifiers, rows: n, scores: k }))
      .sort((a, b) => b.scores - a.scores || a.raw.localeCompare(b.raw));
    names.set(s.id, nameList);
    site.names = nameList.length;
    site.matched_names = nameList.filter((n) => !models[n.model]!.unlisted).length;

    history.set(
      s.id,
      events.map((e) => {
        const ci = colIndex.get(e.metric);
        const mi = modelIndex.get(idFor(s.id, e.model));
        return { ...e, ...(ci !== undefined && { column: ci }), ...(mi !== undefined && { modelIndex: mi }) };
      }),
    );
    cellsFiles.push(file);
  }

  for (const [ci, ms] of columnModels) columns[ci]!.coverage = ms.size;
  const idSources = new Set(config.filter((s) => s.options['benchmark_ids'] === true).map((s) => s.id));
  const linked = benchmarkOf(columns, await loadBenchmarkLinks(), idSources);
  for (const c of columns) {
    const b = linked.get(c.id);
    if (b) c.benchmark = b;
  }

  const index: SiteIndex = {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    sources,
    columns,
    models,
    tags: [...TAGS],
    stats: { invalid_excluded: invalidExcluded, unparsable, unlisted_models: models.filter((m) => m.unlisted).length },
  };
  return { index, cells: cellsFiles, byCell, modelColumns, columnModels, names, history, scores, config };
}
