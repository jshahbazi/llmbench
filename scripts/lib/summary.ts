/**
 * The summary scores (curation/summary-scores.yaml): one number per model for coding and one for
 * everything else. Each is the average over a fixed basket of benchmarks, grouped into areas that
 * count equally. What makes the average fair to compare between models:
 *
 *   - one benchmark, one vote: every column that measures a benchmark feeds one value per model
 *   - an independent run is used before a submitted one, and that before the maker's own report
 *   - everything is on one 0-100 scale: percentages as they are, an Elo rating as the expected
 *     share of wins against the benchmark's median model
 *   - a benchmark the model has no result on is estimated, not skipped, so being measured only on
 *     easy benchmarks does not help and being measured only on hard ones does not hurt
 *   - a model with too few measured benchmarks gets no score
 *
 * The estimate comes from a one-factor fit over the basket: on the logit scale each value is
 * modelled as intercept[benchmark] + slope[benchmark] * ability[model], fitted by alternating least
 * squares over the values that exist. It is used only to fill gaps; a measured value is never
 * replaced, and an estimate never goes outside the range models have actually scored.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export const SUMMARY_PATH = join('curation', 'summary-scores.yaml');

export interface SummaryBenchmarkSpec {
  name: string;
  /** Column ids, `<source>:<metric>`. */
  columns: string[];
}

export interface SummarySpec {
  id: string;
  label: string;
  description: string;
  minBenchmarks: number;
  minAreas: number;
  areas: Array<{ name: string; benchmarks: SummaryBenchmarkSpec[] }>;
}

const SCORE_ID = /^[a-z][a-z0-9-]*$/;
const COLUMN_ID = /^[a-z0-9][a-z0-9-]*:./;
const FIELDS = new Set(['label', 'description', 'min_benchmarks', 'min_areas', 'areas']);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads curation/summary-scores.yaml, with every problem found. */
export function parseSummaryYaml(text: string | undefined): { specs: SummarySpec[]; problems: string[] } {
  const specs: SummarySpec[] = [];
  const problems: string[] = [];
  if (!text) return { specs, problems };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { specs, problems: [`${SUMMARY_PATH}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (doc === null || doc === undefined) return { specs, problems };
  if (!isMap(doc)) return { specs, problems: [`${SUMMARY_PATH}: expected a mapping of score id to its settings`] };

  for (const [id, entry] of Object.entries(doc)) {
    const where = `${SUMMARY_PATH}: ${id}`;
    if (!SCORE_ID.test(id)) {
      problems.push(`${where}: a score id must be lower case letters, digits and "-"`);
      continue;
    }
    if (!isMap(entry)) {
      problems.push(`${where}: expected a mapping with label, min_benchmarks, min_areas and areas`);
      continue;
    }
    for (const k of Object.keys(entry)) if (!FIELDS.has(k)) problems.push(`${where}: unknown field "${k}"`);
    if (typeof entry['label'] !== 'string' || !entry['label'].trim()) problems.push(`${where}: needs a "label"`);
    if (entry['description'] !== undefined && typeof entry['description'] !== 'string') problems.push(`${where}: "description" must be text`);

    const areas: SummarySpec['areas'] = [];
    const seenColumns = new Set<string>();
    const seenNames = new Set<string>();
    if (!isMap(entry['areas']) || !Object.keys(entry['areas']).length) {
      problems.push(`${where}: "areas" must map each area name to its benchmarks`);
    } else {
      for (const [area, list] of Object.entries(entry['areas'])) {
        if (!isMap(list) || !Object.keys(list).length) {
          problems.push(`${where}: area "${area}" must map each benchmark name to a list of columns`);
          continue;
        }
        const benchmarks: SummaryBenchmarkSpec[] = [];
        for (const [name, cols] of Object.entries(list)) {
          const columns = Array.isArray(cols) ? cols.map(String) : [];
          if (!columns.length) {
            problems.push(`${where}: "${name}" needs a list of columns`);
            continue;
          }
          if (seenNames.has(name)) problems.push(`${where}: benchmark "${name}" is listed twice`);
          seenNames.add(name);
          for (const c of columns) {
            if (!COLUMN_ID.test(c)) problems.push(`${where}: "${name}": "${c}" must be <source>:<metric>`);
            else if (seenColumns.has(c)) problems.push(`${where}: column ${c} is listed twice`);
            seenColumns.add(c);
          }
          benchmarks.push({ name, columns });
        }
        if (benchmarks.length) areas.push({ name: area, benchmarks });
      }
    }

    const total = areas.reduce((n, a) => n + a.benchmarks.length, 0);
    const whole = (k: string, least: number, most: number, of: string): number => {
      const v = entry[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < least) problems.push(`${where}: "${k}" must be a whole number, at least ${least}`);
      else if (most && v > most) problems.push(`${where}: "${k}" is ${v} but the score has only ${most} ${of}`);
      else return v;
      return least;
    };
    // Two measured benchmarks is the least an estimate can be made from.
    const minBenchmarks = whole('min_benchmarks', 2, total, 'benchmarks');
    const minAreas = whole('min_areas', 1, areas.length, 'areas');
    specs.push({
      id,
      label: typeof entry['label'] === 'string' ? entry['label'].trim() : id,
      description: typeof entry['description'] === 'string' ? entry['description'].trim() : '',
      minBenchmarks,
      minAreas,
      areas,
    });
  }
  return { specs, problems };
}

export async function loadSummarySpecs(): Promise<SummarySpec[]> {
  let text: string | undefined;
  try {
    text = await readFile(SUMMARY_PATH, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const { specs, problems } = parseSummaryYaml(text);
  if (problems.length) throw new Error(problems.join('\n'));
  return specs;
}

/** Units a summary score can average: both kinds of percentage, and Elo ratings. */
export const SUMMARY_UNITS: ReadonlySet<string> = new Set(['fraction', 'percent', 'elo']);

// ---- Computing --------------------------------------------------------------------------------

/** How a model's value on a benchmark was obtained: an estimate, or who ran the measurement. */
export const BASIS_ESTIMATED = 0;
export const BASIS_INDEPENDENT = 1;
export const BASIS_SUBMITTED = 2;
export const BASIS_LAB = 3;
export const BASIS_LABELS = ['estimated', 'independent', 'submitted', 'lab-reported'] as const;

export interface SummaryColumn {
  id: string;
  unit: string;
  direction: 'higher' | 'lower';
}

export interface SummaryCandidate {
  value: number;
  /** 0 independent, 1 submitted, 2 lab. */
  runBy: number;
  /** Non-zero for quantized runs and runs with web search; those are not used. */
  flags: number;
}

export interface SummaryBenchmark {
  name: string;
  /** Index into the result's areas. */
  area: number;
  /** Indexes of its columns that exist in the data. */
  columns: number[];
  elo: boolean;
  /** For an Elo benchmark: the median rating, which expected win shares are taken against. */
  reference?: number;
  /** Models with a measured value, and how many of those are independent runs. */
  models: number;
  independent: number;
  /**
   * How far apart the ten best measured values are: points, or rating points for an Elo benchmark.
   * Undefined with fewer than ten. A small gap means the benchmark no longer separates the leaders.
   */
  topTenSpread?: number;
}

export interface SummaryPart {
  /** 0-100. */
  value: number;
  basis: number;
  /** For a measured value: the column it came from, and the rating where the benchmark is Elo. */
  column?: number;
  rating?: number;
}

export interface SummaryModel {
  model: number;
  /** The score, 0-100. Undefined when the model has too few measured benchmarks. */
  value?: number;
  /** 1-based, among the models with a score. */
  rank?: number;
  measured: number;
  areasMeasured: number;
  /** One per area, for a model with a score. */
  areaValues?: number[];
  /** One per benchmark. Without a score, only the measured ones are filled. */
  parts: Array<SummaryPart | null>;
}

export interface SummaryResult {
  spec: SummarySpec;
  areas: string[];
  /** The benchmarks the score averages, in the file's order. */
  benchmarks: SummaryBenchmark[];
  /** Every model measured on at least one of them: those with a score first, best first. */
  models: SummaryModel[];
  scored: number;
  warnings: string[];
}

/** A benchmark with fewer measured models than this is left out: too little to estimate from. */
export const MIN_BENCHMARK_MODELS = 10;
const RIDGE = 0.01;
const SLOPE_FLOOR = 0.05;

const sigmoid = (y: number) => 1 / (1 + Math.exp(-y));
/** How much a value (as a logit) can tell about ability: 1 at 50%, falling towards 0 and 100. */
const telling = (y: number) => {
  const p = sigmoid(y);
  return 4 * p * (1 - p);
};
/** A 0-100 value as a logit, kept away from 0 and 100 where the logit runs off. */
const toLogit = (v: number) => {
  const p = Math.min(0.99, Math.max(0.01, v / 100));
  return Math.log(p / (1 - p));
};
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};
const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

interface Measured {
  value: number;
  runBy: number;
  column: number;
  rating?: number;
}

export interface Fit {
  ability: Map<number, number>;
  slope: number[];
  intercept: number[];
  /** Passes the fit took; at MAX_PASSES it stopped without settling. */
  passes: number;
}
export const MAX_PASSES = 1000;

/**
 * logit(value) = intercept[benchmark] + slope[benchmark] * ability[model], by alternating least
 * squares over the measured values. `weight` is each benchmark's say in a model's ability. Only
 * models with two or more measured benchmarks get an ability.
 *
 * A value near 0 or 100 says little about how able a model is (past the ceiling, every able model
 * looks the same), and its logit is the noisiest. So each value also counts by how much it can
 * tell: p(1 - p), scaled to 1 at 50%. Without this the ablest models, which sit at the ceiling of
 * the easier benchmarks, are placed too low on the ones they have no result for.
 */
export function fitAbilities(values: ReadonlyArray<ReadonlyMap<number, number>>, weight: readonly number[]): Fit {
  const byModel = new Map<number, Array<[number, number]>>();
  values.forEach((v, b) => {
    for (const [m, y] of v) {
      let list = byModel.get(m);
      if (!list) byModel.set(m, (list = []));
      list.push([b, y]);
    }
  });
  const intercept = values.map((v) => (v.size ? mean([...v.values()]) : 0));
  const slope = values.map((v, b) => (v.size ? Math.sqrt(mean([...v.values()].map((y) => (y - intercept[b]!) ** 2))) || 1 : 1));
  const models = [...byModel].filter(([, list]) => list.length >= 2).map(([m]) => m);
  const ability = new Map<number, number>();
  if (models.length < 3) return { ability, slope, intercept, passes: 0 };
  for (const m of models) ability.set(m, mean(byModel.get(m)!.map(([b, y]) => (y - intercept[b]!) / slope[b]!)));

  let passes = 0;
  while (passes < MAX_PASSES) {
    passes++;
    const before = new Map(ability);
    values.forEach((v, b) => {
      let n = 0;
      let sk = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (const [m, y] of v) {
        const x = ability.get(m);
        if (x === undefined) continue;
        const k = telling(y);
        n++;
        sk += k;
        sx += k * x;
        sy += k * y;
        sxx += k * x * x;
        sxy += k * x * y;
      }
      const spread = sk * sxx - sx * sx;
      if (n < 3 || spread <= 1e-9) return;
      slope[b] = Math.max(SLOPE_FLOOR, (sk * sxy - sx * sy) / spread);
      intercept[b] = (sy - slope[b]! * sx) / sk;
    });
    for (const m of models) {
      let num = 0;
      let den = RIDGE;
      for (const [b, y] of byModel.get(m)!) {
        const k = weight[b]! * telling(y);
        num += k * slope[b]! * (y - intercept[b]!);
        den += k * slope[b]! ** 2;
      }
      ability.set(m, num / den);
    }
    // Abilities are only defined up to a shift and a scale; pin them to mean 0, spread 1.
    const all = [...ability.values()];
    const mu = mean(all);
    const sd = Math.sqrt(mean(all.map((x) => (x - mu) ** 2)));
    if (sd > 1e-9) {
      for (const m of models) ability.set(m, (ability.get(m)! - mu) / sd);
      for (let b = 0; b < slope.length; b++) {
        intercept[b] = intercept[b]! + slope[b]! * mu;
        slope[b] = slope[b]! * sd;
      }
    }
    let moved = 0;
    for (const m of models) moved = Math.max(moved, Math.abs(ability.get(m)! - before.get(m)!));
    if (moved < 1e-7) break;
  }
  return { ability, slope, intercept, passes };
}

/**
 * One summary score for every model. `cells(column)` gives each model's scores in that column.
 */
export function computeSummary(
  spec: SummarySpec,
  columns: ReadonlyArray<SummaryColumn>,
  cells: (column: number) => Iterable<readonly [number, ReadonlyArray<SummaryCandidate>]>,
): SummaryResult {
  const warnings: string[] = [];
  const warn = (text: string) => warnings.push(`${spec.label}: ${text}`);
  const columnIndex = new Map(columns.map((c, i) => [c.id, i]));

  const areas: string[] = [];
  const benchmarks: SummaryBenchmark[] = [];
  const measured: Array<Map<number, Measured>> = [];

  for (const area of spec.areas) {
    const kept: Array<{ b: SummaryBenchmark; values: Map<number, Measured> }> = [];
    for (const bench of area.benchmarks) {
      const found: number[] = [];
      for (const id of bench.columns) {
        const ci = columnIndex.get(id);
        const col = ci === undefined ? undefined : columns[ci]!;
        if (!col) warn(`${bench.name}: no column ${id} in the data`);
        else if (col.direction !== 'higher' || !SUMMARY_UNITS.has(col.unit)) warn(`${bench.name}: ${id} is not a higher-is-better percentage or Elo rating, so it is not used`);
        else found.push(ci!);
      }
      const elo = found.some((ci) => columns[ci]!.unit === 'elo');
      if (elo && found.some((ci) => columns[ci]!.unit !== 'elo')) {
        warn(`${bench.name}: mixes Elo ratings with percentages, so it is left out`);
        continue;
      }

      // Each model's value: an independent run before a submitted one before the maker's own, and
      // the best within that.
      const values = new Map<number, Measured>();
      const perColumn = new Map<number, Map<number, number>>();
      for (const ci of found) {
        const scale = columns[ci]!.unit === 'fraction' ? 100 : 1;
        const best = new Map<number, number>();
        perColumn.set(ci, best);
        for (const [m, list] of cells(ci)) {
          for (const c of list) {
            if (c.flags) continue;
            const value = c.value * scale;
            if (!(best.get(m)! >= value)) best.set(m, value);
            const have = values.get(m);
            if (!have || c.runBy < have.runBy || (c.runBy === have.runBy && value > have.value)) values.set(m, { value, runBy: c.runBy, column: ci });
          }
        }
      }
      // Two columns of one benchmark that disagree widely are probably not the same measurement.
      for (let i = 0; i < found.length; i++) {
        for (let j = i + 1; j < found.length; j++) {
          const a = perColumn.get(found[i]!)!;
          const b = perColumn.get(found[j]!)!;
          const gaps = [...a].filter(([m]) => b.has(m)).map(([m, v]) => Math.abs(b.get(m)! - v));
          if (gaps.length >= 5 && median(gaps) > (elo ? 100 : 15)) {
            warn(`${bench.name}: ${columns[found[i]!]!.id} and ${columns[found[j]!]!.id} differ by a median of ${median(gaps).toFixed(1)} over ${gaps.length} models; check they are the same measurement on one scale`);
          }
        }
      }
      if (values.size < MIN_BENCHMARK_MODELS) {
        warn(`${bench.name} is left out: ${values.size} model${values.size === 1 ? ' has' : 's have'} a result, and it takes ${MIN_BENCHMARK_MODELS}`);
        continue;
      }

      const b: SummaryBenchmark = { name: bench.name, area: areas.length, columns: found, elo, models: values.size, independent: 0 };
      b.independent = [...values.values()].filter((v) => v.runBy === 0).length;
      const top = [...values.values()].map((v) => v.value).sort((x, y) => y - x);
      if (top.length >= 10) b.topTenSpread = top[0]! - top[9]!;
      if (elo) {
        // A rating becomes the expected share of wins against the benchmark's median model.
        b.reference = median(top);
        for (const v of values.values()) {
          v.rating = v.value;
          v.value = 100 / (1 + 10 ** ((b.reference - v.value) / 400));
        }
      }
      kept.push({ b, values });
    }
    if (!kept.length) {
      warn(`area "${area.name}" has no usable benchmark and is left out`);
      continue;
    }
    areas.push(area.name);
    for (const { b, values } of kept) {
      benchmarks.push(b);
      measured.push(values);
    }
  }

  // Every area has the same say in a model's ability and in its score, however many benchmarks it has.
  const inArea = areas.map((_, a) => benchmarks.filter((b) => b.area === a).length);
  const weight = benchmarks.map((b) => 1 / inArea[b.area]!);
  const fit = fitAbilities(
    measured.map((values) => new Map([...values].map(([m, v]) => [m, toLogit(v.value)] as const))),
    weight,
  );
  if (fit.passes >= MAX_PASSES) warn('the fit behind the estimates did not settle; check the basket for a benchmark that disagrees with the rest');
  benchmarks.forEach((b, i) => {
    if (fit.ability.size && fit.slope[i]! <= SLOPE_FLOOR) warn(`${b.name} does not move with the rest of the basket, so estimates for it are close to its average`);
  });
  const range = measured.map((values) => {
    const vs = [...values.values()].map((v) => v.value);
    return [Math.min(...vs), Math.max(...vs)] as const;
  });
  /** A model's expected value on a benchmark it has no result for, within what models have scored. */
  const estimate = (m: number, i: number): number | undefined => {
    const ability = fit.ability.get(m);
    if (ability === undefined) return undefined;
    const v = 100 * sigmoid(fit.intercept[i]! + fit.slope[i]! * ability);
    return Math.min(range[i]![1], Math.max(range[i]![0], v));
  };

  const everyModel = new Set(measured.flatMap((values) => [...values.keys()]));
  const models: SummaryModel[] = [];
  for (const m of everyModel) {
    const parts: Array<SummaryPart | null> = measured.map((values) => {
      const v = values.get(m);
      return v ? { value: v.value, basis: v.runBy + 1, column: v.column, ...(v.rating !== undefined && { rating: v.rating }) } : null;
    });
    const count = parts.filter(Boolean).length;
    const areasMeasured = new Set(benchmarks.filter((_, i) => parts[i]).map((b) => b.area)).size;
    const entry: SummaryModel = { model: m, measured: count, areasMeasured, parts };
    if (count >= spec.minBenchmarks && areasMeasured >= spec.minAreas) {
      const filled = parts.map((p, i) => {
        if (p) return p;
        const v = estimate(m, i);
        return v === undefined ? null : { value: v, basis: BASIS_ESTIMATED };
      });
      if (filled.every(Boolean)) {
        entry.parts = filled;
        entry.areaValues = areas.map((_, a) => mean(filled.filter((_, i) => benchmarks[i]!.area === a).map((p) => p!.value)));
        entry.value = mean(entry.areaValues);
      }
    }
    models.push(entry);
  }

  models.sort((x, y) => (y.value ?? -1) - (x.value ?? -1) || y.measured - x.measured || x.model - y.model);
  let scored = 0;
  models.forEach((e, i) => {
    if (e.value === undefined) return;
    scored++;
    const prev = models[i - 1];
    e.rank = prev && prev.value === e.value ? prev.rank! : i + 1;
  });
  return { spec, areas, benchmarks, models, scored, warnings };
}
