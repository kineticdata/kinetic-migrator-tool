// Project-level files shared by projects.ts and environments.ts:
// `kinetic-migrate.json` (display name, pipeline order, commit author of a
// managed project), the project .gitignore, committing a change with a plain
// message to the project's history (see project-repo.ts for managed and
// external projects), and the project's random secrets id (the keychain
// account prefix, which also keys an external project's private history).
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.ts';
import { GITATTRIBUTES, stableStringify } from './engine.ts';
import { commitAll, currentBranch, ensureRepo, headOid, layoutDirty, readTreeAt, type Author } from './repo.ts';
import { firstInScope } from './request-scope.ts';
import { LAYOUT_VERSION, upgradeProjectLayout } from './engine-sync.ts';
import { isLocked, withLock } from './locks.ts';
import { externalId, invalidateStatus, privateAuthor, projectRepo, userBranch, userOperation, userRepoName, type ProjectRepo, type UserRepo } from './project-repo.ts';

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
    // A byte-order mark (Windows PowerShell 5 writes one) is not JSON.
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
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

// Written once when missing; an existing file is the user's and left alone.
export function ensureGitattributes(dir: string): void {
  const file = path.join(dir, '.gitattributes');
  if (!existsSync(file)) writeFileSync(file, GITATTRIBUTES);
}

// Adds the missing lines (in the file's own line endings). A symlinked
// .gitignore is left alone: it may lead out of the project folder.
export function ensureGitignore(dir: string): void {
  const file = path.join(dir, '.gitignore');
  try {
    if (lstatSync(file).isSymbolicLink()) return;
  } catch {
    // Absent: written below.
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text && !text.endsWith('\n') ? eol : '';
  writeFileSync(file, `${text}${sep}${missing.join(eol)}${eol}`);
}

// "dev" → "Dev", for plain commit messages.
export const displayName = (env: string) => env.charAt(0).toUpperCase() + env.slice(1);

// Who commits are recorded as: kinetic-migrate.json for a managed project;
// the private history's own record for an external one (the project files
// are shared through the user's repository, the author is this computer's).
export function authorOf(ref: ProjectRef, repo: ProjectRepo): Author {
  return (repo.mode === 'external' ? privateAuthor(repo) : readMeta(ref.dir).author) ?? DEFAULT_AUTHOR;
}

// The repository commits go to. An external project's private history is
// created on first use (in the data folder: no project file is written). A
// managed repository is committed to only on main.
export async function writableRepo(ref: ProjectRef): Promise<ProjectRepo> {
  const repo = await projectRepo(ref);
  if (repo.mode === 'external') {
    await ensureRepo(repo);
    return repo;
  }
  const branch = await currentBranch(repo);
  if (branch !== undefined && branch !== 'main') {
    throw new ApiError(409, 'wrong_branch', `This project's repository is on ${branch === null ? 'a detached commit' : `branch ${branch}`}; Kinetic Migrator records its history on main. Check out main and try again.`);
  }
  return repo;
}

export async function commitChange(ref: ProjectRef, message: string, opts: { always?: boolean } = {}): Promise<string | null> {
  const repo = await writableRepo(ref);
  try {
    return await commitAll(repo, message, authorOf(ref, repo), opts);
  } finally {
    if (repo.user) invalidateStatus(repo.user);
  }
}

// ---- External projects: the user's repository underneath -------------------

export const OUTSIDE_TITLE = 'Files changed outside Kinetic Migrator';
const OPERATION: Record<string, string> = { merge: 'a merge', rebase: 'a rebase', 'cherry-pick': 'a cherry-pick', revert: 'a revert' };

// Writing project files while git is half-way through a merge, rebase,
// cherry-pick or revert in the user's repository could tangle their work:
// until it is finished or aborted, the project is read-only.
export function assertNotBusy(user: UserRepo): void {
  const op = userOperation(user);
  if (!op) return;
  throw new ApiError(409, 'repository_busy', `Your repository ${userRepoName(user)} has ${OPERATION[op]} in progress. Finish or abort it in git first: until then Kinetic Migrator only reads this project.`);
}

// Records whatever changed on disk since the last commit of the private
// history (a branch switch, a pull, an edit or the CLI) as its own commit, so
// the app's next commit holds only its own change and neither side is lost.
// The stat check is cheap; a change it misses (a same-size rewrite within
// the same second) is still kept, in the app's next commit.
async function recordOutsideChanges(ref: ProjectRef, repo: ProjectRepo): Promise<string | null> {
  if (!(await headOid(repo)) || !(await layoutDirty(repo))) return null;
  const branch = userBranch(repo.user!);
  const where = `${branch ? `on branch ${branch}` : 'on a detached commit'} of ${userRepoName(repo.user!)}`;
  return commitAll(repo, `${OUTSIDE_TITLE}\n\nThe project's files on disk changed ${where}.`, authorOf(ref, repo));
}

// Before reading pinned or latest commits: catch the private history up with
// the files on disk (cheap when nothing changed). Skipped while the project
// is being written (that write records its own state) or git is busy.
// Once per request or job; taken under the project lock (only when free, so
// a read never waits behind an apply) so it never interleaves with a write.
export async function syncHistory(ref: ProjectRef): Promise<void> {
  if (!firstInScope(`sync\0${ref.dir}`)) return;
  const repo = await projectRepo(ref);
  if (repo.mode !== 'external' || userOperation(repo.user!) || isLocked(ref.dir)) return;
  await withLock(ref.dir, () => recordOutsideChanges(ref, repo));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Project files and commits. Not re-entrant: never call it from inside itself.
// For an external project it first refuses while git is busy in the user's
// repository and records changes made outside the app.
export const withProjectLock = <T>(ref: ProjectRef, fn: () => Promise<T>): Promise<T> => withLock(ref.dir, async () => {
  const repo = await projectRepo(ref);
  if (repo.mode !== 'external') return fn();
  assertNotBusy(repo.user!);
  await recordOutsideChanges(ref, repo);
  try {
    return await fn();
  } finally {
    invalidateStatus(repo.user!);
  }
});
// The project's secrets in the store (read-modify-write of the name index).
export const withSecretsLock = <T>(ref: ProjectRef, fn: () => Promise<T>): Promise<T> => withLock(`${ref.dir}\0secrets`, fn);

const SECRETS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validSecretsId = (v: unknown): v is string => typeof v === 'string' && SECRETS_ID.test(v);

export const newSecretsId = (): string => randomUUID();

// Makes a folder a managed project: .gitignore, a secrets id, a repository and
// a commit of whatever is there. For an external project the repository is
// the private history, and the user's own .gitattributes rules are left to
// them (only the .gitignore lines that keep credentials and local folders out
// of their repository are added). Call inside withProjectLock.
//
// The mode never changes here: it does not depend on the files written.
// External projects get no secrets id in kinetic-migrate.json (theirs is
// derived from the folder's path), and no .gitignore edit when the project
// folder is the root of the user's repository (that is their root .gitignore).
export async function manageProject(ref: ProjectRef, message: string): Promise<void> {
  const repo = await projectRepo(ref);
  if (repo.mode === 'managed') {
    ensureGitignore(ref.dir);
    ensureGitattributes(ref.dir);
    const meta = readMeta(ref.dir);
    if (!validSecretsId(meta.secretsId)) writeMeta(ref.dir, { ...meta, secretsId: newSecretsId() });
  } else if (repo.user!.subfolder !== '') ensureGitignore(ref.dir);
  await ensureRepo(repo);
  await commitChange(ref, message);
  await upgradeLayoutLocked(ref);
}

// Projects from before the file-name layout change (lib/sync/layout.mjs) are
// upgraded once: snapshots renamed from their content, state and overrides
// re-keyed, saved changesets' keys mapped through the snapshot they are pinned
// to, all in one commit. Returns that commit, or null when nothing changed.
// Call inside withProjectLock.
export async function upgradeLayoutLocked(ref: ProjectRef): Promise<string | null> {
  const r = upgradeProjectLayout(ref.dir);
  const notes = [...r.notes];
  let changed = r.changed;
  if (r.fromLayout < LAYOUT_VERSION) {
    const dir = path.join(ref.dir, 'changesets');
    for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []) {
      const file = path.join(dir, f);
      let cs: { from?: unknown; sourceCommit?: unknown; keys?: unknown; layoutVersion?: unknown };
      try { cs = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      if (typeof cs.from !== 'string' || typeof cs.sourceCommit !== 'string' || !Array.isArray(cs.keys) || cs.layoutVersion === LAYOUT_VERSION) continue;
      const tree = await readTreeAt(await projectRepo(ref), cs.sourceCommit, `snapshots/${cs.from}`);
      const keys = cs.keys.map((k) => (typeof k === 'string' ? tree.rekeyed?.get(k) ?? k : k));
      if ((tree.layout ?? LAYOUT_VERSION) < LAYOUT_VERSION && keys.some((k, i) => k !== (cs.keys as unknown[])[i])) {
        writeFileSync(file, stableStringify({ ...cs, keys, layoutVersion: LAYOUT_VERSION }));
        notes.push(`changesets/${f}: re-keyed`);
        changed = true;
      }
    }
  }
  if (!changed) return null;
  const body = notes.length ? `File names now use the same encoding on every operating system.\n\n${notes.join('\n')}` : undefined;
  return commitChange(ref, body ? `Upgraded project layout\n\n${body}` : 'Upgraded project layout');
}

// The project's secrets id; projects without one (for example CLI-created
// ones in the workspace) become managed and get one now.
// An external project's id comes from its folder's real path (kinetic-migrate.json
// changes with the branch), and reading it never writes anything.
export async function secretsId(ref: ProjectRef): Promise<string> {
  const repo = await projectRepo(ref);
  if (repo.mode === 'external') return externalId(ref.dir);
  const id = readMeta(ref.dir).secretsId;
  if (validSecretsId(id)) return id;
  return withProjectLock(ref, async () => {
    await manageProject(ref, 'Started managing this project');
    return readMeta(ref.dir).secretsId as string;
  });
}
