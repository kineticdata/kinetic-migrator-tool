// Saved changesets: changesets/<id>.json — a named selection of item keys
// from one environment, pinned to the snapshot commit it was taken from,
// plus (optionally) `remove`: keys of items only in a target to remove when
// it is applied. A changeset without `remove` (saved before removals
// existed) removes nothing. Every change is committed.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppliedTo, Changeset } from '../shared/sync-api.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { stableStringify } from './engine.ts';
import { LAYOUT_VERSION, MODULES, isEntryKey, moduleFor, removalRefusal } from './engine-sync.ts';
import { resolveCommit } from './pinned.ts';
import { commitChange, isPlainObject, withProjectLock, type ProjectRef } from './project-meta.ts';
import { slugify } from './projects.ts';
import { projectRepo } from './project-repo.ts';
import { readTreeAt } from './repo.ts';
import type { Router } from './router.ts';
import { latestSnapshotCommit, loadSnapshot, requireEnvironment, type SyncContext } from './snapshots.ts';
import { commitMessage } from './trailers.ts';

const DIR = 'changesets';
const ID = /^[a-z0-9][a-z0-9-]*$/;
const file = (ref: ProjectRef, id: string) => path.join(ref.dir, DIR, `${id}.json`);

export function readChangeset(ref: ProjectRef, id: string): Changeset {
  if (!ID.test(id) || !existsSync(file(ref, id))) throw notFound('No such changeset.');
  try {
    return JSON.parse(readFileSync(file(ref, id), 'utf8')) as Changeset;
  } catch {
    throw new ApiError(422, 'invalid_project_file', `changesets/${id}.json is not valid JSON.`);
  }
}

export function listChangesets(ref: ProjectRef): Changeset[] {
  const dir = path.join(ref.dir, DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)))
    .map((f) => readChangeset(ref, f.slice(0, -5)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function writeChangeset(ref: ProjectRef, cs: Changeset): void {
  mkdirSync(path.join(ref.dir, DIR), { recursive: true });
  writeFileSync(file(ref, cs.id), stableStringify(cs));
}

// Adds an apply to the changeset's record (the caller commits).
export function recordApplied(ref: ProjectRef, id: string, entry: AppliedTo): void {
  const cs = readChangeset(ref, id);
  writeChangeset(ref, { ...cs, appliedTo: [...cs.appliedTo, entry] });
}

const text = (v: unknown, field: string, max: number, required: boolean): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) throw badRequest(`"${field}" must be text of up to ${max} characters.`);
  return v.trim();
};

function keyList(v: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(v) || (!v.length && !allowEmpty) || !v.every((k) => typeof k === 'string' && moduleFor(k)?.applyable !== false && moduleFor(k))) {
    throw badRequest(allowEmpty ? '"keys" must be a list of item keys.' : '"keys" must be a non-empty list of item keys.');
  }
  return [...new Set(v as string[])].sort();
}

// Keys of items to remove: each one removable, none in the source snapshot
// (only items that are only in a target are removed).
export function removeList(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) throw badRequest('"remove" must be a list of item keys.');
  const keys = [...new Set(v as string[])].sort();
  const refused = keys.map((k) => removalRefusal(k, MODULES)).filter((m): m is string => Boolean(m));
  if (refused.length) throw badRequest(refused.length === 1 ? refused[0] : 'Some items can never be removed.', { refused });
  return keys;
}

function needSomething(keys: string[], remove: string[]): void {
  if (!keys.length && !remove.length) throw badRequest('A changeset needs at least one item to promote or remove.');
}

// A changeset's keys in today's encoding. One saved against a pre-encoding
// snapshot holds that snapshot's old file names: they are mapped through the
// pinned tree's own re-keying (from content), whichever way the project was
// upgraded (app or CLI). Keys of later changesets are used as they are.
const rekeyCache = new Map<string, Map<string, string>>();
export async function currentKeys(ref: ProjectRef, cs: Changeset): Promise<string[]> {
  if (cs.layoutVersion === LAYOUT_VERSION) return cs.keys;
  const id = `${ref.dir}\0${cs.sourceCommit}\0${cs.from}`;
  let map = rekeyCache.get(id);
  if (!map) {
    const tree = await readTreeAt(await projectRepo(ref), cs.sourceCommit, `snapshots/${cs.from}`);
    map = (tree.layout ?? LAYOUT_VERSION) < LAYOUT_VERSION ? tree.rekeyed ?? new Map() : new Map();
    rekeyCache.set(id, map);
    while (rekeyCache.size > 64) rekeyCache.delete(rekeyCache.keys().next().value!);
  }
  return cs.keys.map((k) => map!.get(k) ?? k);
}

// A changeset as the API shows it: keys in today's encoding.
async function shown(ref: ProjectRef, cs: Changeset): Promise<Changeset> {
  return { ...cs, keys: await currentKeys(ref, cs) };
}

async function keysAt(ref: ProjectRef, env: string, commit: string): Promise<Set<string>> {
  if (commit === (await latestSnapshotCommit(ref, env))) return new Set((await loadSnapshot(ref, env)).artifacts.keys());
  return new Set((await readTreeAt(await projectRepo(ref), commit, `snapshots/${env}`)).keys());
}

async function checkKeys(ref: ProjectRef, env: string, commit: string, keys: string[], remove: string[] = []): Promise<void> {
  const have = await keysAt(ref, env, commit);
  const missing = keys.filter((k) => !have.has(k));
  if (missing.length) throw badRequest('Some items are not in the pinned snapshot.', { missing });
  // (Whether an entry is in the source's copy of its item is checked by the plan.)
  const inSource = remove.filter((k) => !isEntryKey(k) && have.has(k));
  if (inSource.length) throw badRequest('Only items that are not in the source can be removed.', { inSource });
}

const ALLOWED_CREATE = ['name', 'description', 'from', 'keys', 'remove', 'removeFrom', 'sourceCommit'];
const ALLOWED_UPDATE = ['name', 'description', 'keys', 'remove', 'removeFrom'];

// The environment removals are bound to: one of the project's, not the source.
function removeTarget(ref: ProjectRef, v: unknown, from: string): string {
  const env = requireEnvironment(ref, v);
  if (env === from) throw badRequest('"removeFrom" must be a target, not the changeset\'s source environment.');
  return env;
}

export async function createChangeset(ref: ProjectRef, body: unknown): Promise<Changeset> {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) if (!ALLOWED_CREATE.includes(k)) throw badRequest(`Unknown field "${k}".`);
  const name = text(body.name, 'name', 100, true)!;
  const description = text(body.description, 'description', 2000, false) ?? '';
  const from = requireEnvironment(ref, body.from);
  const remove = removeList(body.remove);
  const keys = keyList(body.keys, remove.length > 0);
  needSomething(keys, remove);
  if (remove.length && body.removeFrom === undefined) throw badRequest('"removeFrom" names the environment the removals were chosen for.');
  const removeFrom = remove.length ? removeTarget(ref, body.removeFrom, from) : undefined;
  let sourceCommit: string | null;
  if (body.sourceCommit !== undefined) {
    sourceCommit = typeof body.sourceCommit === 'string' ? await resolveCommit(await projectRepo(ref), body.sourceCommit) : null;
    if (!sourceCommit) throw badRequest('"sourceCommit" is not a commit of this project.');
  } else {
    sourceCommit = await latestSnapshotCommit(ref, from);
    if (!sourceCommit) throw new ApiError(404, 'no_snapshot', 'Take a snapshot of the source environment first.');
  }
  await checkKeys(ref, from, sourceCommit, keys, remove);
  const id = `${slugify(name) || 'changeset'}-${randomBytes(3).toString('hex')}`;
  const cs: Changeset = {
    id, name, description, from, sourceCommit, keys, ...(remove.length ? { remove, removeFrom } : {}), createdAt: new Date().toISOString(), appliedTo: [], layoutVersion: LAYOUT_VERSION,
  };
  await withProjectLock(ref, async () => {
    writeChangeset(ref, cs);
    await commitChange(ref, commitMessage(`Saved changeset '${name}'`, { Changeset: id, Environment: from }));
  });
  return cs;
}

export async function updateChangeset(ref: ProjectRef, id: string, body: unknown): Promise<Changeset> {
  const current = readChangeset(ref, id);
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) if (!ALLOWED_UPDATE.includes(k)) throw badRequest(`Unknown field "${k}".`);
  const next: Changeset = { ...current };
  if (body.name !== undefined) next.name = text(body.name, 'name', 100, true)!;
  if (body.description !== undefined) next.description = text(body.description, 'description', 2000, false) ?? '';
  if (body.removeFrom !== undefined) next.removeFrom = removeTarget(ref, body.removeFrom, current.from);
  if (body.remove !== undefined) {
    const remove = removeList(body.remove);
    if (remove.length) {
      next.remove = remove;
      if (!next.removeFrom) throw badRequest('"removeFrom" names the environment the removals were chosen for.');
    } else {
      delete next.remove;
      delete next.removeFrom;
    }
  }
  if (body.keys !== undefined) {
    next.keys = keyList(body.keys, true);
    next.layoutVersion = LAYOUT_VERSION;
  }
  if (body.keys !== undefined || body.remove !== undefined) {
    needSomething(next.keys, next.remove ?? []);
    await checkKeys(ref, current.from, current.sourceCommit, body.keys !== undefined ? next.keys : [], next.remove ?? []);
  }
  await withProjectLock(ref, async () => {
    writeChangeset(ref, next);
    await commitChange(ref, commitMessage(`Updated changeset '${next.name}'`, { Changeset: id, Environment: next.from }));
  });
  return shown(ref, next);
}

export async function deleteChangeset(ref: ProjectRef, id: string): Promise<void> {
  const cs = readChangeset(ref, id);
  await withProjectLock(ref, async () => {
    rmSync(file(ref, id));
    await commitChange(ref, commitMessage(`Deleted changeset '${cs.name}'`, { Changeset: id, Environment: cs.from }));
  });
}

export function registerChangesetRoutes(router: Router, ctx: SyncContext): void {
  router.get('/api/projects/:p/changesets', async ({ params }) => {
    const ref = ctx.find(params.p);
    return { json: await Promise.all(listChangesets(ref).map((cs) => shown(ref, cs))) };
  });
  router.post('/api/projects/:p/changesets', async ({ params, body }) => ({ status: 201, json: await createChangeset(ctx.find(params.p), body) }));
  router.get('/api/projects/:p/changesets/:id', async ({ params }) => {
    const ref = ctx.find(params.p);
    return { json: await shown(ref, readChangeset(ref, params.id)) };
  });
  router.put('/api/projects/:p/changesets/:id', async ({ params, body }) => ({ json: await updateChangeset(ctx.find(params.p), params.id, body) }));
  router.delete('/api/projects/:p/changesets/:id', async ({ params }) => {
    await deleteChangeset(ctx.find(params.p), params.id);
    return { json: { deleted: params.id } };
  });
}
