/**
 * Cell-level diff between a source's previous and new rows, producing history events.
 * A cell is (row key, metric). Values are compared as text, exactly as the source wrote them.
 */
import type { HistoryEvent, Row, Value } from './types.ts';

export interface DiffStats {
  prevCells: number;
  added: number;
  changed: number;
  removed: number;
  returned: number;
}

const cellId = (key: string, metric: string) => `${key}\u0000${metric}`;

/** What history already says about each cell: its last operation and when. */
export function historyIndex(events: readonly HistoryEvent[]): Map<string, { op: HistoryEvent['op']; t: string }> {
  const idx = new Map<string, { op: HistoryEvent['op']; t: string }>();
  for (const e of events) idx.set(cellId(e.key, e.metric), { op: e.op, t: e.t });
  return idx;
}

export interface DiffOptions {
  now: string;
  rev?: string;
  history: Map<string, { op: HistoryEvent['op']; t: string }>;
  /**
   * Rating-style sources move every update by design. A change is recorded at most once per this
   * many days per cell; rows.jsonl still holds the latest value.
   */
  rollingDays?: number;
  /** When rolling, the time the source's baseline was taken (cells with no event date from then). */
  baselineAt?: string;
}

export function diffRows(prev: readonly Row[], next: readonly Row[], opts: DiffOptions): { events: HistoryEvent[]; stats: DiffStats } {
  const before = new Map<string, { row: Row; value: Value; metric: string }>();
  for (const row of prev) for (const [metric, value] of Object.entries(row.scores)) before.set(cellId(row.key, metric), { row, value, metric });

  const events: HistoryEvent[] = [];
  const stats: DiffStats = { prevCells: before.size, added: 0, changed: 0, removed: 0, returned: 0 };
  const ev = (row: Row, metric: string, op: HistoryEvent['op'], from?: Value, to?: Value): HistoryEvent => ({
    t: opts.now,
    key: row.key,
    model: row.model,
    metric,
    op,
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(opts.rev && { rev: opts.rev }),
  });
  const rollingCutoff =
    opts.rollingDays !== undefined ? new Date(Date.parse(opts.now) - opts.rollingDays * 86_400_000).toISOString() : undefined;

  const seen = new Set<string>();
  for (const row of next) {
    for (const [metric, value] of Object.entries(row.scores)) {
      const id = cellId(row.key, metric);
      seen.add(id);
      const old = before.get(id);
      if (!old) {
        const returned = opts.history.get(id)?.op === 'remove';
        events.push(ev(row, metric, returned ? 'return' : 'add', undefined, value));
        if (returned) stats.returned++;
        else stats.added++;
      } else if (String(old.value) !== String(value)) {
        stats.changed++;
        if (rollingCutoff) {
          const last = opts.history.get(id)?.t ?? opts.baselineAt ?? '';
          if (last > rollingCutoff) continue;
        }
        events.push(ev(row, metric, 'change', old.value, value));
      }
    }
  }
  for (const [id, old] of before) {
    if (seen.has(id)) continue;
    stats.removed++;
    events.push(ev(old.row, old.metric, 'remove', old.value, undefined));
  }
  return { events, stats };
}
