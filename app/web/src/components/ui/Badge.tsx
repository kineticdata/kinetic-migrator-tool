// Badges and status chips. Colour is never the only signal: chips carry text
// and a symbol.
import type { ReactNode } from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'accent' | 'added' | 'changed' | 'removed' | 'drift' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent border-transparent',
  added: 'bg-added-soft text-added border-transparent',
  changed: 'bg-changed-soft text-changed border-transparent',
  removed: 'bg-removed-soft text-removed border-transparent',
  drift: 'bg-drift-soft text-drift border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
};

export function Badge({ tone = 'neutral', icon, children, className, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export type ItemStatus = 'new' | 'changed' | 'drifted' | 'manual' | 'only-target' | 'same' | 'error';

const statusInfo: Record<ItemStatus, { tone: Tone; symbol: string; label: string }> = {
  new: { tone: 'added', symbol: '+', label: 'New' },
  changed: { tone: 'changed', symbol: '~', label: 'Changed' },
  drifted: { tone: 'drift', symbol: '!', label: 'Drifted' },
  manual: { tone: 'neutral', symbol: '•', label: 'Manual' },
  'only-target': { tone: 'removed', symbol: '−', label: 'Only in target' },
  same: { tone: 'neutral', symbol: '=', label: 'Same' },
  error: { tone: 'danger', symbol: '×', label: 'Error' },
};

export function StatusChip({ status, count, className }: { status: ItemStatus; count?: number; className?: string }) {
  const s = statusInfo[status];
  return (
    <Badge tone={s.tone} className={className}>
      <span aria-hidden className="font-mono">{s.symbol}</span>
      {count !== undefined ? `${count.toLocaleString('en')} ${s.label.toLowerCase()}` : s.label}
    </Badge>
  );
}
