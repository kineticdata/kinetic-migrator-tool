// The pipeline strip: one pill per environment in pipeline order with its
// name, protected lock, snapshot age and drift. Clicking a pill makes it the
// active environment (kept in the URL: Explore's path, else `?env=`).
import { ChevronRight, Lock } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import type { EnvironmentInfo } from '../../../shared/api';
import { envLabel, plural, timeAgo } from '../lib/format';
import { cn } from './ui/cn';

export interface PipelineStripProps {
  projectId: string;
  environments: EnvironmentInfo[];
  drift: Record<string, number>;
  active: string | null;
  now?: Date;
}

function hrefFor(projectId: string, env: string, pathname: string, search: string): string {
  const explore = `/p/${projectId}/explore/`;
  if (pathname.startsWith(explore)) return `${explore}${encodeURIComponent(env)}`;
  const params = new URLSearchParams(search);
  params.set('env', env);
  return `${pathname}?${params.toString()}`;
}

export function PipelineStrip({ projectId, environments, drift, active, now }: PipelineStripProps) {
  const { pathname, search } = useLocation();
  if (!environments.length) return null;
  return (
    <nav aria-label="Environments" className="flex min-w-0 items-center gap-1 overflow-x-auto py-1">
      {environments.map((e, i) => {
        const isActive = e.name === active;
        const drifted = drift[e.name] ?? 0;
        return (
          <div key={e.name} className="flex shrink-0 items-center gap-1">
            {i > 0 && <ChevronRight size={14} aria-hidden className="text-header-subtle" />}
            <Link
              to={hrefFor(projectId, e.name, pathname, search)}
              data-env={e.name}
              aria-current={isActive ? 'true' : undefined}
              className={cn(
                'group flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-colors',
                isActive
                  ? 'border-primary bg-header-active text-header-fg'
                  : 'border-header-border bg-header-hover text-header-muted hover:bg-header-active hover:text-header-fg',
              )}
            >
              <span className={cn('size-1.5 rounded-full', e.lastSnapshot ? 'bg-header-ok' : 'bg-header-subtle/60')} aria-hidden />
              <span className="font-medium text-header-fg">{envLabel(e.name)}</span>
              {e.readOnly && <Lock size={12} role="img" aria-label="Protected" className="text-header-muted" />}
              <span className="text-xs text-header-subtle">{e.lastSnapshot ? timeAgo(e.lastSnapshot.at, now) : 'No snapshot'}</span>
              {drifted > 0 && (
                <span className="rounded-full bg-drift-soft px-1.5 text-[11px] font-medium text-drift">{plural(drifted, 'drifted', 'drifted')}</span>
              )}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
