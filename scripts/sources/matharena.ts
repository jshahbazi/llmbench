/**
 * MathArena (matharena.ai, ETH Zürich): models on maths competitions as soon as they are held, so
 * the problems cannot be in training data. Final-answer contests (AIME, HMMT, BRUMO, SMT, CMIMC),
 * proof contests graded by people (USAMO, IMO, IMC, Putnam), monthly sets of questions from new
 * arXiv papers (ArXivMath, BrokenArXiv, ArXivLean), Kangaroo (visual), Project Euler and others.
 *
 * The home page lists every competition (data-competition-id on its buttons). Each competition's
 * tables come from /competition_tables/<id> as JSON holding HTML; the summary table gives accuracy
 * with a 95% interval and cost per problem. Only measured accuracy is stored: an estimate MathArena
 * fills in for questions it did not run ("Estimated accuracy using item response theory") is kept
 * as a note instead. A model released after the competition (⚠️ on the site) is kept and flagged.
 */
import { orderRow } from '../lib/extract.ts';
import { fetchOk } from '../lib/http.ts';
import { htmlTables, htmlText, type HtmlTable } from '../lib/parse.ts';
import type { ExtractResult, Metric, Plugin, Row } from '../lib/types.ts';

const BASE = 'https://matharena.ai';

export interface Competition {
  id: string;
  label: string;
  headline: boolean;
}

/** Sets named by the id's prefix (before "--"), or after "overall--" for a set's overall table. */
const SETS: Record<string, string> = {
  arxiv: 'ArXivMath',
  arxivmath: 'ArXivMath',
  arxiv_false: 'BrokenArXiv',
  brokenarxiv: 'BrokenArXiv',
  arxivlean: 'ArXivLean',
  leanlean: 'LeanLean',
  visual_math: 'Visual maths (Kangaroo)',
  final_answer_comps: 'Final-answer competitions',
  euler: 'Project Euler',
};
/** Families shared with whatmodel's MathArena columns. */
const FAMILY: Record<string, string> = { arxiv: 'arxivmath', arxivmath: 'arxivmath', arxiv_false: 'brokenarxiv', brokenarxiv: 'brokenarxiv', arxivlean: 'arxivlean' };

export function setOf(id: string): string {
  const [prefix, rest] = id.split('--');
  return prefix === 'overall' ? (rest ?? prefix) : prefix!;
}

/** The competitions on the home page, labelled the way the site groups them. */
export function competitionsFrom(page: string): Competition[] {
  const out = new Map<string, Competition>();
  for (const m of page.matchAll(/<button\b([^>]*\bdata-competition-id="([^"]+)"[^>]*)>([\s\S]*?)<\/button>/g)) {
    const id = m[2]!;
    if (out.has(id)) continue;
    const text = htmlText(m[3]!.split(/<(?:select|optgroup|button)\b/)[0]!);
    const set = SETS[setOf(id)];
    const date = /^(\d{2})\/(\d{4})$/.exec(text);
    let label: string;
    if (id.startsWith('overall--')) label = `${set ?? text} overall`;
    else if (date) label = `${set ?? setOf(id)} ${date[2]}-${date[1]}`;
    else label = text || set || id;
    out.set(id, { id, label, headline: id.startsWith('overall--') || /\bdata-default-open="true"/.test(m[1]!) });
  }
  return [...out.values()];
}

const pct = (s: string) => {
  const m = /^(-?\d+(?:\.\d+)?)%?(?:\s*±\s*(\d+(?:\.\d+)?)%?)?$/.exec(s.trim());
  return m ? { value: Number(m[1]), half: m[2] === undefined ? undefined : Number(m[2]) } : undefined;
};
const dollars = (s: string) => {
  const m = /^\$\s*(\d+(?:\.\d+)?)$/.exec(s.trim());
  return m ? Number(m[1]) : undefined;
};

/** The table to read: a header with "Model Name" and an accuracy or score column. */
export function pickTable(tables: HtmlTable[]): { table: HtmlTable; model: number; score: number; scoreName: string; cost: number } | undefined {
  for (const table of tables) {
    const model = table.header.findIndex((h) => /^model name$/i.test(h));
    const score = table.header.findIndex((h) => /^(accuracy|score)\b/i.test(h));
    if (model < 0 || score < 0) continue;
    return { table, model, score, scoreName: /^score/i.test(table.header[score]!) ? 'score' : 'accuracy', cost: table.header.findIndex((h) => /^cost$/i.test(h)) };
  }
  return undefined;
}

export function competitionRows(c: Competition, doc: unknown): { rows: Row[]; metrics: Metric[]; problems: string[] } {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  const html = ['table', 'problem_table'].map((k) => (typeof d[k] === 'string' ? (d[k] as string) : '')).join('\n');
  const picked = pickTable(htmlTables(html));
  if (!picked) return { rows: [], metrics: [], problems: [] };
  const { table, model, score, scoreName, cost } = picked;
  const provider = table.header.findIndex((h) => /^provider$/i.test(h));
  const open = table.header.findIndex((h) => /^open$/i.test(h));
  const scoreId = `${c.id}/${scoreName}`;
  const costId = `${c.id}/cost`;
  const url = `${BASE}/#${encodeURIComponent(c.id)}`;
  const rows: Row[] = [];
  const problems: string[] = [];
  let hasCost = false;
  for (const r of table.rows) {
    const nameCell = r.cells[model];
    if (!nameCell?.text) continue;
    const flagged = /⚠/.test(nameCell.text);
    const name = nameCell.text.replace(/⚠️?/g, '').trim();
    const scoreCell = r.cells[score];
    const s = scoreCell ? pct(scoreCell.text) : undefined;
    const estimated = scoreCell?.attrs['data-predicted'] === 'yes';
    const row: Row = { key: `${c.id}/${r.attrs['data-config'] || name}`, model: name, scores: {}, run_by: 'independent', upstream_url: url };
    const extra: Record<string, unknown> = {};
    if (s && !estimated) {
      row.scores[scoreId] = s.value;
      if (s.half !== undefined && s.half > 0) row.ci = { [scoreId]: [Number((s.value - s.half).toFixed(2)), Number((s.value + s.half).toFixed(2))] };
    } else if (s && estimated) extra['estimated_accuracy'] = `${s.value}% (MathArena's estimate for questions it did not run)`;
    const usd = cost >= 0 ? dollars(r.cells[cost]?.text ?? '') : undefined;
    if (usd !== undefined && usd > 0 && !estimated) {
      row.scores[costId] = usd;
      hasCost = true;
    }
    if (!Object.keys(row.scores).length && !Object.keys(extra).length) continue;
    if (flagged) extra['released_after_competition'] = true;
    if (r.attrs['data-config']) extra['matharena_config'] = r.attrs['data-config'];
    if (provider >= 0 && r.cells[provider]?.text) extra['provider'] = r.cells[provider]!.text;
    if (open >= 0 && r.cells[open]?.text) extra['open_weights'] = /✅|yes/i.test(r.cells[open]!.text);
    if (Object.keys(extra).length) row.extra = extra;
    if (Object.keys(row.scores).length) rows.push(orderRow(row));
  }
  const set = setOf(c.id);
  const metrics: Metric[] = [];
  if (rows.some((r) => scoreId in r.scores)) {
    metrics.push({
      id: scoreId,
      label: `MathArena ${c.label}${scoreName === 'score' ? ' score' : ''}`,
      direction: 'higher',
      unit: scoreName === 'score' ? 'score' : 'percent',
      headline: c.headline,
      tags: ['math'],
      family: `matharena-${FAMILY[set] ?? set.replaceAll('_', '-')}`,
      url,
      description: `${scoreName === 'score' ? 'Score' : 'Accuracy'} on ${c.label}, run by MathArena, with its 95% interval. Models released after the competition are flagged in the row's details.`,
    });
  }
  if (hasCost) metrics.push({ id: costId, label: `MathArena ${c.label} cost per problem ($)`, direction: 'lower', unit: 'USD', headline: false, tags: ['math'], url, description: 'Cost of one model run on one problem, in US dollars.' });
  if (!rows.length && table.rows.length) problems.push(`MathArena ${c.id}: ${table.rows.length} rows but no readable scores`);
  return { rows, metrics, problems };
}

const matharena: Plugin = async ({ source, previous, force }) => {
  const home = String(source.fetch ?? `${BASE}/`);
  const page = await (await fetchOk(home)).text();
  const comps = competitionsFrom(page);
  if (!comps.length) return { rows: [], metrics: [], problems: ['the home page lists no competitions; the reader needs updating'] };
  const build = /\?v=(\d+)/.exec(page)?.[1] ?? '';
  const revision = `matharena:${build}:${comps.length}`;
  if (!force && previous?.upstream_revision === revision) return 'unchanged';

  const rows: Row[] = [];
  const metrics: Metric[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const noTable: string[] = [];
  for (const c of comps) {
    try {
      const doc = await (await fetchOk(`${BASE}/competition_tables/${encodeURIComponent(c.id)}`)).json();
      const out = competitionRows(c, doc);
      if (!out.metrics.length) noTable.push(c.id);
      rows.push(...out.rows);
      metrics.push(...out.metrics);
      problems.push(...out.problems);
    } catch (e) {
      warnings.push(`${c.id}: ${(e as Error).message}`);
    }
  }
  if (noTable.length) warnings.push(`competitions with no score table, left out: ${noTable.join(', ')}`);
  if (warnings.length > comps.length / 4) problems.push(`${warnings.length} of ${comps.length} competitions could not be read`);
  const result: ExtractResult = { revision, rows, metrics, problems, ...(warnings.length && { warnings }) };
  return result;
};

export default matharena;
