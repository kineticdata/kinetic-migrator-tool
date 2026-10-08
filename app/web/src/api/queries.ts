// Query keys and TanStack Query hooks for projects, environments, settings,
// history and overview data. Everything under ['project', id] is invalidated
// together when a job against that project ends.
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectionTestResult, CreateProjectRequest, CredentialsStatus, JobStarted, OpenProjectRequest, ProjectConfig,
  ProjectDetail, ProjectSummary, PutCredentialsRequest, PutEnvironmentRequest, SessionInfo,
} from '../../../shared/api';
import type {
  Changeset, CompareItem, CompareMode, CompareRequest, CompareResult, CompareTreeNode, CreateChangesetRequest, ExploreItem, HistoryEvent,
  PlanRequest, SearchResponse, SuggestionOut, TreeNode,
} from '../../../shared/sync-api';
import { api, projectPath } from './client';
import { waitForJob } from './useJob';

export const qk = {
  session: ['session'] as const,
  projects: ['projects'] as const,
  project: (p: string) => ['project', p] as const,
  config: (p: string) => ['project', p, 'config'] as const,
  history: (p: string) => ['project', p, 'history'] as const,
  tree: (p: string, env: string, commit: string) => ['project', p, 'explore', env, 'tree', commit] as const,
  treeChildren: (p: string, env: string, commit: string, parent: string) => ['project', p, 'explore', env, 'tree', commit, parent] as const,
  exploreItem: (p: string, env: string, commit: string, key: string) => ['project', p, 'explore', env, 'item', commit, key] as const,
  search: (p: string, env: string, commit: string, q: string) => ['project', p, 'explore', env, 'search', commit, q] as const,
  // Outside the project prefix: keyed by snapshot commits, so it never goes
  // stale, and invalidating the project must not start new compare jobs.
  rawDiff: (p: string, from: string, to: string, a: string, b: string) => ['raw-diff', p, from, to, a, b] as const,
  // A finished comparison, keyed by its inputs and both snapshot commits (so
  // a new snapshot means a new comparison). Outside the project prefix too.
  compareRun: (p: string, from: string, to: string, mode: CompareMode, live: boolean, a: string, b: string) => ['compare-run', p, from, to, mode, live, a, b] as const,
  // A comparison's tree, items and suggestions never change: keyed by its id.
  compareTree: (p: string, id: string, parent: string) => ['compare', p, id, 'tree', parent] as const,
  compareItem: (p: string, id: string, key: string) => ['compare', p, id, 'item', key] as const,
  suggestions: (p: string, id: string, keys: string[]) => ['compare', p, id, 'suggestions', keys] as const,
  changesets: (p: string) => ['project', p, 'changesets'] as const,
  changeset: (p: string, id: string) => ['project', p, 'changesets', id] as const,
};

// Accepts a bare list or an object wrapping one (`{ events: [...] }`).
export function asList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[key])) {
    return (value as Record<string, T[]>)[key];
  }
  return [];
}

export const useSession = () => useQuery({ queryKey: qk.session, queryFn: () => api.get<SessionInfo>('/api/session') });

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => api.get<ProjectSummary[]>('/api/projects') });

export const useProject = (p: string) => useQuery({ queryKey: qk.project(p), queryFn: () => api.get<ProjectDetail>(projectPath(p)) });

export const useHistory = (p: string) => useQuery({
  queryKey: qk.history(p),
  queryFn: async () => asList<HistoryEvent>(await api.get<unknown>(projectPath(p, 'history')), 'events'),
});

export const useConfig = (p: string) => useQuery({ queryKey: qk.config(p), queryFn: () => api.get<ProjectConfig>(projectPath(p, 'config')) });

// The root of an environment's snapshot tree (group nodes with item counts).
export const useTreeRoot = (p: string, env: string, commit: string | undefined) => useQuery({
  queryKey: qk.tree(p, env, commit ?? ''),
  enabled: Boolean(commit),
  staleTime: Infinity,
  queryFn: async () => asList<TreeNode>(await api.get<unknown>(`${projectPath(p, 'explore', env, 'tree')}`), 'nodes'),
});

// The children of each open tree node, loaded lazily (one request per node).
export function useTreeChildren(p: string, env: string, commit: string | undefined, parents: string[]) {
  return useQueries({
    queries: parents.map((parent) => ({
      queryKey: qk.treeChildren(p, env, commit ?? '', parent),
      enabled: Boolean(commit),
      staleTime: Infinity,
      queryFn: async () => asList<TreeNode>(await api.get<unknown>(`${projectPath(p, 'explore', env, 'tree')}?parent=${encodeURIComponent(parent)}`), 'nodes'),
    })),
  });
}

// One item of a snapshot: summary, relationships, JSON and history.
export const useExploreItem = (p: string, env: string, commit: string | undefined, key: string | null) => useQuery({
  queryKey: qk.exploreItem(p, env, commit ?? '', key ?? ''),
  enabled: Boolean(commit && key),
  staleTime: Infinity,
  queryFn: () => api.get<ExploreItem>(`${projectPath(p, 'explore', env, 'item')}?key=${encodeURIComponent(key ?? '')}`),
});

// Server-side search of a snapshot (names, slugs and form fields).
export const useSearch = (p: string, env: string, commit: string | undefined, q: string) => useQuery({
  queryKey: qk.search(p, env, commit ?? '', q),
  enabled: Boolean(commit && q),
  staleTime: Infinity,
  placeholderData: keepPreviousData,
  queryFn: ({ signal }) => api.get<SearchResponse>(`${projectPath(p, 'search', env)}?q=${encodeURIComponent(q)}`, signal),
});

// "N differences" between two environments: a raw compare of their newest
// snapshots, cached per pair of snapshot commits.
export const useRawDifferences = (p: string, from: string, to: string, fromCommit?: string, toCommit?: string) => useQuery({
  queryKey: qk.rawDiff(p, from, to, fromCommit ?? '', toCommit ?? ''),
  enabled: Boolean(fromCommit && toCommit),
  staleTime: Infinity,
  // Each attempt starts a compare job on the server: never retry silently.
  retry: false,
  queryFn: async ({ signal }) => {
    const { jobId } = await api.post<JobStarted>(projectPath(p, 'compare'), { from, to, mode: 'raw' });
    const job = await waitForJob<CompareResult>(jobId, signal);
    if (job.status !== 'succeeded' || !job.result) throw new Error(job.error?.message ?? 'The comparison did not finish.');
    return Object.entries(job.result.counts).reduce((n, [status, c]) => (status === 'same' ? n : n + (c ?? 0)), 0);
  },
});

function useProjectMutation<V, R>(p: string, fn: (v: V) => Promise<R>, onSuccess?: (r: R) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (onSuccess) onSuccess(r);
      return qc.invalidateQueries({ queryKey: qk.project(p) });
    },
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api.post<ProjectDetail>('/api/projects', body),
    onSuccess: (d) => {
      qc.setQueryData(qk.project(d.id), d);
      return qc.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

export function useOpenProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OpenProjectRequest) => api.post<ProjectDetail>('/api/projects/open', body),
    onSuccess: (d) => {
      qc.setQueryData(qk.project(d.id), d);
      return qc.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

export function usePutEnvironment(p: string) {
  const qc = useQueryClient();
  return useProjectMutation(p, ({ env, ...body }: PutEnvironmentRequest & { env: string }) => (
    api.put<ProjectDetail>(projectPath(p, 'environments', env), body)
  ), (d) => qc.setQueryData(qk.project(p), d));
}

export function useDeleteEnvironment(p: string) {
  const qc = useQueryClient();
  return useProjectMutation(p, (env: string) => api.del<ProjectDetail>(projectPath(p, 'environments', env)), (d) => qc.setQueryData(qk.project(p), d));
}

// Credentials are sent with a plain request, never through useMutation or a
// query: TanStack keeps mutation variables in its cache, and a secret must
// not outlive the request that carries it.
export const putCredentials = (p: string, env: string, body: PutCredentialsRequest) => (
  api.put<CredentialsStatus>(projectPath(p, 'environments', env, 'credentials'), body)
);

export const testConnection = (p: string, env: string) => api.post<ConnectionTestResult>(projectPath(p, 'environments', env, 'test'));

export function usePutConfig(p: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ProjectConfig>) => api.put<ProjectConfig>(projectPath(p, 'config'), body),
    onSuccess: (c) => qc.setQueryData(qk.config(p), c),
  });
}

export const startSnapshot = (p: string, env: string) => api.post<JobStarted>(projectPath(p, 'snapshots'), { env });

// ---- Compare -----------------------------------------------------------------

export const startCompare = (p: string, body: CompareRequest) => api.post<JobStarted>(projectPath(p, 'compare'), body);

export const fetchCompareChildren = async (p: string, id: string, parent: string, signal?: AbortSignal) => asList<CompareTreeNode>(
  await api.get<unknown>(`${projectPath(p, 'compare', id, 'tree')}${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`, signal),
  'nodes',
);

export const compareChildrenQuery = (p: string, id: string, parent: string) => ({
  queryKey: qk.compareTree(p, id, parent),
  staleTime: Infinity,
  retry: false,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchCompareChildren(p, id, parent, signal),
});

// The children of each listed node of a comparison ('' = the roots).
export function useCompareChildren(p: string, id: string | undefined, parents: string[]) {
  return useQueries({
    queries: parents.map((parent) => ({ ...compareChildrenQuery(p, id ?? '', parent), enabled: Boolean(id) })),
  });
}

export const useCompareItem = (p: string, id: string | undefined, key: string | null) => useQuery({
  queryKey: qk.compareItem(p, id ?? '', key ?? ''),
  enabled: Boolean(id && key),
  staleTime: Infinity,
  retry: false,
  queryFn: () => api.get<CompareItem>(`${projectPath(p, 'compare', id ?? '', 'item')}?key=${encodeURIComponent(key ?? '')}`),
});

// Dependencies of the selection that are new or changed and not selected,
// recomputed whenever the selection changes.
export const useSuggestions = (p: string, id: string | undefined, keys: string[]) => useQuery({
  queryKey: qk.suggestions(p, id ?? '', keys),
  enabled: Boolean(id && keys.length),
  staleTime: Infinity,
  retry: false,
  placeholderData: keepPreviousData,
  queryFn: () => api.post<SuggestionOut[]>(projectPath(p, 'compare', id ?? '', 'suggestions'), { selected: keys }),
});

// ---- Changesets and plans --------------------------------------------------

export const useChangesets = (p: string) => useQuery({
  queryKey: qk.changesets(p),
  queryFn: async () => asList<Changeset>(await api.get<unknown>(projectPath(p, 'changesets')), 'changesets'),
});

export const useChangeset = (p: string, id: string) => useQuery({
  queryKey: qk.changeset(p, id),
  queryFn: () => api.get<Changeset>(projectPath(p, 'changesets', id)),
});

export const useCreateChangeset = (p: string) => useProjectMutation(p, (body: CreateChangesetRequest) => api.post<Changeset>(projectPath(p, 'changesets'), body));

export const useDeleteChangeset = (p: string) => useProjectMutation(p, (id: string) => api.del<{ deleted: string }>(projectPath(p, 'changesets', id)));

export const startPlan = (p: string, body: PlanRequest) => api.post<JobStarted>(projectPath(p, 'plans'), body);

// Names for the connection and operation ids an item's integrations refer
// to, from the item's "calls" relationships in an environment's snapshot.
// Ids differ between environments, so each side is resolved on its own.
export function useIntegrationNames(p: string, env: string | null, commit: string | undefined, key: string | null): Record<string, string> {
  const item = useExploreItem(p, env ?? '', env ? commit : undefined, key);
  const keys = (item.data?.relationships.uses ?? []).filter((r) => r.kind === 'calls').map((r) => r.key);
  const related = useQueries({
    queries: keys.map((k) => ({
      queryKey: qk.exploreItem(p, env ?? '', commit ?? '', k),
      staleTime: Infinity,
      retry: false,
      queryFn: () => api.get<ExploreItem>(`${projectPath(p, 'explore', env ?? '', 'item')}?key=${encodeURIComponent(k)}`),
    })),
  });
  const out: Record<string, string> = {};
  for (const r of related) {
    const id = (r.data?.json as { id?: unknown } | undefined)?.id;
    if (r.data && typeof id === 'string') out[id] = r.data.label;
  }
  return out;
}

// Labels of items in an environment's newest snapshot ({ key: label }); keys
// not in it (or still loading) are left out.
export function useItemLabels(p: string, env: string | null, commit: string | undefined, keys: string[]): Record<string, string> {
  const results = useQueries({
    queries: keys.map((k) => ({
      queryKey: qk.exploreItem(p, env ?? '', commit ?? '', k),
      enabled: Boolean(env && commit),
      staleTime: Infinity,
      retry: false,
      queryFn: () => api.get<ExploreItem>(`${projectPath(p, 'explore', env ?? '', 'item')}?key=${encodeURIComponent(k)}`),
    })),
  });
  const out: Record<string, string> = {};
  results.forEach((r, i) => { if (r.data?.label) out[keys[i]] = r.data.label; });
  return out;
}
