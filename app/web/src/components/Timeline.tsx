// Timeline: history events grouped by day, newest first. Each entry is a
// toggle button (aria-pressed marks the open one) with a labelled badge, the
// plain title, the environment, the time and who did it.
import type { HistoryEvent } from '../../../shared/sync-api';
import { envLabel } from '../lib/format';
import { eventInfo, groupByDay } from '../lib/history';
import { Badge } from './ui/Badge';
import { cn } from './ui/cn';

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
};

export function Timeline({ events, selectedId, onSelect, now }: {
  events: HistoryEvent[];
  selectedId: string | null;
  onSelect: (e: HistoryEvent) => void;
  now?: Date;
}) {
  const groups = groupByDay(events, now);
  return (
    <ol aria-label="Timeline" className="space-y-6">
      {groups.map((g) => (
        <li key={g.key}>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            {g.label === g.date ? g.date : `${g.label} · ${g.date}`}
          </h3>
          <ul className="relative space-y-1 border-l border-border pl-4">
            {g.events.map((e) => {
              const info = eventInfo(e);
              const selected = e.id === selectedId;
              return (
                <li key={e.id} className="relative">
                  <span aria-hidden className={cn('absolute top-4 -left-[21px] size-2.5 rounded-full ring-2 ring-bg', selected ? 'bg-accent' : 'bg-border-strong')} />
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(e)}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                      selected ? 'bg-surface shadow-card ring-1 ring-border' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={info.tone}>
                        <span aria-hidden className="font-mono">{info.symbol}</span>
                        <span>{info.label}</span>
                      </Badge>
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{e.title}</span>
                    </span>
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted">
                      <span>{timeOf(e.at)}</span>
                      {e.env && <span>· {envLabel(e.env)}</span>}
                      {e.author && <span>· {e.author}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
