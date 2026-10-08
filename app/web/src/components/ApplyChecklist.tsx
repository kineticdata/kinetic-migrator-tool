// ApplyChecklist: the apply as a live checklist, grouped by phase in the
// order the apply runs (the backup first). Driven by the job's streamed step
// and item events; each row says its status in words as well as with an icon.
import type { ReactNode } from 'react';
import { CheckCircle2, Circle, MinusCircle, XCircle } from 'lucide-react';
import { envLabel } from '../lib/format';
import type { ChecklistState, Phase, StepStatus } from '../lib/plan';
import { Spinner } from './ui/Spinner';
import { cn } from './ui/cn';

const STATUS: Record<StepStatus, { word: string; icon: ReactNode; text: string }> = {
  pending: { word: 'Pending', icon: <Circle size={16} aria-hidden className="text-border-strong" />, text: 'text-subtle' },
  running: { word: 'Running', icon: <Spinner size={16} className="text-accent" />, text: 'text-accent' },
  done: { word: 'Done', icon: <CheckCircle2 size={16} aria-hidden className="text-added" />, text: 'text-added' },
  failed: { word: 'Failed', icon: <XCircle size={16} aria-hidden className="text-danger" />, text: 'text-danger' },
  skipped: { word: 'Skipped', icon: <MinusCircle size={16} aria-hidden className="text-removed" />, text: 'text-removed' },
};

function Row({ label, sub, status, message }: { label: string; sub?: string; status: StepStatus; message?: string }) {
  const s = STATUS[status];
  return (
    <li
      aria-label={`${label}: ${s.word}${message ? ` — ${message}` : ''}`}
      className={cn('flex items-start gap-3 px-4 py-2.5', status === 'running' && 'bg-accent-soft/40', status === 'failed' && 'bg-danger-soft/60')}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{s.icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm', status === 'pending' ? 'text-muted' : 'text-fg')}>{label}</span>
        {sub && <span className="block truncate font-mono text-[11px] text-subtle" title={sub}>{sub}</span>}
        {message && <span className={cn('mt-0.5 block text-[13px]', status === 'failed' ? 'text-danger' : 'text-muted')}>{message}</span>}
      </span>
      <span className={cn('shrink-0 text-xs font-medium', s.text)}>{s.word}</span>
    </li>
  );
}

function Group({ title, done, total, danger, children }: { title: string; done: number; total: number; danger?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className={cn('flex items-center justify-between border-y border-border px-4 py-1.5 first:border-t-0', danger ? 'bg-danger-soft' : 'bg-surface-2/60')}>
        <h3 className={cn('text-xs font-semibold tracking-wide uppercase', danger ? 'text-danger' : 'text-muted')}>{title}</h3>
        <span className="text-xs text-subtle tabular-nums">{done} of {total}</span>
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

// A checklist row: `sub` defaults to the key.
export interface ChecklistRow {
  key: string;
  label: string;
  sub?: string;
}

export interface ApplyChecklistProps {
  to: string;
  // Phases in apply order; removals (if any) come last, in red.
  groups: Array<Phase & { items: ChecklistRow[]; danger?: boolean }>;
  // Settled by the page once the job ends (no row is left running).
  state: ChecklistState;
}

export function ApplyChecklist({ to, groups, state }: ApplyChecklistProps) {
  const statusOf = (key: string): StepStatus => state.items[key]?.status ?? 'pending';
  const settled = (s: StepStatus) => s === 'done' || s === 'skipped';
  const total = 1 + groups.reduce((n, g) => n + g.items.length, 0);
  const done = (settled(state.backup) ? 1 : 0) + groups.reduce((n, g) => n + g.items.filter((i) => settled(statusOf(i.key))).length, 0);
  return (
    <section aria-label="Progress" className="overflow-hidden rounded-xl border border-border bg-surface">
      <p role="status" aria-live="polite" className="flex items-center justify-between gap-3 px-4 py-2 text-[13px] text-muted">
        <span>Steps</span>
        <span className="tabular-nums">{done} of {total} done</span>
      </p>
      <Group title="Backup" done={settled(state.backup) ? 1 : 0} total={1}>
        <Row label={`Backup of ${envLabel(to)}`} status={state.backup} />
      </Group>
      {groups.map((g) => (
        <Group key={g.id} title={g.label} danger={g.danger} done={g.items.filter((i) => settled(statusOf(i.key))).length} total={g.items.length}>
          {g.items.map((i) => (
            <Row key={i.key} label={i.label} sub={i.sub ?? i.key} status={statusOf(i.key)} message={state.items[i.key]?.message} />
          ))}
        </Group>
      ))}
    </section>
  );
}
