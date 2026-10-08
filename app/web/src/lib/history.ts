// History rules, as pure functions: how each event reads (label, tone and a
// symbol, so colour is never the only signal), grouping by local day,
// filters, run counts and duration, and where Restore… and Open in Compare go.
import type { HistoryEvent, HistoryType, RunRecord } from '../../../shared/sync-api';
import type { Tone } from '../components/ui/Badge';

export interface EventInfo {
  label: string;
  tone: Tone;
  symbol: string;
}

export function eventInfo(e: HistoryEvent): EventInfo {
  switch (e.type) {
    case 'snapshot': return { label: 'Snapshot', tone: 'accent', symbol: '◉' };
    case 'backup': return { label: 'Backup', tone: 'neutral', symbol: '⧉' };
    case 'changeset': return { label: 'Changeset saved', tone: 'neutral', symbol: '≡' };
    case 'drift': return { label: 'Drift detected', tone: 'drift', symbol: '!' };
    case 'applied':
      if (e.status === 'failed') return { label: 'Failed', tone: 'danger', symbol: '×' };
      if (e.status === 'cancelled') return { label: 'Stopped', tone: 'danger', symbol: '■' };
      if (e.status === 'partial') return { label: 'Partly applied', tone: 'drift', symbol: '◐' };
      return { label: 'Applied', tone: 'added', symbol: '✓' };
    case 'restore':
      if (e.status === 'failed') return { label: 'Restore failed', tone: 'danger', symbol: '×' };
      if (e.status === 'partial' || e.status === 'cancelled') return { label: 'Partly restored', tone: 'drift', symbol: '◐' };
      return { label: 'Restored', tone: 'changed', symbol: '↺' };
    default: return { label: 'Project', tone: 'neutral', symbol: '•' };
  }
}

// The type filter's choices (in timeline order of importance).
export const TYPE_FILTERS: Array<{ value: HistoryType; label: string }> = [
  { value: 'snapshot', label: 'Snapshots' },
  { value: 'drift', label: 'Drift' },
  { value: 'changeset', label: 'Changesets' },
  { value: 'applied', label: 'Promotions' },
  { value: 'backup', label: 'Backups' },
  { value: 'restore', label: 'Restores' },
  { value: 'project', label: 'Project changes' },
];

export interface HistoryFilter {
  env: string | null;
  type: string | null;
}

export const filterEvents = (events: HistoryEvent[], f: HistoryFilter): HistoryEvent[] => events.filter((e) => (
  (!f.env || e.env === f.env) && (!f.type || e.type === f.type)
));

export interface DayGroup {
  key: string;
  // "Today", "Yesterday" or the date.
  label: string;
  date: string;
  events: HistoryEvent[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateLabel = (d: Date) => d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

// Newest first, by the viewer's local day.
export function groupByDay(events: HistoryEvent[], now: Date = new Date()): DayGroup[] {
  const today = dayKey(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y);
  const sorted = [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const groups: DayGroup[] = [];
  for (const e of sorted) {
    const d = new Date(e.at);
    const key = Number.isNaN(d.getTime()) ? 'unknown' : dayKey(d);
    let g = groups.at(-1);
    if (!g || g.key !== key) {
      const date = key === 'unknown' ? 'Unknown date' : dateLabel(d);
      g = { key, date, label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : date, events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups;
}

// The event a `?commit=` points at: the commit's own entry rather than its
// drift companion.
export function eventForCommit(events: HistoryEvent[], commit: string): HistoryEvent | undefined {
  const hits = events.filter((e) => e.commit === commit || (commit.length >= 4 && e.commit.startsWith(commit)));
  return hits.find((e) => e.type !== 'drift') ?? hits[0];
}

export interface RestoreTarget {
  commit: string;
  env: string;
}

// A backup or snapshot restores itself; an apply or restore run restores the
// backup it took first.
export function restoreTargetFor(e: HistoryEvent, run: RunRecord | null): RestoreTarget | null {
  if ((e.type === 'backup' || e.type === 'snapshot') && e.env) return { commit: e.commit, env: e.env };
  if ((e.type === 'applied' || e.type === 'restore') && run?.backupCommit) return { commit: run.backupCommit, env: run.to };
  return null;
}

export function compareHrefFor(p: string, e: HistoryEvent, run: RunRecord | null): string | null {
  const base = `/p/${encodeURIComponent(p)}/compare`;
  const q = (params: Record<string, string>) => `${base}?${new URLSearchParams(params).toString()}`;
  if (run && run.from !== run.to) return q({ from: run.from, to: run.to });
  if (!e.env) return null;
  if (e.type === 'drift' || e.type === 'applied' || e.type === 'restore' || e.type === 'backup') return q({ to: e.env });
  return q({ from: e.env });
}

export interface RunCounts {
  selected: number;
  done: number;
  failed: number;
  skipped: number;
}

export function runCounts(run: RunRecord): RunCounts {
  const count = (s: string) => run.items.filter((i) => i.status === s).length;
  return { selected: run.selection.length, done: count('done'), failed: count('failed'), skipped: count('skipped') };
}

export function runDuration(run: RunRecord): string | null {
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Environment values a run used, flattened for display.
export function runValues(run: RunRecord): Array<{ key: string; path: string; value: unknown }> {
  return Object.entries(run.values ?? {}).flatMap(([key, paths]) => Object.entries(paths ?? {}).map(([path, value]) => ({ key, path, value })));
}
