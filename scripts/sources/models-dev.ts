/**
 * models.dev (MIT, github.com/anomalyco/models.dev): an open database of AI models, updated most
 * days. Its models.json describes each model apart from where it is served: name, maker, release
 * date, open weights, licence, context window and links to the weights. A catalogue feed: it adds
 * models and fills in fields, and has no scores.
 *
 * Kept: text-in, text-out models with no specialised type (image, speech, embedding, reranking...).
 * Maker names come from api.json, where a lab that serves its own models is also a provider.
 */
import { licenseId } from '../lib/catalog.ts';
import { fetchJson, fetchOk } from '../lib/http.ts';
import { slugifyModel } from '../lib/match.ts';
import type { CatalogModel, Plugin } from '../lib/types.ts';

export interface MdModel {
  id: string;
  name: string;
  type?: string;
  release_date?: string;
  open_weights?: boolean;
  license?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  weights?: Array<{ label?: string; url?: string }>;
}

const MODELS_URL = 'https://models.dev/models.json';
const API_URL = 'https://models.dev/api.json';

const isText = (m: MdModel) => !m.type && (m.modalities?.input ?? []).includes('text') && (m.modalities?.output ?? []).includes('text');

/** The lab's name as a provider in api.json, else its id ("thinkingmachines"). */
const labName = (lab: string, names: ReadonlyMap<string, string>) => names.get(lab) ?? names.get(`${lab}-ai`) ?? lab;

export function catalogFrom(doc: Record<string, MdModel>, labNames: ReadonlyMap<string, string>): CatalogModel[] {
  const out = new Map<string, CatalogModel>();
  for (const [key, m] of Object.entries(doc)) {
    if (!isText(m) || !m.name) continue;
    const slash = key.indexOf('/');
    const lab = slash > 0 ? key.slice(0, slash) : '';
    const id = slugifyModel(slash > 0 ? key.slice(slash + 1) : key);
    if (!id || out.has(id)) continue; // two labs with one model id: the first (in key order) is kept
    const repo = m.weights?.map((w) => w.url).find((u) => u && /^https:\/\/huggingface\.co\/[^/]+\/[^/?#]+/.test(u));
    const license = licenseId(m.license);
    const context = m.limit?.context;
    out.set(id, {
      id,
      // A few names are written like ids with a maker ("X-Ai/Grok-4-Fast-Reasoning").
      name: m.name.slice(m.name.lastIndexOf('/') + 1).trim(),
      category: 'llm',
      origin: 'models-dev',
      ...(lab && { provider: labName(lab, labNames) }),
      ...(m.release_date && /^\d{4}-\d{2}/.test(m.release_date) && { released: m.release_date }),
      ...(typeof m.open_weights === 'boolean' && { open_weights: m.open_weights }),
      ...(license && { license }),
      ...(typeof context === 'number' && context > 0 && { context_k: context / 1000 }),
      ...(repo && { model_repo: repo }),
    });
  }
  return [...out.values()];
}

const modelsDev: Plugin = async ({ source, previous, cache, force }) => {
  const headers: Record<string, string> = {};
  if (!force && previous && cache?.etag) headers['if-none-match'] = cache.etag;
  const res = await fetchOk(source.fetch ?? MODELS_URL, { headers });
  if (res.status === 304) return 'unchanged';
  const doc = (await res.json()) as Record<string, MdModel>;
  const providers = await fetchJson<Record<string, { name?: string }>>(String(source.options['providers'] ?? API_URL));
  const labNames = new Map(Object.entries(providers).flatMap(([id, p]) => (p.name ? [[id, p.name] as const] : [])));
  const catalog = catalogFrom(doc, labNames);
  const warnings = catalog.length < Object.keys(doc).length / 4 ? [`only ${catalog.length} of ${Object.keys(doc).length} models are text models`] : undefined;
  return { etag: res.headers.get('etag') ?? undefined, rows: [], metrics: [], catalog, ...(warnings && { warnings }) };
};

export default modelsDev;
