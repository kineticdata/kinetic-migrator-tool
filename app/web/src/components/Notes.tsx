// Notes: plain-language warnings about what a snapshot or comparison left
// out (connections and operations when the Integrator sign-in is unavailable).
import { AlertTriangle } from 'lucide-react';
import { cn } from './ui/cn';

export function Notes({ notes, className, label = 'Notes' }: { notes?: string[]; className?: string; label?: string }) {
  if (!notes?.length) return null;
  return (
    <ul aria-label={label} className={cn('space-y-1.5 rounded-lg border border-drift/30 bg-drift-soft/50 px-3 py-2', className)}>
      {notes.map((n) => (
        <li key={n} className="flex items-start gap-2 text-xs text-fg">
          <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-drift" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}
