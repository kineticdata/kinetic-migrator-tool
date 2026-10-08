// ApplyChecklist: the apply as a live checklist, grouped by phase in the
// order the apply runs (the backup first). Driven by the job's streamed step
// and item events; each row says its status in words as well as with an icon.
import type { ReactNode } from 'react';
import { CheckCircle2, Circle, MinusCircle, XCircle } from 'lucide-react';
import type { PlanItemOut } from '../../../shared/sync-api';
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
        {message && <span className="mt-0.5 block text-[13px] text-danger">{message}</span>}
      </span>
      <span className={cn('shrink-0 text-xs font-medium', s.text)}>{s.word}</span>
    </li>
  );
}

function Group({ title, done, total, children }: { title: string; done: number; total: number; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between border-y border-border bg-surface-2/60 px-4 py-1.5 first:border-t-0">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
        <span className="text-xs text-subtle tabular-nums">{done} of {total}</span>
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

export interface ApplyChecklistProps {
  to: string;
  groups: Array<Phase & { items: PlanItemOut[] }>;
  state: ChecklistState;
  // Items the finished job never reached were already as wanted.
  finished: boolean;
}

export function ApplyChecklist({ to, groups, state, finished }: ApplyChecklistProps) {
  const statusOf = (key: string): StepStatus => state.items[key]?.status ?? (finished ? 'skipped' : 'pending');
  const settled = (s: StepStatus) => s === 'done' || s === 'skipped';
  return (
    <section aria-label="Progress" className="overflow-hidden rounded-xl border border-border bg-surface">
      <Group title="Backup" done={settled(state.backup) ? 1 : 0} total={1}>
        <Row label={`Backup of ${envLabel(to)}`} status={state.backup} />
      </Group>
      {groups.map((g) => (
        <Group key={g.id} title={g.label} done={g.items.filter((i) => settled(statusOf(i.key))).length} total={g.items.length}>
          {g.items.map((i) => (
            <Row key={i.key} label={i.label} sub={i.key} status={statusOf(i.key)} message={state.items[i.key]?.message} />
          ))}
        </Group>
      ))}
    </section>
  );
}
