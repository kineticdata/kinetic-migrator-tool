// Project-level files shared by projects.ts and environments.ts:
// `kinetic-migrate.json` (display name, pipeline order, commit author), the
// managed .gitignore, committing a change with a plain message, and the
// project's random secrets id (the keychain account prefix).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.ts';
import { stableStringify } from './engine.ts';
import { commitAll, ensureRepo, type Author } from './repo.ts';

export interface ProjectRef {
  id: string;
  dir: string;
}

export interface ProjectMeta {
  name?: string;
  order?: string[];
  author?: Author;
  // Random, generated once per project; prefixes every keychain account so
  // credentials never follow a folder name across workspaces or re-creation.
  secretsId?: string;
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

// Serialises work per key so file writes and commits never interleave.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

// Project files and commits. Not re-entrant: never call it from inside itself.
export const withProjectLock = <T>(ref: ProjectRef, fn: () => Promise<T>): Promise<T> => withLock(ref.dir, fn);
// The project's secrets in the store (read-modify-write of the name index).
export const withSecretsLock = <T>(ref: ProjectRef, fn: () => Promise<T>): Promise<T> => withLock(`${ref.dir}\0secrets`, fn);

const SECRETS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validSecretsId = (v: unknown): v is string => typeof v === 'string' && SECRETS_ID.test(v);

export const newSecretsId = (): string => randomUUID();

// Makes a folder a managed project: .gitignore, a secrets id, a repository and
// a commit of whatever is there. Call inside withProjectLock.
export async function manageProject(ref: ProjectRef, message: string): Promise<void> {
  ensureGitignore(ref.dir);
  const meta = readMeta(ref.dir);
  if (!validSecretsId(meta.secretsId)) writeMeta(ref.dir, { ...meta, secretsId: newSecretsId() });
  await ensureRepo(ref.dir);
  await commitChange(ref, message);
}

// The project's secrets id; projects without one (for example CLI-created
// ones in the workspace) become managed and get one now.
export async function secretsId(ref: ProjectRef): Promise<string> {
  const id = readMeta(ref.dir).secretsId;
  if (validSecretsId(id)) return id;
  return withProjectLock(ref, async () => {
    await manageProject(ref, 'Started managing this project');
    return readMeta(ref.dir).secretsId as string;
  });
}
