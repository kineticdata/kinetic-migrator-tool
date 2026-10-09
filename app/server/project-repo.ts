// Where a project's history lives: its ProjectRepo.
//
// "managed": the project folder has no repository around it, or it is the
// root of a repository Kinetic Migrator created for it. History is
// <dir>/.git and the app commits there (as it always has).
//
// "external": the project folder is inside a repository the user already has
// (a monorepo, any subfolder, any branch, a linked worktree or a submodule).
// The app never writes to that repository through git: no commits, no index
// or config changes, no pushes. It writes the project's files and leaves
// committing to the user, and keeps its own private history repository in
// the app's data folder (its work tree is the project folder) so History,
// backups, Restore and pinned changesets keep working.
//
// By construction: every isomorphic-git call made for a ProjectRepo gets a
// file system that refuses writes outside that repo's gitdir (gitFs), the
// gitdir of an external project is checked to lie outside the project folder
// and the user's git folder, and the user's repository is only ever read,
// through a file system that refuses every write (READ_ONLY_FS).
//
// Fail safe: a repository is managed only when the app created it (the
// marker it writes right after its own `git init`) or it carries the app's
// signature from before the marker existed. Anything else, including an
// unreadable or unborn HEAD, is the user's.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git, { type PromiseFsClient } from 'isomorphic-git';
import { ApiError } from './errors.ts';

export type RepoMode = 'managed' | 'external';
export type UserRepoKind = 'repository' | 'worktree' | 'submodule';
export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

// The user's own repository around an external project (read-only).
export interface UserRepo {
  // The work tree root: the folder holding `.git`.
  root: string;
  // <root>/.git: a folder, or a file pointing elsewhere (worktree, submodule).
  dotGit: string;
  // This work tree's git folder (HEAD, index, MERGE_HEAD…).
  gitdir: string;
  // Objects, refs and config (the main repository's for a linked worktree).
  commondir: string;
  kind: UserRepoKind;
  // The project folder relative to root, '/'-separated ('' at the root).
  subfolder: string;
}

export interface ProjectRepo {
  readonly mode: RepoMode;
  // The work tree: the project folder.
  readonly dir: string;
  // Where commits go: <dir>/.git (managed) or the private history (external).
  readonly gitdir: string;
  // External only.
  readonly user?: Readonly<UserRepo>;
}

// The project layout: what the app and the CLI write and keep in history.
// Nothing else in the folder is ever staged. plans/, compares/ and backups/
// are local-only.
export const LAYOUT_DIRS = ['environments', 'overrides', 'snapshots', 'export', 'state', 'changesets', 'runs'];
export const LAYOUT_FILES = ['kinetic-sync.config.json', 'kinetic-migrate.json', '.gitignore', '.gitattributes'];
export const inLayout = (filepath: string): boolean => (
  LAYOUT_FILES.includes(filepath) || (filepath.includes('/') && LAYOUT_DIRS.includes(filepath.split('/')[0]))
);

// In a managed project's .git: "Kinetic Migrator created and manages this
// repository". In a private history folder: the record (work tree, author).
export const MARKER_FILE = 'kinetic-migrator.json';
const META_FILE = 'kinetic-migrate.json';
// The author the app commits as until someone sets one.
export const APP_AUTHOR = Object.freeze({ name: 'kinetic-migrate', email: 'kinetic-migrate@localhost' });

// ---- The app's data folder ---------------------------------------------------

// Per OS: macOS ~/Library/Application Support/Kinetic Migrator, Windows
// %APPDATA%\Kinetic Migrator, Linux $XDG_DATA_HOME/kinetic-migrator (or
// ~/.local/share/kinetic-migrator). KINETIC_MIGRATOR_DATA_DIR overrides it.
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.KINETIC_MIGRATOR_DATA_DIR) return p.resolve(env.KINETIC_MIGRATOR_DATA_DIR);
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'Kinetic Migrator');
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Kinetic Migrator');
  const xdg = env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, '.local', 'share');
  return p.join(xdg, 'kinetic-migrator');
}

export const historyRoot = (): string => path.join(appDataDir(), 'history');

// ---- File systems handed to isomorphic-git ---------------------------------

const fold = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The real path of `p`, resolving symlinks in its existing part.
function real(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const up = path.dirname(abs);
    return up === abs ? abs : path.join(real(up), path.basename(abs));
  }
}

const READS = ['readFile', 'stat', 'lstat', 'readdir', 'readlink'] as const;
const WRITES = ['writeFile', 'mkdir', 'rmdir', 'unlink', 'symlink', 'rm', 'chmod', 'rename'] as const;
type AnyFn = (...args: unknown[]) => Promise<unknown>;

export class RefusedWriteError extends Error {
  code = 'EKM_REFUSED_WRITE';
}

function makeFs(canWrite: (abs: string) => boolean): PromiseFsClient {
  const fsp = fs.promises as unknown as Record<string, AnyFn>;
  const promises: Record<string, AnyFn> = {};
  for (const m of READS) promises[m] = (...a) => fsp[m](...a);
  for (const m of WRITES) {
    promises[m] = async (target, ...rest) => {
      if (!canWrite(path.resolve(String(target)))) throw new RefusedWriteError(`Kinetic Migrator refused to write ${String(target)}: it is outside the project's history repository.`);
      return fsp[m](target, ...rest);
    };
  }
  return { promises } as unknown as PromiseFsClient;
}

// For the user's repository: every write is refused.
export const READ_ONLY_FS = makeFs(() => false);

const gitFsCache = new Map<string, PromiseFsClient>();
// For a ProjectRepo: writes only inside its gitdir (isomorphic-git never
// writes the work tree here: nothing is ever checked out), and for an
// external project never in the project folder or the user's git folders.
export function gitFs(repo: ProjectRepo): PromiseFsClient {
  const user = repo.user;
  const key = [repo.gitdir, repo.dir, user?.gitdir ?? '', user?.commondir ?? ''].join('\0');
  let f = gitFsCache.get(key);
  if (!f) {
    const { gitdir, dir } = repo;
    f = makeFs((abs) => isInside(abs, gitdir) && !(user && (isInside(abs, dir) || isInside(abs, user.gitdir) || isInside(abs, user.commondir))));
    gitFsCache.set(key, f);
  }
  return f;
}

// ---- Finding the repository around a folder --------------------------------

const refuse = (message: string) => new ApiError(400, 'unsupported_repository', message);

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const isDirectory = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const configSaysBare = (gitdir: string) => /^\s*bare\s*=\s*true\s*$/im.test(readText(path.join(gitdir, 'config')) ?? '');

function looksBare(p: string): boolean {
  return fs.existsSync(path.join(p, 'HEAD')) && isDirectory(path.join(p, 'objects')) && isDirectory(path.join(p, 'refs')) && configSaysBare(p);
}

function describe(root: string, dotGit: string, dir: string): UserRepo {
  const subfolder = path.relative(root, dir).split(path.sep).join('/');
  let gitdir = dotGit;
  let kind: UserRepoKind = 'repository';
  if (!isDirectory(dotGit)) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
    if (!m) throw refuse(`${dotGit} is not a git folder or a valid pointer to one, so Kinetic Migrator cannot tell which repository this project is in.`);
    gitdir = path.resolve(root, m[1]);
    if (!isDirectory(gitdir)) throw refuse(`${dotGit} points to a git folder that does not exist (${gitdir}). Repair the repository (for a worktree: git worktree prune) and open the project again.`);
  }
  const common = readText(path.join(gitdir, 'commondir'));
  const commondir = common ? path.resolve(gitdir, common.trim()) : gitdir;
  if (common) kind = 'worktree';
  else if (gitdir !== dotGit && /[\\/]modules[\\/]/.test(gitdir)) kind = 'submodule';
  if (configSaysBare(commondir) && !common) throw refuse('This folder is inside a bare git repository (one with no working files). Clone it and open the project folder in the clone.');
  return { root, dotGit, gitdir, commondir, kind, subfolder };
}

// The nearest repository around `dir` (including `dir` itself), or null.
// Throws a plain refusal for a bare repository or a broken `.git` file.
export function findEnclosingRepository(dir: string): UserRepo | null {
  const start = path.resolve(dir);
  for (let p = start; ; p = path.dirname(p)) {
    const dotGit = path.join(p, '.git');
    if (fs.existsSync(dotGit)) return describe(p, dotGit, start);
    if (looksBare(p)) throw refuse('This folder is inside a bare git repository (one with no working files). Clone it and open the project folder in the clone.');
    if (path.dirname(p) === p) return null;
  }
}

// ---- Reading the user's repository (never writing) --------------------------

export function userBranch(u: UserRepo): string | null {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(readText(path.join(u.gitdir, 'HEAD')) ?? '');
  return m ? m[1] : null;
}

export function userOperation(u: UserRepo): RepoOperation | null {
  const has = (n: string) => fs.existsSync(path.join(u.gitdir, n));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}

async function userHead(u: UserRepo): Promise<string | null> {
  const text = (readText(path.join(u.gitdir, 'HEAD')) ?? '').trim();
  if (/^[0-9a-f]{40}$/i.test(text)) return text;
  const m = /^ref:\s*(\S+)$/.exec(text);
  if (!m) return null;
  try {
    // A linked worktree's branches live in the main repository's refs.
    return await git.resolveRef({ fs: READ_ONLY_FS, gitdir: u.commondir, ref: m[1] });
  } catch {
    return null;
  }
}

// Files in the project folder that differ from the user's last commit
// (modified, added or deleted; ignored files left out).
export async function userChangedFiles(u: UserRepo): Promise<number> {
  const head = await userHead(u);
  const sub = u.subfolder;
  const within = (f: string) => sub === '' || f === sub || f.startsWith(`${sub}/`);
  const toward = (f: string) => within(f) || sub.startsWith(`${f}/`);
  const ctx = { fs: READ_ONLY_FS, dir: u.root, gitdir: u.commondir };
  let changed = 0;
  await git.walk({
    ...ctx,
    trees: head ? [git.TREE({ ref: head }), git.WORKDIR({ refresh: false })] : [git.WORKDIR({ refresh: false })],
    map: async (filepath, entries) => {
      if (filepath === '.') return true;
      if (!toward(filepath)) return null;
      const [h, w] = head ? entries : [null, entries[0]];
      const ht = h ? await h.type() : undefined;
      const wt = w ? await w.type() : undefined;
      if (ht === 'commit') return null;
      if (!h && w && await git.isIgnored({ ...ctx, filepath })) return null;
      if (within(filepath) && (ht === 'blob' || wt === 'blob')) {
        const ho = ht === 'blob' ? await h!.oid() : undefined;
        const wo = wt === 'blob' ? await w!.oid() : undefined;
        if (ho !== wo) changed++;
      }
      return true;
    },
  });
  return changed;
}

// The changed-files count, cached: it hashes the whole project folder, so it
// is worked out in the background and served from the cache while the
// user's HEAD and index, the project folder and its top-level entries look
// the same (by mtime and size) and it is younger than STATUS_TTL. App
// writes invalidate it. Until a count is ready, `checking` is true.
const STATUS_TTL = 15_000;
interface StatusEntry { value: number | null; stamp: string; at: number; running: Promise<void> | null }
const statusCache = new Map<string, StatusEntry>();
const statusKey = (u: UserRepo) => `${u.root}\0${u.subfolder}`;

function statusStamp(u: UserRepo): string {
  const dir = u.subfolder ? path.join(u.root, ...u.subfolder.split('/')) : u.root;
  const parts: string[] = [];
  const add = (p: string) => {
    try {
      const st = fs.statSync(p);
      parts.push(`${p}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${p}:-`);
    }
  };
  add(path.join(u.gitdir, 'HEAD'));
  add(path.join(u.gitdir, 'index'));
  add(dir);
  try {
    for (const name of fs.readdirSync(dir).sort()) add(path.join(dir, name));
  } catch {
    // An unreadable folder: the TTL still applies.
  }
  return parts.join('|');
}

export function invalidateStatus(u: UserRepo): void {
  const e = statusCache.get(statusKey(u));
  if (e) e.stamp = '';
}

export function changedFilesStatus(u: UserRepo, now: number = Date.now()): { changedFiles: number | null; checking: boolean } {
  const key = statusKey(u);
  const e = statusCache.get(key);
  const stamp = statusStamp(u);
  if (e && !e.running && e.stamp === stamp && now - e.at < STATUS_TTL) return { changedFiles: e.value, checking: false };
  if (!e?.running) {
    const entry: StatusEntry = e ?? { value: null, stamp: '', at: 0, running: null };
    entry.running = userChangedFiles(u)
      .then((n) => { entry.value = n; }, () => { entry.value = null; })
      .then(() => { entry.stamp = stamp; entry.at = Date.now(); entry.running = null; });
    statusCache.set(key, entry);
  }
  return { changedFiles: e?.value ?? null, checking: true };
}

// Resolves when a count being worked out is ready (tests).
export const statusSettled = async (u: UserRepo): Promise<void> => { await statusCache.get(statusKey(u))?.running; };

// ---- The private history of an external project ------------------------------

// An external project's id: derived from the project folder's real path,
// never from its files (which change with the branch). It keys the private
// history and the keychain. Moving the folder starts a new private history.
export function externalId(dir: string): string {
  const h = createHash('sha256').update(fold(real(dir))).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface HistoryRecord {
  worktree?: string;
  author?: { name: string; email: string };
}

function readRecord(gitdir: string): HistoryRecord {
  try {
    const r = JSON.parse(readText(path.join(gitdir, MARKER_FILE)) ?? '');
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  } catch {
    return {};
  }
}

const privateGitdir = (dir: string) => path.join(historyRoot(), externalId(dir));

// The private history must not be in the project folder (it would track
// itself) or in the user's git folders. Elsewhere in the user's work tree
// (a home folder kept in git) is fine: nothing there is written through git.
function assertOutside(gitdir: string, dir: string, u: UserRepo): void {
  const g = real(gitdir);
  if ([dir, u.gitdir, u.commondir].some((p) => isInside(g, real(p)))) {
    throw new ApiError(409, 'history_inside_repository', `Kinetic Migrator keeps this project's history in ${appDataDir()}, which is inside the project folder or your repository's .git folder. Set KINETIC_MIGRATOR_DATA_DIR to a folder outside them and start the app again.`);
  }
}

// Creates the private history and records which folder it belongs to.
export async function ensurePrivateHistory(repo: ProjectRepo): Promise<void> {
  if (repo.mode !== 'external') throw new Error('Only an external project has a private history.');
  assertOutside(repo.gitdir, repo.dir, repo.user!);
  fs.mkdirSync(path.dirname(repo.gitdir), { recursive: true });
  if (!fs.existsSync(path.join(repo.gitdir, 'config'))) await git.init({ fs: gitFs(repo), dir: repo.dir, gitdir: repo.gitdir, defaultBranch: 'main' });
  const record = readRecord(repo.gitdir);
  if (record.worktree !== repo.dir) writeRecord(repo, { ...record, worktree: repo.dir });
}

function writeRecord(repo: ProjectRepo, record: HistoryRecord): void {
  const file = path.join(repo.gitdir, MARKER_FILE);
  if (!isInside(file, repo.gitdir)) throw new RefusedWriteError('Refused to write outside the private history.');
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

// The commit author of an external project lives with its private history
// (never in the project files, which are shared through the user's repository).
export function privateAuthor(repo: ProjectRepo): HistoryRecord['author'] | undefined {
  const a = readRecord(repo.gitdir).author;
  return a && typeof a.name === 'string' && typeof a.email === 'string' ? a : undefined;
}

export async function setPrivateAuthor(repo: ProjectRepo, author: { name: string; email: string }): Promise<void> {
  await ensurePrivateHistory(repo);
  writeRecord(repo, { ...readRecord(repo.gitdir), author });
}

// ---- Deciding the mode ----------------------------------------------------

const managed = (dir: string): ProjectRepo => Object.freeze({ mode: 'managed', dir, gitdir: path.join(dir, '.git') });

// Repositories from before the marker carry the app's exact signature: one
// root commit, by the app's own author, titled exactly "Created project
// <name>" (the name in that commit's kinetic-migrate.json) or "Started
// managing this project", and every tracked file a project-layout path.
// Anything unreadable is not a match.
const legacyCache = new Map<string, boolean>();
async function looksAppCreated(u: UserRepo): Promise<boolean> {
  const head = await userHead(u);
  if (!head) return false;
  const key = `${u.commondir}\0${head}`;
  const known = legacyCache.get(key);
  if (known !== undefined) return known;
  let verdict = false;
  try {
    const ro = { fs: READ_ONLY_FS, gitdir: u.commondir };
    const roots = (await git.log({ ...ro, ref: head })).filter((c) => c.commit.parent.length === 0);
    if (roots.length === 1) {
      const [{ oid, commit }] = roots;
      const title = commit.message.split('\n')[0];
      const byApp = commit.author.name === APP_AUTHOR.name && commit.author.email === APP_AUTHOR.email;
      let titled = title === 'Started managing this project';
      if (!titled && title.startsWith('Created project ')) {
        const { blob } = await git.readBlob({ ...ro, oid, filepath: META_FILE });
        const name = JSON.parse(Buffer.from(blob).toString('utf8').replace(/^\uFEFF/, ''))?.name;
        titled = typeof name === 'string' && title === `Created project ${name}`;
      }
      verdict = byApp && titled && (await git.listFiles({ ...ro, ref: head })).every(inLayout);
    }
  } catch {
    verdict = false;
  }
  legacyCache.set(key, verdict);
  return verdict;
}

// A repository matching the legacy signature is the app's own: it gets the
// marker once, so a file the user adds later never turns it into theirs.
async function isAppManaged(dir: string, u: UserRepo): Promise<boolean> {
  if (fs.existsSync(path.join(u.gitdir, MARKER_FILE))) return true;
  if (!(await looksAppCreated(u))) return false;
  markManaged(managed(dir));
  return true;
}

// Marks a repository as the app's: right after its own `git init`, or once
// for one matching the strict legacy signature. Never any other repository.
export function markManaged(repo: ProjectRepo): void {
  if (repo.mode !== 'managed' || !isDirectory(repo.gitdir)) return;
  const file = path.join(repo.gitdir, MARKER_FILE);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ managed: true }, null, 2)}\n`);
}

export async function projectRepo(ref: { dir: string }): Promise<ProjectRepo> {
  const dir = path.resolve(ref.dir);
  const user = findEnclosingRepository(dir);
  if (!user) return managed(dir);
  if (user.kind === 'repository' && user.gitdir === user.dotGit && fold(user.root) === fold(dir) && await isAppManaged(dir, user)) return managed(dir);
  const gitdir = privateGitdir(dir);
  assertOutside(gitdir, dir, user);
  return Object.freeze({ mode: 'external', dir, gitdir, user: Object.freeze(user) });
}

// The plain name of the user's repository (its root folder's name).
export const userRepoName = (u: UserRepo): string => path.basename(u.kind === 'worktree' ? path.dirname(u.commondir) : u.root) || u.root;
