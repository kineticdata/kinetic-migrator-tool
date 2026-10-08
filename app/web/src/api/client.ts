// API client: same-origin fetch with the CSRF header and JSON bodies; error
// bodies become ApiError with the server's plain message. Job events are read
// with fetch streaming rather than EventSource, because EventSource cannot
// send the X-Kinetic-Migrate header that every /api request needs.
import type { ApiErrorBody, JobEndEvent, JobEventData } from '../../../shared/api';

export const API_HEADER = 'X-Kinetic-Migrate';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function headers(json: boolean): Record<string, string> {
  return json ? { [API_HEADER]: '1', 'content-type': 'application/json' } : { [API_HEADER]: '1' };
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const e = body?.error;
  if (e?.message) return new ApiError(res.status, e.code ?? 'error', e.message, e.detail);
  if (res.status === 401) return new ApiError(401, 'unauthorized', 'Your session has ended. Open the app again from the link printed by kinetic-migrate ui.');
  return new ApiError(res.status, 'error', `The request failed (${res.status}).`);
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'Could not reach Kinetic Migrator. Is it still running?');
  }
  if (!res.ok) throw await toError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// Builds `/api/projects/<p>/…` with each segment encoded.
export const projectPath = (projectId: string, ...rest: string[]): string =>
  ['/api/projects', encodeURIComponent(projectId), ...rest.map(encodeURIComponent)].join('/');

export interface SseEvent {
  type: string;
  data: unknown;
  // The frame's `id:` (the job event's seq), when present.
  id?: string;
}

// Parses complete SSE frames from a buffer; returns the unparsed remainder.
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    let type = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    let parsed: unknown = data.join('\n');
    try {
      parsed = JSON.parse(parsed as string);
    } catch {
      // Keep the raw text.
    }
    events.push(id === undefined ? { type, data: parsed } : { type, data: parsed, id });
  }
  return { events, rest };
}

// Streams a job's events (replayed, then live) until `end`. Resolves with the
// end event, or null when the stream closed without one. `lastEventId` asks
// the server to replay only later events (after a reconnect).
export async function streamJobEvents(
  jobId: string,
  onEvent: (event: JobEventData, id?: number) => void,
  signal?: AbortSignal,
  lastEventId?: number,
): Promise<JobEndEvent | null> {
  const extra: Record<string, string> = lastEventId ? { 'last-event-id': String(lastEventId) } : {};
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events`, {
    headers: { ...headers(false), accept: 'text/event-stream', ...extra },
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) throw await toError(res);
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const e of events) {
      if (e.type === 'end') {
        reader.cancel().catch(() => {});
        return e.data as JobEndEvent;
      }
      const data = (e.data && typeof e.data === 'object' ? e.data : { message: e.data }) as Record<string, unknown>;
      const seq = e.id !== undefined && /^\d+$/.test(e.id) ? Number(e.id) : undefined;
      onEvent({ ...data, type: typeof data.type === 'string' ? data.type : e.type }, seq);
    }
    if (done) return null;
  }
}
