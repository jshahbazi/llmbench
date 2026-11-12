/**
 * Guards decide whether a run's data is trusted enough to publish. Any reason returned holds the
 * run: nothing is written, the last good data stays published, and an issue is opened.
 */
import { looksNumeric } from './extract.ts';
import type { DiffStats } from './diff.ts';
import type { Row } from './types.ts';

export interface GuardInput {
  prevRows: readonly Row[];
  nextRows: readonly Row[];
  stats: DiffStats;
  problems: readonly string[];
  /** Fewest rows a good run can have. */
  minRows: number;
  rolling: boolean;
}

/** Share of a metric's values that are numbers, per metric. */
function numericShare(rows: readonly Row[]): Map<string, { numeric: number; total: number }> {
  const out = new Map<string, { numeric: number; total: number }>();
  for (const r of rows) {
    for (const [m, v] of Object.entries(r.scores)) {
      const s = out.get(m) ?? { numeric: 0, total: 0 };
      s.total++;
      if (looksNumeric(v)) s.numeric++;
      out.set(m, s);
    }
  }
  return out;
}

export function checkGuards(g: GuardInput): string[] {
  const reasons: string[] = [...g.problems];
  const n = g.nextRows.length;
  const prev = g.prevRows.length;

  if (n < g.minRows) reasons.push(`row drop: ${n} rows, fewer than the minimum of ${g.minRows}`);
  else if (prev >= 10 && n < prev / 2) reasons.push(`row drop: ${n} rows, under half of the previous ${prev}`);

  if (!g.rolling && g.stats.prevCells >= 20 && g.stats.changed / g.stats.prevCells > 0.2) {
    const pct = Math.round((100 * g.stats.changed) / g.stats.prevCells);
    reasons.push(`mass change: ${g.stats.changed} of ${g.stats.prevCells} existing scores (${pct}%) changed at once`);
  }

  const before = numericShare(g.prevRows);
  for (const [m, s] of numericShare(g.nextRows)) {
    const b = before.get(m);
    if (b && b.total >= 5 && b.numeric / b.total >= 0.9 && s.numeric / s.total < 0.5) {
      reasons.push(`type flip: "${m}" was numeric and is now mostly not (${s.numeric} of ${s.total})`);
    }
  }
  return reasons;
}
