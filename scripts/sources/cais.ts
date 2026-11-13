/**
 * CAIS AI Dashboard (dashboard.safe.ai): the Center for AI Safety's own runs of its benchmarks
 * (Humanity's Last Exam, MASK, EnigmaEval, TextQuests, the Remote Labor Index and others) and of a
 * few by other groups (ERQA, MindCube, SpatialViz, IntPhys 2, Machiavelli).
 *
 * The page is a Next.js build with no data endpoint. Its scripts carry the scores as a JSON list,
 * JSON.parse('[{"name":…,"id":…,"scores":{…}}, …]'), and the Remote Labor Index results as a
 * literal list of {name, provider, rate}. Script names are content hashes that change with every
 * deploy, so the reader loads the page, then its scripts until it has found both. The list of
 * script names is the revision: when the data changes, so does the name of the script holding it.
 *
 * Scores are stored as the dashboard's data holds them, each in its natural direction. The
 * dashboard's risk table shows some of them flipped (MASK as 100 minus honesty, the bioweapons
 * column as 100 minus refusal); the descriptions say so.
 *
 * Names: model is the dashboard's run id ("claude-opus-5-5-high"), which carries the setting; the
 * display name is kept as the label, with "Claude" added to Anthropic's tier names ("Opus 5.5").
 */
import { orderRow } from '../lib/extract.ts';
import { fetchOk } from '../lib/http.ts';
import { unescapeJs } from '../lib/parse.ts';
import type { ExtractResult, Metric, Plugin, Row } from '../lib/types.ts';

const HOME = 'https://dashboard.safe.ai/';

type Def = Omit<Metric, 'id' | 'unit'> & { unit?: string };

/** Score columns, in the dashboard's own ids. */
export const METRICS: Record<string, Def> = {
  hle: {
    label: "Humanity's Last Exam (CAIS run)",
    direction: 'higher',
    headline: true,
    tags: ['knowledge'],
    url: 'https://lastexam.ai',
    description: "Accuracy on HLE's 2,500 public expert-written questions, without tools, run by CAIS (co-creator of HLE).",
  },
  hle_diamond: {
    label: "Humanity's Last Exam Diamond",
    direction: 'higher',
    headline: true,
    tags: ['knowledge'],
    url: 'https://lastexam.ai',
    description: 'Accuracy on HLE-Diamond (released 2026-09), the harder follow-on set for when models near the noise ceiling of the original.',
  },
  hle_calibration_error: {
    label: "Humanity's Last Exam calibration error",
    direction: 'lower',
    tags: ['knowledge'],
    url: 'https://lastexam.ai',
    description: "RMS calibration error of the model's stated confidence on HLE: how over- or under-confident it is. Lower is better.",
  },
  textquests: {
    label: 'TextQuests',
    direction: 'higher',
    headline: true,
    tags: ['agents'],
    url: 'https://textquests.ai/',
    description: 'Progress through 25 classic text adventure games, which take people hundreds of precise actions and over 30 hours.',
  },
  textquests_harm: {
    label: 'TextQuests harm',
    direction: 'lower',
    tags: ['agents'],
    url: 'https://textquests.ai/',
    description: 'How often the agent takes wantonly harmful actions while playing the TextQuests games. Lower is better.',
  },
  enigmaeval: {
    label: 'EnigmaEval',
    direction: 'higher',
    headline: true,
    tags: ['vision'],
    url: 'https://arxiv.org/abs/2502.08859',
    description: 'Multimodal puzzles from competitions such as the MIT Mystery Hunt, which take expert teams days to solve.',
  },
  erqa: {
    label: 'ERQA (embodied reasoning)',
    direction: 'higher',
    tags: ['vision'],
    url: 'https://github.com/embodiedreasoning/ERQA',
    description: 'Embodied-reasoning questions for robotics: spatial, trajectory and action reasoning, state estimation, pointing and multi-view.',
  },
  mindcube: {
    label: 'MindCube Tiny (spatial)',
    direction: 'higher',
    tags: ['vision'],
    url: 'https://mind-cube.github.io/',
    description: 'Spatial reasoning over groups of images of the same scene from different views: occlusion, perspective and "what if" questions.',
  },
  spatialviz: {
    label: 'SpatialViz',
    direction: 'higher',
    tags: ['vision'],
    url: 'https://github.com/wangst0181/Spatial-Visualization-Benchmark',
    description: 'Mental rotation, mental folding, visual penetration and mental animation.',
  },
  intphys2: {
    label: 'IntPhys 2 (intuitive physics)',
    direction: 'higher',
    tags: ['vision'],
    url: 'https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks',
    description: 'Telling physically possible video clips from impossible ones (permanence, solidity, continuity).',
  },
  masks: {
    label: 'MASK honesty',
    direction: 'higher',
    url: 'https://www.mask-benchmark.ai',
    description: "Share of answers that stay honest when the model is pressured to lie. The dashboard's risk table shows 100 minus this.",
  },
  machiavelli: {
    label: 'Machiavelli deception',
    direction: 'lower',
    unit: 'score',
    url: 'https://aypan17.github.io/machiavelli/',
    description: 'Deceptive behaviour in 30 goal-driven text games, scaled so 100 is as deceptive as random play. Lower is better.',
  },
  art: {
    label: 'Agent Red Teaming attack success',
    direction: 'lower',
    tags: ['agents'],
    url: 'https://arxiv.org/abs/2507.20526',
    description: 'Share of behaviours for which an attacker gets the agent to break policy within 100 tries (direct and indirect prompt injection). Lower is better.',
  },
  refusal_avg: {
    label: 'Bioweapons refusal (average)',
    direction: 'higher',
    url: 'https://www.virologytest.ai',
    description: "Average refusal rate on three dual-use biology refusal sets (VCT, HPCT, BioTIER). The dashboard's risk table shows 100 minus this.",
  },
  vct_refusal: {
    label: 'VCT refusal',
    direction: 'higher',
    url: 'https://www.virologytest.ai',
    description: 'Refusal rate on the Virology Capabilities Test refusal set: expert-labelled questions that should be refused.',
  },
  hpct_refusal: {
    label: 'HPCT refusal',
    direction: 'higher',
    url: 'https://securebio.org/',
    description: 'Refusal rate on the Human Pathogen Capabilities Test refusal set.',
  },
  biotier_refusal: {
    label: 'BioTIER refusal',
    direction: 'higher',
    url: 'https://securebio.org/',
    description: 'Refusal rate on the BioTIER dual-use biology refusal set.',
  },
  pct: {
    label: 'Political inconsistency (PCT)',
    direction: 'lower',
    url: 'https://political-manipulation.ai',
    description: 'Polarized Contrastive Pairs: how much sentiment and helpfulness shift between matched left- and right-coded subjects. Lower is better.',
  },
};

export const RLI: Metric = {
  id: 'rli',
  label: 'Remote Labor Index automation rate',
  direction: 'higher',
  unit: 'percent',
  headline: true,
  tags: ['agents'],
  url: 'https://www.remotelabor.ai/',
  description: 'Share of 240 real paid freelance projects (design, games, video, data and more) that the agent completed to a standard a client would accept.',
};

/**
 * Columns the data still holds but the dashboard no longer shows or describes, so where the
 * numbers came from is not stated. SWE-bench Pro and ARC-AGI-2 are run by other organisations
 * (Scale AI, ARC Prize), whose own sites we do not read.
 */
const SKIP = new Set(['swebench_pro', 'arc_agi_2']);

const CLAUDE_TIER = /^(Opus|Sonnet|Haiku|Fable)\b/;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The dashboard's model list, if this script holds it. */
export function modelsFromScript(js: string): Array<Record<string, unknown>> | undefined {
  for (const m of js.matchAll(/JSON\.parse\('(\[\{(?:[^'\\]|\\[\s\S])*)'\)/g)) {
    try {
      const list = JSON.parse(unescapeJs(m[1]!)) as unknown;
      if (Array.isArray(list) && list.length && list.every((x) => obj(x)['scores'] && typeof obj(x)['id'] === 'string')) return list.map(obj);
    } catch {
      // Another JSON blob; keep looking.
    }
  }
  return undefined;
}

/** The Remote Labor Index list, if this script holds it. */
export function rliFromScript(js: string): Array<{ name: string; provider: string; rate: number }> | undefined {
  const item = String.raw`\{name:"(?:[^"\\]|\\.)*",provider:"[^"]*",rate:-?\d*\.?\d+\}`;
  const lists = [...js.matchAll(new RegExp(String.raw`\[${item}(?:,${item})*\]`, 'g'))];
  if (lists.length !== 1) return undefined;
  return [...lists[0]![0].matchAll(/\{name:"((?:[^"\\]|\\.)*)",provider:"([^"]*)",rate:(-?\d*\.?\d+)\}/g)].map((m) => ({
    name: unescapeJs(m[1]!),
    provider: m[2]!,
    rate: Number(m[3]),
  }));
}

/** How the run was set up, from the end of the dashboard's run id. */
export function runSetting(id: string): Record<string, string> {
  let m: RegExpExecArray | null;
  if ((m = /-adaptive-(\d+)k$/.exec(id))) return { reasoning: `adaptive thinking, ${m[1]}k budget` };
  if ((m = /-thinking-(\d+)k$/.exec(id))) return { reasoning: `thinking, ${m[1]}k budget` };
  if ((m = /-(\d+)k$/.exec(id))) return { reasoning: `${m[1]}k thinking budget` };
  if ((m = /-(none|minimal|low|medium|high|xhigh|max)$/.exec(id))) return { reasoning_effort: `${m[1]} effort` };
  return {};
}

const labelFor = (name: string, provider: string) => (provider === 'anthropic' && CLAUDE_TIER.test(name) ? `Claude ${name}` : name);

export function modelRow(entry: Record<string, unknown>, unknown: Set<string>): { row?: Row; problem?: string } {
  const id = str(entry['id']);
  const name = str(entry['name']);
  if (!id || !name) return { problem: 'a dashboard model has no id or name' };
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(entry['scores']))) {
    if (SKIP.has(k)) continue;
    if (!(k in METRICS)) {
      unknown.add(k);
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) scores[k] = v;
  }
  if (!Object.keys(scores).length) return {};
  const extra: Record<string, unknown> = {};
  const notes = Object.entries(obj(entry['scoreNotes']))
    .filter(([k, v]) => k in scores && typeof v === 'string')
    .map(([k, v]) => `${METRICS[k]!.label}: ${plain(v as string)}`);
  if (notes.length) extra['notes'] = notes.join(' | ');
  for (const k of ['provider', 'releaseDate', 'model_size', 'modelWeights'] as const) if (str(entry[k])) extra[k] = str(entry[k]);
  const pct = obj(entry['pct_detail']);
  if (Object.keys(pct).length && 'pct' in scores) extra['pct_detail'] = pct;
  const label = labelFor(name, str(entry['provider']) ?? '');
  const url = str(entry['modelCardUrl']);
  const setting = runSetting(id);
  const row: Row = {
    key: id,
    model: id,
    model_label: label,
    ...(url?.startsWith('https://') && { model_url: url }),
    ...(Object.keys(setting).length && { context: setting }),
    scores,
    run_by: 'independent',
    upstream_url: HOME,
    ...(Object.keys(extra).length && { extra }),
  };
  return { row: orderRow(row) };
}

export function rliRow(e: { name: string; provider: string; rate: number }): Row {
  const label = labelFor(e.name, e.provider);
  return orderRow({
    key: `rli/${e.name}`,
    model: e.name,
    ...(label !== e.name && { model_label: label }),
    scores: { rli: e.rate },
    run_by: 'independent',
    upstream_url: `${HOME}#automation`,
    extra: { provider: e.provider },
  });
}

export function extract(models: Array<Record<string, unknown>>, rli: Array<{ name: string; provider: string; rate: number }>): ExtractResult {
  const rows: Row[] = [];
  const problems: string[] = [];
  const unknown = new Set<string>();
  for (const entry of models) {
    const out = modelRow(entry, unknown);
    if (out.problem) problems.push(out.problem);
    if (out.row) rows.push(out.row);
  }
  rows.push(...rli.map(rliRow));
  const used = new Set(rows.flatMap((r) => Object.keys(r.scores)));
  const metrics: Metric[] = Object.entries(METRICS)
    .filter(([id]) => used.has(id))
    .map(([id, d]) => ({ id, ...d, unit: d.unit ?? 'percent', headline: d.headline ?? false }));
  if (used.has('rli')) metrics.push(RLI);
  const warnings = unknown.size ? [`scores the reader does not know yet (add them to scripts/sources/cais.ts): ${[...unknown].sort().join(', ')}`] : undefined;
  return { rows, metrics, problems, ...(warnings && { warnings }) };
}

const cais: Plugin = async ({ source, previous, force }) => {
  const home = String(source.fetch ?? HOME).replace(/\/?$/, '/');
  const page = await (await fetchOk(home)).text();
  const scripts = [...new Set([...page.matchAll(/\/_next\/static\/chunks\/[\w-]+\.js/g)].map((m) => m[0]))];
  if (!scripts.length) return { rows: [], metrics: [], problems: ['the dashboard page lists no scripts; the reader needs updating'] };
  const revision = scripts.map((s) => s.replace(/^.*\//, '').replace(/\.js$/, '')).sort().join(',');
  if (!force && previous?.upstream_revision === revision) return 'unchanged';

  let models: Array<Record<string, unknown>> | undefined;
  let rli: Array<{ name: string; provider: string; rate: number }> | undefined;
  for (const s of scripts) {
    if (models && rli) break;
    const js = await (await fetchOk(new URL(s, home).href)).text();
    models ??= modelsFromScript(js);
    rli ??= rliFromScript(js);
  }
  const problems: string[] = [];
  if (!models) problems.push("the dashboard's model list was not found in its scripts; the reader needs updating");
  if (!rli) problems.push("the dashboard's Remote Labor Index list was not found in its scripts; the reader needs updating");
  const result = extract(models ?? [], rli ?? []);
  return { ...result, revision, problems: [...problems, ...(result.problems ?? [])] };
};

export default cais;
