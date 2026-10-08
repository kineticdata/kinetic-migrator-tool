// Query keys and TanStack Query hooks for projects, environments, settings,
// history and overview data. Everything under ['project', id] is invalidated
// together when a job against that project ends.
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectionTestResult, CreateProjectRequest, CredentialsStatus, JobStarted, OpenProjectRequest, ProjectConfig,
  ProjectDetail, ProjectSummary, PutCredentialsRequest, PutEnvironmentRequest, SessionInfo,
} from '../../../shared/api';
import type { CompareResult, ExploreItem, HistoryEvent, SearchResponse, TreeNode } from '../../../shared/sync-api';
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

export const usePutCredentials = (p: string) => useProjectMutation(p, ({ env, ...body }: PutCredentialsRequest & { env: string }) => (
  api.put<CredentialsStatus>(projectPath(p, 'environments', env, 'credentials'), body)
));

export const testConnection = (p: string, env: string) => api.post<ConnectionTestResult>(projectPath(p, 'environments', env, 'test'));

export function usePutConfig(p: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ProjectConfig>) => api.put<ProjectConfig>(projectPath(p, 'config'), body),
    onSuccess: (c) => qc.setQueryData(qk.config(p), c),
  });
}

export const startSnapshot = (p: string, env: string) => api.post<JobStarted>(projectPath(p, 'snapshots'), { env });
