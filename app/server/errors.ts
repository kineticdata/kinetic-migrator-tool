// API errors and the mapping from thrown errors to `{ error: { code, message } }`.
// Unknown errors never expose their message or stack; engine HttpErrors are
// reduced to their status plus the platform's own message and error list
// when its body has them (names, not values; redacted and capped). URLs and
// the rest of the body stay server-side.
import type { ApiErrorBody } from '../shared/api.ts';
import { describePlatformError, integratorAuthText, integratorSignInText } from './engine-sync.ts';

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
  const e = err as { name?: string; status?: number; method?: string; body?: unknown } | null;
  switch (e?.name) {
    case 'CancelledError':
      return new ApiError(409, 'cancelled', 'The job was cancelled.');
    case 'ReadOnlyError':
      return new ApiError(403, 'read_only', 'This environment is read-only.');
    case 'IntegratorAuthUnavailable': {
      // Rebuilt from its fields (never its message), worded as the snapshot warning.
      const i = err as { status?: number | null; version?: string | null; host?: string | null };
      const text = integratorAuthText({ status: i.status, version: i.version, host: i.host });
      return new ApiError(502, 'integrator_unavailable', `Connections and operations were left out: ${text}`);
    }
    case 'IntegratorSignInFailed': {
      const i = err as { status?: number | null; redirected?: boolean; sso?: boolean };
      return new ApiError(502, 'integrator_sign_in', integratorSignInText({ status: typeof i.status === 'number' ? i.status : null, redirected: i.redirected === true, sso: i.sso === true }));
    }
    case 'HttpError':
      return new ApiError(502, 'upstream_error', describePlatformError({ status: e.status, method: e.method, body: e.body }));
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
