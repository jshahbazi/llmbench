/** Minimal DOM helpers. Strings are always inserted as text, never parsed as HTML. */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'number' ? String(c) : c);
  return e;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
}

/** A link only when the URL is http(s); otherwise plain text. */
export function link(href: string | null, text: Child, attrs: Attrs = {}): HTMLElement {
  return href ? el('a', { href, ...attrs }, text) : el('span', {}, text);
}
