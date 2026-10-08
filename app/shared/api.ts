// Shared HTTP API contract types (no runtime code). Used by app/server and app/web.

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export interface SessionInfo {
  version: string;
  workspace: string;
  keychain: { available: boolean };
}

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

// An engine event (see lib/sync/events.mjs): always has a type, plus fields.
export interface JobEventData {
  type: string;
  [field: string]: unknown;
}

export interface JobEvent {
  seq: number;
  at: string;
  type: string;
  data: JobEventData;
}

export interface JobInfo<R = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  result?: R;
  error?: { code: string; message: string };
}

// Data of the final SSE event (`event: end`).
export interface JobEndEvent {
  status: JobStatus;
}

// The response of any endpoint that starts a job.
export interface JobStarted {
  jobId: string;
}
