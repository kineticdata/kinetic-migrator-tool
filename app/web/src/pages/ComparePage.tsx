// Compare: what differs between two environments, as the Explore tree with a
// status per item, rolled-up counts and tri-state checkboxes; the selected
// item's changes (a readable table, side-by-side JSON, or the three-way view
// of a drifted item); and the changeset tray, always visible, with explained
// suggestions, Review plan → and Save as changeset…. An item only in the
// target has no checkbox: its own Remove action marks it for removal (never a
// parent tick, never a suggestion).
//
// From, To, the mode and the open item live in the URL. A finished comparison
// is cached by its inputs and both snapshot commits, so returning is instant
// and a new snapshot means a new comparison. The selection is kept per
// From → To pair for the browser session and is pruned to what still differs
// whenever the comparison changes.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight, ArrowRight, Camera, ChevronsDownUp, ChevronsUpDown, GitCompare, MousePointerClick, RotateCcw, Search, Trash2, X,
} from 'lucide-react';
import type { JobStarted } from '../../../shared/api';
import type {
  CompareItem, CompareMode, CompareResult, CompareStatus, CompareTreeNode, PlanResult, Resolution, SuggestionOut,
} from '../../../shared/sync-api';
import { ApiError, api, projectPath } from '../api/client';
import {
  compareChildrenQuery, qk, startCompare, startPlan, useCompareChildren, useCompareItem, useCreateChangeset, useIntegrationNames, useSuggestions,
} from '../api/queries';
import { useJob } from '../api/useJob';
import { ChangesetTray, type TrayItem } from '../components/ChangesetTray';
import { CountBar, ItemStatus, RollupCounts } from '../components/CountBar';
import { DiffNamesProvider, FieldDiffTable, ThreeWayDiff } from '../components/FieldDiffTable';
import { JobProgress } from '../components/JobProgress';
import { JsonView } from '../components/JsonView';
import { KindIcon, ObjectTree, flattenTree, type ChildrenState, type TreeRow } from '../components/ObjectTree';
import { Notes } from '../components/Notes';
import { SuggestionsList, uniqueSuggestions } from '../components/SuggestionsList';
import { Button, IconButton, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../components/ui/EmptyState';
import { Switch, inputClasses } from '../components/ui/Field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { cn } from '../components/ui/cn';
import { envLabel, formatDateTime, plural } from '../lib/format';
import { newestFirst, useProjectContext } from '../lib/project';
import {
  SELECTABLE, addItems, checkStateOf, emptySelection, isMarkedForRemoval, isRemovable, isSelectable, planResolutions, pruneSelection, removalKeys, removeKeys, selectedKeys,
  setResolution, tickKind, toggleItem, toggleNode, toggleRemoval, underCounts, unmarkRemovals, type CheckState, type KeyStatus, type Selection,
} from '../lib/selection';
import { ancestorsOf, kindOfKey, nameOfKey } from '../lib/tree-layout';
import { entryItemKey, entryLabel, isEntryKey } from '../lib/key-label';

const ALL = 'all';

// The server forgot this comparison (it keeps the latest few, in memory).
const isExpired = (err: unknown) => err instanceof ApiError && err.status === 404 && /expired/i.test(err.message);
const MAX_EXPAND = 1500;

// ---- Selection, kept per From → To pair for the session -----------------------

const storageKey = (p: string, from: string, to: string) => `km-changeset:${p}:${from}:${to}`;

function loadSelection(key: string): Selection {
  try {
    const raw = sessionStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v.items === 'object' && typeof v.resolutions === 'object') {
      return { ...v, remove: Array.isArray(v.remove) ? v.remove.filter((k: unknown) => typeof k === 'string') : [] } as Selection;
    }
  } catch {
    // Unavailable or unreadable: start empty.
  }
  return emptySelection();
}

function useSelection(p: string, from: string, to: string) {
  const key = storageKey(p, from, to);
  const [state, setState] = useState(() => ({ key, sel: loadSelection(key) }));
  const sel = state.key === key ? state.sel : loadSelection(key);
  const update = useCallback((fn: (s: Selection) => Selection) => {
    setState((cur) => {
      const base = cur.key === key ? cur.sel : loadSelection(key);
      const next = fn(base);
      if (next === base && cur.key === key) return cur;
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not essential.
      }
      return { key, sel: next };
    });
  }, [key]);
  return [sel, update] as const;
}

// ---- Running the comparison ---------------------------------------------------

// `toVersion` identifies the target's state: its snapshot commit, or for a
// live target the project's newest history commit (a snapshot or an apply
// adds one, so the live comparison runs again afterwards).
// `restore` (a backup or snapshot commit) compares that backup with the live
// environment instead, through the server's restore endpoint.
function useCompareRun(p: string, opts: { from: string; to: string; mode: CompareMode; live: boolean; fromCommit?: string; toVersion?: string; restore?: string | null }) {
  const { from, to, mode, live, fromCommit, toVersion, restore } = opts;
  const qc = useQueryClient();
  const queryKey = restore
    ? qk.compareRun(p, `restore:${restore}`, to, mode, true, restore, toVersion ?? '')
    : qk.compareRun(p, from, to, mode, live, fromCommit ?? '', toVersion ?? '');
  const keyStr = JSON.stringify(queryKey);
  const cached = useQuery<CompareResult>({ queryKey, enabled: false, staleTime: Infinity, gcTime: Infinity, queryFn: () => Promise.reject(new Error('not run')) });
  const ready = restore ? Boolean(to) : Boolean(fromCommit && (toVersion || (mode === 'preview' && live)) && from !== to);
  const [run, setRun] = useState<{ jobId: string; key: string } | null>(null);
  const [startError, setStartError] = useState<{ key: string; error: unknown } | null>(null);
  const started = useRef<string | null>(null);

  const job = useJob<CompareResult>(run && run.key === keyStr ? run.jobId : null, {
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result && run) qc.setQueryData(JSON.parse(run.key), j.result);
    },
  });

  const start = useCallback(async () => {
    started.current = keyStr;
    setStartError(null);
    try {
      const body = mode === 'preview' ? { from, to, mode, useSnapshots: !live } : { from, to, mode };
      const { jobId } = restore
        ? await api.post<JobStarted>(projectPath(p, 'restore'), { commit: restore, mode })
        : await startCompare(p, body);
      setRun({ jobId, key: keyStr });
    } catch (error) {
      setStartError({ key: keyStr, error });
    }
  }, [p, from, to, mode, live, keyStr, restore]);

  useEffect(() => {
    if (ready && !cached.data && started.current !== keyStr) start();
  }, [ready, cached.data, keyStr, start]);

  const running = Boolean(run && run.key === keyStr && job.status === 'running');
  const error = startError?.key === keyStr ? startError.error : (run?.key === keyStr && (job.status === 'failed' || job.status === 'cancelled') ? job.error ?? 'The comparison was cancelled.' : null);
  // The server no longer has the cached comparison: forget it and run again.
  const expire = useCallback(() => {
    if (qc.getQueryData(JSON.parse(keyStr)) === undefined) return;
    started.current = null;
    qc.resetQueries({ queryKey: JSON.parse(keyStr), exact: true });
  }, [qc, keyStr]);
  return { result: cached.data, ready, running, job, error, rerun: start, expire };
}

// ---- Tree ---------------------------------------------------------------------

const differs = (n: CompareTreeNode) => (n.status !== undefined && n.status !== 'same') || Object.entries(n.counts).some(([s, c]) => s !== 'same' && (c ?? 0) > 0)
  || (n.entries ?? 0) > 0 || (n.entriesBelow ?? 0) > 0;
const hasStatus = (n: CompareTreeNode, s: CompareStatus) => n.status === s || (n.counts[s] ?? 0) > 0;
const selectableBelow = (n: CompareTreeNode) => [...SELECTABLE].some((s) => (n.counts[s] ?? 0) > 0);

interface TreeFilters {
  onlyDiff: boolean;
  status: CompareStatus | null;
  section: string;
  text: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Items below `node` that a parent tick may select (loads what it needs),
// limited to what the current filters show.
async function collectBelow(
  qc: ReturnType<typeof useQueryClient>, p: string, id: string, node: CompareTreeNode, shown: (n: CompareTreeNode) => boolean,
): Promise<KeyStatus[]> {
  const out: KeyStatus[] = [];
  let level = [node];
  while (level.length) {
    const lists = await Promise.all(level.map((n) => qc.fetchQuery(compareChildrenQuery(p, id, n.id))));
    level = [];
    for (const c of lists.flat()) {
      if (!shown(c)) continue;
      if (c.key && isSelectable(c.status)) out.push({ key: c.key, status: c.status! });
      if (c.hasChildren && selectableBelow(c)) level.push(c);
    }
  }
  return out;
}

const DRIFT_HINT = 'Only drifted items are below: review each one and choose Overwrite or Keep.';

function CompareTree({ projectId, result, sel, setSel, selectedKey, onSelect, filters, setFilters, onAdded, onExpired }: {
  projectId: string;
  result: CompareResult;
  sel: Selection;
  setSel: (fn: (s: Selection) => Selection) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  filters: TreeFilters;
  setFilters: (f: Partial<TreeFilters>) => void;
  // Keys a parent tick added.
  onAdded: (keys: string[]) => void;
  // The server no longer has this comparison.
  onExpired: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const filterId = useId();
  const id = result.compareId;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expanding, setExpanding] = useState(false);
  const text = useDebounced(filters.text.trim().toLowerCase(), 200);

  const open = useMemo(() => ['', ...expanded], [expanded]);
  const queries = useCompareChildren(projectId, id, open);
  const rootQuery = queries[0];
  const children = useMemo(() => {
    const m = new Map<string, ChildrenState>();
    open.forEach((nid, i) => {
      if (!nid) return;
      const q = queries[i];
      m.set(nid, q?.data ?? (q?.isError ? 'error' : 'loading'));
    });
    return m;
  }, [open, queries]);

  // Structural filters (known without loading children).
  const visible = useCallback((n: CompareTreeNode) => (!filters.onlyDiff || differs(n)) && (!filters.status || hasStatus(n, filters.status)), [filters.onlyDiff, filters.status]);

  // Search: a node stays when its label matches or a loaded descendant does.
  const matching = useMemo(() => {
    if (!text) return null;
    const keep = new Set<string>();
    const walk = (list: CompareTreeNode[]): boolean => {
      let any = false;
      for (const node of list) {
        const kids = children.get(node.id);
        const below = Array.isArray(kids) ? walk(kids as CompareTreeNode[]) : false;
        if (below || node.label.toLowerCase().includes(text)) {
          keep.add(node.id);
          any = true;
        }
      }
      return any;
    };
    walk(rootQuery?.data ?? []);
    return keep;
  }, [text, children, rootQuery?.data]);

  const rows = useMemo(() => {
    const pick = (list: CompareTreeNode[]) => list.filter((n) => visible(n) && (!matching || matching.has(n.id)));
    const roots = pick((rootQuery?.data ?? []).filter((n) => filters.section === ALL || n.id === filters.section));
    const kids = new Map<string, ChildrenState>();
    children.forEach((v, k) => kids.set(k, Array.isArray(v) ? pick(v as CompareTreeNode[]) : v));
    return flattenTree(roots, kids, expanded).map((r) => (children.get(r.node.id) === 'error' && r.expanded ? { ...r, detail: 'Could not load' } : r));
  }, [rootQuery?.data, children, expanded, visible, matching, filters.section]);

  const toggle = (nid: string, isOpen: boolean) => setExpanded((s) => {
    const next = new Set(s);
    if (isOpen) next.add(nid);
    else next.delete(nid);
    return next;
  });

  // Expand all: open every visible node with children, level by level.
  const expandAll = useCallback(async () => {
    setExpanding(true);
    try {
      const ids: string[] = [];
      let level = (await qc.fetchQuery(compareChildrenQuery(projectId, id, ''))).filter((n) => n.hasChildren && visible(n) && (filters.section === ALL || n.id === filters.section));
      while (level.length && ids.length < MAX_EXPAND) {
        ids.push(...level.map((n) => n.id));
        const lists = await Promise.all(level.map((n) => qc.fetchQuery(compareChildrenQuery(projectId, id, n.id))));
        level = lists.flat().filter((n) => n.hasChildren && visible(n));
      }
      setExpanded(new Set(ids.slice(0, MAX_EXPAND)));
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not expand everything', description: err instanceof Error ? err.message : undefined });
    } finally {
      setExpanding(false);
    }
  }, [qc, projectId, id, visible, filters.section, toast]);

  // Searching looks through everything.
  useEffect(() => {
    if (text) expandAll();
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reveal the open item.
  useEffect(() => {
    if (!selectedKey) return;
    const above = ancestorsOf(selectedKey);
    setExpanded((s) => (above.every((a) => s.has(a)) ? s : new Set([...s, ...above])));
  }, [selectedKey]);

  const under = useMemo(() => underCounts(sel), [sel]);
  const checkState = useCallback((row: TreeRow): CheckState => checkStateOf(row.node as CompareTreeNode, sel, under), [sel, under]);
  const checkHint = useCallback((row: TreeRow) => (tickKind(row.node as CompareTreeNode) === 'disabled' ? DRIFT_HINT : null), []);

  // The comparison expired on the server (for example after a restart).
  const expired = queries.some((q) => q.isError && isExpired(q.error));
  useEffect(() => {
    if (expired) onExpired();
  }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps

  // One parent tick at a time: clicks while one is loading are ignored.
  const pending = useRef(false);
  const onCheck = async (row: TreeRow) => {
    const node = row.node as CompareTreeNode;
    const state = checkState(row);
    const kind = tickKind(node);
    if (pending.current || kind === 'disabled' || kind === 'none') return;
    if (kind === 'self' || (node.key && !selectableBelow(node))) {
      setSel((s) => toggleItem(s, node.key!, node.status!));
      return;
    }
    if (state === 'checked') {
      const below = selectedKeys(sel).filter((k) => ancestorsOf(k).includes(node.id)).map((key) => ({ key, status: sel.items[key] }));
      setSel((s) => toggleNode(s, node, below, 'checked'));
      return;
    }
    pending.current = true;
    try {
      const shown = (n: CompareTreeNode) => visible(n) && (!matching || matching.has(n.id));
      const below = await collectBelow(qc, projectId, id, node, shown);
      const before = new Set(selectedKeys(sel));
      const next = toggleNode(sel, node, below, state);
      setSel((s) => toggleNode(s, node, below, state));
      const added = selectedKeys(next).filter((k) => !before.has(k));
      if (added.length) onAdded(added);
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not select the items', description: err instanceof Error ? err.message : undefined });
    } finally {
      pending.current = false;
    }
  };

  const aside = (row: TreeRow) => {
    const node = row.node as CompareTreeNode;
    const removable = Boolean(node.key && isRemovable(node.status));
    const marked = removable && isMarkedForRemoval(sel, node.key!);
    return (
      <>
        {node.hasChildren && <RollupCounts counts={node.counts} to={result.to} />}
        {node.key && node.status && !marked && <ItemStatus status={node.status} to={result.to} />}
        {(node.entries ?? 0) > 0 && (
          <span
            title={`${plural(node.entries!, 'entry', 'entries')} only in ${envLabel(result.to)} (open the item to remove them)`}
            className="inline-flex h-5 items-center rounded-md border border-transparent bg-removed-soft px-1.5 text-xs font-medium text-removed"
          >
            <span aria-hidden>−</span>{node.entries}<span className="sr-only"> entries only in {envLabel(result.to)}</span>
          </span>
        )}
        {removable && (
          // Mouse shortcut for the detail pane's Remove from … button (the
          // treeitem itself stays the one focusable row).
          <span
            aria-hidden
            data-remove
            title={marked ? `Keep in ${envLabel(result.to)}` : `Remove from ${envLabel(result.to)}`}
            onClick={(e) => {
              e.stopPropagation();
              setSel((cur) => toggleRemoval(cur, node.key!, node.status));
            }}
            className={cn(
              'inline-flex h-5 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-xs font-medium',
              marked ? 'border-danger bg-danger text-danger-fg' : 'border-danger/40 text-danger hover:bg-danger-soft',
            )}
          >
            <Trash2 size={11} />{marked ? 'Removing' : 'Remove'}
          </span>
        )}
      </>
    );
  };

  let body;
  if (!rootQuery || rootQuery.isPending) body = <LoadingState label="Loading differences…" />;
  else if (expired) body = <LoadingState label="Running the comparison again…" />;
  else if (rootQuery.isError) body = <ErrorState title="Could not load the differences" error={rootQuery.error} onRetry={() => rootQuery.refetch()} />;
  else if (!rows.length) {
    body = (
      <EmptyState
        title={filters.text || filters.status || filters.section !== ALL ? 'Nothing matches' : 'No differences'}
        description={filters.text || filters.status || filters.section !== ALL ? 'Clear the filters to see everything.' : `${envLabel(result.to)} already matches ${result.fromName}.`}
        className="py-10"
      />
    );
  } else {
    body = (
      <ObjectTree
        label={`Differences, ${result.fromName} to ${envLabel(result.to)}`}
        rows={rows}
        selectedKey={selectedKey}
        onSelect={(node) => node.key && onSelect(node.key)}
        onToggle={toggle}
        renderAside={aside}
        checkState={checkState}
        checkHint={checkHint}
        onCheck={onCheck}
        showCounts={false}
        className="min-h-0 flex-1 py-1"
      />
    );
  }

  return (
    <div className="flex h-[460px] min-h-0 flex-col border-b border-border bg-surface lg:h-auto lg:border-r lg:border-b-0">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            aria-label="Filter by name"
            placeholder="Filter by name"
            value={filters.text}
            onChange={(e) => setFilters({ text: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') setFilters({ text: '' }); }}
            className={cn(inputClasses, 'pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden')}
          />
          {filters.text && <span className="absolute top-1/2 right-1 -translate-y-1/2"><IconButton label="Clear filter" icon={<X size={14} aria-hidden />} onClick={() => setFilters({ text: '' })} /></span>}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-xs font-medium text-muted">Show</label>
          <select id={filterId} value={filters.section} onChange={(e) => setFilters({ section: e.target.value })} className={cn(inputClasses, 'h-8 flex-1 py-0 text-[13px]')}>
            <option value={ALL}>All types</option>
            {(rootQuery?.data ?? []).filter((n) => !filters.onlyDiff || differs(n)).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Switch checked={filters.onlyDiff} onCheckedChange={(v) => setFilters({ onlyDiff: v })} label="Only differences" />
          <div className="flex items-center">
            <IconButton label="Expand all" icon={<ChevronsUpDown size={15} aria-hidden />} loading={expanding} onClick={expandAll} />
            <IconButton label="Collapse all" icon={<ChevronsDownUp size={15} aria-hidden />} onClick={() => setExpanded(new Set())} />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}

// ---- Detail -------------------------------------------------------------------

function ItemDetail({ projectId, result, itemKey, sel, setSel, suggestions, onAddSuggestion, onExpired }: {
  projectId: string;
  result: CompareResult;
  itemKey: string | null;
  sel: Selection;
  setSel: (fn: (s: Selection) => Selection) => void;
  suggestions: SuggestionOut[];
  onAddSuggestion: (s: SuggestionOut) => void;
  onExpired: () => void;
}) {
  const item = useCompareItem(projectId, result.compareId, itemKey);
  const expired = item.isError && isExpired(item.error);
  useEffect(() => {
    if (expired) onExpired();
  }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState('changes');
  const headingId = useId();
  const { project } = useProjectContext();
  const snapshotOf = (name: string) => project.environments.find((e) => e.name === name)?.lastSnapshot?.commit;
  const fromEnv = result.sourceCommit && !snapshotOf(result.from) ? null : result.from;
  const names = {
    target: useIntegrationNames(projectId, result.to, snapshotOf(result.to), itemKey),
    incoming: useIntegrationNames(projectId, fromEnv, fromEnv ? snapshotOf(fromEnv) : undefined, itemKey),
  };
  if (!itemKey) {
    return <EmptyState icon={<MousePointerClick size={20} />} title="Select an item" description="Pick something in the tree to see exactly what promoting it would change." className="h-full" />;
  }
  if (item.isPending || expired) return <LoadingState label="Loading item…" />;
  if (item.isError) {
    const gone = item.error instanceof ApiError && item.error.status === 404;
    return <ErrorState title={gone ? 'Not in this comparison' : 'Could not load the item'} error={item.error} onRetry={gone ? undefined : () => item.refetch()} />;
  }
  const it: CompareItem = item.data;
  const from = result.fromName;
  const to = result.to;
  const selected = Boolean(sel.items[it.key]);
  const marked = isMarkedForRemoval(sel, it.key);
  const resolution: Resolution | null = selected ? 'overwrite' : sel.resolutions[it.key] === 'keep' ? 'keep' : null;
  const diff = it.diff;
  const mine = suggestions.filter((s) => s.forKey === it.key);

  let changes;
  if (it.status === 'new') changes = <p className="text-sm text-muted">New in {from}: {envLabel(to)} doesn’t have it yet. Everything below is incoming.</p>;
  else if (it.status === 'only-target') {
    changes = (
      <p className="text-sm text-muted">
        Only in {envLabel(to)}. Promoting never deletes it{marked ? `; it is marked to be removed from ${envLabel(to)} when this changeset is applied.` : `. Choose Remove from ${envLabel(to)} to delete it as part of this changeset.`}
      </p>
    );
  }
  else if (!diff.length) changes = <p className="text-sm text-muted">No differences{it.status === 'manual' ? ': this item is promoted by hand.' : '.'}</p>;
  else changes = <DiffNamesProvider value={names}><FieldDiffTable diff={diff} from={from} to={to} /></DiffNamesProvider>;

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><KindIcon kind={kindOfKey(it.key)} className="size-[18px]" /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={headingId} className="truncate text-lg font-semibold tracking-tight text-fg">{it.label}</h2>
              <ItemStatus status={it.status} to={to} />
            </div>
            <p className="mt-1 truncate font-mono text-xs text-subtle" title={it.key}>{it.key}</p>
          </div>
        </div>
        {(it.status === 'new' || it.status === 'changed') && (
          <Button size="sm" variant={selected ? 'secondary' : 'primary'} onClick={() => setSel((s) => toggleItem(s, it.key, it.status))}>
            {selected ? 'Remove from changeset' : 'Add to changeset'}
          </Button>
        )}
        {it.status === 'only-target' && (
          <Button
            size="sm"
            variant={marked ? 'secondary' : 'danger'}
            aria-pressed={marked}
            icon={marked ? undefined : <Trash2 size={14} aria-hidden />}
            onClick={() => setSel((s) => toggleRemoval(s, it.key, it.status))}
          >
            {marked ? `Keep in ${envLabel(to)}` : `Remove from ${envLabel(to)}`}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-8">
        {it.status === 'drifted' && it.threeWay && (
          <DiffNamesProvider value={names}><ThreeWayDiff threeWay={it.threeWay} incoming={it.diff} from={from} to={to} resolution={resolution} onResolve={(r) => setSel((s) => setResolution(s, it.key, it.status, r))} /></DiffNamesProvider>
        )}
        {mine.length > 0 && <SuggestionsList title="This item needs" suggestions={mine} onAdd={onAddSuggestion} />}
        {(it.targetOnlyEntries?.length ?? 0) > 0 && (
          <section aria-label={`Only in ${envLabel(to)}`} className="overflow-hidden rounded-xl border border-border">
            <h3 className="border-b border-border bg-surface-2/60 px-4 py-2 text-[13px] font-semibold text-fg">
              Only in {envLabel(to)} <span className="font-normal text-muted">· kept when promoting; remove one on purpose to delete it</span>
            </h3>
            <ul className="divide-y divide-border">
              {it.targetOnlyEntries!.map((e) => {
                const on = isMarkedForRemoval(sel, e.key);
                return (
                  <li key={e.key} className="flex items-center gap-3 px-4 py-2">
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm text-fg', on && 'line-through decoration-danger/60')}>{e.name}</span>
                      <span className="block text-xs text-muted">{e.word}</span>
                    </span>
                    <Button
                      size="sm"
                      variant={on ? 'secondary' : 'danger'}
                      aria-pressed={on}
                      aria-label={on ? `Keep ${e.name} in ${envLabel(to)}` : `Remove ${e.name} from ${envLabel(to)}`}
                      onClick={() => setSel((cur) => toggleRemoval(cur, e.key, 'only-target'))}
                    >
                      {on ? `Keep in ${envLabel(to)}` : `Remove from ${envLabel(to)}`}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <Tabs value={view} onValueChange={setView}>
          <TabsList label="View">
            <TabsTrigger value="changes">Changes{diff.length > 0 && it.status === 'changed' && <span className="ml-1.5 text-subtle tabular-nums">{diff.length}</span>}</TabsTrigger>
            <TabsTrigger value="json">Side by side</TabsTrigger>
          </TabsList>
          <TabsContent value="changes" className="pt-4 outline-none">
            {changes}
            {it.status === 'new' && <div className="mt-3"><JsonView value={it.incoming} label={`${from} incoming`} /></div>}
          </TabsContent>
          <TabsContent value="json" className="pt-4 outline-none">
            <div className="grid gap-3 xl:grid-cols-2">
              <div className="min-w-0">
                <h3 className="mb-1.5 text-xs font-medium text-muted">{envLabel(to)} now</h3>
                {it.current === null || it.current === undefined ? <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">Not in {envLabel(to)}</p> : <JsonView value={it.current} label={`${envLabel(to)} now`} />}
              </div>
              <div className="min-w-0">
                <h3 className="mb-1.5 text-xs font-medium text-muted">{from} incoming</h3>
                {it.incoming === null || it.incoming === undefined ? <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">Not in {from}</p> : <JsonView value={it.incoming} label={`${from} incoming`} />}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}

// ---- Page ---------------------------------------------------------------------

function EnvSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputClasses, 'h-8 w-auto min-w-28 py-0 text-[13px] font-medium')}>
        {options.map((o) => <option key={o} value={o}>{envLabel(o)}</option>)}
      </select>
    </div>
  );
}

// A radio group of buttons. One tab stop; the arrow keys move the choice.
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>; onChange: (v: T) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    for (let i = 1; i <= options.length; i++) {
      const idx = (at + step * i + options.length * 2) % options.length;
      if (!options[idx].disabled) {
        onChange(options[idx].value);
        refs.current[idx]?.focus();
        return;
      }
    }
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors disabled:opacity-50',
            'focus-visible:outline-2 focus-visible:outline-accent',
            value === o.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Labels, kinds and current statuses of selected keys, from the comparison's
// tree (each key's parent node), plus whether each lookup has settled.
function useSelectionLookup(projectId: string, compareId: string | undefined, keys: string[]) {
  const parents = useMemo(() => [...new Set(['', ...keys.map((k) => ancestorsOf(k).at(-1) ?? '')])], [keys]);
  const queries = useQueries({
    queries: parents.map((parent) => ({ ...compareChildrenQuery(projectId, compareId ?? '', parent), enabled: Boolean(compareId) })),
  });
  return useMemo(() => {
    const byParent = new Map(parents.map((p, i) => [p, queries[i]]));
    const rootsOk = byParent.get('')?.isSuccess ?? false;
    const nodes = new Map<string, CompareTreeNode>();
    const found = new Map<string, CompareStatus | null>();
    for (const key of keys) {
      const q = byParent.get(ancestorsOf(key).at(-1) ?? '');
      if (q?.isSuccess) {
        const node = q.data.find((nd) => nd.key === key);
        if (node) nodes.set(key, node);
        found.set(key, node?.status ?? null);
      } else if (q?.isError && rootsOk && !isExpired(q.error) && q.error instanceof ApiError && q.error.status === 404) {
        // The node above it is gone from a comparison that still exists.
        found.set(key, null);
      }
    }
    return { nodes, found };
  }, [parents, queries, keys]);
}

export function ComparePage() {
  const { project, activeEnv, history } = useProjectContext();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const names = project.environments.map((e) => e.name);
  const pick = (v: string | null) => (v && names.includes(v) ? v : null);
  // Restore: the backup (or snapshot) at ?restore=<commit> as From, the live
  // environment ?to= as To.
  const restoreParam = params.get('restore');
  const restore = restoreParam && /^[0-9a-f]{4,40}$/i.test(restoreParam) ? restoreParam : null;
  const restoreTo = pick(params.get('to')) ?? activeEnv ?? names[0] ?? '';
  const from = restore ? restoreTo : pick(params.get('from')) ?? activeEnv ?? names[0] ?? '';
  const fromIndex = names.indexOf(from);
  const to = restore ? restoreTo : pick(params.get('to')) ?? names[fromIndex + 1] ?? names.find((x) => x !== from) ?? '';
  const mode: CompareMode = params.get('mode') === 'raw' ? 'raw' : 'preview';
  const live = Boolean(restore) || (mode === 'preview' && params.get('live') === '1');
  const itemKey = params.get('item');
  const fromEnv = project.environments.find((e) => e.name === from);
  const toEnv = project.environments.find((e) => e.name === to);

  const setParam = (changes: Record<string, string | null>) => setParams((cur) => {
    const next = new URLSearchParams(cur);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    return next;
  });

  const newest = useMemo(() => newestFirst(history)[0]?.commit ?? '', [history]);
  const run = useCompareRun(project.id, {
    from, to, mode, live, fromCommit: fromEnv?.lastSnapshot?.commit, toVersion: live ? `live:${newest}` : toEnv?.lastSnapshot?.commit, restore,
  });
  const restoreAt = restore ? history.find((e) => e.commit.startsWith(restore) || restore.startsWith(e.commit))?.at : undefined;
  const fromLabel = restore ? `Backup of ${envLabel(to)}${restoreAt ? ` (${formatDateTime(restoreAt)})` : ''}` : envLabel(from);
  const result = useMemo(() => (run.result && restore ? { ...run.result, fromName: fromLabel } : run.result), [run.result, restore, fromLabel]);
  const [sel, setSel] = useSelection(project.id, restore ? `restore:${restore}` : from, to);
  const keys = useMemo(() => selectedKeys(sel), [sel]);
  const removing = useMemo(() => removalKeys(sel), [sel]);
  // Entry removals have no tree node of their own.
  const looked = useMemo(() => [...keys, ...removing.filter((k) => !isEntryKey(k))], [keys, removing]);
  const [filters, setFilterState] = useState<TreeFilters>({ onlyDiff: true, status: null, section: ALL, text: '' });
  const setFilters = (f: Partial<TreeFilters>) => setFilterState((cur) => ({ ...cur, ...f }));

  // Preselected items (a restore) are ticked once per comparison.
  const preselectedFor = useRef<string | null>(null);
  const lookup = useSelectionLookup(project.id, result?.compareId, looked);
  // Their statuses come from the comparison's tree; drifted ones are left
  // for a decision.
  useEffect(() => {
    if (!result || preselectedFor.current === result.compareId || !result.preselected.length) return;
    preselectedFor.current = result.compareId;
    const wanted = result.preselected;
    const parents = [...new Set(wanted.map((k) => ancestorsOf(k).at(-1) ?? ''))];
    Promise.all(parents.map((parent) => qc.fetchQuery(compareChildrenQuery(project.id, result.compareId, parent)).catch(() => [] as CompareTreeNode[])))
      .then((lists) => {
        const status = new Map(lists.flat().filter((nd) => nd.key).map((nd) => [nd.key!, nd.status]));
        const items = wanted.flatMap((key): KeyStatus[] => {
          const st = status.get(key);
          return st && st !== 'drifted' && isSelectable(st) ? [{ key, status: st }] : [];
        });
        if (items.length) setSel((cur) => addItems(cur, items.filter((i) => !cur.items[i.key])));
      });
  }, [result, setSel, qc, project.id]);

  // Keep the tray to what still differs in the current comparison.
  useEffect(() => {
    if (!lookup.found.size) return;
    const { removed } = pruneSelection(sel, lookup.found);
    setSel((cur) => pruneSelection(cur, lookup.found).selection);
    const label = (k: string) => lookup.nodes.get(k)?.label ?? nameOfKey(k);
    const drifted = removed.filter((k) => lookup.found.get(k) === 'drifted');
    const gone = removed.filter((k) => lookup.found.get(k) !== 'drifted');
    if (gone.length) {
      toast.show({
        tone: 'info',
        title: gone.length === 1 ? `${label(gone[0])} no longer differs` : `${gone.length} items no longer differ`,
        description: 'Taken out of the changeset.',
      });
    }
    if (drifted.length) {
      toast.show({
        tone: 'info',
        title: drifted.length === 1 ? `${label(drifted[0])} is now changed in ${envLabel(to)}: review it` : `${drifted.length} items are now changed in ${envLabel(to)}: review them`,
        description: 'Taken out of the changeset until you choose Overwrite.',
      });
    }
  }, [lookup.found]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestionsQuery = useSuggestions(project.id, result?.compareId, keys);
  // With nothing selected there is nothing to suggest (the query keeps its
  // previous data as a placeholder even while disabled).
  const suggestionData = keys.length ? suggestionsQuery.data : undefined;
  const suggestionsExpired = suggestionsQuery.isError && isExpired(suggestionsQuery.error);
  useEffect(() => {
    if (suggestionsExpired) run.expire();
  }, [suggestionsExpired]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => (suggestionData ?? []).filter((s) => !sel.items[s.key]), [suggestionData, sel]);

  // Items a parent tick just added are highlighted in the tray for a moment.
  const [recent, setRecent] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!recent.size) return undefined;
    const t = setTimeout(() => setRecent(new Set()), 2500);
    return () => clearTimeout(t);
  }, [recent]);
  const onAdded = (added: string[]) => {
    setRecent(new Set(added));
    toast.show({ tone: 'success', title: `Added ${plural(added.length, 'item')} to the changeset` });
  };

  const addSuggestion = (s: SuggestionOut) => !s.unchecked && setSel((cur) => addItems(cur, [{ key: s.key, status: s.status }]));
  // Items the comparison could not check are named, never added.
  const addAll = () => setSel((cur) => addItems(cur, uniqueSuggestions(suggestions).filter((s) => !s.unchecked).map((s) => ({ key: s.key, status: s.status }))));

  const trayItems: TrayItem[] = keys.map((key) => {
    const node = lookup.nodes.get(key);
    const sug = suggestionData?.find((s) => s.key === key);
    return { key, label: node?.label ?? sug?.label ?? nameOfKey(key), kind: node?.kind ?? kindOfKey(key), status: sel.items[key] };
  });
  const trayRemovals: TrayItem[] = removing.map((key) => {
    if (isEntryKey(key)) return { key, label: entryLabel(key), kind: kindOfKey(entryItemKey(key)), status: 'only-target' };
    const node = lookup.nodes.get(key);
    return { key, label: node?.label ?? nameOfKey(key), kind: node?.kind ?? kindOfKey(key), status: 'only-target' };
  });

  // Review plan →: a plan job for the selection, then the plan screen.
  const [planJob, setPlanJob] = useState<string | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const plan = useJob<PlanResult>(planJob, {
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result) navigate(`/p/${project.id}/plan/${encodeURIComponent(j.result.planId)}`);
      else setPlanError(j.error?.message ?? 'The plan did not finish.');
    },
  });
  const review = async () => {
    setPlanError(null);
    try {
      const resolutions = planResolutions(sel);
      const { jobId } = await startPlan(project.id, {
        to, from, selected: keys,
        ...(removing.length ? { remove: removing } : {}),
        ...(result?.sourceCommit ? { sourceCommit: result.sourceCommit } : {}),
        ...(restore ? { restore: true } : {}),
        ...(Object.keys(resolutions).length ? { resolutions } : {}),
      });
      setPlanJob(jobId);
    } catch (err) {
      setPlanError(err);
    }
  };

  const create = useCreateChangeset(project.id);
  const [saved, setSaved] = useState<{ id: string; name: string; href: string; keys: string } | null>(null);
  const savedId = [...keys, '', ...removing].join('\n');
  const save = async (v: { name: string; description: string }) => {
    const cs = await create.mutateAsync({
      name: v.name, description: v.description, from, keys, ...(removing.length ? { remove: removing, removeFrom: to } : {}), ...(result?.sourceCommit ? { sourceCommit: result.sourceCommit } : {}),
    });
    setSaved({ id: cs.id, name: cs.name, href: `/p/${project.id}/changesets/${encodeURIComponent(cs.id)}`, keys: savedId });
    const removed = cs.remove?.length ?? 0;
    toast.show({ tone: 'success', title: `Saved changeset “${cs.name}”`, description: [cs.keys.length ? plural(cs.keys.length, 'item') : '', removed ? `${plural(removed, 'removal')}` : ''].filter(Boolean).join(', ') });
  };
  const savedNow = saved && saved.keys === savedId ? saved : null;

  const open = (key: string) => setParam({ item: entryItemKey(key) });

  if (names.length < 2 && !restore) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Card><EmptyState icon={<GitCompare size={20} />} title="Add a second environment" description="Compare needs two environments, for example Dev and Test." action={<LinkButton to={`/p/${project.id}/settings/environments`} variant="primary">Environments</LinkButton>} /></Card>
      </div>
    );
  }

  const missing = restore ? [] : [fromEnv, ...(live ? [] : [toEnv])].filter((e) => e && !e.lastSnapshot).map((e) => e!.name);

  return (
    <div className="flex flex-col lg:h-full lg:min-h-[560px]">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border bg-surface px-6 py-3">
        <h1 className="text-base font-semibold tracking-tight text-fg">Compare</h1>
        {restore ? (
          <p className="flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-muted">From</span>
            <span className="rounded-md bg-surface-2 px-2 py-1 font-medium text-fg" data-testid="restore-from">{fromLabel}</span>
            <ArrowRight size={14} aria-hidden className="text-subtle" />
            <span className="text-xs font-medium text-muted">To</span>
            <span className="rounded-md bg-surface-2 px-2 py-1 font-medium text-fg">{envLabel(to)} (live)</span>
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <EnvSelect label="From" value={from} options={names} onChange={(v) => setParam({ from: v, to: v === to ? from : to, item: null })} />
            <IconButton label="Swap" icon={<ArrowLeftRight size={14} aria-hidden />} onClick={() => setParam({ from: to, to: from, item: null })} />
            <EnvSelect label="To" value={to} options={names.filter((x) => x !== from)} onChange={(v) => setParam({ to: v, item: null })} />
          </div>
        )}
        <Segmented<CompareMode>
          label="Mode"
          value={mode}
          onChange={(v) => setParam({ mode: v === 'raw' ? 'raw' : null })}
          options={[
            { value: 'preview', label: 'Preview', title: 'What promoting would change, with environment values and drift applied' },
            { value: 'raw', label: 'Raw', title: 'Every difference between the two snapshots' },
          ]}
        />
        {!restore && (
          <Segmented<'snap' | 'live'>
            label="Target"
            value={live ? 'live' : 'snap'}
            onChange={(v) => setParam({ live: v === 'live' ? '1' : null })}
            options={[
              { value: 'snap', label: 'Latest snapshots (instant)' },
              { value: 'live', label: 'Check live target', disabled: mode === 'raw', title: mode === 'raw' ? 'Raw compares the two snapshots' : `Reads ${envLabel(to)} now` },
            ]}
          />
        )}
        <div className="ml-auto flex items-center gap-3">
          {run.running && <div className="w-48"><JobProgress job={run.job} label="Comparing" /></div>}
          {run.running
            ? <Button size="sm" onClick={run.job.cancel}>Cancel</Button>
            : <Button size="sm" icon={<RotateCcw size={14} aria-hidden />} disabled={!run.ready} onClick={() => run.rerun()}>Run again</Button>}
        </div>
      </div>

      {missing.length > 0 ? (
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <Card>
            <EmptyState
              icon={<Camera size={20} />}
              title={`Take a snapshot of ${missing.map(envLabel).join(' and ')} first`}
              description={live || mode === 'raw' || missing.includes(from) ? 'Compare reads the newest snapshots.' : `Or check ${envLabel(to)} live instead of its snapshot.`}
              action={(
                <>
                  {missing.map((e) => <LinkButton key={e} to={`/p/${project.id}/explore/${encodeURIComponent(e)}`} variant="primary">Explore {envLabel(e)}</LinkButton>)}
                  {!missing.includes(from) && mode === 'preview' && <Button onClick={() => setParam({ live: '1' })}>Check live target</Button>}
                </>
              )}
            />
          </Card>
        </div>
      ) : run.error && !result ? (
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <Card><ErrorState title="The comparison did not finish" error={run.error instanceof Error ? run.error : new Error(String(run.error))} onRetry={() => run.rerun()} /></Card>
        </div>
      ) : !result ? (
        <div className="mx-auto w-full max-w-md px-6 py-16">
          <p className="mb-3 text-center text-sm text-muted">Comparing {envLabel(from)} with {envLabel(to)}{live ? ' (live)' : ''}…</p>
          <JobProgress job={run.job} label="Comparing" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg px-6 py-2.5">
            <CountBar counts={result.counts} to={result.to} active={filters.status} onToggle={(s) => setFilters({ status: filters.status === s ? null : s })} />
            <p className="flex items-center gap-1.5 text-xs text-muted">
              {result.fromName} <ArrowRight size={12} aria-hidden /> {envLabel(result.to)} · {result.mode === 'preview' ? 'Preview' : 'Raw'}
              {(result.counts.same ?? 0) > 0 && <> · {plural(result.counts.same ?? 0, 'item')} the same</>}
            </p>
            {run.error ? <div className="w-full"><InlineError error={run.error} /></div> : null}
            <Notes notes={result.notes} label="Comparison notes" className="w-full" />
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)_300px] lg:grid-rows-[minmax(0,1fr)]">
            <CompareTree
              projectId={project.id}
              result={result}
              sel={sel}
              setSel={setSel}
              selectedKey={itemKey}
              onSelect={open}
              filters={filters}
              setFilters={setFilters}
              onAdded={onAdded}
              onExpired={run.expire}
            />
            <div className="min-h-0 overflow-hidden">
              <ItemDetail
                key={`${result.compareId}:${itemKey ?? ''}`}
                projectId={project.id}
                result={result}
                itemKey={itemKey}
                sel={sel}
                setSel={setSel}
                suggestions={suggestions}
                onAddSuggestion={addSuggestion}
                onExpired={run.expire}
              />
            </div>
            <ChangesetTray
              from={from}
              to={to}
              items={trayItems}
              removals={trayRemovals}
              onUnremove={(key) => setSel((s) => unmarkRemovals(s, [key]))}
              resolutions={sel.resolutions}
              suggestions={suggestions}
              suggestionsLoading={keys.length > 0 && suggestionsQuery.isFetching && !suggestionsQuery.data}
              suggestionsError={keys.length ? suggestionsQuery.error : null}
              highlight={recent}
              overwrites={Object.values(sel.items).filter((st) => st === 'drifted').length}
              onOpen={open}
              onRemove={(key) => setSel((s) => removeKeys(s, [key]))}
              onClear={() => setSel(() => emptySelection())}
              onAdd={addSuggestion}
              onAddAll={addAll}
              onReview={review}
              reviewing={plan.status === 'running'}
              reviewError={planError}
              onSave={save}
              canSave={!restore}
              fromLabel={fromLabel}
              saved={savedNow}
            />
          </div>
        </>
      )}
    </div>
  );
}
