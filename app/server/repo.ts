// Project repositories via isomorphic-git (bundled; no git install needed).
// Linear history on `main`: commit everything that changed (adds and
// deletes), read the log by path, read a JSON tree at a commit, and push to an
// optional remote with a token from the secrets store.
import fs from 'node:fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import type { SecretStore } from './secrets.ts';
import { LAYOUT_VERSION, MARKER, markerLayout, markerOmitted, rekeyTree, type LoadedTree } from './engine-sync.ts';

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

// The project layout: what the app and the CLI write and keep in history.
// Nothing else in the folder is ever staged (a project opened inside another
// repository must not sweep up that repository's files). plans/, compares/
// and backups/ are local-only and ignored.
export const LAYOUT_DIRS = ['environments', 'overrides', 'snapshots', 'export', 'state', 'changesets', 'runs'];
export const LAYOUT_FILES = ['kinetic-sync.config.json', 'kinetic-migrate.json', '.gitignore', '.gitattributes'];
export const inLayout = (filepath: string): boolean => (
  LAYOUT_FILES.includes(filepath) || (filepath.includes('/') && LAYOUT_DIRS.includes(filepath.split('/')[0]))
);

export async function ensureRepo(dir: string): Promise<void> {
  if (fs.existsSync(`${dir}/.git`)) return;
  await git.init({ fs, dir, defaultBranch: BRANCH });
}

// The checked-out branch: undefined when there is no repository, null when
// HEAD is detached.
export async function currentBranch(dir: string): Promise<string | null | undefined> {
  if (!fs.existsSync(`${dir}/.git`)) return undefined;
  try {
    return (await git.currentBranch({ fs, dir, fullname: false })) ?? null;
  } catch {
    return null;
  }
}

// Stages every change (adds, modifications, deletions) within the project
// layout and commits. Returns the new commit id, or null when nothing
// differs from HEAD.
export async function commitAll(dir: string, message: string, author: Author): Promise<string | null> {
  const status = () => git.statusMatrix({ fs, dir, filter: (f) => inLayout(f) && !NEVER_STAGE(f) });
  // Every present file is re-added: statusMatrix trusts file stats, which
  // miss same-size rewrites within the same second ("racy git").
  const present: string[] = [];
  for (const [filepath, head, workdir, stage] of await status()) {
    if (workdir === 0) {
      if (head === 1 || stage !== 0) await git.remove({ fs, dir, filepath });
    } else present.push(filepath);
  }
  if (present.length) await git.add({ fs, dir, filepath: present });
  const same = (await status()).every(([, head, , stage]) => (head === 1 && stage === 1) || (head === 0 && stage === 0));
  if (same) return null;
  return git.commit({ fs, dir, message, author: { ...author, timestamp: Math.floor(Date.now() / 1000) } });
}

async function headOid(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' });
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

// Newest first. With `path`, only commits that changed that file or folder.
export async function log(dir: string, opts: { path?: string; limit: number }): Promise<LogEntry[]> {
  if (!(await headOid(dir))) return [];
  if (!opts.path) return (await git.log({ fs, dir, depth: opts.limit })).map(toEntry);
  const all = await git.log({ fs, dir });
  const out: LogEntry[] = [];
  // A commit touches `path` when the object at `path` differs from its parent's.
  for (const c of all) {
    if (out.length >= opts.limit) break;
    const parent = c.commit.parent[0];
    const mine = await treeOidAt(dir, c.oid, opts.path);
    const theirs = parent ? await treeOidAt(dir, parent, opts.path) : null;
    if (mine !== theirs) out.push(toEntry(c));
  }
  return out;
}

async function treeOidAt(dir: string, commit: string, filepath: string): Promise<string | null> {
  try {
    const { oid } = await git.readObject({ fs, dir, oid: commit, filepath, format: 'deflated' });
    return oid;
  } catch {
    return null;
  }
}

// Every JSON blob under `subdir` at `commit`, keyed by its path relative to
// `subdir` without `.json` (the engine's artifact keys). A tree written in an
// older file-name layout comes back re-keyed from its content (`rekeyed`,
// `unresolved`: see lib/sync/layout.mjs); `raw` skips that.
export async function readTreeAt(dir: string, commit: string, subdir: string, opts: { raw?: boolean } = {}): Promise<LoadedTree> {
  const out = new Map<string, unknown>();
  let marker: string | undefined;
  const prefix = subdir.replace(/^\/+|\/+$/g, '');
  let root: string;
  try {
    root = prefix ? (await git.readTree({ fs, dir, oid: commit, filepath: prefix })).oid : (await git.readTree({ fs, dir, oid: commit })).oid;
  } catch {
    return rekeyTree(out, LAYOUT_VERSION);
  }
  const walk = async (oid: string, base: string): Promise<void> => {
    const { tree } = await git.readTree({ fs, dir, oid });
    for (const entry of tree) {
      const rel = base ? `${base}/${entry.path}` : entry.path;
      if (!base && entry.path === MARKER && entry.type === 'blob') marker = Buffer.from((await git.readBlob({ fs, dir, oid: entry.oid })).blob).toString('utf8');
      if (entry.type === 'tree') await walk(entry.oid, rel);
      else if (entry.type === 'blob' && entry.path.endsWith('.json')) {
        const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
        out.set(rel.slice(0, -'.json'.length).normalize('NFC'), JSON.parse(Buffer.from(blob).toString('utf8').replace(/^\uFEFF/, '')));
      }
    }
  };
  await walk(root, '');
  return rekeyTree(out, opts.raw ? LAYOUT_VERSION : markerLayout(marker), markerOmitted(marker));
}

export async function getRemote(dir: string): Promise<string | null> {
  const remotes = await git.listRemotes({ fs, dir });
  return remotes.find((r) => r.remote === 'origin')?.url ?? null;
}

export async function setRemote(dir: string, url: string | null): Promise<void> {
  const current = await getRemote(dir);
  if (current !== null) await git.deleteRemote({ fs, dir, remote: 'origin' });
  if (url) await git.addRemote({ fs, dir, remote: 'origin', url });
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
export async function push(dir: string, opts: { store: SecretStore; account: string }): Promise<void> {
  const url = await getRemote(dir);
  if (!url) throw new Error('No remote repository is set.');
  if (!isSafeRemoteUrl(url)) {
    throw Object.assign(new Error('The remote repository’s address must start with https:// before anything is pushed to it.'), { code: 'UnsafeRemoteError' });
  }
  const token = await opts.store.get(opts.account);
  const result = await git.push({
    fs, http, dir, remote: 'origin', ref: BRANCH,
    onAuth: () => (token ? { username: token, password: 'x-oauth-basic' } : { cancel: true }),
  });
  if (!result.ok) throw new Error('The remote repository rejected the push.');
}
