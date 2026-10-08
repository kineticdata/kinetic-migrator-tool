// NeedsAttention: what this apply does that deserves a second look (handler
// installs, index rebuilds, reference data that runs workflows, connections
// without credentials, overwritten drift, other preflight warnings). Each
// entry is ticked on its own; nothing is ticked for the user.
import type { ReactNode } from 'react';
import { AlertTriangle, Database, KeyRound, ListRestart, Package, Workflow } from 'lucide-react';
import type { AttentionEntry } from '../lib/plan';
import { cn } from './ui/cn';

const KIND: Record<AttentionEntry['kind'], { label: string; icon: ReactNode }> = {
  handler: { label: 'Handler', icon: <Package size={15} aria-hidden /> },
  'handler-settings': { label: 'Handler settings', icon: <KeyRound size={15} aria-hidden /> },
  index: { label: 'Index rebuild', icon: <ListRestart size={15} aria-hidden /> },
  'data-workflows': { label: 'Runs workflows', icon: <Workflow size={15} aria-hidden /> },
  'connection-secrets': { label: 'Credentials', icon: <KeyRound size={15} aria-hidden /> },
  drift: { label: 'Overwrites changes', icon: <AlertTriangle size={15} aria-hidden /> },
  warning: { label: 'Preflight', icon: <Database size={15} aria-hidden /> },
};

// `filled` holds environment values filled in: entries they take care of are
// shown as done without a tick.
export function NeedsAttention({ entries, ticked, filled, onToggle }: {
  entries: AttentionEntry[]; ticked: ReadonlySet<string>; filled: ReadonlySet<string>; onToggle: (id: string) => void;
}) {
  const byValue = (e: AttentionEntry) => Boolean(e.valueId && filled.has(e.valueId));
  const count = entries.filter((e) => ticked.has(e.id) || byValue(e)).length;
  const all = count === entries.length;
  return (
    <section aria-label="Needs attention" className="overflow-hidden rounded-xl border border-drift/40 bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-drift/30 bg-drift-soft px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <AlertTriangle size={15} aria-hidden className="text-drift" />
          Needs attention
        </h3>
        <span className={cn('text-xs tabular-nums', all ? 'font-medium text-added' : 'text-muted')} aria-live="polite">
          {count} of {entries.length} done
        </span>
      </div>
      <ul className="divide-y divide-border">
        {entries.map((e) => {
          const auto = byValue(e);
          const on = ticked.has(e.id) || auto;
          const k = KIND[e.kind];
          return (
            <li key={e.id}>
              <label className={cn('flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60', on && 'bg-surface-2/40')}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={auto}
                  onChange={() => onToggle(e.id)}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm', on ? 'text-muted' : 'text-fg')}>{e.message}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
                    <span className="inline-flex items-center gap-1 text-muted">{k.icon}{k.label}</span>
                    {e.key && <span className="truncate font-mono text-[11px]" title={e.key}>{e.key}</span>}
                    {auto && <span className="font-medium text-added">Filled in under Environment values</span>}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
