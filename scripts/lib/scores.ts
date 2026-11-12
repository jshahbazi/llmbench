/** Parses a score as the source wrote it: 0.873, "78.4%", "1,312", "1312 (+5/-4)". */
export function parseScore(v: string | number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(v);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
