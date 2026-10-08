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
const MAX_POLL_MS = 5000;
// Delays before reopening a dropped event stream; then polling takes over.
const RECONNECT_MS = [250, 500, 1000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isAbort = (err: unknown) => (err as { name?: string } | null)?.name === 'AbortError';

// A network hiccup (the server may still be running the job), as opposed to
// an answer from the server.
export const isTransient = (err: unknown): boolean => !isAbort(err) && (!(err instanceof ApiError) || err.status === 0);

// Waits for a job to finish by polling. Network hiccups are retried with
// backoff; only the server's answer settles the outcome.
export async function waitForJob<R>(jobId: string, signal?: AbortSignal): Promise<JobInfo<R>> {
  let delay = POLL_MS;
  for (;;) {
    try {
      const job = await api.get<JobInfo<R>>(`/api/jobs/${encodeURIComponent(jobId)}`, signal);
      if (job.status !== 'running') return job;
      delay = POLL_MS;
    } catch (err) {
      if (!isTransient(err)) throw err;
      delay = Math.min(delay * 2, MAX_POLL_MS);
    }
    await sleep(delay);
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
      const signal = controller.signal;
      let lastId = 0;
      const onEvent = (event: JobEventData, id?: number) => {
        // After a reconnect the server replays from Last-Event-ID; skip any repeat.
        if (id !== undefined) {
          if (id <= lastId) return;
          lastId = id;
        }
        setState((s) => ({ ...s, events: [...s.events, event], progress: progressOf(event) ?? s.progress }));
      };
      try {
        let end = null;
        for (let attempt = 0; ; attempt++) {
          try {
            end = await streamJobEvents(jobId, onEvent, signal, lastId || undefined);
            break;
          } catch (err) {
            if (signal.aborted || !isTransient(err)) throw err;
            if (attempt >= RECONNECT_MS.length) break;
            await sleep(RECONNECT_MS[attempt]);
            if (signal.aborted) return;
          }
        }
        // The final status and result come from the job itself; polling
        // covers a stream that dropped and could not be reopened.
        let job: JobInfo<R>;
        try {
          job = await api.get<JobInfo<R>>(`/api/jobs/${encodeURIComponent(jobId)}`, signal);
        } catch (err) {
          if (!isTransient(err)) throw err;
          job = await waitForJob<R>(jobId, signal);
        }
        if (job.status === 'running' && !end) job = await waitForJob<R>(jobId, signal);
        if (signal.aborted) return;
        setState((s) => ({ ...s, status: job.status, result: job.result, error: job.error?.message ?? null }));
        await Promise.all((optsRef.current.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        optsRef.current.onDone?.(job);
      } catch (err) {
        if (signal.aborted || isAbort(err)) return;
        // Only an answer from the server (an ApiError) gets here.
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
