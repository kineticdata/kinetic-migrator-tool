// Stepper: the steps of a guided flow, with the current one marked for
// assistive technology (aria-current) and by more than colour (a number, a
// tick for finished steps, bold for the current one).
import { Check } from 'lucide-react';
import { cn } from './ui/cn';

export function Stepper({ steps, current, className }: { steps: string[]; current: number; className?: string }) {
  return (
    <nav aria-label="Steps" className={className}>
      <ol className="flex items-center gap-2">
        {steps.map((label, i) => {
          const done = i < current;
          const here = i === current;
          return (
            <li key={label} aria-current={here ? 'step' : undefined} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                  done && 'bg-accent text-accent-fg',
                  here && 'bg-accent-soft text-accent ring-2 ring-accent',
                  !done && !here && 'bg-surface-2 text-subtle ring-1 ring-border-strong',
                )}
              >
                {done ? <Check size={13} strokeWidth={3} aria-hidden /> : i + 1}
              </span>
              <span className={cn('truncate text-[13px]', here ? 'font-semibold text-fg' : done ? 'text-fg' : 'text-muted')}>
                {label}
                {done && <span className="sr-only"> (done)</span>}
              </span>
              {i < steps.length - 1 && <span aria-hidden className={cn('mx-1 h-px min-w-4 flex-1', done ? 'bg-accent' : 'bg-border-strong')} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
