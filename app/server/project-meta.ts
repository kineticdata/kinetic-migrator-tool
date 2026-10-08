// Project-level files shared by projects.ts and environments.ts:
// `kinetic-migrate.json` (display name, pipeline order, commit author), the
// managed .gitignore, and committing a change with a plain message.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.ts';
import { stableStringify } from './engine.ts';
import { commitAll, type Author } from './repo.ts';

export interface ProjectRef {
  id: string;
  dir: string;
}

export interface ProjectMeta {
  name?: string;
  order?: string[];
  author?: Author;
}

export const META_FILE = 'kinetic-migrate.json';
export const DEFAULT_AUTHOR: Author = { name: 'kinetic-migrate', email: 'kinetic-migrate@localhost' };
// Credentials, pre-apply backups, plan records and comparison reports stay local.
export const GITIGNORE_LINES = ['.env*', 'backups/', 'plans/', 'compares/'];

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ApiError(422, 'invalid_project_file', `${path.basename(file)} is not valid JSON.`);
  }
}

export function readMeta(dir: string): ProjectMeta {
  const file = path.join(dir, META_FILE);
  if (!existsSync(file)) return {};
  const raw = readJsonFile(file);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ProjectMeta) : {};
}

export function writeMeta(dir: string, meta: ProjectMeta): void {
  writeFileSync(path.join(dir, META_FILE), stableStringify(meta));
}

export function ensureGitignore(dir: string): void {
  const file = path.join(dir, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${text}${sep}${missing.join('\n')}\n`);
}

// "dev" → "Dev", for plain commit messages.
export const displayName = (env: string) => env.charAt(0).toUpperCase() + env.slice(1);

export function commitChange(ref: ProjectRef, message: string): Promise<string | null> {
  return commitAll(ref.dir, message, readMeta(ref.dir).author ?? DEFAULT_AUTHOR);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Serialises mutations per project so file writes and commits never interleave.
const locks = new Map<string, Promise<unknown>>();
export function withProjectLock<T>(ref: ProjectRef, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(ref.dir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(ref.dir, tail);
  void tail.then(() => { if (locks.get(ref.dir) === tail) locks.delete(ref.dir); });
  return next;
}
