/**
 * Hugging Face: parameter counts and licences for open-weights models, from the Hub's public model
 * API (the safetensors header totals, and the model card's licence tag). A fill-only catalogue feed
 * (`catalog: fill`): it never adds a model, it only fills fields the other feeds left empty.
 *
 * Asked about: catalogue models that link to a Hugging Face repository and lack a parameter count or
 * a licence. Each repository is asked about once; the answer (even "nothing to add") is kept in
 * data/catalog/huggingface.jsonl, so a later run only asks about new models. Requests are spaced
 * out to stay inside the Hub's anonymous rate limit.
 */
import { licenseId } from '../lib/catalog.ts';
import { loadCatalog } from '../lib/curation.ts';
import { fetchOk } from '../lib/http.ts';
import { catalogPath, readJsonl } from '../lib/store.ts';
import type { CatalogModel, Plugin } from '../lib/types.ts';

export interface HfModelInfo {
  safetensors?: { parameters?: Record<string, number>; total?: number };
  cardData?: { license?: string | string[]; license_name?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "org/name" of a Hugging Face model repository link, or undefined. */
export function repoOf(url: string | undefined): string | undefined {
  const m = url && /^https?:\/\/huggingface\.co\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(url);
  return m && !['datasets', 'spaces'].includes(m[1]!) ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The fields the Hub's answer gives. Packed quantised weights (int32 or uint8 tensors, as GPTQ, AWQ
 * and bitsandbytes store them) undercount parameters, so those repositories give no count.
 */
export function fieldsFrom(info: HfModelInfo): Pick<CatalogModel, 'params_b' | 'license'> {
  const out: Pick<CatalogModel, 'params_b' | 'license'> = {};
  const st = info.safetensors;
  const packed = Object.keys(st?.parameters ?? {}).some((k) => /^(I32|U8|I8|U32)$/i.test(k));
  // Under 10M is a partial header (an adapter, or one shard listed), not a language model's size.
  if (st?.total && st.total >= 1e7 && !packed) out.params_b = Math.round(st.total / 1e7) / 100;
  const raw = Array.isArray(info.cardData?.license) ? info.cardData.license[0] : info.cardData?.license;
  const license = raw === 'other' ? (info.cardData?.license_name ?? 'other') : raw;
  const id = licenseId(license);
  if (id) out.license = id;
  return out;
}

const huggingface: Plugin = async ({ source, force }) => {
  const max = Number(source.options['max_lookups'] ?? 300);
  const delay = Number(source.options['delay_ms'] ?? 700);
  const catalog = await loadCatalog({ before: source.id });
  const previous = new Map((await readJsonl<CatalogModel>(catalogPath(source.id))).map((m) => [m.id, m]));

  const current = new Map(catalog.map((m) => [m.id, m]));
  const kept = [...previous.values()].filter((p) => current.get(p.id)?.model_repo === p.model_repo);
  const asked = new Set(kept.map((p) => p.id));
  const wanted = catalog.filter((m) => repoOf(m.model_repo) && (m.params_b === undefined || m.license === undefined) && (force || !asked.has(m.id)));
  if (!wanted.length && kept.length === previous.size) return 'unchanged';

  const answers = new Map(kept.map((p) => [p.id, p]));
  const warnings: string[] = [];
  let failed = 0;
  for (const [i, m] of wanted.slice(0, max).entries()) {
    if (i > 0) await sleep(delay);
    const repo = repoOf(m.model_repo)!;
    const entry: CatalogModel = { id: m.id, name: m.name, category: m.category, origin: source.id, model_repo: m.model_repo! };
    try {
      const res = await fetchOk(`https://huggingface.co/api/models/${repo}?expand%5B%5D=safetensors&expand%5B%5D=cardData`);
      answers.set(m.id, { ...entry, ...fieldsFrom((await res.json()) as HfModelInfo) });
    } catch (e) {
      const message = (e as Error).message;
      if (/HTTP (401|404)\b/.test(message)) {
        answers.set(m.id, entry); // gone or private: asked, nothing to add
      } else if (/HTTP 429\b/.test(message)) {
        warnings.push(`rate-limited after ${i} requests; the rest wait for the next run`);
        break;
      } else if (++failed >= 5) {
        warnings.push(`stopped after ${failed} failed requests (last: ${message})`);
        break;
      }
    }
  }
  if (wanted.length > max) warnings.push(`${wanted.length - max} models wait for the next run (at most ${max} requests a run)`);
  return { rows: [], metrics: [], catalog: [...answers.values()], ...(warnings.length && { warnings }) };
};

export default huggingface;
