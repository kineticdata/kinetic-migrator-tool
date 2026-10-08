// The project frame: top bar (project, theme), the pipeline strip and the
// tabs Overview · Explore · Compare · Changesets · History · Settings.
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ChevronsUpDown } from 'lucide-react';
import type { ProjectDetail } from '../../../shared/api';
import { BrandMark } from './Brand';
import { PipelineStrip } from './PipelineStrip';
import { ThemeToggle } from './ThemeToggle';
import { cn } from './ui/cn';

export interface AppFrameProps {
  project: ProjectDetail;
  activeEnv: string | null;
  drift: Record<string, number>;
  children: ReactNode;
}

export function AppFrame({ project, activeEnv, drift, children }: AppFrameProps) {
  const { pathname, search } = useLocation();
  const base = `/p/${project.id}`;
  const keep = new URLSearchParams(search).get('env');
  const q = keep ? `?env=${encodeURIComponent(keep)}` : '';
  const tabs = [
    { to: `${base}/overview${q}`, label: 'Overview', match: `${base}/overview` },
    { to: activeEnv ? `${base}/explore/${encodeURIComponent(activeEnv)}` : `${base}/explore`, label: 'Explore', match: `${base}/explore` },
    { to: `${base}/compare${q}`, label: 'Compare', match: `${base}/compare` },
    { to: `${base}/changesets${q}`, label: 'Changesets', match: `${base}/changesets` },
    { to: `${base}/history${q}`, label: 'History', match: `${base}/history` },
    { to: `${base}/settings/environments${q}`, label: 'Settings', match: `${base}/settings` },
  ];
  return (
    <div className="flex h-screen flex-col">
      <header className="z-30 shrink-0 border-b border-header-border bg-header">
        <div className="flex h-14 items-center gap-4 px-6">
          <BrandMark />
          <span aria-hidden className="text-header-subtle/60">/</span>
          <Link to="/" className="group flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-header-fg hover:bg-header-hover" title="Switch project">
            <span className="truncate">{project.name}</span>
            <ChevronsUpDown size={14} aria-hidden className="text-header-subtle group-hover:text-header-muted" />
          </Link>
          <div className="ml-2 min-w-0 flex-1">
            <PipelineStrip projectId={project.id} environments={project.environments} drift={drift} active={activeEnv} />
          </div>
          <ThemeToggle />
        </div>
        <nav aria-label="Sections" className="flex gap-1 overflow-x-auto px-4">
          {tabs.map((t) => {
            const active = pathname === t.match || pathname.startsWith(`${t.match}/`);
            return (
              <Link
                key={t.label}
                to={t.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative px-3 pt-1.5 pb-2.5 text-sm font-medium transition-colors',
                  active ? 'text-header-fg after:absolute after:inset-x-2 after:-bottom-px after:h-[3px] after:rounded-t-full after:bg-primary' : 'text-header-muted hover:text-header-fg',
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

