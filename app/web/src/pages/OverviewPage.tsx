// Overview: one lane per environment in pipeline order (snapshot age, item
// counts, drift, latest run and actions), arrows with "N differences" from an
// instant raw compare of snapshots, and recent activity below.
import { useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight, Camera, CheckCircle2, Compass, GitCompare, History as HistoryIcon, Layers, Lock, Plus, RotateCcw, Server, Undo2,
} from 'lucide-react';
import type { EnvironmentInfo } from '../../../shared/api';
import type { HistoryEvent, HistoryType, SnapshotResult } from '../../../shared/sync-api';
import { qk, startSnapshot, useRawDifferences, useTreeRoot } from '../api/queries';
import { useJob } from '../api/useJob';
import { JobProgress } from '../components/JobProgress';
import { Badge, StatusChip } from '../components/ui/Badge';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState, InlineError } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { envLabel, hostOf, plural, timeAgo } from '../lib/format';
import { latestByEnv, newestFirst, useProjectContext } from '../lib/project';
import { ApiError } from '../api/client';

function ItemCounts({ projectId, env }: { projectId: string; env: EnvironmentInfo }) {
  const tree = useTreeRoot(projectId, env.name, env.lastSnapshot?.commit);
  if (!env.lastSnapshot) return null;
  if (tree.isPending) return <p className="text-sm text-subtle">Counting items…</p>;
  if (tree.isError) return <p className="text-sm text-subtle">Item counts unavailable</p>;
  const groups = tree.data.map((n) => ({ label: n.label, count: n.count + (n.key ? 1 : 0) })).filter((g) => g.count > 0);
  const total = groups.reduce((s, g) => s + g.count, 0);
  return (
    <div>
      <p className="text-2xl font-semibold tracking-tight text-fg tabular-nums">{plural(total, 'item')}</p>
      {groups.length > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {[...groups].sort((a, b) => b.count - a.count).slice(0, 4).map((g) => `${g.count.toLocaleString('en')} ${g.label.toLowerCase()}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function LatestRun({ run }: { run: HistoryEvent | undefined }) {
  if (!run) return <p className="text-sm text-subtle">Nothing promoted here yet</p>;
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-fg" title={run.title}>{run.title}</p>
      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
        {run.status === 'applied' && <Badge tone="added" icon={<CheckCircle2 size={11} aria-hidden />}>Done</Badge>}
        {run.status === 'partial' && <Badge tone="drift">Partly done</Badge>}
        {run.status === 'failed' && <StatusChip status="error" />}
        {run.status === 'cancelled' && <Badge>Cancelled</Badge>}
        <span>{timeAgo(run.at)}</span>
      </p>
    </div>
  );
}

function Lane({ projectId, env, next, drift, run }: {
  projectId: string;
  env: EnvironmentInfo;
  next: EnvironmentInfo | undefined;
  drift: number | undefined;
  run: HistoryEvent | undefined;
}) {
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const label = envLabel(env.name);
  const job = useJob<SnapshotResult>(jobId, {
    invalidate: [qk.project(projectId)],
    onDone: (j) => {
      if (j.status === 'succeeded') {
        const r = j.result;
        toast.show({ tone: 'success', title: `Snapshot of ${label} taken`, description: r ? (r.commit ? plural(r.total, 'item') : 'Nothing changed since the last snapshot.') : undefined });
      }
    },
  });
  const running = job.status === 'running';

  const refresh = async () => {
    setStarting(true);
    setStartError(null);
    try {
      setJobId((await startSnapshot(projectId, env.name)).jobId);
    } catch (err) {
      setStartError(err instanceof ApiError && err.code === 'locked' ? new Error(`Something is already running against ${label}.`) : err);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section aria-label={`${label} environment`} className="flex w-[300px] shrink-0 flex-col">
      <Card className="flex flex-1 flex-col">
        <div className="border-b border-border px-5 pt-4 pb-3.5">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-fg">{label}</h2>
            {env.readOnly && <Badge icon={<Lock size={11} aria-hidden />}>Protected</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-subtle" title={env.url}>{hostOf(env.url)}</p>
        </div>

        <div className="flex flex-1 flex-col gap-4 px-5 py-4">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-subtle uppercase">Snapshot</p>
            {env.lastSnapshot
              ? <p className="mt-1 text-sm text-fg">Taken {timeAgo(env.lastSnapshot.at)}</p>
              : <p className="mt-1 text-sm text-muted">No snapshot yet</p>}
          </div>
          <ItemCounts projectId={projectId} env={env} />
          {env.lastSnapshot && (
            <div>
              <p className="text-[11px] font-medium tracking-wide text-subtle uppercase">Drift</p>
              <div className="mt-1">
                {drift === undefined
                  ? <span className="text-sm text-muted">Not known yet</span>
                  : drift > 0
                    ? <Badge tone="drift">{plural(drift, 'drifted', 'drifted')}</Badge>
                    : <span className="text-sm text-muted">{run ? 'No changes since the last promotion' : 'No promotions yet'}</span>}
              </div>
            </div>
          )}
          <div>
            <p className="text-[11px] font-medium tracking-wide text-subtle uppercase">Latest promotion</p>
            <div className="mt-1"><LatestRun run={run} /></div>
          </div>
          {!env.credentials.password && (
            <p className="text-xs text-drift">
              No password saved. <Link className="underline underline-offset-2" to={`/p/${projectId}/settings/environments`}>Add credentials</Link>
            </p>
          )}
          {running && <JobProgress job={job} label={`Snapshot of ${label}`} />}
          {(job.status === 'failed' || job.status === 'cancelled') && <InlineError error={job.error ?? 'The snapshot was cancelled.'} />}
          <InlineError error={startError} />
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
          {running ? (
            <Button size="sm" onClick={job.cancel}>Cancel</Button>
          ) : (
            <Button size="sm" variant={env.lastSnapshot ? 'secondary' : 'primary'} loading={starting} icon={env.lastSnapshot ? <RotateCcw size={14} aria-hidden /> : <Camera size={14} aria-hidden />} onClick={refresh}>
              {env.lastSnapshot ? 'Refresh snapshot' : 'Take snapshot'}
            </Button>
          )}
          {env.lastSnapshot && (
            <LinkButton size="sm" variant="ghost" to={`/p/${projectId}/explore/${encodeURIComponent(env.name)}`} icon={<Compass size={14} aria-hidden />}>Explore</LinkButton>
          )}
          {next && (
            <LinkButton size="sm" variant="ghost" to={`/p/${projectId}/compare?from=${encodeURIComponent(env.name)}&to=${encodeURIComponent(next.name)}`} icon={<GitCompare size={14} aria-hidden />}>
              Compare with {envLabel(next.name)}
            </LinkButton>
          )}
        </div>
      </Card>
    </section>
  );
}

function DiffArrow({ projectId, from, to }: { projectId: string; from: EnvironmentInfo; to: EnvironmentInfo }) {
  const diff = useRawDifferences(projectId, from.name, to.name, from.lastSnapshot?.commit, to.lastSnapshot?.commit);
  const href = `/p/${projectId}/compare?from=${encodeURIComponent(from.name)}&to=${encodeURIComponent(to.name)}`;
  const both = Boolean(from.lastSnapshot && to.lastSnapshot);
  return (
    <div className="flex w-28 shrink-0 flex-col items-center justify-center gap-2 px-1 text-center">
      <ArrowRight size={20} aria-hidden className="text-border-strong" />
      {!both && <span className="text-xs text-subtle">Snapshot both to compare</span>}
      {both && diff.isPending && <span className="flex items-center gap-1.5 text-xs text-muted"><Spinner size={12} /> Comparing…</span>}
      {both && diff.isError && <Link to={href} className="text-xs font-medium text-accent hover:underline">Compare</Link>}
      {both && diff.data !== undefined && (
        <Link
          to={href}
          className={diff.data ? 'rounded-full bg-changed-soft px-2.5 py-1 text-xs font-medium text-changed hover:underline' : 'text-xs text-muted hover:underline'}
        >
          {diff.data ? plural(diff.data, 'difference') : 'No differences'}
        </Link>
      )}
    </div>
  );
}

const activityIcon: Record<HistoryType, typeof Camera> = {
  snapshot: Camera,
  changeset: Layers,
  applied: CheckCircle2,
  backup: Server,
  restore: Undo2,
  drift: RotateCcw,
  project: Plus,
};

function RecentActivity({ projectId, history }: { projectId: string; history: HistoryEvent[] }) {
  const items = newestFirst(history).slice(0, 8);
  return (
    <section aria-labelledby="recent-activity" className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recent-activity" className="text-[15px] font-semibold text-fg">Recent activity</h2>
        {items.length > 0 && <Link to={`/p/${projectId}/history`} className="text-sm font-medium text-accent hover:underline">View history</Link>}
      </div>
      <Card>
        {items.length === 0 ? (
          <EmptyState icon={<HistoryIcon size={20} />} title="Nothing yet" description="Snapshots and promotions will be listed here." className="py-10" />
        ) : (
          <div className="divide-y divide-border">
            {items.map((e) => {
              const Icon = activityIcon[e.type] ?? HistoryIcon;
              return (
                <div key={e.id} className="flex items-center gap-3 px-5 py-3">
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><Icon size={14} /></span>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{e.title}</span>
                  {e.drifted.length > 0 && <Badge tone="drift">{plural(e.drifted.length, 'drifted', 'drifted')}</Badge>}
                  <span className="shrink-0 text-xs text-subtle">{timeAgo(e.at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </section>
  );
}

export function OverviewPage() {
  const { project, history } = useProjectContext();
  const envs = project.environments;
  const snapshots = latestByEnv(history, 'snapshot');
  const runs = latestByEnv(history, 'applied');

  if (!envs.length) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Card>
          <EmptyState
            icon={<Server size={20} />}
            title="Add your first environment"
            description="Connect a Kinetic space, such as Dev, to start exploring and promoting."
            action={<LinkButton to={`/p/${project.id}/settings/environments`} variant="primary" icon={<Plus size={16} aria-hidden />}>Add environment</LinkButton>}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Overview</h1>
        <p className="mt-0.5 text-sm text-muted">Changes move left to right through the pipeline.</p>
      </div>
      <div className="flex items-stretch overflow-x-auto pb-2">
        {envs.map((env, i) => (
          <div key={env.name} className="flex shrink-0 items-stretch">
            {i > 0 && <DiffArrow projectId={project.id} from={envs[i - 1]} to={env} />}
            <Lane projectId={project.id} env={env} next={envs[i + 1]} drift={snapshots[env.name]?.drifted.length} run={runs[env.name]} />
          </div>
        ))}
      </div>
      {!envs.some((e) => e.lastSnapshot) && (
        <p className="mt-4 text-sm text-muted">Take a snapshot of an environment to see what it contains.</p>
      )}
      <RecentActivity projectId={project.id} history={history} />
    </div>
  );
}
