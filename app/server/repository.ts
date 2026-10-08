// Settings → Repository: the commit author (kinetic-migrate.json, committed),
// the optional remote (git config, never committed), a write-only token in the
// secrets store, and pushing as a job. The last push outcome is kept in
// .git/, so it stays local. The token is sent only to the remote.
// Routes: GET/PUT /api/projects/:p/repository, POST /api/projects/:p/repository/push.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import type { LastPush, RepositoryAuthor, RepositorySettings } from '../shared/repository-api.ts';
import { ApiError, badRequest } from './errors.ts';
import type { JobRegistry } from './jobs.ts';
import {
  DEFAULT_AUTHOR, commitChange, isPlainObject, readMeta, secretsId, withProjectLock, withSecretsLock, writeMeta, type ProjectRef,
} from './project-meta.ts';
import { findProject } from './projects.ts';
import { getRemote, push as repoPush, setRemote } from './repo.ts';
import type { Router } from './router.ts';
import { accountFor, type SecretStore } from './secrets.ts';

export interface RepositoryContext {
  workspace: string;
  secrets: SecretStore;
  jobs: JobRegistry;
}

type PushFn = (dir: string, opts: { store: SecretStore; account: string }) => Promise<void>;
let pushImpl: PushFn = repoPush;

// Tests swap the push (a real one needs a git server); returns the undo.
export function setPushImplementation(fn: PushFn): () => void {
  const prev = pushImpl;
  pushImpl = fn;
  return () => { pushImpl = prev; };
}

// The project-level keychain scope ('_project' cannot be an environment name).
const tokenAccount = async (ref: ProjectRef) => accountFor(await secretsId(ref), '_project', 'git', 'token');

const LAST_PUSH = 'kinetic-migrate-last-push.json';
const lastPushFile = (ref: ProjectRef) => path.join(ref.dir, '.git', LAST_PUSH);

function readLastPush(ref: ProjectRef): LastPush | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lastPushFile(ref), 'utf8'));
    if (!isPlainObject(raw) || typeof raw.at !== 'string' || typeof raw.ok !== 'boolean') return null;
    return {
      at: raw.at, ok: raw.ok,
      commit: typeof raw.commit === 'string' ? raw.commit : null,
      message: typeof raw.message === 'string' ? raw.message : null,
    };
  } catch {
    return null;
  }
}

function clearLastPush(ref: ProjectRef): void {
  fs.rmSync(lastPushFile(ref), { force: true });
}

function writeLastPush(ref: ProjectRef, last: LastPush): void {
  try {
    fs.writeFileSync(lastPushFile(ref), JSON.stringify(last));
  } catch {
    // Only a convenience; the push itself is what matters.
  }
}

// A remote URL as shown: never with credentials in it.
function displayUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    // Not a URL (for example scp-style); drop anything before an '@'.
    return url.replace(/^[^@/]*@/, '');
  }
}

export async function repositorySettings(ref: ProjectRef, store: SecretStore): Promise<RepositorySettings> {
  const meta = readMeta(ref.dir);
  const url = await getRemote(ref.dir).catch(() => null);
  return {
    author: meta.author ?? DEFAULT_AUTHOR,
    remote: { url: displayUrl(url), token: { has: url ? await store.has(await tokenAccount(ref)) : false } },
    lastPush: readLastPush(ref),
  };
}

const CONTROL = /[\x00-\x1f\x7f]/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

function parseAuthor(v: unknown): RepositoryAuthor {
  if (!isPlainObject(v) || typeof v.name !== 'string' || typeof v.email !== 'string') throw badRequest('The author needs a name and an email.');
  const name = v.name.trim();
  const email = v.email.trim();
  if (!name || name.length > 200 || CONTROL.test(name) || /[<>]/.test(name)) throw badRequest('Enter the author’s name.');
  if (email.length > 200 || !EMAIL.test(email)) throw badRequest('Enter a valid email address for the author.');
  return { name, email };
}

// Error messages never repeat the URL: it may hold a credential.
function parseRemoteUrl(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 2000 || CONTROL.test(v)) throw badRequest('Enter the remote repository’s address.');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw badRequest('Enter the remote repository’s address, starting with https://.');
  }
  // The token travels as basic auth: plain http only to this computer.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw badRequest('The remote repository’s address must start with https://.');
  if (u.username || u.password) throw badRequest('Leave sign-in details out of the address: put the token in the Token field.');
  return u.toString();
}

// null and '' both mean "remove the token".
function parseToken(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 4000 || /[\r\n\x00]/.test(v)) throw badRequest('The token must be a single line of text.');
  return v.trim() || null;
}

export async function putRepository(ref: ProjectRef, store: SecretStore, body: unknown): Promise<RepositorySettings> {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  const author = body.author === undefined ? undefined : parseAuthor(body.author);
  const remoteUrl = body.remoteUrl === undefined ? undefined : parseRemoteUrl(body.remoteUrl);
  const token = body.token === undefined ? undefined : parseToken(body.token);
  const account = await tokenAccount(ref);
  let remoteChanged = false;
  await withProjectLock(ref, async () => {
    if (author) {
      writeMeta(ref.dir, { ...readMeta(ref.dir), author });
      await commitChange(ref, 'Updated repository settings');
    }
    if (remoteUrl !== undefined) {
      const current = await getRemote(ref.dir).catch(() => null);
      remoteChanged = (current ?? null) !== remoteUrl;
      if (remoteChanged) await setRemote(ref.dir, remoteUrl);
    }
    // The last outcome is about settings that may no longer hold.
    clearLastPush(ref);
  });
  await withSecretsLock(ref, async () => {
    // A token belongs to the remote it was given for: a disconnected or
    // different remote keeps none unless a new one comes with it.
    if (remoteUrl === null || token === null || (remoteChanged && !token)) await store.delete(account);
    else if (token) await store.set(account, token);
  });
  return repositorySettings(ref, store);
}

// The push failure in plain words, from status codes only (remote bodies and
// URLs stay server-side).
function pushError(err: unknown): ApiError {
  const e = err as { code?: string; name?: string; data?: { statusCode?: number } } | null;
  const code = e?.code ?? e?.name;
  const status = e?.data?.statusCode;
  let message = 'The push did not complete.';
  if (code === 'UserCanceledError') message = 'The remote repository needs a token: add one in Settings → Repository.';
  else if (code === 'HttpError' && (status === 401 || status === 403)) message = `The remote repository refused the token (${status}). Check it has write access.`;
  else if (code === 'HttpError' && status === 404) message = 'There is no repository at that address (404).';
  else if (code === 'HttpError') message = `The remote repository returned an error (${status ?? 'unknown'}).`;
  else if (code === 'PushRejectedError') message = 'The remote repository has changes this project does not have, so the push was refused.';
  else if (code === 'SmartHttpError') message = 'That address does not look like a git repository.';
  else if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(String((err as { code?: string })?.code))) {
    message = 'Could not reach the remote repository.';
  }
  return new ApiError(502, 'push_failed', message);
}

async function headOid(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' });
  } catch {
    return null;
  }
}

export function registerRepositoryRoutes(router: Router, ctx: RepositoryContext): void {
  const find = (id: string) => findProject(ctx.workspace, id);

  router.get('/api/projects/:p/repository', async ({ params }) => ({ json: await repositorySettings(find(params.p), ctx.secrets) }));

  router.put('/api/projects/:p/repository', async ({ params, body }) => ({ json: await putRepository(find(params.p), ctx.secrets, body) }));

  router.post('/api/projects/:p/repository/push', async ({ params }) => {
    const ref = find(params.p);
    if (!(await getRemote(ref.dir).catch(() => null))) throw new ApiError(400, 'no_remote', 'Connect a remote repository first.');
    const account = await tokenAccount(ref);
    const jobId = ctx.jobs.createJob('push', async (emit) => {
      emit({ type: 'step', step: 'push', status: 'running' });
      const at = () => new Date().toISOString();
      try {
        // Only reading HEAD needs the lock; the push itself runs outside it
        // so a slow remote never holds up snapshots or applies.
        const commit = await withProjectLock(ref, () => headOid(ref.dir));
        await pushImpl(ref.dir, { store: ctx.secrets, account });
        const last: LastPush = { at: at(), ok: true, commit, message: null };
        writeLastPush(ref, last);
        emit({ type: 'step', step: 'push', status: 'done' });
        return last;
      } catch (err) {
        const mapped = err instanceof ApiError ? err : pushError(err);
        writeLastPush(ref, { at: at(), ok: false, commit: null, message: mapped.message });
        emit({ type: 'step', step: 'push', status: 'failed', message: mapped.message });
        throw mapped;
      }
    }, { lockKey: `${ref.id}/_repository` });
    return { status: 202, json: { jobId } };
  });
}
