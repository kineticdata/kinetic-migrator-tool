// Project history via isomorphic-git (bundled; no git install needed), for a
// ProjectRepo (see project-repo.ts): <dir>/.git for a managed project, the
// private history repository for a project inside the user's own repository.
// Linear history on `main`: commit everything that changed in the project
// layout (adds and deletes), read the log by path, read a JSON tree at a
// commit, and (managed only) push to an optional remote with a token from the
// secrets store. Every call goes through gitFs(repo): writes land only in
// repo.gitdir.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import type { SecretStore } from './secrets.ts';
import { LAYOUT_VERSION, MARKER, markerLayout, markerOmitted, rekeyTree, type LoadedTree } from './engine-sync.ts';
import { withLock } from './locks.ts';
import { ensurePrivateHistory, gitFs, inLayout, markManaged, type ProjectRepo } from './project-repo.ts';

export { LAYOUT_DIRS, LAYOUT_FILES, inLayout, type ProjectRepo } from './project-repo.ts';

export interface Author { name: string; email: string }

export interface LogEntry {
  oid: string;
  message: string;
  at: string;
  author: Author;
}

const BRANCH = 'main';

// Belt and braces on top of .gitignore: credentials files are never staged.
const NEVER_STAGE = (filepath: string) => /(^|\/)\.env[^/]*$/.test(filepath);

// The arguments every isomorphic-git call takes for this repository.
export const g = (repo: ProjectRepo) => ({ fs: gitFs(repo), dir: repo.dir, gitdir: repo.gitdir });

// A managed project's repository at <dir>/.git (tests and new projects).
export const managedRepo = (dir: string): ProjectRepo => Object.freeze({ mode: 'managed' as const, dir: path.resolve(dir), gitdir: path.join(path.resolve(dir), '.git') });

export const hasHistory = (repo: ProjectRepo): boolean => fs.existsSync(path.join(repo.gitdir, 'config'));

export async function ensureRepo(repo: ProjectRepo): Promise<void> {
  if (repo.mode === 'external') return ensurePrivateHistory(repo);
  if (!fs.existsSync(repo.gitdir)) await git.init({ ...g(repo), defaultBranch: BRANCH });
  markManaged(repo);
}

// The checked-out branch of a managed repository: undefined when there is no
// repository, null when HEAD is detached.
export async function currentBranch(repo: ProjectRepo): Promise<string | null | undefined> {
  if (!hasHistory(repo) && !fs.existsSync(repo.gitdir)) return undefined;
  try {
    return (await git.currentBranch({ ...g(repo), fullname: false })) ?? null;
  } catch {
    return null;
  }
}

// Whether anything in the project layout differs from HEAD, by file stats
// (cheap; commitAll re-reads every file).
export async function layoutDirty(repo: ProjectRepo): Promise<boolean> {
  const rows = await git.statusMatrix({ ...g(repo), filter: (f) => inLayout(f) && !NEVER_STAGE(f) });
  return rows.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
}

// Stages every change (adds, modifications, deletions) within the project
// layout and commits. Returns the new commit id, or null when nothing
// differs from HEAD (unless `always`: then an empty commit is recorded).
export function commitAll(repo: ProjectRepo, message: string, author: Author, opts: { always?: boolean } = {}): Promise<string | null> {
  return withLock(`${repo.gitdir}\0history`, async () => {
    const status = () => git.statusMatrix({ ...g(repo), filter: (f) => inLayout(f) && !NEVER_STAGE(f) });
    // Every present file is re-added: statusMatrix trusts file stats, which
    // miss same-size rewrites within the same second ("racy git").
    const present: string[] = [];
    for (const [filepath, head, workdir, stage] of await status()) {
      if (workdir === 0) {
        if (head === 1 || stage !== 0) await git.remove({ ...g(repo), filepath });
      } else present.push(filepath);
    }
    if (present.length) await git.add({ ...g(repo), filepath: present });
    const same = (await status()).every(([, head, , stage]) => (head === 1 && stage === 1) || (head === 0 && stage === 0));
    if (same && !opts.always) return null;
    return git.commit({ ...g(repo), message, author: { ...author, timestamp: Math.floor(Date.now() / 1000) } });
  });
}

export async function headOid(repo: ProjectRepo): Promise<string | null> {
  if (!hasHistory(repo)) return null;
  try {
    return await git.resolveRef({ ...g(repo), ref: 'HEAD' });
  } catch {
    return null;
  }
}

const toEntry = (c: Awaited<ReturnType<typeof git.log>>[number]): LogEntry => ({
  oid: c.oid,
  message: c.commit.message.replace(/\n$/, ''),
  at: new Date(c.commit.author.timestamp * 1000).toISOString(),
  author: { name: c.commit.author.name, email: c.commit.author.email },
});

// One commit as a log entry, or null when it is not in this history.
export async function readEntry(repo: ProjectRepo, oid: string): Promise<LogEntry | null> {
  try {
    const { commit } = await git.readCommit({ ...g(repo), oid });
    return toEntry({ oid, commit, payload: '' });
  } catch {
    return null;
  }
}

// Newest first. With `path`, only commits that changed that file or folder.
export async function log(repo: ProjectRepo, opts: { path?: string; limit: number }): Promise<LogEntry[]> {
  if (!(await headOid(repo))) return [];
  if (!opts.path) return (await git.log({ ...g(repo), depth: opts.limit })).map(toEntry);
  const all = await git.log({ ...g(repo) });
  const out: LogEntry[] = [];
  // A commit touches `path` when the object at `path` differs from its parent's.
  for (const c of all) {
    if (out.length >= opts.limit) break;
    const parent = c.commit.parent[0];
    const mine = await treeOidAt(repo, c.oid, opts.path);
    const theirs = parent ? await treeOidAt(repo, parent, opts.path) : null;
    if (mine !== theirs) out.push(toEntry(c));
  }
  return out;
}

async function treeOidAt(repo: ProjectRepo, commit: string, filepath: string): Promise<string | null> {
  try {
    const { oid } = await git.readObject({ ...g(repo), oid: commit, filepath, format: 'deflated' });
    return oid;
  } catch {
    return null;
  }
}

// Every JSON blob under `subdir` at `commit`, keyed by its path relative to
// `subdir` without `.json` (the engine's artifact keys). A tree written in an
// older file-name layout comes back re-keyed from its content (`rekeyed`,
// `unresolved`: see lib/sync/layout.mjs); `raw` skips that.
export async function readTreeAt(repo: ProjectRepo, commit: string, subdir: string, opts: { raw?: boolean } = {}): Promise<LoadedTree> {
  const out = new Map<string, unknown>();
  let marker: string | undefined;
  const prefix = subdir.replace(/^\/+|\/+$/g, '');
  let root: string;
  try {
    root = prefix ? (await git.readTree({ ...g(repo), oid: commit, filepath: prefix })).oid : (await git.readTree({ ...g(repo), oid: commit })).oid;
  } catch {
    return rekeyTree(out, LAYOUT_VERSION);
  }
  const walk = async (oid: string, base: string): Promise<void> => {
    const { tree } = await git.readTree({ ...g(repo), oid });
    for (const entry of tree) {
      const rel = base ? `${base}/${entry.path}` : entry.path;
      if (!base && entry.path === MARKER && entry.type === 'blob') marker = Buffer.from((await git.readBlob({ ...g(repo), oid: entry.oid })).blob).toString('utf8');
      if (entry.type === 'tree') await walk(entry.oid, rel);
      else if (entry.type === 'blob' && entry.path.endsWith('.json')) {
        const { blob } = await git.readBlob({ ...g(repo), oid: entry.oid });
        out.set(rel.slice(0, -'.json'.length).normalize('NFC'), JSON.parse(Buffer.from(blob).toString('utf8').replace(/^\uFEFF/, '')));
      }
    }
  };
  await walk(root, '');
  return rekeyTree(out, opts.raw ? LAYOUT_VERSION : markerLayout(marker), markerOmitted(marker));
}

// Remotes and pushing belong to managed projects only: a project inside the
// user's own repository is pushed with their own git tools.
function managedOnly(repo: ProjectRepo): void {
  if (repo.mode !== 'managed') {
    throw Object.assign(new Error('This project is in your own repository: Kinetic Migrator never changes its remotes or pushes it.'), { code: 'ExternalRepositoryError' });
  }
}

export async function getRemote(repo: ProjectRepo): Promise<string | null> {
  if (repo.mode !== 'managed' || !hasHistory(repo)) return null;
  const remotes = await git.listRemotes({ ...g(repo) });
  return remotes.find((r) => r.remote === 'origin')?.url ?? null;
}

export async function setRemote(repo: ProjectRepo, url: string | null): Promise<void> {
  managedOnly(repo);
  const current = await getRemote(repo);
  if (current !== null) await git.deleteRemote({ ...g(repo), remote: 'origin' });
  if (url) await git.addRemote({ ...g(repo), remote: 'origin', url });
}

// The token travels as HTTP basic auth: https, or plain http only to this
// computer.
export function isSafeRemoteUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
}

// Pushes `main` to origin. The token comes from the store and is sent only to
// the remote as HTTP basic auth. The remote is checked again here, since it
// may have been set outside the app. Errors never repeat the URL.
export async function push(repo: ProjectRepo, opts: { store: SecretStore; account: string }): Promise<void> {
  managedOnly(repo);
  const url = await getRemote(repo);
  if (!url) throw new Error('No remote repository is set.');
  if (!isSafeRemoteUrl(url)) {
    throw Object.assign(new Error('The remote repository’s address must start with https:// before anything is pushed to it.'), { code: 'UnsafeRemoteError' });
  }
  const token = await opts.store.get(opts.account);
  const result = await git.push({
    ...g(repo), http, remote: 'origin', ref: BRANCH,
    onAuth: () => (token ? { username: token, password: 'x-oauth-basic' } : { cancel: true }),
  });
  if (!result.ok) throw new Error('The remote repository rejected the push.');
}
