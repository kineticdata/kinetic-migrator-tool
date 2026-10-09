// Settings → Repository: who the project's history is recorded as (author
// name and email), an optional remote repository (address plus a write-only
// token kept in the keychain), Push, and how the last push went. The token is
// sent with a plain request and cleared from the field straight after.
// A project inside the user's own repository (external mode) shows that
// repository read-only instead of the remote: Kinetic Migrator never commits,
// pushes or changes remotes there, and the author names its private history.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CheckCircle2, CloudUpload, AlertTriangle } from 'lucide-react';
import type { ExternalRepository, LastPush, RepositorySettings as Settings } from '../../../../shared/repository-api';
import { ExternalRepoBanner } from '../../components/ExternalRepoBanner';
import { historyKeys, putRepository, startPush, useRepository } from '../../api/history';
import { qk } from '../../api/queries';
import { useJob } from '../../api/useJob';
import { Button } from '../../components/ui/Button';
import { Card, CardFooter, CardHeader } from '../../components/ui/Card';
import { ErrorState, InlineError, LoadingState } from '../../components/ui/EmptyState';
import { Field, Input } from '../../components/ui/Field';
import { SecretInput } from '../../components/ui/SecretInput';
import { useToast } from '../../components/ui/Toast';
import { formatDateTime } from '../../lib/format';
import { isDefaultAuthor } from '../../lib/history';
import { useProjectContext } from '../../lib/project';

// The built-in author (nobody set a name yet) shows as empty fields.
const shown = (a: Settings['author']) => (isDefaultAuthor(a.name) ? { name: '', email: '' } : a);

function AuthorCard({ projectId, settings, onSaved }: { projectId: string; settings: Settings; onSaved: (s: Settings) => void }) {
  const toast = useToast();
  const unset = isDefaultAuthor(settings.author.name);
  const [name, setName] = useState(shown(settings.author).name);
  const [email, setEmail] = useState(shown(settings.author).email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setName(shown(settings.author).name);
    setEmail(shown(settings.author).email);
  }, [settings.author]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await putRepository(projectId, { author: { name, email } }));
      toast.show({ tone: 'success', title: 'Author saved' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Author"
        description={settings.mode === 'external'
          ? 'Who Kinetic Migrator’s private history of this project, on this computer, records snapshots, changesets and promotions as. Your own commits to your repository use your git settings.'
          : unset
            ? 'No name is set yet, so History shows your snapshots, changesets and promotions as “You”. Add your name so others can tell who did what.'
            : 'Snapshots, changesets and promotions are recorded in History under this name.'}
      />
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}</Field>
      </div>
      {error ? <div className="px-5 pb-4"><InlineError error={error} /></div> : null}
      <CardFooter>
        <Button variant="primary" size="sm" loading={busy} disabled={!name.trim() || !email.trim()} onClick={submit}>Save author</Button>
      </CardFooter>
    </Card>
  );
}

function LastPushLine({ last }: { last: LastPush | null }) {
  if (!last) return <p className="text-sm text-muted">Not pushed yet.</p>;
  return last.ok ? (
    <p className="flex items-center gap-2 text-sm text-fg">
      <CheckCircle2 size={16} className="text-added" aria-hidden />
      Last push succeeded {formatDateTime(last.at)}.
    </p>
  ) : (
    <p className="flex items-start gap-2 text-sm text-fg">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      <span>Last push failed {formatDateTime(last.at)}: {last.message ?? 'unknown reason'}</span>
    </p>
  );
}

function RemoteCard({ projectId, settings, onSaved }: { projectId: string; settings: Settings; onSaved: (s: Settings) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState(settings.remote.url ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => setUrl(settings.remote.url ?? ''), [settings.remote.url]);
  const job = useJob(jobId, {
    invalidate: [historyKeys.repository(projectId)],
    onDone: (j) => {
      if (j.status === 'succeeded') toast.show({ tone: 'success', title: 'Pushed to the remote repository' });
    },
  });
  const pushing = job.status === 'running';
  const connected = Boolean(settings.remote.url);
  const changed = url.trim() !== (settings.remote.url ?? '') || token !== '';

  const save = async (body: Parameters<typeof putRepository>[1]) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await putRepository(projectId, body));
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      // The token never outlives its request, whatever the outcome.
      setToken('');
      setBusy(false);
    }
  };

  const connect = async () => {
    const body: Parameters<typeof putRepository>[1] = {};
    if (url.trim() !== (settings.remote.url ?? '')) body.remoteUrl = url.trim() || null;
    if (token) body.token = token;
    if (await save(body)) toast.show({ tone: 'success', title: connected ? 'Remote repository updated' : 'Remote repository connected' });
  };

  const push = async () => {
    setError(null);
    try {
      setJobId((await startPush(projectId)).jobId);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Remote repository"
        description="Optional. Push the project’s history to a git server so others can see it. Snapshots and settings go; credentials never do."
      />
      <div className="space-y-4 px-5 py-4">
        <Field label="Address" hint="For example https://git.example.com/team/project.git">
          {(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" placeholder="https://" />}
        </Field>
        <SecretInput
          label="Token"
          isSet={settings.remote.token.has}
          value={token}
          onChange={setToken}
          hint="A personal access token with write access. Kept in this computer’s keychain and never shown again."
        />
        {error ? <InlineError error={error} /> : null}
        {job.status === 'failed' && job.error && <InlineError error={job.error} />}
        <LastPushLine last={settings.lastPush} />
      </div>
      <CardFooter>
        {connected && <Button size="sm" variant="ghost" disabled={busy || pushing} onClick={() => save({ remoteUrl: null })}>Disconnect</Button>}
        <Button size="sm" loading={busy} disabled={!changed || !url.trim()} onClick={connect}>{connected ? 'Save' : 'Connect'}</Button>
        <Button size="sm" variant="primary" icon={<CloudUpload size={14} aria-hidden />} loading={pushing} disabled={!connected || busy} onClick={push}>Push</Button>
      </CardFooter>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-sm text-fg">{children}</dd>
    </div>
  );
}

const KIND: Record<ExternalRepository['kind'], string> = { repository: 'Repository', worktree: 'Linked worktree', submodule: 'Submodule' };

function YourRepositoryCard({ projectId, external }: { projectId: string; external: ExternalRepository }) {
  return (
    <Card>
      <CardHeader
        title="Your repository"
        description="This project is a folder inside a git repository you already have. Kinetic Migrator writes the project’s files and leaves committing, pull requests and pushing to you: it never commits, stages, pushes or changes remotes there."
      />
      <div className="space-y-4 px-5 py-4">
        <ExternalRepoBanner projectId={projectId} className="" />
        <dl className="space-y-2">
          <Row label="Repository">{external.root}</Row>
          <Row label="Kind">{KIND[external.kind]}</Row>
          <Row label="Branch">{external.branch ?? 'Detached commit'}</Row>
          <Row label="Project folder">{external.subfolder || 'The repository root'}</Row>
          <Row label="Kinetic Migrator’s history">{external.historyPath}</Row>
        </dl>
        <p className="text-sm text-muted">
          History, backups, Restore and saved changesets use a private history that Kinetic Migrator keeps on this computer, outside your repository.
          There is no remote or token to set here: push your repository with your usual git tools.
        </p>
      </div>
    </Card>
  );
}

export function RepositorySettings() {
  const { project } = useProjectContext();
  const qc = useQueryClient();
  const repo = useRepository(project.id);
  const onSaved = (s: Settings) => {
    qc.setQueryData(historyKeys.repository(project.id), s);
    // An author change is a new commit in History.
    void qc.invalidateQueries({ queryKey: qk.history(project.id) });
  };
  if (repo.isPending) return <LoadingState />;
  if (repo.isError) return <ErrorState title="Could not load the repository settings" error={repo.error} onRetry={() => repo.refetch()} />;
  return (
    <div className="space-y-6">
      {repo.data.mode === 'external' && repo.data.external && <YourRepositoryCard projectId={project.id} external={repo.data.external} />}
      <AuthorCard projectId={project.id} settings={repo.data} onSaved={onSaved} />
      {repo.data.mode !== 'external' && <RemoteCard projectId={project.id} settings={repo.data} onSaved={onSaved} />}
    </div>
  );
}
