// Changesets: saved selections of items, pinned to the source snapshot they
// were taken from. The list shows where each came from, when it was pinned,
// its size and where it has been applied; a changeset's page lists its items
// and plans it against any other environment (always shipping the pinned
// content).
import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ArrowRight, CheckCircle2, GitCompare, Layers, Lock, Trash2 } from 'lucide-react';
import type { Changeset, NodeKind, PlanResult } from '../../../shared/sync-api';
import { ApiError } from '../api/client';
import { startPlan, useChangeset, useChangesets, useDeleteChangeset } from '../api/queries';
import { useJob } from '../api/useJob';
import { KindIcon } from '../components/ObjectTree';
import { Badge } from '../components/ui/Badge';
import { Button, LinkButton } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../components/ui/EmptyState';
import { inputClasses } from '../components/ui/Field';
import { cn } from '../components/ui/cn';
import { envLabel, formatDateTime, plural, timeAgo } from '../lib/format';
import { useProjectContext } from '../lib/project';
import { kindOfKey, nameOfKey } from '../lib/tree-layout';

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en', { dateStyle: 'medium' });
};

// When the pinned snapshot was taken (from history), else when it was saved.
function usePinnedAt(cs: Changeset | undefined): string | null {
  const { history } = useProjectContext();
  return useMemo(() => (cs ? history.find((e) => e.commit === cs.sourceCommit)?.at ?? cs.createdAt : null), [history, cs]);
}

function AppliedTo({ cs }: { cs: Changeset }) {
  if (!cs.appliedTo.length) return <span className="text-subtle">Not yet</span>;
  // The newest apply per environment.
  const latest = new Map<string, string>();
  for (const a of cs.appliedTo) if (!latest.has(a.env) || latest.get(a.env)! < a.at) latest.set(a.env, a.at);
  return (
    <span className="flex flex-wrap gap-1">
      {[...latest].map(([env, at]) => (
        <Badge key={env} tone="added" icon={<CheckCircle2 size={11} aria-hidden />} title={`Applied ${formatDateTime(at)}`}>{envLabel(env)}</Badge>
      ))}
    </span>
  );
}

function ChangesetRow({ projectId, cs }: { projectId: string; cs: Changeset }) {
  const pinned = usePinnedAt(cs);
  return (
    <tr className="align-top hover:bg-surface-2/60">
      <td className="px-5 py-3">
        <Link to={`/p/${projectId}/changesets/${encodeURIComponent(cs.id)}`} className="font-medium text-fg hover:text-accent hover:underline">{cs.name}</Link>
        {cs.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{cs.description}</p>}
      </td>
      <td className="px-4 py-3 text-fg">{envLabel(cs.from)}</td>
      <td className="px-4 py-3 text-muted">{pinned && <time dateTime={pinned} title={formatDateTime(pinned)}>{formatDate(pinned)}</time>}</td>
      <td className="px-4 py-3 text-right text-fg tabular-nums">{cs.keys.length.toLocaleString('en')}</td>
      <td className="px-5 py-3"><AppliedTo cs={cs} /></td>
    </tr>
  );
}

export function ChangesetsPage() {
  const { project } = useProjectContext();
  const list = useChangesets(project.id);
  let body;
  if (list.isPending) body = <LoadingState label="Loading changesets…" />;
  else if (list.isError) body = <ErrorState title="Could not load the changesets" error={list.error} onRetry={() => list.refetch()} />;
  else if (!list.data.length) {
    body = (
      <EmptyState
        icon={<Layers size={20} />}
        title="No saved changesets yet"
        description="In Compare, tick what you want to promote and choose Save as changeset… to promote the same set through each environment."
        action={<LinkButton to={`/p/${project.id}/compare`} variant="primary" icon={<GitCompare size={15} aria-hidden />}>Compare environments</LinkButton>}
      />
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table aria-label="Changesets" className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-subtle">
            <tr>
              <th scope="col" className="px-5 py-2 font-medium">Name</th>
              <th scope="col" className="px-4 py-2 font-medium">From</th>
              <th scope="col" className="px-4 py-2 font-medium">Snapshot</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Items</th>
              <th scope="col" className="px-5 py-2 font-medium">Applied to</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.data.map((cs) => <ChangesetRow key={cs.id} projectId={project.id} cs={cs} />)}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Changesets</h1>
          <p className="mt-1 text-sm text-muted">Saved selections, pinned to the snapshot they were taken from.</p>
        </div>
        <LinkButton to={`/p/${project.id}/compare`} icon={<GitCompare size={15} aria-hidden />}>Compare</LinkButton>
      </div>
      <Card>{body}</Card>
    </div>
  );
}

const KIND_TITLES: Partial<Record<NodeKind, string>> = {
  space: 'Space', kapp: 'Kapps', form: 'Forms', data: 'Reference data', workflow: 'Workflows', webapi: 'WebAPIs', connection: 'Connections',
  operation: 'Operations', handler: 'Handlers', team: 'Teams', model: 'Models', 'file-resource': 'File resources', routine: 'Routines', other: 'Other',
};

function ItemsCard({ keys }: { keys: string[] }) {
  const groups = useMemo(() => {
    const m = new Map<NodeKind, string[]>();
    for (const k of keys) {
      const kind = kindOfKey(k);
      m.set(kind, [...(m.get(kind) ?? []), k]);
    }
    return (Object.keys(KIND_TITLES) as NodeKind[]).filter((k) => m.has(k)).map((k) => ({ kind: k, title: KIND_TITLES[k]!, keys: m.get(k)! }));
  }, [keys]);
  return (
    <Card>
      <CardHeader title="Items" description={plural(keys.length, 'item')} />
      <section aria-label="Items" className="divide-y divide-border">
        {groups.map((g) => (
          <div key={g.kind} className="px-5 py-3">
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g.title} <span className="tabular-nums">{g.keys.length}</span></h3>
            <ul className="space-y-1">
              {g.keys.map((k) => (
                <li key={k} className="flex min-w-0 items-center gap-2.5">
                  <KindIcon kind={g.kind} className="text-subtle" />
                  <span className="text-sm text-fg">{nameOfKey(k)}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-subtle" title={k}>{k}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </Card>
  );
}

function PlanAgainst({ projectId, cs }: { projectId: string; cs: Changeset }) {
  const { project } = useProjectContext();
  const navigate = useNavigate();
  const selectId = useId();
  const targets = project.environments.filter((e) => e.name !== cs.from);
  const names = project.environments.map((e) => e.name);
  const next = targets.find((e) => names.indexOf(e.name) > names.indexOf(cs.from)) ?? targets[0];
  const [to, setTo] = useState(next?.name ?? '');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const job = useJob<PlanResult>(jobId, {
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result) navigate(`/p/${projectId}/plan/${encodeURIComponent(j.result.planId)}`);
      else setError(j.error?.message ?? 'The plan did not finish.');
    },
  });
  const start = async () => {
    setError(null);
    try {
      setJobId((await startPlan(projectId, { to, changesetId: cs.id })).jobId);
    } catch (err) {
      setError(err);
    }
  };
  if (!targets.length) return <p className="text-sm text-muted">Add another environment to promote this changeset.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1 space-y-1.5">
          <label htmlFor={selectId} className="text-[13px] font-medium text-fg">Plan against</label>
          <select id={selectId} value={to} onChange={(e) => setTo(e.target.value)} className={inputClasses}>
            {targets.map((e) => <option key={e.name} value={e.name}>{envLabel(e.name)}{e.readOnly ? ' (protected)' : ''}</option>)}
          </select>
        </div>
        <Button variant="primary" loading={job.status === 'running'} disabled={!to} onClick={start}>
          Review plan <ArrowRight size={15} aria-hidden />
        </Button>
      </div>
      {targets.find((e) => e.name === to)?.readOnly && (
        <p className="flex items-center gap-1.5 text-xs text-muted"><Lock size={12} aria-hidden /> {envLabel(to)} is protected: you can review the plan, but not apply it.</p>
      )}
      <InlineError error={error} />
    </div>
  );
}

export function ChangesetDetailPage() {
  const { project } = useProjectContext();
  const { changesetId = '' } = useParams();
  const navigate = useNavigate();
  const cs = useChangeset(project.id, changesetId);
  const pinned = usePinnedAt(cs.data);
  const del = useDeleteChangeset(project.id);
  const [confirming, setConfirming] = useState(false);
  const back = <Link to={`/p/${project.id}/changesets`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Changesets</Link>;

  if (cs.isPending) return <div className="mx-auto max-w-5xl px-6 py-8">{back}<LoadingState label="Loading changeset…" /></div>;
  if (cs.isError) {
    const gone = cs.error instanceof ApiError && cs.error.status === 404;
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        {back}
        <ErrorState title={gone ? 'Changeset not found' : 'Could not load the changeset'} error={cs.error} onRetry={gone ? undefined : () => cs.refetch()} />
      </div>
    );
  }
  const c = cs.data;
  const remove = async () => {
    await del.mutateAsync(c.id);
    navigate(`/p/${project.id}/changesets`);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {back}
      <div className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{c.name}</h1>
          {c.description && <p className="mt-1 max-w-2xl text-sm text-muted">{c.description}</p>}
        </div>
        <Button variant="ghost" size="sm" icon={<Trash2 size={14} aria-hidden />} onClick={() => setConfirming(true)}>Delete</Button>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ItemsCard keys={c.keys} />
        <div className="space-y-5">
          <Card>
            <CardHeader title="Promote" description="Ships the items exactly as they were in the pinned snapshot." />
            <div className="px-5 py-4"><PlanAgainst projectId={project.id} cs={c} /></div>
          </Card>
          <Card>
            <dl className="divide-y divide-border text-sm">
              {[
                ['From', envLabel(c.from)],
                ['Snapshot', pinned ? <span key="s"><time dateTime={pinned} title={formatDateTime(pinned)}>{formatDate(pinned)}</time> <span className="font-mono text-xs text-subtle" title="Version">{c.sourceCommit.slice(0, 7)}</span></span> : '—'],
                ['Saved', <time key="t" dateTime={c.createdAt} title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</time>],
                ['Applied to', <AppliedTo key="a" cs={c} />],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex items-start justify-between gap-4 px-5 py-2.5">
                  <dt className="text-muted">{label}</dt>
                  <dd className={cn('text-right text-fg')}>{value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title={`Delete “${c.name}”?`}
          description="The changeset is removed from the project. Promotions already made are not affected, and History keeps the record."
          footer={(
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="danger" loading={del.isPending} onClick={remove}>Delete changeset</Button>
            </>
          )}
        >
          <InlineError error={del.error} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
