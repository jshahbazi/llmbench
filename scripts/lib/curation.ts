/**
 * The hand-edited files in curation/, applied whenever names are matched or the site is built, so an
 * edit takes effect on the next run without re-reading any source:
 *
 *   curation/aliases.csv   source,raw_name,model_id[,note]: send a source's name for a model to a
 *                          catalogue model. source "*" applies to every source; model_id "-" keeps
 *                          the name from being matched at all.
 *   curation/models.yaml   models to add to the catalogue, or fields to correct on one already in it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { aliasMap, NO_MATCH, type Aliases } from './match.ts';
import { normalize } from './names.ts';
import { parseDelimited, tableToRecords, type Rec } from './parse.ts';
import { CATALOG_PATH, readJsonl } from './store.ts';
import type { CatalogModel } from './types.ts';

export const ALIASES_PATH = join('curation', 'aliases.csv');
export const MODELS_PATH = join('curation', 'models.yaml');

const MODEL_FIELDS: Record<string, 'string' | 'number' | 'boolean'> = {
  id: 'string',
  name: 'string',
  provider: 'string',
  released: 'string',
  open_weights: 'boolean',
  license: 'string',
  params_b: 'number',
  active_b: 'number',
  context_k: 'number',
  model_repo: 'string',
  note: 'string',
};

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Reads curation/models.yaml into entries, with every problem found. */
export function parseModelsYaml(text: string | undefined): { entries: Array<Partial<CatalogModel> & { id: string }>; problems: string[] } {
  const problems: string[] = [];
  const entries: Array<Partial<CatalogModel> & { id: string }> = [];
  if (!text) return { entries, problems };
  const doc: unknown = parse(text);
  if (doc === null || doc === undefined) return { entries, problems };
  if (!Array.isArray(doc)) return { entries, problems: [`${MODELS_PATH}: expected a list of models`] };
  const seen = new Set<string>();
  doc.forEach((e: unknown, i: number) => {
    const where = `${MODELS_PATH}[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return problems.push(`${where}: expected a mapping`);
    const entry = e as Record<string, unknown>;
    const id = entry['id'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) return problems.push(`${where}: "id" must be lower case letters, digits, "-" and "."`);
    if (seen.has(id)) problems.push(`${where}: "${id}" is listed twice`);
    seen.add(id);
    const out: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(entry)) {
      const type = MODEL_FIELDS[k];
      if (!type) {
        problems.push(`${where} (${id}): unknown field "${k}"`);
        continue;
      }
      // YAML reads "released: 2025-11" as text, but a full date as text too; numbers stay numbers.
      const value = type === 'string' && typeof v === 'number' ? String(v) : v;
      if (typeof value !== type) problems.push(`${where} (${id}): "${k}" must be a ${type}`);
      else if (k !== 'note') out[k] = value;
    }
    if (typeof out['released'] === 'string' && !/^\d{4}(-\d{2}){0,2}$/.test(out['released'])) problems.push(`${where} (${id}): "released" must look like 2025-11`);
    entries.push(out as Partial<CatalogModel> & { id: string });
    return undefined;
  });
  return { entries, problems };
}

/** The catalogue from data/catalog/models.jsonl with curation/models.yaml applied. */
export async function loadCatalog(): Promise<CatalogModel[]> {
  const base = await readJsonl<CatalogModel>(CATALOG_PATH);
  const { entries, problems } = parseModelsYaml(await readOptional(MODELS_PATH));
  if (problems.length) throw new Error(problems.join('\n'));
  return applyModels(base, entries);
}

export function applyModels(base: readonly CatalogModel[], entries: ReadonlyArray<Partial<CatalogModel> & { id: string }>): CatalogModel[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (existing) byId.set(e.id, { ...existing, ...e });
    else if (e.name) byId.set(e.id, { category: 'llm', origin: 'curation', ...e, name: e.name });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function readAliasRows(): Promise<Rec[]> {
  const text = await readOptional(ALIASES_PATH);
  return text ? tableToRecords(parseDelimited(text)) : [];
}

export async function loadAliases(): Promise<Aliases> {
  return aliasMap(await readAliasRows());
}

/** Problems in the curation files: unknown sources or models, duplicates, new models without names. */
export async function checkCuration(sourceIds: readonly string[]): Promise<string[]> {
  const base = await readJsonl<CatalogModel>(CATALOG_PATH);
  const { entries, problems } = parseModelsYaml(await readOptional(MODELS_PATH));
  const known = new Set(base.map((m) => m.id));
  const keys = new Map<string, string>();
  for (const m of base) for (const k of [normalize(m.id), normalize(m.name)]) keys.set(k, m.id);
  for (const e of entries) {
    if (known.has(e.id)) continue;
    if (!e.name) problems.push(`${MODELS_PATH}: new model "${e.id}" needs a "name"`);
    const same = keys.get(normalize(e.id)) ?? (e.name ? keys.get(normalize(e.name)) : undefined);
    if (same) problems.push(`${MODELS_PATH}: new model "${e.id}" looks like catalogue model "${same}"; correct that one instead`);
  }
  const ids = new Set(applyModels(base, entries).map((m) => m.id));
  const sources = new Set(sourceIds);
  const seen = new Set<string>();
  (await readAliasRows()).forEach((r, i) => {
    const where = `${ALIASES_PATH} line ${i + 2}`;
    const source = String(r['source'] ?? '').trim();
    const raw = String(r['raw_name'] ?? '');
    const id = String(r['model_id'] ?? '').trim();
    if (!source || !raw || !id) return problems.push(`${where}: needs source, raw_name and model_id`);
    if (source !== '*' && !sources.has(source)) problems.push(`${where}: no source "${source}" in sources.yaml`);
    if (id !== NO_MATCH && !ids.has(id)) problems.push(`${where}: no model "${id}" in the catalogue or ${MODELS_PATH}`);
    const k = `${source}\u0000${raw}`;
    if (seen.has(k)) problems.push(`${where}: "${raw}" is listed twice for ${source}`);
    seen.add(k);
    return undefined;
  });
  return problems;
}
