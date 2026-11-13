/**
 * A tiny HTML template helper. Every interpolated value is escaped unless it is already Html, so
 * scraped strings can never become markup.
 */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export const raw = (s: string): Html => new Html(s);

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type Part = Html | string | number | boolean | null | undefined | readonly Part[];

function render(v: Part): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Html(out);
}

/** "../" repeated for a page this many folders below the site root. */
export const up = (depth: number): string => (depth ? '../'.repeat(depth) : './');
