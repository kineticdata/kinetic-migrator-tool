// Server-side logging for unexpected errors. Everything written passes through
// the engine's redact() (Basic/Bearer tokens and secret-named JSON values).
// Clients only ever see generic messages; details stay on stderr.
// @ts-expect-error -- untyped engine module
import { redact as engineRedact } from '../../lib/sync/http.mjs';

export const redact = engineRedact as (text: string) => string;

export interface Logger {
  error(context: string, err: unknown): void;
}

export function formatError(context: string, err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const stack = typeof e?.stack === 'string' ? e.stack.split('\n').slice(1).join('\n') : '';
  return redact(`[kinetic-migrate] ${context}: ${name}: ${message}${stack ? `\n${stack}` : ''}`) + '\n';
}

export function createLogger(write: (text: string) => void = (t) => { process.stderr.write(t); }): Logger {
  return { error: (context, err) => write(formatError(context, err)) };
}

export const defaultLogger: Logger = createLogger();
