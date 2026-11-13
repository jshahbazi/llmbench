/**
 * Epoch AI's database of AI models (CC BY 4.0, epoch.ai/data/ai-models): every notable model with
 * its developer, publication date, parameter count and how it can be used, updated daily. A
 * catalogue feed: it adds models and fills in fields, and has no scores (Epoch's benchmark runs are
 * the "epoch" source).
 *
 * Kept: language models that were released in some form ("Unreleased" ones are left out). Dates are
 * kept to the month: Epoch sets an unknown day to the 15th.
 */
import { slugifyModel } from '../lib/match.ts';
import { fetchOk } from '../lib/http.ts';
import { parseDelimited, tableToRecords, type Rec } from '../lib/parse.ts';
import type { CatalogModel, Plugin } from '../lib/types.ts';

const URL_ALL = 'https://epoch.ai/data/all_ai_models.csv';

const text = (r: Rec, k: string) => String(r[k] ?? '').trim();

/** Open weights from "Model accessibility": "Open weights (restricted use)" and so on. */
export function openWeights(access: string): boolean | undefined {
  if (/^open weights/i.test(access)) return true;
  if (/^(api access|hosted access|limited access)/i.test(access)) return false;
  return undefined;
}

export function catalogFrom(records: readonly Rec[]): { catalog: CatalogModel[]; problems: string[] } {
  const needed = ['Model', 'Domain', 'Organization', 'Publication date', 'Parameters', 'Model accessibility'];
  const missing = records.length ? needed.filter((k) => !(k in records[0]!)) : needed;
  if (missing.length) return { catalog: [], problems: [`missing columns: ${missing.join(', ')}`] };
  const out = new Map<string, CatalogModel>();
  for (const r of records) {
    const name = text(r, 'Model');
    const domains = text(r, 'Domain').split(',').map((d) => d.trim());
    const access = text(r, 'Model accessibility');
    if (!name || !domains.includes('Language') || /unreleased/i.test(access)) continue;
    const id = slugifyModel(name);
    if (!id || out.has(id)) continue;
    const date = /^(\d{4}-\d{2})/.exec(text(r, 'Publication date'))?.[1];
    const params = Number(text(r, 'Parameters'));
    const provider = text(r, 'Organization').split(',')[0]?.trim();
    const open = openWeights(access);
    out.set(id, {
      id,
      name,
      category: 'llm',
      origin: 'epoch-models',
      ...(provider && { provider }),
      ...(date && { released: date }),
      ...(open !== undefined && { open_weights: open }),
      ...(params > 0 && { params_b: Math.round(params / 1e7) / 100 }),
    });
  }
  return { catalog: [...out.values()], problems: [] };
}

const epochModels: Plugin = async ({ source, previous, cache, force }) => {
  const headers: Record<string, string> = {};
  if (!force && previous) {
    if (cache?.etag) headers['if-none-match'] = cache.etag;
    if (cache?.last_modified) headers['if-modified-since'] = cache.last_modified;
  }
  const res = await fetchOk(source.fetch ?? URL_ALL, { headers });
  if (res.status === 304) return 'unchanged';
  const { catalog, problems } = catalogFrom(tableToRecords(parseDelimited((await res.text()).replace(/^\uFEFF/, ''))));
  return {
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    rows: [],
    metrics: [],
    catalog,
    ...(problems.length && { problems }),
  };
};

export default epochModels;
