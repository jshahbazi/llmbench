/**
 * Task tags group metrics for the explorer's presets. whatmodel's task groupings supply most of them;
 * sources.yaml adds the rest with `tags:`, either a list (every metric of the source) or a mapping
 * from metric id, or a glob such as "webdev/*", to a list.
 */
import { globToRegExp } from './http.ts';
import type { Metric } from './types.ts';

export const TAGS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'coding', label: 'Coding' },
  { id: 'agents', label: 'Agents & tools' },
  { id: 'math', label: 'Math' },
  { id: 'knowledge', label: 'Knowledge & reasoning' },
  { id: 'chat', label: 'Chat & writing' },
  { id: 'vision', label: 'Vision & documents' },
  { id: 'search', label: 'Web search' },
];
const KNOWN = new Set(TAGS.map((t) => t.id));

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);

/** Checks a source's `tags` option. Returns problems as messages. */
export function checkTags(option: unknown, where: string): string[] {
  if (option === undefined) return [];
  const values = Array.isArray(option) || typeof option === 'string' ? list(option) : option && typeof option === 'object' ? Object.values(option).flatMap(list) : null;
  if (!values) return [`${where}: "tags" must be a list or a mapping of metric to list`];
  return values.filter((t) => !KNOWN.has(t)).map((t) => `${where}: unknown tag "${t}" (known: ${[...KNOWN].join(', ')})`);
}

/** Adds the tags from a source's option to its metrics, keeping tags a plugin already set. */
export function applyTags(metrics: Metric[], option: unknown): Metric[] {
  if (option === undefined) return metrics;
  const rules: Array<[RegExp, string[]]> =
    Array.isArray(option) || typeof option === 'string'
      ? [[/^/, list(option)]]
      : Object.entries(option as Record<string, unknown>).map(([pattern, tags]) => [globToRegExp(pattern), list(tags)]);
  return metrics.map((m) => {
    const add = rules.filter(([re]) => re.test(m.id)).flatMap(([, tags]) => tags);
    if (!add.length) return m;
    const tags = [...new Set([...(m.tags ?? []), ...add])].sort();
    return { ...m, tags };
  });
}

/**
 * Display settings from sources.yaml applied at build time, so editing them takes effect on the next
 * build without re-reading the source: `labels`, `headline` and `tags`.
 */
export function presentMetrics(metrics: Metric[], options: Record<string, unknown>): Metric[] {
  const labels = options['labels'] && typeof options['labels'] === 'object' && !Array.isArray(options['labels']) ? (options['labels'] as Record<string, unknown>) : {};
  const headline = options['headline'] === undefined ? undefined : new Set(list(options['headline']));
  const shown = metrics.map((m) => ({
    ...m,
    ...(labels[m.id] !== undefined && { label: String(labels[m.id]) }),
    ...(headline && { headline: headline.has(m.id) }),
  }));
  return applyTags(shown, options['tags']);
}
