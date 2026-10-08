// Settings → Environments: the pipeline in order, with add, edit, reorder,
// credentials (write-only) and Test connection per environment.
import { useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Lock, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import type { ConnectionTestResult, EnvironmentInfo } from '../../../../shared/api';
import { testConnection, useDeleteEnvironment, usePutEnvironment } from '../../api/queries';
import { EnvironmentDialog } from './EnvironmentDialog';
import { Badge } from '../../components/ui/Badge';
import { Button, IconButton } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Dialog, DialogClose, DialogContent } from '../../components/ui/Dialog';
import { EmptyState, InlineError } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { envLabel, timeAgo } from '../../lib/format';
import { useProjectContext } from '../../lib/project';

function credentialsText(e: EnvironmentInfo): string {
  const { username, password } = e.credentials;
  if (!username && !password) return 'No credentials';
  return [username ? 'Username set' : 'No username', password ? 'Password set' : 'No password'].join(' · ');
}

function TestOutcome({ result }: { result: ConnectionTestResult }) {
  if (result.ok) return <span className="flex items-center gap-1.5 text-xs font-medium text-added"><CheckCircle2 size={14} aria-hidden />Connected</span>;
  const failed = result.steps.find((s) => !s.ok && !s.skipped);
  return (
    <span className="flex items-start gap-1.5 text-xs text-danger">
      <XCircle size={14} aria-hidden className="mt-px shrink-0" />
      <span>{failed ? `${failed.label} failed${failed.message ? `: ${failed.message}` : ''}` : 'Could not connect'}</span>
    </span>
  );
}

export function EnvironmentsSettings() {
  const { project } = useProjectContext();
  const put = usePutEnvironment(project.id);
  const remove = useDeleteEnvironment(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState<EnvironmentInfo | 'new' | null>(null);
  const [removing, setRemoving] = useState<EnvironmentInfo | null>(null);
  const [tests, setTests] = useState<Record<string, ConnectionTestResult | 'running' | Error>>({});
  const envs = project.environments;

  const move = (e: EnvironmentInfo, position: number) => {
    put.mutate({ env: e.name, url: e.url, readOnly: e.readOnly, position });
  };

  const test = async (e: EnvironmentInfo) => {
    setTests((t) => ({ ...t, [e.name]: 'running' }));
    try {
      const r = await testConnection(project.id, e.name);
      setTests((t) => ({ ...t, [e.name]: r }));
    } catch (err) {
      setTests((t) => ({ ...t, [e.name]: err instanceof Error ? err : new Error('The test did not finish.') }));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Environments"
          description="Changes are promoted from the top of this list to the bottom. Credentials are kept in your system keychain, never in the project."
          actions={<Button variant="primary" size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setEditing('new')}>Add environment</Button>}
        />
        {envs.length === 0 ? (
          <EmptyState title="No environments yet" description="Add the Kinetic spaces you promote between, such as Dev, Test and Prod." className="py-10" />
        ) : (
          <ol className="divide-y divide-border" aria-label="Pipeline order">
            {envs.map((e, i) => {
              const label = envLabel(e.name);
              const t = tests[e.name];
              return (
                <li key={e.name} data-env={e.name} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted tabular-nums">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{label}</span>
                      {e.readOnly && <Badge icon={<Lock size={11} aria-hidden />}>Protected</Badge>}
                      {e.lastSnapshot && <span className="text-xs text-subtle">Snapshot {timeAgo(e.lastSnapshot.at)}</span>}
                    </div>
                    <p className="truncate font-mono text-xs text-subtle">{e.url}</p>
                    <p className={e.credentials.password ? 'mt-1 text-xs text-muted' : 'mt-1 text-xs text-drift'}>{credentialsText(e)}</p>
                    {t && t !== 'running' && <div className="mt-1.5">{t instanceof Error ? <InlineError error={t} /> : <TestOutcome result={t} />}</div>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" aria-label={`Test ${label}`} loading={t === 'running'} onClick={() => test(e)}>Test</Button>
                    <IconButton label={`Edit ${label}`} onClick={() => setEditing(e)}><Pencil size={15} aria-hidden /></IconButton>
                    <IconButton label={`Move ${label} earlier`} disabled={i === 0 || put.isPending} onClick={() => move(e, i - 1)}><ArrowUp size={15} aria-hidden /></IconButton>
                    <IconButton label={`Move ${label} later`} disabled={i === envs.length - 1 || put.isPending} onClick={() => move(e, i + 1)}><ArrowDown size={15} aria-hidden /></IconButton>
                    <IconButton label={`Remove ${label}`} onClick={() => setRemoving(e)}><Trash2 size={15} aria-hidden /></IconButton>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {put.error && <div className="px-5 pb-4"><InlineError error={put.error} /></div>}
      </Card>

      {editing && (
        <EnvironmentDialog
          projectId={project.id}
          environment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog open={Boolean(removing)} onOpenChange={(o) => { if (!o) { setRemoving(null); remove.reset(); } }}>
        {removing && (
          <DialogContent
            title={`Remove ${envLabel(removing.name)}?`}
            description="This removes the environment from the project and forgets its saved credentials. Nothing in the Kinetic space is changed, and its snapshots stay in history."
          >
            <InlineError error={remove.error} />
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => remove.mutate(removing.name, {
                  onSuccess: () => {
                    toast.show({ tone: 'success', title: `${envLabel(removing.name)} removed` });
                    setRemoving(null);
                  },
                })}
              >
                Remove
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
