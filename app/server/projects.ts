// Projects: folders in the workspace (or opened from elsewhere) that hold a
// kinetic-sync project and are managed as git repositories. Also the API
// routes for projects, environments, credentials, config and overrides.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, ProjectDetail, ProjectSummary } from '../shared/api.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { canonicalSpaceFields, createClient, dataConfigError, envBoundAttributesError, envBoundSpaceFieldsError, loadConfig, runInit, stableStringify, type ClientFactory } from './engine.ts';
import { isReservedDeviceName } from './engine-sync.ts';
import {
  checkEnvName, credentialsStatus, deleteEnvironment, environmentExists, pipelineOrder, putEnvironment, putOverrides,
  readEnvironmentFile, readOverrides, setCredentials, testConnection, validateNewEnvironment, writeEnvironment,
} from './environments.ts';
import {
  commitChange, ensureGitignore, isPlainObject, manageProject, newSecretsId, readJsonFile, readMeta, upgradeLayoutLocked, withProjectLock, writeMeta,
  type ProjectRef,
} from './project-meta.ts';
import { currentBranch, ensureRepo, log } from './repo.ts';
import type { Router } from './router.ts';
import type { SecretStore } from './secrets.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Projects opened from outside the workspace: { opened: { <id>: <abs path> } }.
const WORKSPACE_FILE = '.kinetic-migrate-workspace.json';
const CONFIG_FILE = 'kinetic-sync.config.json';

export function slugify(name: string): string {
  // Accents are dropped, not turned into dashes: "José Núñez" → "jose-nunez".
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  // A folder named con, aux, nul, com1… cannot exist on Windows.
  return slug && isReservedDeviceName(slug) ? `${slug}-project` : slug;
}

// Two paths name the same folder: Windows compares without case.
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const [x, y] = [p.resolve(a), p.resolve(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A project has kinetic-sync.config.json (which init always writes), or at
// least one environment file. A bare environments/ folder (common in
// infrastructure repositories) is not enough.
export function isProjectDir(dir: string): boolean {
  if (existsSync(path.join(dir, CONFIG_FILE))) return true;
  const envDir = path.join(dir, 'environments');
  if (!isDir(envDir)) return false;
  try {
    return readdirSync(envDir).some((f) => f.endsWith('.json') && !isDir(path.join(envDir, f)));
  } catch {
    return false;
  }
}

function readOpened(workspace: string): Record<string, string> {
  const file = path.join(workspace, WORKSPACE_FILE);
  if (!existsSync(file)) return {};
  const raw = readJsonFile(file);
  const opened = isPlainObject(raw) && isPlainObject(raw.opened) ? raw.opened : {};
  return Object.fromEntries(Object.entries(opened).filter((e): e is [string, string] => typeof e[1] === 'string' && ID.test(e[0])));
}

function writeOpened(workspace: string, opened: Record<string, string>): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, WORKSPACE_FILE), stableStringify({ opened }));
}

function summary(ref: ProjectRef): ProjectSummary {
  return { id: ref.id, name: readMeta(ref.dir).name ?? path.basename(ref.dir), path: ref.dir };
}

export function listProjects(workspace: string): ProjectSummary[] {
  const refs: ProjectRef[] = [];
  if (isDir(workspace)) {
    for (const name of readdirSync(workspace)) {
      const dir = path.join(workspace, name);
      if (ID.test(name) && isDir(dir) && isProjectDir(dir)) refs.push({ id: name, dir });
    }
  }
  const taken = new Set(refs.map((r) => r.id));
  for (const [id, dir] of Object.entries(readOpened(workspace))) {
    if (!taken.has(id) && isDir(dir) && isProjectDir(dir)) refs.push({ id, dir });
  }
  return refs.map(summary).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function findProject(workspace: string, id: string): ProjectRef {
  if (ID.test(id)) {
    const dir = path.join(workspace, id);
    if (isDir(dir) && isProjectDir(dir)) return { id, dir };
    const opened = readOpened(workspace)[id];
    if (opened && isDir(opened) && isProjectDir(opened)) return { id, dir: opened };
  }
  throw notFound('No such project.');
}

export async function createProject(workspace: string, body: unknown): Promise<ProjectRef> {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) if (!['name', 'environment'].includes(k)) throw badRequest('Unknown field.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw badRequest('A project needs a name of up to 100 characters.');
  const id = slugify(name);
  if (!id || !ID.test(id)) throw badRequest('The project name needs at least one letter or digit.');
  let first: { name: string; url: string; readOnly: boolean } | undefined;
  if (body.environment !== undefined) {
    if (!isPlainObject(body.environment) || typeof body.environment.name !== 'string') throw badRequest('"environment" needs a name and a url.');
    checkEnvName(body.environment.name);
    first = { name: body.environment.name, ...validateNewEnvironment(body.environment) };
  }
  const dir = path.join(workspace, id);
  if (existsSync(dir) || readOpened(workspace)[id]) throw new ApiError(409, 'exists', `A project folder named "${id}" already exists.`);
  mkdirSync(dir, { recursive: true });
  const ref = { id, dir };
  try {
    await withProjectLock(ref, async () => {
      await runInit({ projectDir: dir, log: () => {} });
      // runInit writes a placeholder environments/dev.json; the UI adds real ones.
      rmSync(path.join(dir, 'environments', 'dev.json'), { force: true });
      if (first) writeEnvironment(dir, first.name, { url: first.url, readOnly: first.readOnly });
      writeMeta(dir, { name, order: first ? [first.name] : [], secretsId: newSecretsId() });
      ensureGitignore(dir);
      await ensureRepo(dir);
      await commitChange(ref, `Created project ${name}`);
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return ref;
}

export async function openProject(workspace: string, body: unknown): Promise<ProjectRef> {
  if (!isPlainObject(body) || typeof body.path !== 'string' || !path.isAbsolute(body.path)) {
    throw badRequest('Give the full path of a project folder.');
  }
  if (!isDir(body.path)) throw badRequest('That folder does not exist.');
  // The native call gives Windows' own spelling (letter case, 8.3 names expanded).
  const dir = realpathSync.native(body.path);
  if (!isProjectDir(dir)) throw badRequest('That folder is not a Kinetic project (no kinetic-sync.config.json or environment files in environments/).');
  // Commits only ever go to main: never into a repository checked out elsewhere.
  const branch = await currentBranch(dir);
  if (branch !== undefined && branch !== 'main') {
    throw badRequest(`This folder is a git repository on ${branch === null ? 'a detached commit' : `branch ${branch}`}; kinetic-migrate manages projects on main.`);
  }
  const ws = isDir(workspace) ? realpathSync.native(workspace) : path.resolve(workspace);
  let id: string;
  if (samePath(path.dirname(dir), ws) && ID.test(path.basename(dir))) {
    id = path.basename(dir);
  } else {
    const opened = readOpened(workspace);
    const known = Object.entries(opened).find(([, p]) => samePath(p, dir));
    if (known) id = known[0];
    else {
      const base = slugify(path.basename(dir)) || 'project';
      id = base;
      for (let n = 2; opened[id] || existsSync(path.join(workspace, id)); n++) id = `${base}-${n}`;
      writeOpened(workspace, { ...opened, [id]: dir });
    }
  }
  const ref = { id, dir };
  // CLI-created projects become managed: ignore local-only files, then commit.
  await withProjectLock(ref, () => manageProject(ref, 'Started managing this project'));
  return ref;
}

// Upgrades every managed project in the workspace to the current file-name
// layout (see upgradeLayoutLocked); failures are logged and never stop the
// server. Unmanaged projects are upgraded when they become managed.
export async function upgradeWorkspace(workspace: string, onError: (id: string, err: unknown) => void = () => {}): Promise<void> {
  for (const p of listProjects(workspace)) {
    try {
      const ref = findProject(workspace, p.id);
      if (!existsSync(path.join(ref.dir, '.git'))) continue;
      await withProjectLock(ref, () => upgradeLayoutLocked(ref));
    } catch (err) {
      onError(p.id, err);
    }
  }
}

export async function readProject(ref: ProjectRef, store: SecretStore): Promise<ProjectDetail> {
  const environments = [];
  for (const name of pipelineOrder(ref.dir)) {
    const def = readEnvironmentFile(ref.dir, name);
    const last = (await log(ref.dir, { path: `snapshots/${name}`, limit: 1 }))[0];
    environments.push({
      name,
      url: def.url,
      readOnly: def.readOnly,
      credentials: await credentialsStatus(store, ref, name),
      lastSnapshot: last ? { commit: last.oid, at: last.at, message: last.message } : null,
    });
  }
  return { ...summary(ref), environments };
}

// ---- Project config (kinetic-sync.config.json) ---------------------------

export function readConfig(ref: ProjectRef): ProjectConfig {
  try {
    return loadConfig(ref.dir) as ProjectConfig;
  } catch {
    throw new ApiError(422, 'invalid_project_file', `${CONFIG_FILE} is not valid.`);
  }
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');

function validateConfig(body: unknown): Partial<ProjectConfig> {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) if (!['data', 'exclude', 'envBoundAttributes', 'envBoundSpaceFields'].includes(k)) throw badRequest('Unknown field.');
  const out: Partial<ProjectConfig> = {};
  if ('data' in body) {
    const problem = dataConfigError(body.data);
    if (problem) throw badRequest(problem);
    out.data = body.data as ProjectConfig['data'];
  }
  if ('exclude' in body) {
    const e = body.exclude;
    if (!isPlainObject(e) || Object.keys(e).some((k) => k !== 'kapps' && k !== 'forms') || ('kapps' in e && !isStringList(e.kapps)) || ('forms' in e && !isStringList(e.forms))) {
      throw badRequest('"exclude" takes lists of kapp slugs and kapp/form slugs.');
    }
    out.exclude = { kapps: (e.kapps as string[]) ?? [], forms: (e.forms as string[]) ?? [] };
  }
  if ('envBoundAttributes' in body) {
    const problem = envBoundAttributesError(body.envBoundAttributes);
    if (problem) throw badRequest(problem);
    out.envBoundAttributes = body.envBoundAttributes as ProjectConfig['envBoundAttributes'];
  }
  if ('envBoundSpaceFields' in body) {
    const problem = envBoundSpaceFieldsError(body.envBoundSpaceFields);
    if (problem) throw badRequest(problem);
    out.envBoundSpaceFields = canonicalSpaceFields(body.envBoundSpaceFields as string[]);
  }
  return out;
}

export async function putConfig(ref: ProjectRef, body: unknown): Promise<ProjectConfig> {
  const change = validateConfig(body);
  await withProjectLock(ref, async () => {
    const file = path.join(ref.dir, CONFIG_FILE);
    const current = existsSync(file) ? readJsonFile(file) : {};
    writeFileSync(file, stableStringify({ ...(isPlainObject(current) ? current : {}), ...change }));
    await commitChange(ref, 'Updated project settings');
  });
  return readConfig(ref);
}

// ---- Routes --------------------------------------------------------------

export interface ProjectRoutesContext {
  workspace: string;
  secrets: SecretStore;
  clientFactory?: ClientFactory;
}

export function registerProjectRoutes(router: Router, ctx: ProjectRoutesContext): void {
  const find = (id: string) => findProject(ctx.workspace, id);
  const detail = (ref: ProjectRef) => readProject(ref, ctx.secrets);

  router.get('/api/projects', () => ({ json: listProjects(ctx.workspace) }));
  router.post('/api/projects', async ({ body }) => ({ status: 201, json: await detail(await createProject(ctx.workspace, body)) }));
  router.post('/api/projects/open', async ({ body }) => ({ json: await detail(await openProject(ctx.workspace, body)) }));
  router.get('/api/projects/:p', async ({ params }) => ({ json: await detail(find(params.p)) }));

  router.put('/api/projects/:p/environments/:env', async ({ params, body }) => {
    const ref = find(params.p);
    await putEnvironment(ref, params.env, body);
    return { json: await detail(ref) };
  });
  router.delete('/api/projects/:p/environments/:env', async ({ params }) => {
    const ref = find(params.p);
    await deleteEnvironment(ref, params.env, ctx.secrets);
    return { json: await detail(ref) };
  });
  router.put('/api/projects/:p/environments/:env/credentials', async ({ params, body }) => (
    { json: await setCredentials(find(params.p), params.env, body, ctx.secrets) }
  ));
  router.post('/api/projects/:p/environments/:env/test', async ({ params }) => {
    const ref = find(params.p);
    if (!environmentExists(ref.dir, params.env)) throw notFound(`No environment named "${params.env}".`);
    return { json: await testConnection(ref, params.env, ctx.secrets, ctx.clientFactory ?? createClient) };
  });

  router.get('/api/projects/:p/config', ({ params }) => ({ json: readConfig(find(params.p)) }));
  router.put('/api/projects/:p/config', async ({ params, body }) => ({ json: await putConfig(find(params.p), body) }));
  router.get('/api/projects/:p/overrides/:env', ({ params }) => ({ json: readOverrides(find(params.p), params.env) }));
  router.put('/api/projects/:p/overrides/:env', async ({ params, body }) => ({ json: await putOverrides(find(params.p), params.env, body) }));
}
