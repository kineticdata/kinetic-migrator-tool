// Projects launcher: the projects in the workspace, "New project" (the
// first-run wizard) and "Open folder…" for a project elsewhere on disk.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, FolderOpen, FolderPlus, Info, Plus } from 'lucide-react';
import { useOpenProject, useProjects, useSession } from '../api/queries';
import { PlainFrame } from '../components/Brand';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog, DialogClose, DialogContent } from '../components/ui/Dialog';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../components/ui/EmptyState';
import { Field, Input } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';
import { lastProject } from '../lib/project';

function OpenFolderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [path, setPath] = useState('');
  const openProject = useOpenProject();
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    openProject.mutate({ path: path.trim() }, { onSuccess: (d) => navigate(`/p/${d.id}/overview`) });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) openProject.reset(); }}>
      <DialogContent
        title="Open a project folder"
        description="Use a folder made by kinetic-migrate or the kinetic-sync command line. It will be managed from here on."
      >
        <form id="open-folder" onSubmit={submit} className="space-y-4">
          <Field label="Folder path" hint="The full path, for example /Users/you/migrations/my-project">
            {(p) => <Input {...p} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/project" autoFocus spellCheck={false} />}
          </Field>
          <InlineError error={openProject.error} />
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button>Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" disabled={!path.trim()} loading={openProject.isPending}>Open</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsPage() {
  const projects = useProjects();
  const session = useSession();
  const [opening, setOpening] = useState(false);
  const last = lastProject();
  const list = [...(projects.data ?? [])].sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0));

  return (
    <PlainFrame>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            Each project holds the environments of one Kinetic setup and everything promoted between them.
            {session.data && <> Stored in <span className="font-mono text-[13px] text-fg">{session.data.workspace}</span>.</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<FolderOpen size={16} aria-hidden />} onClick={() => setOpening(true)}>Open folder…</Button>
          <LinkButton to="/new" variant="primary" icon={<Plus size={16} aria-hidden />}>New project</LinkButton>
        </div>
      </div>

      {session.data && !session.data.keychain.available && (
        <p className="mb-6 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-muted">
          <Info size={16} aria-hidden className="mt-0.5 shrink-0 text-accent" />
          No system keychain was found, so passwords are kept only until kinetic-migrate stops.
        </p>
      )}

      {projects.isPending && <LoadingState label="Loading projects…" />}
      {projects.isError && <ErrorState title="Could not list projects" error={projects.error} onRetry={() => projects.refetch()} />}
      {projects.data && list.length === 0 && (
        <Card>
          <EmptyState
            icon={<FolderPlus size={20} />}
            title="No projects yet"
            description="Create a project, connect your first environment and take a snapshot. It takes a couple of minutes."
            action={(
              <>
                <LinkButton to="/new" variant="primary">Create your first project</LinkButton>
                <Button onClick={() => setOpening(true)}>Open folder…</Button>
              </>
            )}
          />
        </Card>
      )}
      {list.length > 0 && (
        <Card className="divide-y divide-border overflow-hidden">
          {list.map((p) => (
            <Link key={p.id} to={`/p/${p.id}/overview`} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-2">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-sm font-semibold text-accent">
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-fg">{p.name}</span>
                  {p.id === last && <Badge tone="accent">Last opened</Badge>}
                </span>
                <span className="block truncate font-mono text-xs text-subtle">{p.path}</span>
              </span>
              <ChevronRight size={16} aria-hidden className="text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-muted" />
            </Link>
          ))}
        </Card>
      )}
      <OpenFolderDialog open={opening} onOpenChange={setOpening} />
    </PlainFrame>
  );
}
