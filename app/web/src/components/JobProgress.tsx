// Live progress of a job: a bar with the phase and count, or the outcome.
import type { JobState } from '../api/useJob';
import { Progress } from './ui/Spinner';

const phaseLabel = (phase?: string) => {
  if (!phase) return 'Working';
  return phase[0].toUpperCase() + phase.slice(1).replace(/[-_]/g, ' ');
};

export function JobProgress({ job, label }: { job: JobState<unknown>; label: string }) {
  const p = job.progress;
  const value = p && p.total > 0 ? p.done / p.total : null;
  return (
    <div className="space-y-1.5">
      <Progress value={value} label={label} />
      <p className="flex justify-between text-xs text-muted" aria-live="polite">
        <span>{phaseLabel(p?.phase)}…</span>
        {p && p.total > 0 && <span className="tabular-nums">{p.done.toLocaleString('en')} of {p.total.toLocaleString('en')}</span>}
      </p>
    </div>
  );
}
