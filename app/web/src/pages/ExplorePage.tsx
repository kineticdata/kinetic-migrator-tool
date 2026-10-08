// Explore: an environment's newest snapshot as a searchable, filterable
// object tree (lazy, virtualized) beside the detail pane of the selected
// item. The selected item lives in the URL (`?item=`) so links and Back work.
// "Refresh snapshot" takes a new one with live progress; the project (and so
// the snapshot commit every query is keyed by) reloads when it ends.
import { useEffect, useId, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Camera, Compass, Lock, MousePointerClick, RotateCcw, Search, SearchX, X } from 'lucide-react';
import type { EnvironmentInfo } from '../../../shared/api';
import type { SearchResult, SnapshotResult, TreeNode } from '../../../shared/sync-api';
import { ApiError } from '../api/client';
import { qk, startSnapshot, useExploreItem, useSearch, useTreeChildren, useTreeRoot } from '../api/queries';
import { useJob } from '../api/useJob';
import { DetailPane } from '../components/DetailPane';
import { JobProgress } from '../components/JobProgress';
import { ObjectTree, flattenTree, type ChildrenState, type TreeRow } from '../components/ObjectTree';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../components/ui/EmptyState';
import { inputClasses } from '../components/ui/Field';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { cn } from '../components/ui/cn';
import { envLabel, plural, timeAgo } from '../lib/format';
import { useProjectContext } from '../lib/project';
import { ancestorsOf, sectionOf } from '../lib/tree-layout';
import { segmentLabel } from '../lib/key-label';

const SEARCH_DELAY_MS = 250;
const ALL = 'all';

// Where a search result lives, in a few words.
function whereOf(r: SearchResult): string {
  if (r.match === 'field' && r.field) return `field ${r.field}`;
  const p = r.key.split('/');
  if (p[0] === 'kapps' && p.length > 3) return segmentLabel(p[1]);
  if (p[0] === 'connections' && p[2] === 'operations') return segmentLabel(p[1]);
  return '';
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function useSnapshotJob(projectId: string, env: string) {
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const label = envLabel(env);
  const job = useJob<SnapshotResult>(jobId, {
    invalidate: [qk.project(projectId)],
    onDone: (j) => {
      if (j.status !== 'succeeded') return;
      const r = j.result;
      toast.show({ tone: 'success', title: `Snapshot of ${label} taken`, description: r ? (r.commit ? plural(r.total, 'item') : 'Nothing changed since the last snapshot.') : undefined });
    },
  });
  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      setJobId((await startSnapshot(projectId, env)).jobId);
    } catch (err) {
      setStartError(err instanceof ApiError && err.code === 'locked' ? new Error(`Something is already running against ${label}.`) : err);
    } finally {
      setStarting(false);
    }
  };
  return { job, start, starting, startError };
}

function SnapshotBar({ projectId, env }: { projectId: string; env: EnvironmentInfo }) {
  const { job, start, starting, startError } = useSnapshotJob(projectId, env.name);
  const running = job.status === 'running';
  const label = envLabel(env.name);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border bg-surface px-6 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight text-fg">Explore {label}</h1>
        {env.readOnly && <Badge icon={<Lock size={11} aria-hidden />}>Protected</Badge>}
        <span className="text-sm text-muted">
          {env.lastSnapshot ? <>Snapshot taken <time dateTime={env.lastSnapshot.at}>{timeAgo(env.lastSnapshot.at)}</time></> : 'No snapshot yet'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {running && <div className="w-56"><JobProgress job={job} label={`Snapshot of ${label}`} /></div>}
        {running ? (
          <Button size="sm" onClick={job.cancel}>Cancel</Button>
        ) : (
          <Button
            size="sm"
            variant={env.lastSnapshot ? 'secondary' : 'primary'}
            loading={starting}
            icon={env.lastSnapshot ? <RotateCcw size={14} aria-hidden /> : <Camera size={14} aria-hidden />}
            onClick={start}
          >
            {env.lastSnapshot ? 'Refresh snapshot' : 'Take snapshot'}
          </Button>
        )}
      </div>
      {(job.status === 'failed' || job.status === 'cancelled' || startError) ? (
        <div className="w-full"><InlineError error={startError ?? job.error ?? 'The snapshot was cancelled.'} /></div>
      ) : null}
    </div>
  );
}

function TreePanel({ projectId, env, commit, selectedKey, onSelect }: {
  projectId: string;
  env: string;
  commit: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const filterId = useId();
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), SEARCH_DELAY_MS);
  const searching = text.trim() !== '';
  const [filter, setFilter] = useState(ALL);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const root = useTreeRoot(projectId, env, commit);
  const open = useMemo(() => [...expanded], [expanded]);
  const childQueries = useTreeChildren(projectId, env, commit, open);
  const children = useMemo(() => {
    const m = new Map<string, ChildrenState>();
    open.forEach((id, i) => {
      const q = childQueries[i];
      m.set(id, q?.data ?? (q?.isError ? 'error' : 'loading'));
    });
    return m;
  }, [open, childQueries]);
  const search = useSearch(projectId, env, commit, query);

  const roots = useMemo(() => (root.data ?? []).filter((n) => filter === ALL || n.id === filter), [root.data, filter]);
  const rows = useMemo(() => flattenTree(roots, children, expanded).map((r) => (children.get(r.node.id) === 'error' && r.expanded ? { ...r, detail: 'Could not load' } : r)), [roots, children, expanded]);

  const results = useMemo<TreeRow[]>(() => {
    const list = (search.data?.results ?? []).filter((r) => filter === ALL || sectionOf(r.key) === filter);
    return list.map((r, i) => ({
      node: { id: r.key, key: r.key, label: r.label, kind: r.kind, count: 0, hasChildren: false },
      depth: 0, parentId: null, expanded: false, loading: false, pos: i + 1, size: list.length, detail: whereOf(r),
    }));
  }, [search.data, filter]);

  const toggle = (id: string, isOpen: boolean) => setExpanded((s) => {
    const next = new Set(s);
    if (isOpen) next.add(id);
    else next.delete(id);
    return next;
  });
  // Reveal the selected item: open every node above it.
  useEffect(() => {
    if (!selectedKey) return;
    const above = ancestorsOf(selectedKey);
    setExpanded((s) => (above.every((id) => s.has(id)) ? s : new Set([...s, ...above])));
  }, [selectedKey]);

  const select = (node: TreeNode) => node.key && onSelect(node.key);
  const changeFilter = (value: string) => {
    setFilter(value);
    if (value !== ALL && root.data?.find((n) => n.id === value)?.hasChildren) toggle(value, true);
  };

  let body;
  if (root.isPending) body = <LoadingState label="Loading items…" />;
  else if (root.isError) body = <ErrorState title="Could not load the items" error={root.error} onRetry={() => root.refetch()} />;
  else if (searching) {
    // Earlier results stay up while the next query settles.
    if (!search.data && search.isError) body = <ErrorState title="Search failed" error={search.error} onRetry={() => search.refetch()} />;
    else if (!search.data) body = <LoadingState label="Searching…" />;
    else if (!results.length) body = <EmptyState icon={<SearchX size={20} />} title="No matches" description="Try part of a name, a slug or a field name." className="py-10" />;
    else {
      body = (
        <>
          <ObjectTree label="Search results" rows={results} selectedKey={selectedKey} onSelect={select} onToggle={() => {}} className="min-h-0 flex-1 py-1" />
          <p className="border-t border-border px-4 py-2 text-xs text-muted" aria-live="polite">
            {search.data?.truncated ? `Showing the first ${results.length.toLocaleString('en')} matches` : plural(results.length, 'match', 'matches')}
          </p>
        </>
      );
    }
  } else {
    body = <ObjectTree label={`Items in ${envLabel(env)}`} rows={rows} selectedKey={selectedKey} onSelect={select} onToggle={toggle} className="min-h-0 flex-1 py-1" />;
  }

  return (
    <div className="flex h-[420px] min-h-0 flex-col border-b border-border bg-surface lg:h-auto lg:border-r lg:border-b-0">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            aria-label="Search items"
            placeholder="Search names, slugs and fields"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setText(''); }}
            className={cn(inputClasses, 'pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden')}
          />
          {text && (
            <span className="absolute top-1/2 right-1 -translate-y-1/2">
              {search.isFetching || query !== text.trim() ? <span className="flex size-8 items-center justify-center text-subtle"><Spinner size={14} /></span> : <IconButton label="Clear search" icon={<X size={14} aria-hidden />} onClick={() => setText('')} />}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-xs font-medium text-muted">Show</label>
          <select id={filterId} value={filter} onChange={(e) => changeFilter(e.target.value)} className={cn(inputClasses, 'h-8 flex-1 py-0 text-[13px]')}>
            <option value={ALL}>All items</option>
            {(root.data ?? []).map((n) => (
              <option key={n.id} value={n.id}>{n.label} ({(n.count + (n.key ? 1 : 0)).toLocaleString('en')})</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}

function ItemPanel({ projectId, env, commit, itemKey, onOpen }: { projectId: string; env: string; commit: string; itemKey: string | null; onOpen: (key: string) => void }) {
  const { history } = useProjectContext();
  const item = useExploreItem(projectId, env, commit, itemKey);
  if (!itemKey) {
    return (
      <EmptyState
        icon={<MousePointerClick size={20} />}
        title="Select an item"
        description="Pick something in the tree to see its summary, what it uses and what uses it."
        className="h-full"
      />
    );
  }
  if (item.isPending) return <LoadingState label="Loading item…" />;
  if (item.isError) {
    const gone = item.error instanceof ApiError && item.error.status === 404;
    return <ErrorState title={gone ? 'Not in this snapshot' : 'Could not load the item'} error={item.error} onRetry={gone ? undefined : () => item.refetch()} />;
  }
  return <DetailPane key={item.data.key} item={item.data} events={history} onOpen={onOpen} />;
}

export function ExplorePage() {
  const { project } = useProjectContext();
  const { env: envName = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const env = project.environments.find((e) => e.name === envName);
  const itemKey = params.get('item');
  const open = (key: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set('item', key);
    return next;
  });

  if (!env) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Card><EmptyState icon={<Compass size={20} />} title="No such environment" description={`This project has no environment named “${envName}”.`} /></Card>
      </div>
    );
  }
  const commit = env.lastSnapshot?.commit;

  return (
    <div className="flex flex-col lg:h-full lg:min-h-[520px]">
      <SnapshotBar key={env.name} projectId={project.id} env={env} />
      {commit ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,380px)_1fr] lg:grid-rows-[minmax(0,1fr)]">
          <TreePanel key={env.name} projectId={project.id} env={env.name} commit={commit} selectedKey={itemKey} onSelect={open} />
          <div className="min-h-0 overflow-hidden">
            <ItemPanel projectId={project.id} env={env.name} commit={commit} itemKey={itemKey} onOpen={open} />
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <Card>
            <EmptyState
              icon={<Camera size={20} />}
              title={`No snapshot of ${envLabel(env.name)} yet`}
              description="Take a snapshot to see everything in this environment. It takes about a minute; you can keep working meanwhile."
            />
          </Card>
        </div>
      )}
    </div>
  );
}
