// Empty, loading and error states for screens and panels.
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from './cn';
import { Spinner } from './Spinner';
import { Button } from './Button';

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-surface-2 text-muted">{icon}</div>}
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-14 text-sm text-muted', className)}>
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, onRetry, className }: { title?: string; error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : 'Please try again.';
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-danger-soft text-danger"><AlertTriangle size={20} aria-hidden /></div>
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted">{message}</p>
      {onRetry && <Button className="mt-5" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// An inline error line for forms and dialogs.
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </p>
  );
}
