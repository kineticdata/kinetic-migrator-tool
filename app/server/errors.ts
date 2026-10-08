// API errors and the mapping from thrown errors to `{ error: { code, message } }`.
// Unknown errors never expose their message or stack; engine HttpErrors are
// reduced to their status (bodies and URLs stay server-side).
import type { ApiErrorBody } from '../shared/api.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const badRequest = (message: string, detail?: unknown) => new ApiError(400, 'bad_request', message, detail);

export interface MappedError {
  status: number;
  body: ApiErrorBody;
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as { name?: string; status?: number } | null;
  switch (e?.name) {
    case 'CancelledError':
      return new ApiError(409, 'cancelled', 'The job was cancelled.');
    case 'ReadOnlyError':
      return new ApiError(403, 'read_only', 'This environment is read-only.');
    case 'HttpError':
      return new ApiError(502, 'upstream_error', `The Kinetic Platform returned an error (${e.status ?? 'unknown'}).`);
    default:
      return new ApiError(500, 'internal_error', 'Something went wrong on the server.');
  }
}

export function mapError(err: unknown): MappedError {
  const a = toApiError(err);
  const body: ApiErrorBody = { error: { code: a.code, message: a.message } };
  if (a.detail !== undefined) body.error.detail = a.detail;
  return { status: a.status, body };
}
