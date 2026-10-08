// Settings: a side navigation (Environments, Data & values, Repository), the
// path of the server's log file below it, and the section.
import { Link, Outlet, useLocation } from 'react-router';
import { Database, FileText, GitBranch, Server } from 'lucide-react';
import { useSession } from '../../api/queries';
import { cn } from '../../components/ui/cn';
import { useProjectContext } from '../../lib/project';

export function SettingsLayout() {
  const ctx = useProjectContext();
  const session = useSession();
  const logFile = session.data?.logFile;
  const { pathname } = useLocation();
  const base = `/p/${ctx.project.id}/settings`;
  const sections = [
    { to: `${base}/environments`, label: 'Environments', Icon: Server },
    { to: `${base}/data`, label: 'Data & values', Icon: Database },
    { to: `${base}/repository`, label: 'Repository', Icon: GitBranch },
  ];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8 md:flex-row">
      <nav aria-label="Settings" className="flex shrink-0 gap-1 md:w-52 md:flex-col">
        {sections.map(({ to, label, Icon }) => {
          const active = pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? 'page' : undefined}
              className={cn('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors', active ? 'bg-surface text-fg shadow-card ring-1 ring-border' : 'text-muted hover:bg-surface-2 hover:text-fg')}
            >
              <Icon size={16} aria-hidden />
              {label}
            </Link>
          );
        })}
        {logFile && (
          <div className="mt-4 hidden rounded-lg px-3 py-2 text-xs text-muted md:block">
            <p className="flex items-center gap-1.5 font-medium text-fg"><FileText size={13} aria-hidden /> Log file</p>
            <p className="mt-1 font-mono text-[11px] break-all select-all" title="Server log for today (secrets are never written); the last 14 days are kept.">{logFile}</p>
          </div>
        )}
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet context={ctx} />
      </div>
    </div>
  );
}
