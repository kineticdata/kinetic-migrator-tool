// History detail and Settings → Repository. The repository token is sent with
// a plain request, never through useMutation: TanStack keeps mutation
// variables in its cache, and a secret must not outlive its request.
import { useQuery } from '@tanstack/react-query';
import type { JobStarted } from '../../../shared/api';
import type { PutRepositoryRequest, RepositorySettings } from '../../../shared/repository-api';
import type { HistoryDetail } from '../../../shared/sync-api';
import { api, projectPath } from './client';

export const historyKeys = {
  detail: (p: string, commit: string) => ['project', p, 'history', 'detail', commit] as const,
  repository: (p: string) => ['project', p, 'repository'] as const,
};

// A commit's entry never changes (its run record is written before the commit).
export const useHistoryDetail = (p: string, commit: string | null) => useQuery({
  queryKey: historyKeys.detail(p, commit ?? ''),
  enabled: Boolean(commit),
  staleTime: Infinity,
  retry: false,
  queryFn: () => api.get<HistoryDetail>(projectPath(p, 'history', commit ?? '')),
});

export const useRepository = (p: string) => useQuery({
  queryKey: historyKeys.repository(p),
  queryFn: () => api.get<RepositorySettings>(projectPath(p, 'repository')),
});

export const putRepository = (p: string, body: PutRepositoryRequest) => api.put<RepositorySettings>(projectPath(p, 'repository'), body);

export const startPush = (p: string) => api.post<JobStarted>(projectPath(p, 'repository', 'push'));
