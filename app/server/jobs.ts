// Jobs: long-running work (snapshot, compare, plan, apply) tracked in an
// in-memory registry with recorded events, a result, cancellation via
// AbortSignal, and one write job per target (`lockKey`) at a time.
// Routes: GET /api/jobs/:id, GET /api/jobs/:id/events (SSE), DELETE /api/jobs/:id.
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { JobEvent, JobEventData, JobInfo, JobStatus } from '../shared/api.ts';
import { ApiError, mapError, notFound } from './errors.ts';
import type { Router } from './router.ts';
import { defaultLogger, type Logger } from './log.ts';

export type Emit = (event: JobEventData) => void;
export type JobRun<R = unknown> = (emit: Emit, signal: AbortSignal) => Promise<R>;

export interface Job extends JobInfo {
  events: JobEvent[];
  lockKey?: string;
}

interface Entry {
  job: Job;
  controller: AbortController;
  listeners: Set<(event: JobEvent | null) => void>;
  done: Promise<Job>;
}

export interface CreateJobOptions {
  // Write jobs pass the target (for example `<projectId>/<env>`); a second
  // job with the same key while the first runs is rejected with 409.
  lockKey?: string;
}

export class JobRegistry {
  private entries = new Map<string, Entry>();
  private locks = new Map<string, string>();
  private logger: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.logger = opts.logger ?? defaultLogger;
  }

  createJob<R>(kind: string, run: JobRun<R>, opts: CreateJobOptions = {}): string {
    const { lockKey } = opts;
    if (lockKey !== undefined && this.locks.has(lockKey)) {
      throw new ApiError(409, 'locked', 'Another change is already running against this environment.', { jobId: this.locks.get(lockKey) });
    }
    const id = randomUUID();
    const job: Job = { id, kind, status: 'running', createdAt: new Date().toISOString(), events: [], lockKey };
    const controller = new AbortController();
    const listeners = new Set<(event: JobEvent | null) => void>();
    if (lockKey !== undefined) this.locks.set(lockKey, id);

    const emit: Emit = (data) => {
      if (job.status !== 'running') return;
      const event: JobEvent = { seq: job.events.length + 1, at: new Date().toISOString(), type: String(data?.type ?? 'log'), data };
      job.events.push(event);
      for (const l of listeners) l(event);
    };

    const finish = (status: JobStatus) => {
      job.status = status;
      job.finishedAt = new Date().toISOString();
      if (lockKey !== undefined && this.locks.get(lockKey) === id) this.locks.delete(lockKey);
      for (const l of listeners) l(null);
      listeners.clear();
      return job;
    };

    const done = (async () => {
      try {
        const result = await run(emit, controller.signal);
        if (controller.signal.aborted) return finish('cancelled');
        job.result = result;
        return finish('succeeded');
      } catch (err) {
        if (controller.signal.aborted || (err as { name?: string } | null)?.name === 'CancelledError') return finish('cancelled');
        this.logger.error(`job ${kind} ${id} failed`, err);
        const { code, message } = mapError(err).body.error;
        job.error = { code, message };
        return finish('failed');
      }
    })();

    this.entries.set(id, { job, controller, listeners, done });
    return id;
  }

  get(id: string): Job | undefined {
    return this.entries.get(id)?.job;
  }

  // Resolves when the job settles.
  wait(id: string): Promise<Job> {
    const e = this.entries.get(id);
    if (!e) return Promise.reject(notFound('No such job.'));
    return e.done;
  }

  // Requests cancellation; returns false for unknown jobs.
  abort(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.job.status === 'running') e.controller.abort();
    return true;
  }

  // Listener gets each new event, then `null` once the job ends. Returns an unsubscribe.
  subscribe(id: string, listener: (event: JobEvent | null) => void): () => void {
    const e = this.entries.get(id);
    if (!e || e.job.status !== 'running') return () => {};
    e.listeners.add(listener);
    return () => { e.listeners.delete(listener); };
  }

  abortAll(): void {
    for (const id of this.entries.keys()) this.abort(id);
  }
}

export function jobInfo(job: Job): JobInfo {
  const { id, kind, status, createdAt, finishedAt, result, error } = job;
  const info: JobInfo = { id, kind, status, createdAt };
  if (finishedAt) info.finishedAt = finishedAt;
  if (result !== undefined) info.result = result;
  if (error) info.error = error;
  return info;
}

function writeEvent(res: ServerResponse, event: JobEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.type.replace(/[\r\n]/g, '')}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function writeEnd(res: ServerResponse, job: Job): void {
  res.write(`event: end\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
  res.end();
}

export function registerJobRoutes(router: Router, jobs: JobRegistry): void {
  const find = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw notFound('No such job.');
    return job;
  };

  router.get('/api/jobs/:id', ({ params }) => ({ json: jobInfo(find(params.id)) }));

  router.delete('/api/jobs/:id', ({ params }) => {
    const job = find(params.id);
    jobs.abort(job.id);
    return { status: 202, json: jobInfo(job) };
  });

  router.get('/api/jobs/:id/events', ({ req, res, params }) => {
    const job = find(params.id);
    const after = Number(req.headers['last-event-id'] ?? 0) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.flushHeaders();
    for (const event of job.events) if (event.seq > after) writeEvent(res, event);
    if (job.status !== 'running') {
      writeEnd(res, job);
      return undefined;
    }
    const unsubscribe = jobs.subscribe(job.id, (event) => {
      if (event) writeEvent(res, event);
      else writeEnd(res, job);
    });
    req.on('close', unsubscribe);
    return undefined;
  });
}
