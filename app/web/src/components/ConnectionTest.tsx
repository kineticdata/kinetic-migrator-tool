// The outcome of "Test connection": each step (Core sign-in, Integrator
// token) with a plain message for the one that failed.
import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import type { ConnectionTestResult } from '../../../shared/api';

export function ConnectionTestSteps({ result }: { result: ConnectionTestResult }) {
  return (
    <div role="status" className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <p className={result.ok ? 'text-sm font-medium text-added' : 'text-sm font-medium text-danger'}>
        {result.ok ? 'Connected' : 'Could not connect'}
      </p>
      <div className="mt-1.5 space-y-1">
        {result.steps.map((s) => (
          <div key={s.step} className="flex items-start gap-2 text-[13px]">
            {s.skipped
              ? <CircleDashed size={15} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              : s.ok
                ? <CheckCircle2 size={15} aria-hidden className="mt-0.5 shrink-0 text-added" />
                : <XCircle size={15} aria-hidden className="mt-0.5 shrink-0 text-danger" />}
            <span className="min-w-0">
              <span className="text-fg">{s.label}</span>
              <span className="text-muted">{s.skipped ? ' — skipped' : s.ok ? ' — ok' : ''}</span>
              {s.message && <span className="block text-muted">{s.message}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
