import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { RUN_BY, type RunBy, type SourceConfig } from './types.ts';

const KNOWN_KEYS = new Set([
  'id', 'name', 'homepage', 'terms', 'terms_note', 'fetch', 'plugin', 'license', 'attribution',
  'every', 'run_by',
]);

export class ConfigError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(entry: Record<string, unknown>, key: string, where: string, required: boolean): string | undefined {
  const v = entry[key];
  if (v === undefined || v === null) {
    if (required) throw new ConfigError(`${where}: missing "${key}"`);
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${where}: "${key}" must be a non-empty string`);
  return v.trim();
}

/** Parses and checks sources.yaml text. Throws ConfigError with every problem's location. */
export function parseSources(text: string): SourceConfig[] {
  const doc: unknown = parse(text);
  if (!isRecord(doc)) throw new ConfigError('sources.yaml: expected a mapping at the top level');
  const defaults = isRecord(doc['defaults']) ? doc['defaults'] : {};
  const list = doc['sources'];
  if (!Array.isArray(list)) throw new ConfigError('sources.yaml: "sources" must be a list');

  const seen = new Set<string>();
  const out: SourceConfig[] = [];
  list.forEach((entry: unknown, i: number) => {
    const where = `sources[${i}]`;
    if (!isRecord(entry)) throw new ConfigError(`${where}: expected a mapping`);
    const id = str(entry, 'id', where, true)!;
    const at = `source "${id}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ConfigError(`${at}: id must be lowercase letters, digits and dashes`);
    if (seen.has(id)) throw new ConfigError(`${at}: duplicate id`);
    seen.add(id);

    const terms = str(entry, 'terms', at, true);
    if (terms !== 'allowed' && terms !== 'blocked') throw new ConfigError(`${at}: terms must be "allowed" or "blocked"`);
    const allowed = terms === 'allowed';

    const fetch = str(entry, 'fetch', at, allowed);
    const plugin = str(entry, 'plugin', at, false);
    if (allowed && !plugin && entry['model'] === undefined) {
      throw new ConfigError(`${at}: needs either "model" (the model-name column) or "plugin"`);
    }
    if (plugin && !/^[a-z0-9-]+$/.test(plugin)) throw new ConfigError(`${at}: plugin must be a plain name`);

    const runBy = (entry['run_by'] ?? defaults['run_by'] ?? 'independent') as RunBy;
    if (!RUN_BY.includes(runBy)) throw new ConfigError(`${at}: run_by must be one of ${RUN_BY.join(', ')}`);
    const every = String(entry['every'] ?? defaults['every'] ?? '6h');
    if (!/^\d+[mhd]$/.test(every)) throw new ConfigError(`${at}: every must look like 30m, 6h or 1d`);

    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) if (!KNOWN_KEYS.has(k)) options[k] = v;

    out.push({
      id,
      name: str(entry, 'name', at, true)!,
      homepage: str(entry, 'homepage', at, true)!,
      terms,
      terms_note: str(entry, 'terms_note', at, false),
      fetch,
      plugin,
      license: str(entry, 'license', at, allowed),
      attribution: str(entry, 'attribution', at, false),
      every,
      run_by: runBy,
      options,
    });
  });
  return out;
}

/** "30m", "6h", "1d" in milliseconds. */
export function intervalMs(every: string): number {
  const m = /^(\d+)([mhd])$/.exec(every);
  if (!m) return 0;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

export async function loadSources(path = 'sources.yaml'): Promise<SourceConfig[]> {
  return parseSources(await readFile(path, 'utf8'));
}
