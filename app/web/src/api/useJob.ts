// useJob(id): follows a server job — collects its events over SSE, loads the
// final status and result, and invalidates related queries when it ends so
// screens never show stale data after a snapshot, compare or apply.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { JobEventData, JobInfo, JobStatus } from '../../../shared/api';
import { api, ApiError, streamJobEvents } from './client';

export interface JobProgress {
  phase?: string;
  done: number;
  total: number;
}

export interface JobState<R> {
  status: 'idle' | JobStatus;
  events: JobEventData[];
  progress: JobProgress | null;
  result: R | undefined;
  error: string | null;
  cancel: () => void;
}

export interface UseJobOptions<R> {
  // Query keys (prefixes) to invalidate when the job ends, whatever its outcome.
  invalidate?: QueryKey[];
  onDone?: (job: JobInfo<R>) => void;
}

const POLL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits for a job to finish by polling (used when no event stream is wanted).
export async function waitForJob<R>(jobId: string, signal?: AbortSignal): Promise<JobInfo<R>> {
  for (;;) {
    const job = await api.get<JobInfo<R>>(`/api/jobs/${encodeURIComponent(jobId)}`, signal);
    if (job.status !== 'running') return job;
    await sleep(POLL_MS);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

function progressOf(e: JobEventData): JobProgress | null {
  if (e.type !== 'progress' || typeof e.done !== 'number' || typeof e.total !== 'number') return null;
  return { phase: typeof e.phase === 'string' ? e.phase : undefined, done: e.done, total: e.total };
}

export function useJob<R = unknown>(jobId: string | null | undefined, opts: UseJobOptions<R> = {}): JobState<R> {
  const queryClient = useQueryClient();
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [state, setState] = useState<Omit<JobState<R>, 'cancel'>>({ status: 'idle', events: [], progress: null, result: undefined, error: null });

  useEffect(() => {
    if (!jobId) {
      setState({ status: 'idle', events: [], progress: null, result: undefined, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'running', events: [], progress: null, result: undefined, error: null });

    (async () => {
      try {
        const end = await streamJobEvents(jobId, (event) => {
          setState((s) => ({ ...s, events: [...s.events, event], progress: progressOf(event) ?? s.progress }));
        }, controller.signal);
        // The final status and result come from the job itself (and polling
        // covers a stream that dropped before `end`).
        let job = await api.get<JobInfo<R>>(`/api/jobs/${encodeURIComponent(jobId)}`, controller.signal);
        if (job.status === 'running' && !end) job = await waitForJob<R>(jobId, controller.signal);
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, status: job.status, result: job.result, error: job.error?.message ?? null }));
        await Promise.all((optsRef.current.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        optsRef.current.onDone?.(job);
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof ApiError ? err.message : 'Lost contact with the job.';
        setState((s) => ({ ...s, status: 'failed', error: message }));
      }
    })();

    return () => controller.abort();
  }, [jobId, queryClient]);

  const cancel = useCallback(() => {
    if (jobId) api.del(`/api/jobs/${encodeURIComponent(jobId)}`).catch(() => {});
  }, [jobId]);

  return { ...state, cancel };
}
