// Environments of a project: `environments/<env>.json` (url, readOnly — the
// engine's allowed keys), pipeline order in kinetic-migrate.json, write-only
// credentials and secrets in the SecretStore, the engine env resolved from
// both, per-environment values (`overrides/<env>.json`) and Test connection.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ConnectionTestResult, ConnectionTestStep, CredentialsStatus, EnvironmentOverrides, PutCredentialsRequest,
} from '../shared/api.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { envKey, loadOverrides, stableStringify, validateEnvName, type ClientFactory, type EngineEnv } from './engine.ts';
import {
  commitChange, displayName, isPlainObject, readJsonFile, readMeta, secretsId, withProjectLock, withSecretsLock, writeMeta,
  type ProjectRef,
} from './project-meta.ts';
import { accountFor, type SecretStore } from './secrets.ts';

export interface EnvironmentFile {
  url: string;
  readOnly: boolean;
}

// Store scopes. `secret` → KINETIC_<ENV>_SECRET_<name> (connection secrets),
// `handler` → KINETIC_<ENV>_HANDLER_<name> (encrypted handler properties).
export type SecretScope = 'credentials' | 'secret' | 'handler';
const VAR_SCOPES = { secret: 'SECRET', handler: 'HANDLER' } as const;
const INDEX = { scope: 'index', name: 'names' };

const envFile = (dir: string, env: string) => path.join(dir, 'environments', `${env}.json`);

export function checkEnvName(env: string): void {
  try {
    validateEnvName(env);
  } catch {
    throw badRequest('Environment names use letters, digits, - and _, and start with a letter or digit.');
  }
}

export function environmentExists(dir: string, env: string): boolean {
  // Exact-case match from the listing: case-insensitive file systems would
  // otherwise report "DEV" as existing when only dev.json does.
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(env) && environmentNames(dir).includes(env);
}

function requireEnv(ref: ProjectRef, env: string): void {
  if (!environmentExists(ref.dir, env)) throw notFound(`No environment named "${env}".`);
}

export function readEnvironmentFile(dir: string, env: string): EnvironmentFile {
  const raw = readJsonFile(envFile(dir, env));
  const def = isPlainObject(raw) ? raw : {};
  return { url: typeof def.url === 'string' ? def.url : '', readOnly: def.readOnly === true };
}

export function environmentNames(dir: string): string[] {
  const d = path.join(dir, 'environments');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n));
}

// Stored order first, then any other environments by name.
export function pipelineOrder(dir: string): string[] {
  const names = new Set(environmentNames(dir));
  const stored = (readMeta(dir).order ?? []).filter((n) => names.has(n));
  const rest = [...names].filter((n) => !stored.includes(n)).sort();
  return [...new Set([...stored, ...rest])];
}

function saveOrder(dir: string, order: string[]): void {
  writeMeta(dir, { ...readMeta(dir), order });
}

function parseUrl(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('"url" is required.');
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw badRequest('"url" is not a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('"url" must start with https:// or http://.');
  if (u.username || u.password) throw badRequest('"url" must not contain credentials.');
  if (u.search || u.hash) throw badRequest('"url" must be the space address only.');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

export function writeEnvironment(dir: string, env: string, def: EnvironmentFile): void {
  mkdirSync(path.join(dir, 'environments'), { recursive: true });
  writeFileSync(envFile(dir, env), stableStringify({ url: def.url, readOnly: def.readOnly }));
}

export function validateNewEnvironment(body: unknown): EnvironmentFile & { position?: number } {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) {
    if (!['url', 'readOnly', 'position', 'name'].includes(k)) throw badRequest('Unknown field.');
  }
  if ('readOnly' in body && typeof body.readOnly !== 'boolean') throw badRequest('"readOnly" must be true or false.');
  if ('position' in body && (!Number.isInteger(body.position) || (body.position as number) < 0)) {
    throw badRequest('"position" must be a whole number from 0.');
  }
  return { url: parseUrl(body.url), readOnly: body.readOnly === true, position: body.position as number | undefined };
}

export async function putEnvironment(ref: ProjectRef, env: string, body: unknown): Promise<void> {
  checkEnvName(env);
  if (isPlainObject(body) && 'name' in body) throw badRequest('Unknown field.');
  const input = validateNewEnvironment(body);
  await withProjectLock(ref, async () => {
    const existed = environmentExists(ref.dir, env);
    if (!existed && environmentNames(ref.dir).some((n) => n.toLowerCase() === env.toLowerCase())) {
      throw new ApiError(409, 'exists', 'An environment with that name in different letter case already exists.');
    }
    const readOnly = isPlainObject(body) && 'readOnly' in body ? input.readOnly : existed ? readEnvironmentFile(ref.dir, env).readOnly : false;
    writeEnvironment(ref.dir, env, { url: input.url, readOnly });
    const order = pipelineOrder(ref.dir).filter((n) => n !== env);
    const at = input.position ?? (existed ? pipelineOrder(ref.dir).indexOf(env) : order.length);
    order.splice(Math.min(Math.max(at, 0), order.length), 0, env);
    saveOrder(ref.dir, order);
    await commitChange(ref, `${existed ? 'Updated' : 'Added'} environment ${displayName(env)}`);
  });
}

export async function deleteEnvironment(ref: ProjectRef, env: string, store: SecretStore): Promise<void> {
  requireEnv(ref, env);
  await withProjectLock(ref, async () => {
    rmSync(envFile(ref.dir, env));
    saveOrder(ref.dir, pipelineOrder(ref.dir).filter((n) => n !== env));
    await commitChange(ref, `Removed environment ${displayName(env)}`);
  });
  await forgetEnvSecrets(store, ref, env);
}

// ---- Secrets in the store ------------------------------------------------
// Accounts are `<secretsId>/<env>/<scope>/<name>`, where secretsId is the
// project's random id (not its folder name). Keychains cannot be listed, so
// each environment keeps an index of its secret names (names only) in the
// store itself, updated under the project's secrets lock.

async function readIndex(store: SecretStore, sid: string, env: string): Promise<string[]> {
  const raw = await store.get(accountFor(sid, env, INDEX.scope, INDEX.name));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIndex(store: SecretStore, sid: string, env: string, names: string[]): Promise<void> {
  const account = accountFor(sid, env, INDEX.scope, INDEX.name);
  if (names.length) await store.set(account, JSON.stringify([...new Set(names)].sort()));
  else await store.delete(account);
}

export async function setEnvSecret(store: SecretStore, ref: ProjectRef, env: string, scope: SecretScope, name: string, value: string): Promise<void> {
  const sid = await secretsId(ref);
  await withSecretsLock(ref, async () => {
    await store.set(accountFor(sid, env, scope, name), value);
    const entry = `${scope}/${name}`;
    const index = await readIndex(store, sid, env);
    if (!index.includes(entry)) await writeIndex(store, sid, env, [...index, entry]);
  });
}

export async function deleteEnvSecret(store: SecretStore, ref: ProjectRef, env: string, scope: SecretScope, name: string): Promise<void> {
  const sid = await secretsId(ref);
  await withSecretsLock(ref, async () => {
    await store.delete(accountFor(sid, env, scope, name));
    const entry = `${scope}/${name}`;
    const index = await readIndex(store, sid, env);
    if (index.includes(entry)) await writeIndex(store, sid, env, index.filter((e) => e !== entry));
  });
}

export async function hasEnvSecret(store: SecretStore, ref: ProjectRef, env: string, scope: SecretScope, name: string): Promise<boolean> {
  return store.has(accountFor(await secretsId(ref), env, scope, name));
}

async function forgetEnvSecrets(store: SecretStore, ref: ProjectRef, env: string): Promise<void> {
  const sid = await secretsId(ref);
  await withSecretsLock(ref, async () => {
    for (const entry of await readIndex(store, sid, env)) {
      const [scope, name] = entry.split('/');
      if (scope && name) await store.delete(accountFor(sid, env, scope, name));
    }
    await writeIndex(store, sid, env, []);
  });
}

export async function credentialsStatus(store: SecretStore, ref: ProjectRef, env: string): Promise<CredentialsStatus> {
  return {
    username: await hasEnvSecret(store, ref, env, 'credentials', 'username'),
    password: await hasEnvSecret(store, ref, env, 'credentials', 'password'),
  };
}

// `null` clears a field; strings set it; omitted fields stay.
export async function setCredentials(ref: ProjectRef, env: string, body: unknown, store: SecretStore): Promise<CredentialsStatus> {
  requireEnv(ref, env);
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  const req = body as PutCredentialsRequest & Record<string, unknown>;
  const fields = ['username', 'password'] as const;
  for (const k of Object.keys(req)) if (!(fields as readonly string[]).includes(k)) throw badRequest('Unknown field.');
  if (!fields.some((f) => f in req)) throw badRequest('Send a username, a password or both.');
  for (const f of fields) {
    if (!(f in req)) continue;
    const v = req[f];
    if (v === null) await deleteEnvSecret(store, ref, env, 'credentials', f);
    else if (typeof v === 'string' && v !== '') await setEnvSecret(store, ref, env, 'credentials', f, v);
    else throw badRequest(`"${f}" must be a non-empty string, or null to clear it.`);
  }
  return credentialsStatus(store, ref, env);
}

// The engine's resolved environment: the file plus credentials and secrets
// from the store. `extraVars` carries session-only secrets for one run.
export async function resolveEnv(ref: ProjectRef, env: string, store: SecretStore, extraVars: Record<string, string> = {}): Promise<EngineEnv> {
  requireEnv(ref, env);
  const def = readEnvironmentFile(ref.dir, env);
  const sid = await secretsId(ref);
  const username = await store.get(accountFor(sid, env, 'credentials', 'username'));
  const password = await store.get(accountFor(sid, env, 'credentials', 'password'));
  if (!username || !password) {
    throw new ApiError(400, 'missing_credentials', `No credentials for ${displayName(env)}: set the username and password in Settings → Environments.`);
  }
  const vars: Record<string, string> = {};
  const k = envKey(env);
  for (const entry of await readIndex(store, sid, env)) {
    const [scope, name] = entry.split('/');
    if (scope !== 'secret' && scope !== 'handler') continue;
    const value = await store.get(accountFor(sid, env, scope, name));
    if (value) vars[`KINETIC_${k}_${VAR_SCOPES[scope]}_${name}`] = value;
  }
  return { name: env, url: def.url, readOnly: def.readOnly, username, password, vars: { ...vars, ...extraVars } };
}

// ---- Test connection -----------------------------------------------------

function stepMessage(err: unknown): string {
  const e = err as { name?: string; status?: number } | null;
  if (e?.name === 'HttpError') {
    if (e.status === 401 || e.status === 403) return `The username or password was not accepted (${e.status}).`;
    return `The server returned an error (${e.status ?? 'unknown'}).`;
  }
  if (e?.name === 'TypeError' || /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(String((err as Error)?.message))) {
    return 'Could not reach the server; check the URL.';
  }
  return 'The check failed.';
}

// Core `/me` with basic auth, then the Integrator token (and one Integrator
// call) through the engine's read-only client.
export async function testConnection(ref: ProjectRef, env: string, store: SecretStore, clientFactory: ClientFactory): Promise<ConnectionTestResult> {
  const resolved = await resolveEnv(ref, env, store);
  const client = clientFactory({ env: resolved, mode: 'read' });
  const steps: ConnectionTestStep[] = [];
  try {
    await client.get('core', '/me');
    steps.push({ step: 'core', label: 'Core login', ok: true });
  } catch (err) {
    steps.push({ step: 'core', label: 'Core login', ok: false, message: stepMessage(err) });
    steps.push({ step: 'integrator', label: 'Integrator token', ok: false, skipped: true, message: 'Skipped until Core login works.' });
    return { ok: false, steps };
  }
  try {
    await client.get('integrator', '/connections');
    steps.push({ step: 'integrator', label: 'Integrator token', ok: true });
  } catch (err) {
    steps.push({ step: 'integrator', label: 'Integrator token', ok: false, message: stepMessage(err) });
  }
  return { ok: steps.every((s) => s.ok), steps };
}

// ---- Environment values (overrides) --------------------------------------

export function readOverrides(ref: ProjectRef, env: string): EnvironmentOverrides {
  requireEnv(ref, env);
  try {
    return loadOverrides(ref.dir, env) as EnvironmentOverrides;
  } catch {
    throw new ApiError(422, 'invalid_project_file', `overrides/${env}.json is not valid JSON.`);
  }
}

function validateOverrides(body: unknown): EnvironmentOverrides {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) if (!['artifacts', 'replace'].includes(k)) throw badRequest('Unknown field.');
  const artifacts = body.artifacts ?? {};
  if (!isPlainObject(artifacts) || !Object.values(artifacts).every(isPlainObject)) {
    throw badRequest('"artifacts" must map item keys to objects of values.');
  }
  const replace = body.replace ?? [];
  if (!Array.isArray(replace)) throw badRequest('"replace" must be a list.');
  for (const r of replace) {
    if (!isPlainObject(r) || Object.keys(r).some((k) => k !== 'from' && k !== 'to') || typeof r.from !== 'string' || r.from === '' || typeof r.to !== 'string') {
      throw badRequest('Each replace rule needs a non-empty "from" and a string "to".');
    }
  }
  return { artifacts: artifacts as EnvironmentOverrides['artifacts'], replace: replace as EnvironmentOverrides['replace'] };
}

export async function putOverrides(ref: ProjectRef, env: string, body: unknown): Promise<EnvironmentOverrides> {
  requireEnv(ref, env);
  const value = validateOverrides(body);
  await withProjectLock(ref, async () => {
    mkdirSync(path.join(ref.dir, 'overrides'), { recursive: true });
    writeFileSync(path.join(ref.dir, 'overrides', `${env}.json`), stableStringify(value));
    await commitChange(ref, `Updated environment values for ${displayName(env)}`);
  });
  return readOverrides(ref, env);
}
