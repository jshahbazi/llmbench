/** Formatting shared by the build (static pages) and the browser (explorer). */

export const RUN_BY_LABELS = ['independent', 'submitted', 'lab-reported'] as const;

/** A score as shown in a table. Fractions and percentages are shown as percentages. */
export function fmt(value: number, unit: string): string {
  if (unit === 'fraction') return (value * 100).toFixed(1);
  if (unit === 'percent') return value.toFixed(1);
  if (unit === 'elo' || Math.abs(value) >= 100) return String(Math.round(value));
  return String(Number(value.toFixed(2)));
}

export const unitSuffix = (unit: string): string => (unit === 'fraction' || unit === 'percent' ? '%' : '');

/** Words for a unit, for column descriptions. */
export function unitWords(unit: string): string {
  if (unit === 'fraction' || unit === 'percent') return 'percent';
  if (unit === 'elo') return 'Elo-style rating';
  return unit === 'score' ? 'score' : unit;
}

/** Only http(s) links are ever rendered. */
export function safeUrl(u: unknown): string | null {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}

/** Lowercase letters, digits and dashes. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

/** "70B" or "235B-A22B" for mixture-of-experts models. */
export function paramsLabel(total?: number, active?: number): string {
  if (!total) return '';
  const n = (x: number) => (x >= 10 ? String(Math.round(x)) : String(Number(x.toFixed(1))));
  return active && active !== total ? `${n(total)}B-A${n(active)}B` : `${n(total)}B`;
}

const PERMISSIVE = /(^|[^a-z])(apache|mit|bsd|isc|mpl|unlicense|cc-by-4)/i;

/**
 * Standard permissive licences (Apache, MIT, BSD and similar). Custom model licences such as Llama's
 * or Gemma's terms are not counted, even where they allow commercial use.
 */
export function isPermissive(license?: string): boolean {
  return !!license && PERMISSIVE.test(license) && !isNonCommercial(license);
}

const isNonCommercial = (license: string) => /(^|[^a-z])nc([^a-z]|$)|non-?commercial/i.test(license);

/** How a source's data may be reused, from the licence sources.yaml records for it. */
export type DataReuse = 'licensed' | 'noncommercial' | 'unstated';

export function dataReuse(license?: string): DataReuse {
  if (!license || /^(none|none stated|no licen[cs]e|not stated|unknown)$/i.test(license.trim())) return 'unstated';
  return isNonCommercial(license) ? 'noncommercial' : 'licensed';
}

export const REUSE_TEXT: Record<DataReuse, string> = {
  licensed: 'Reusable under its licence.',
  noncommercial: 'Non-commercial: these scores may be reused only for non-commercial purposes, with credit.',
  unstated: 'No licence stated: the scores are reproduced as factual results, with credit to the source.',
};
