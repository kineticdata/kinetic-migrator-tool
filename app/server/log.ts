// Server-side logging for unexpected errors and a few notes. Everything
// written passes through the engine's redact() (Basic/Bearer tokens and
// secret-named JSON values) and then masks every secret value the server has
// been given (passwords, keychain secrets, secrets typed for one run). Clients
// only ever see generic messages; details go to stderr and to a daily log
// file in the workspace (<workspace>/.kinetic-migrate/logs/), kept 14 days.
// @ts-expect-error -- untyped engine module
import { redact as engineRedact } from '../../lib/sync/http.mjs';
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeScrubber } from './scrub.ts';

const engineText = engineRedact as (text: string) => string;

// Secret values seen by this process, masked in every line logged.
const known = new Set<string>();
export function rememberSecrets(values: Iterable<string | null | undefined>): void {
  for (const v of values) if (typeof v === 'string' && v.length >= 4) known.add(v);
}

export const redact = (text: string): string => makeScrubber(known)(engineText(text));

export interface Logger {
  error(context: string, err: unknown): void;
  // quiet: the log file only (not stderr).
  info?(message: string, opts?: { quiet?: boolean }): void;
  // The log file being written, when there is one.
  file?: () => string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

// The upstream response's `message` and the names (never the values) of what
// its `errors` / `validationErrors` point at. Response bodies only: a request
// body is never kept on an error.
export function upstreamSummary(err: unknown): string | null {
  const e = err as { name?: unknown; status?: unknown; body?: unknown } | null;
  if (e?.name !== 'HttpError' || typeof e.body !== 'string') return null;
  let body: unknown;
  try { body = JSON.parse(e.body); } catch { return null; }
  if (!isObj(body)) return null;
  const parts: string[] = [];
  const message = body.message ?? body.error;
  if (typeof message === 'string' && message) parts.push(`message: ${JSON.stringify(message.slice(0, 300))}`);
  const names = new Set<string>();
  for (const field of ['errors', 'validationErrors'] as const) {
    const list = body[field];
    if (Array.isArray(list)) {
      for (const x of list) {
        const n = isObj(x) ? x.field ?? x.name ?? x.path ?? x.key : undefined;
        if (typeof n === 'string' && n) names.add(n);
      }
    } else if (isObj(list)) {
      for (const k of Object.keys(list)) names.add(k);
    }
  }
  if (names.size) parts.push(`errors: ${[...names].slice(0, 20).join(', ')}`);
  return parts.length ? `upstream ${String(e.status ?? '?')}: ${parts.join('; ')}` : null;
}

export function formatError(context: string, err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const stack = typeof e?.stack === 'string' ? e.stack.split('\n').slice(1).join('\n') : '';
  const upstream = upstreamSummary(err);
  return redact(`[kinetic-migrate] ${context}: ${name}: ${message}${upstream ? `\n  ${upstream}` : ''}${stack ? `\n${stack}` : ''}`) + '\n';
}

export const formatInfo = (message: string): string => `${redact(`[kinetic-migrate] ${message}`)}\n`;

type Sink = (text: string) => void;
const stderr: Sink = (t) => { process.stderr.write(t); };

export function createLogger(write: Sink = stderr, extra: { file?: () => string | null } = {}): Logger {
  return {
    error: (context, err) => write(formatError(context, err)),
    info: (message) => write(formatInfo(message)),
    ...extra,
  };
}

// ---- Log file ----------------------------------------------------------------

export const LOG_DIR = path.join('.kinetic-migrate', 'logs');
export const KEEP_DAYS = 14;
const LOG_NAME = /^kinetic-migrate-(\d{4}-\d{2}-\d{2})\.log$/;
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const logDir = (workspace: string): string => path.join(workspace, LOG_DIR);
export const logFileFor = (workspace: string, now: Date = new Date()): string => path.join(logDir(workspace), `kinetic-migrate-${day(now)}.log`);

// Removes all but the newest `keep` days' log files.
export function pruneLogs(dir: string, keep = KEEP_DAYS): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const days = names.map((n) => LOG_NAME.exec(n)?.[1]).filter((d): d is string => Boolean(d)).sort().reverse();
  for (const d of days.slice(keep)) {
    try { rmSync(path.join(dir, `kinetic-migrate-${d}.log`), { force: true }); } catch { /* tried again at the next day change */ }
  }
}

// A sink that appends each (already redacted) text to the day's log file,
// each line stamped with the time, and prunes old files when the day changes.
// Logging never throws: a file that cannot be written is skipped.
export function fileSink(workspace: string, opts: { now?: () => Date; keep?: number } = {}): { write: Sink; file: () => string } {
  const now = opts.now ?? (() => new Date());
  let current: string | null = null;
  const file = () => logFileFor(workspace, now());
  const write: Sink = (text) => {
    const target = file();
    try {
      const opened = target !== current;
      if (opened) mkdirSync(path.dirname(target), { recursive: true });
      const at = now().toISOString();
      const stamped = text.replace(/\n$/, '').split('\n').map((l) => `${at} ${l}`).join('\n');
      appendFileSync(target, `${stamped}\n`);
      if (opened) {
        current = target;
        pruneLogs(path.dirname(target), opts.keep ?? KEEP_DAYS);
      }
    } catch { /* stderr still has it */ }
  };
  return { write, file };
}

// stderr plus the workspace's daily log file.
export function workspaceLogger(workspace: string, opts: { now?: () => Date; stderr?: Sink; keep?: number } = {}): Logger {
  const sink = fileSink(workspace, opts);
  const out = opts.stderr ?? stderr;
  const both = createLogger((t) => { out(t); sink.write(t); }, { file: sink.file });
  return { ...both, info: (message, o) => (o?.quiet ? sink.write(formatInfo(message)) : both.info!(message)) };
}

export const defaultLogger: Logger = createLogger();
