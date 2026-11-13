/** Choosing what a cell shows, and CSV output. Shared by the explorer and the static pages. */
import type { HistoryEntry } from './types.ts';

export interface Candidate {
  value: number;
  runBy: number;
  date: string;
  context: string;
  url: string | null;
  interval: string;
  rawName: string;
  source: string;
  history: HistoryEntry[] | null;
}

const better = (a: number, b: number, dir: 'higher' | 'lower') => (dir === 'lower' ? a < b : a > b);

/**
 * The headline score in a cell: the best value by the column's direction among candidates whose
 * run-by is included, ties going to the newest date. `n` counts the included candidates.
 */
export function pickBest(list: readonly Candidate[], dir: 'higher' | 'lower', runBy: ReadonlySet<number>): { best: Candidate; n: number } | null {
  let best: Candidate | null = null;
  let n = 0;
  for (const c of list) {
    if (!runBy.has(c.runBy)) continue;
    n++;
    if (!best || better(c.value, best.value, dir) || (c.value === best.value && c.date > best.date)) best = c;
  }
  return best ? { best, n } : null;
}

/** 1-based competition ranks ("1, 2, 2, 4") for values in a column. */
export function ranks(values: readonly number[], dir: 'higher' | 'lower'): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => (dir === 'lower' ? a[0] - b[0] : b[0] - a[0]));
  const out = new Array<number>(values.length);
  order.forEach(([v, i], k) => {
    const prev = order[k - 1];
    out[i] = k > 0 && prev && prev[0] === v ? out[prev[1]]! : k + 1;
  });
  return out;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
