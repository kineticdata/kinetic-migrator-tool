// Snapshots: a full export of one environment into snapshots/<env>/, committed
// as "Snapshot of <Env>" (with the items that drifted since their last
// promotion), and the in-memory snapshot cache that Explore and Compare read:
// artifacts, tree index and relationships, keyed by the snapshot commit.
import { randomUUID } from 'node:crypto';
import fs, { statSync } from 'node:fs';
import git from 'isomorphic-git';
import path from 'node:path';
import type { SnapshotResult } from '../shared/sync-api.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { loadConfig, snapshotDir, type ClientFactory, type EngineEnv } from './engine.ts';
import {
  buildRelationships, hashOf, loadState, moduleFor, readTree, runExport, withoutEnvBound, type OnEvent, type Relationships,
} from './engine-sync.ts';
import { environmentExists, resolveEnv } from './environments.ts';
import type { Emit } from './jobs.ts';
import {
  DEFAULT_AUTHOR, commitChange, displayName, isPlainObject, readMeta, secretsId, withProjectLock, type ProjectRef,
} from './project-meta.ts';
import { log } from './repo.ts';
import { makeScrubber, scrubError } from './scrub.ts';
import { buildTreeIndex, type TreeIndex } from './tree-index.ts';
import { commitMessage } from './trailers.ts';

export function requireEnvironment(ref: ProjectRef, env: unknown): string {
  if (typeof env !== 'string' || !environmentExists(ref.dir, env)) throw notFound(`No environment named "${String(env)}".`);
  return env;
}

export async function latestSnapshotCommit(ref: ProjectRef, env: string): Promise<string | null> {
  return (await log(ref.dir, { path: `snapshots/${env}`, limit: 1 }))[0]?.oid ?? null;
}

// Items whose current content differs from the hash recorded at their last
// promotion into `env`.
export function driftedKeys(projectDir: string, env: string, artifacts: Map<string, unknown>): string[] {
  const state = loadState(projectDir, env);
  const eba = loadConfig(projectDir).envBoundAttributes ?? {};
  return Object.keys(state).filter((key) => {
    if (!artifacts.has(key)) return false;
    const mod = moduleFor(key);
    return Boolean(mod) && hashOf(withoutEnvBound(mod!.scope, artifacts.get(key), eba)) !== state[key];
  }).sort();
}

// Exports `env` into a temporary folder, swaps it into snapshots/<env>/ only
// when the export succeeded, and commits. Call inside withProjectLock.
export async function takeSnapshot(opts: {
  ref: ProjectRef; env: EngineEnv; title: string; trailers?: Record<string, string>;
  onEvent?: OnEvent; signal?: AbortSignal; clientFactory?: ClientFactory;
  // Record the commit even when the export matches the previous snapshot
  // (backups, so History shows one per apply).
  always?: boolean;
}): Promise<SnapshotResult> {
  const { ref, env } = opts;
  const temp = path.join(ref.dir, 'plans', `snap-${randomUUID()}`);
  let r: Awaited<ReturnType<typeof runExport>>;
  try {
    r = await runExport({ projectDir: ref.dir, env, dest: temp, onEvent: opts.onEvent, signal: opts.signal, clientFactory: opts.clientFactory, log: () => {} });
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw scrubError(err, envSecrets(env));
  }
  const final = snapshotDir(ref.dir, env.name);
  fs.rmSync(final, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(final), { recursive: true });
  fs.renameSync(temp, final);
  const drifted = driftedKeys(ref.dir, env.name, readTree(snapshotDir(ref.dir, env.name)));
  const body = drifted.length ? `Drifted: ${drifted.length} item(s) changed since the last promotion.\n${drifted.join('\n')}` : undefined;
  const message = commitMessage(opts.title, { Environment: env.name, ...opts.trailers }, body);
  let commit = await commitChange(ref, message);
  if (!commit && opts.always) {
    const author = readMeta(ref.dir).author ?? DEFAULT_AUTHOR;
    commit = await git.commit({ fs, dir: ref.dir, message, author: { ...author, timestamp: Math.floor(Date.now() / 1000) } });
  }
  return { env: env.name, commit, total: r.artifacts, counts: r.counts, drifted };
}

// ---- Snapshot cache --------------------------------------------------------

export interface Snapshot {
  env: string;
  commit: string;
  dir: string;
  artifacts: Map<string, unknown>;
  index: TreeIndex;
  relationships: () => Relationships;
}

const CACHE_SIZE = 8;
const cache = new Map<string, Snapshot>();

export function snapshotFrom(env: string, commit: string, dir: string, artifacts: Map<string, unknown>): Snapshot {
  let rel: Relationships | undefined;
  return {
    env, commit, dir, artifacts,
    index: buildTreeIndex(artifacts.keys(), (k) => artifacts.get(k)),
    relationships: () => (rel ??= buildRelationships([...artifacts].map(([key, data]) => ({ key, data })))),
  };
}

// The newest committed snapshot of `env` (404 when there is none).
export async function loadSnapshot(ref: ProjectRef, env: string): Promise<Snapshot> {
  const commit = await latestSnapshotCommit(ref, env);
  if (!commit) throw new ApiError(404, 'no_snapshot', `There is no snapshot of ${displayName(env)} yet: take one first.`);
  const id = `${ref.dir}\0${env}\0${commit}`;
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const dir = snapshotDir(ref.dir, env);
  const snap = snapshotFrom(env, commit, dir, readTree(dir));
  cache.set(id, snap);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return snap;
}

export function fileSize(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

export const packagePath = (snap: Snapshot, key: string) => path.join(snap.dir, ...key.split('/').slice(0, -1), 'package.zip');

// Job events go out scrubbed of every secret the run knows.
export function forwardEvents(emit: Emit, secrets: Iterable<string>, map?: (e: Record<string, unknown>) => Record<string, unknown>): OnEvent {
  const scrub = makeScrubber(secrets);
  return (event) => {
    const e = map ? map(event) : event;
    emit(scrub({ ...e, type: String(e.type ?? 'log') }));
  };
}

export const envSecrets = (env: EngineEnv) => [env.password, ...Object.values(env.vars)];

// ---- Routes ----------------------------------------------------------------

export interface SyncContext {
  workspace: string;
  secrets: import('./secrets.ts').SecretStore;
  clientFactory?: ClientFactory;
  jobs: import('./jobs.ts').JobRegistry;
  find: (id: string) => ProjectRef;
  logger?: import('./log.ts').Logger;
}

export function registerSnapshotRoutes(router: import('./router.ts').Router, ctx: SyncContext): void {
  router.post('/api/projects/:p/snapshots', async ({ params, body }) => {
    const ref = ctx.find(params.p);
    if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
    const name = requireEnvironment(ref, body.env);
    await secretsId(ref);
    const env = await resolveEnv(ref, name, ctx.secrets);
    const jobId = ctx.jobs.createJob('snapshot', (emit, signal) => withProjectLock(ref, () => takeSnapshot({
      ref, env, title: `Snapshot of ${displayName(name)}`, onEvent: forwardEvents(emit, envSecrets(env)), signal, clientFactory: ctx.clientFactory,
    })), { lockKey: `${ref.id}/${name}` });
    return { status: 202, json: { jobId } };
  });
}
