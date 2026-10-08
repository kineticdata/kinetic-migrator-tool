// SuggestionsList: dependencies of the selection that are new or changed in
// the source and not selected yet, each with its plain reason and Add. They
// are never added silently.
import { Lightbulb, Plus } from 'lucide-react';
import type { SuggestionOut } from '../../../shared/sync-api';
import { kindOfKey } from '../lib/tree-layout';
import { KindIcon } from './ObjectTree';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

// One entry per suggested item (an item can be needed by several selected ones).
export function uniqueSuggestions(list: SuggestionOut[]): SuggestionOut[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

export function SuggestionsList({ suggestions, onAdd, onAddAll, title = 'Suggested', className }: {
  suggestions: SuggestionOut[];
  onAdd: (s: SuggestionOut) => void;
  onAddAll?: () => void;
  title?: string;
  className?: string;
}) {
  const list = uniqueSuggestions(suggestions);
  if (!list.length) return null;
  return (
    <section aria-label={title} className={cn('rounded-xl border border-drift/30 bg-drift-soft/50', className)}>
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <Lightbulb size={14} aria-hidden className="text-drift" />
          {title} <span className="font-normal text-muted tabular-nums">({list.length})</span>
        </h3>
        {onAddAll && list.length > 1 && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onAddAll}>Add all</Button>}
      </div>
      <ul className="space-y-1 px-1.5 pb-1.5">
        {list.map((s) => (
          <li key={s.key} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-surface/70">
            <KindIcon kind={kindOfKey(s.key)} className="mt-0.5 text-subtle" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-fg" title={s.label}>{s.label}</p>
              <p className="text-xs text-muted">{s.reason}</p>
            </div>
            <Button size="sm" variant="secondary" className="h-7 px-2" aria-label={`Add ${s.label}`} icon={<Plus size={13} aria-hidden />} onClick={() => onAdd(s)}>
              Add
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
