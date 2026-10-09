// For a project inside the user's own repository (external mode): which
// repository and branch it is in, that Kinetic Migrator doesn't commit there,
// and how many of the project's files changed since the user's last commit.
// A merge, rebase, cherry-pick or revert in progress there makes the project
// read-only, said here too. Renders nothing for a managed project.
import { AlertTriangle, GitBranch } from 'lucide-react';
import type { ExternalRepository } from '../../../shared/repository-api';
import { useRepository } from '../api/history';
import { plural } from '../lib/format';

const OPERATION: Record<NonNullable<ExternalRepository['operation']>, string> = {
  merge: 'A merge', rebase: 'A rebase', 'cherry-pick': 'A cherry-pick', revert: 'A revert',
};

export function externalSummary(x: ExternalRepository): string {
  const where = x.branch ? `on branch ${x.branch}` : 'on a detached commit';
  const changed = x.changedFiles !== null ? ` — ${plural(x.changedFiles, 'file')} changed since your last commit${x.checking ? ' (checking again…)' : ''}`
    : x.checking ? ' — checking for files changed since your last commit…' : '';
  return `This project is in your repository ${x.name} ${where}; Kinetic Migrator doesn't commit there${changed}.`;
}

export function ExternalRepoBanner({ projectId, className = 'mb-6' }: { projectId: string; className?: string }) {
  const repo = useRepository(projectId);
  const x = repo.data?.mode === 'external' ? repo.data.external : undefined;
  if (!x) return null;
  return (
    <div role="note" aria-label="Your repository" className={`${className} space-y-1.5 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-muted`}>
      <p className="flex items-start gap-2">
        <GitBranch size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span>{externalSummary(x)}</span>
      </p>
      {x.operation && (
        <p className="flex items-start gap-2 text-fg">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-drift" aria-hidden />
          <span>{OPERATION[x.operation]} is in progress there: until you finish or abort it, Kinetic Migrator only reads this project.</span>
        </p>
      )}
    </div>
  );
}
