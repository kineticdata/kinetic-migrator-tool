// Plans and apply. A plan is fixed once computed, so it is cached by id and
// never refetched. Apply is a plain request (never useMutation): its body can
// carry secrets, and TanStack keeps mutation variables in its cache.
import { useQuery } from '@tanstack/react-query';
import type { JobStarted } from '../../../shared/api';
import type { ApplyRequest, PlanResult } from '../../../shared/sync-api';
import { api, projectPath } from './client';

export const planKey = (p: string, id: string) => ['plan', p, id] as const;

export const usePlan = (p: string, id: string) => useQuery({
  queryKey: planKey(p, id),
  staleTime: Infinity,
  retry: false,
  queryFn: () => api.get<PlanResult>(projectPath(p, 'plans', id)),
});

export const startApply = (p: string, planId: string, body: ApplyRequest) => (
  api.post<JobStarted>(projectPath(p, 'plans', planId, 'apply'), body)
);
