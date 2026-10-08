// CountBar: a comparison's totals per status, each a toggle that filters the
// tree to that status. RollupCounts: the compact per-node version shown at
// the end of parent rows ("+2 ~5 !1"). Colour is never the only signal: each
// count carries its symbol and a spoken label.
import type { CompareStatus } from '../../../shared/sync-api';
import { envLabel } from '../lib/format';
import { cn } from './ui/cn';

export const STATUS_ORDER: CompareStatus[] = ['new', 'changed', 'drifted', 'manual', 'only-target'];

const meta: Record<CompareStatus, { symbol: string; text: string; on: string }> = {
  new: { symbol: '+', text: 'text-added', on: 'bg-added-soft border-added/40' },
  changed: { symbol: '~', text: 'text-changed', on: 'bg-changed-soft border-changed/40' },
  drifted: { symbol: '⚠', text: 'text-drift', on: 'bg-drift-soft border-drift/40' },
  manual: { symbol: '•', text: 'text-muted', on: 'bg-surface-2 border-border-strong' },
  'only-target': { symbol: '−', text: 'text-removed', on: 'bg-removed-soft border-border-strong' },
  same: { symbol: '=', text: 'text-subtle', on: 'bg-surface-2 border-border-strong' },
};

export const statusSymbol = (s: CompareStatus) => meta[s].symbol;

export function statusWords(s: CompareStatus, to: string): string {
  switch (s) {
    case 'new': return 'new';
    case 'changed': return 'changed';
    case 'drifted': return 'drifted';
    case 'manual': return 'manual';
    case 'only-target': return `only in ${envLabel(to)}`;
    default: return 'same';
  }
}

export interface CountBarProps {
  counts: Partial<Record<CompareStatus, number>>;
  to: string;
  // The status the tree is filtered to, if any.
  active: CompareStatus | null;
  onToggle: (status: CompareStatus) => void;
}

export function CountBar({ counts, to, active, onToggle }: CountBarProps) {
  const shown = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0 || s === 'new' || s === 'changed');
  const total = STATUS_ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0);
  return (
    <div role="group" aria-label="Differences by status" className="flex flex-wrap items-center gap-1.5">
      {shown.map((s) => {
        const n = counts[s] ?? 0;
        const on = active === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            disabled={n === 0}
            onClick={() => onToggle(s)}
            title={on ? 'Show every status' : `Show only ${statusWords(s, to)} items`}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium transition-colors disabled:opacity-50',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              on ? meta[s].on : 'border-border bg-surface hover:bg-surface-2',
            )}
          >
            <span aria-hidden className={cn('font-mono font-semibold', meta[s].text)}>{meta[s].symbol}</span>
            <span className="tabular-nums text-fg">{n.toLocaleString('en')}</span>{' '}
            <span className="text-muted">{statusWords(s, to)}</span>
          </button>
        );
      })}
      {total === 0 && <span className="text-sm text-muted">No differences</span>}
    </div>
  );
}

export function RollupCounts({ counts, to }: { counts: Partial<Record<CompareStatus, number>>; to: string }) {
  const parts = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  if (!parts.length) return null;
  const spoken = parts.map((s) => `${counts[s]} ${statusWords(s, to)}`).join(', ');
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums" aria-label={spoken} title={spoken}>
      {parts.map((s) => (
        <span key={s} aria-hidden className={meta[s].text}>{meta[s].symbol}{counts[s]}</span>
      ))}
    </span>
  );
}

// A compact chip for an item row: symbol and a word.
export function ItemStatus({ status, to }: { status: CompareStatus; to: string }) {
  if (status === 'same') return <span className="text-[11px] text-subtle">same</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium', meta[status].on, meta[status].text)}>
      <span aria-hidden className="font-mono">{meta[status].symbol}</span>
      {statusWords(status, to)}
    </span>
  );
}
