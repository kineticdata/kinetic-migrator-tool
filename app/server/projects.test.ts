// Projects, environments, credentials, config and overrides through the API,
// against a temporary workspace, MemoryStore and a fake fetch behind the real
// engine client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConnectionTestResult, CredentialsStatus, ProjectDetail, ProjectSummary } from '../shared/api.ts';
import { createClient, type ClientFactory } from './engine.ts';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { ensureRepo, log, readTreeAt } from './repo.ts';
import { MemoryStore } from './secrets.ts';
import { readMeta } from './project-meta.ts';
import { resolveEnv, setEnvSecret } from './environments.ts';
import { startTestServer, type RawResponse, type TestServer } from './test-helpers.ts';

const PLANTED = 'Planted-Pa55word-zq81';

type FetchLike = (url: string | URL, init?: { method?: string; headers?: Record<string, string> }) => Promise<Response>;

// Core /me accepts the planted password; the OAuth authorize step fails
// unless `integratorOk`.
function fakeFetch(opts: { integratorOk?: boolean; coreStatus?: number } = {}): FetchLike {
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/app/api/v1/me') {
      return new Response(JSON.stringify({ username: 'admin' }), { status: opts.coreStatus ?? 200 });
    }
    if (u.pathname === '/app/oauth/authorize') {
      if (!opts.integratorOk) return new Response(`denied ${PLANTED}`, { status: 401 });
      return new Response(null, { status: 302, headers: { location: 'https://your-space.kinops.io/#access_token=tok&expires_in=3600' } });
    }
    if (u.pathname === '/app/integrator/api/connections') return new Response('[]', { status: 200 });
    return new Response('{}', { status: 404 });
  };
}

function factory(fetchImpl: FetchLike): ClientFactory {
  return ({ env, mode }) => createClient({ env, mode, fetchImpl } as Parameters<ClientFactory>[0]);
}

interface Ctx {
  server: TestServer;
  store: MemoryStore;
  bodies: string[];
  call: (method: string, pathname: string, body?: unknown) => Promise<RawResponse & { json: any }>;
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, fetchOpts: Parameters<typeof fakeFetch>[0] = {}): Promise<Ctx> {
  const store = new MemoryStore();
  const server = await startTestServer({ secrets: store, clientFactory: factory(fakeFetch(fetchOpts)) });
  t.after(() => server.cleanup());
  const bodies: string[] = [];
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await server.api(pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    bodies.push(res.body);
    return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return { server, store, bodies, call };
}

async function commitCount(dir: string): Promise<number> {
  return (await log(dir, { limit: 1000 })).length;
}

test('create, list and open projects', async (t) => {
  const { call } = await setup(t);
  const created = await call('POST', '/api/projects', { name: 'Acme Migration', environment: { name: 'dev', url: 'https://your-space.kinops.io', readOnly: true } });
  assert.equal(created.status, 201);
  const p = created.json as ProjectDetail;
  assert.equal(p.id, 'acme-migration');
  assert.equal(p.name, 'Acme Migration');
  assert.deepEqual(p.environments.map((e) => [e.name, e.url, e.readOnly]), [['dev', 'https://your-space.kinops.io', true]]);
  const dir = path.join(JSON.parse((await call('GET', '/api/session')).body).workspace as string, 'acme-migration');
  assert.ok(existsSync(path.join(dir, '.git')));
  assert.ok(existsSync(path.join(dir, 'kinetic-sync.config.json')));
  assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.env\*$/m);
  assert.equal(await commitCount(dir), 1);

  assert.equal((await call('POST', '/api/projects', { name: 'Acme Migration' })).status, 409);
  assert.equal((await call('POST', '/api/projects', { name: '  ' })).status, 400);

  // A CLI-created project outside the workspace.
  const outside = mkdtempSync(path.join(tmpdir(), 'km-cli-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(outside, 'environments'));
  writeFileSync(path.join(outside, 'environments', 'test.json'), JSON.stringify({ url: 'https://test.example.com' }));
  writeFileSync(path.join(outside, '.env.test'), `KINETIC_TEST_PASSWORD=${PLANTED}`);
  const opened = await call('POST', '/api/projects/open', { path: outside });
  assert.equal(opened.status, 200);
  const op = opened.json as ProjectDetail;
  assert.match(readMeta(outside).secretsId ?? '', /^[0-9a-f-]{36}$/);
  assert.deepEqual(op.environments.map((e) => e.name), ['test']);
  const head = (await log(outside, { limit: 1 }))[0];
  const tree = await readTreeAt(outside, head.oid, '');
  assert.ok(!JSON.stringify([...tree]).includes(PLANTED));

  assert.equal((await call('POST', '/api/projects/open', { path: tmpdir() })).status, 400);
  assert.equal((await call('POST', '/api/projects/open', { path: 'relative/path' })).status, 400);

  const list = (await call('GET', '/api/projects')).json as ProjectSummary[];
  assert.deepEqual(list.map((x) => x.id).sort(), ['acme-migration', op.id].sort());
  assert.equal((await call('GET', `/api/projects/${op.id}`)).status, 200);
  assert.equal((await call('GET', '/api/projects/nope')).status, 404);
  assert.equal((await call('GET', '/api/projects/..')).status, 404);
});

test('environments: add, order, credentials, delete — one commit per mutation, no secrets in responses', async (t) => {
  const { call, store, bodies } = await setup(t);
  const ws = JSON.parse((await call('GET', '/api/session')).body).workspace as string;
  await call('POST', '/api/projects', { name: 'pipeline' });
  const dir = path.join(ws, 'pipeline');
  let commits = await commitCount(dir);
  const mutated = async () => {
    const n = await commitCount(dir);
    assert.equal(n, commits + 1, 'one commit per mutation');
    commits = n;
  };

  assert.equal((await call('PUT', '/api/projects/pipeline/environments/prod', { url: 'https://prod.example.com/', readOnly: true })).status, 200);
  await mutated();
  assert.equal((await call('PUT', '/api/projects/pipeline/environments/dev', { url: 'https://dev.example.com', position: 0 })).status, 200);
  await mutated();
  const added = await call('PUT', '/api/projects/pipeline/environments/test', { url: 'https://test.example.com', position: 1 });
  await mutated();
  assert.deepEqual((added.json as ProjectDetail).environments.map((e) => e.name), ['dev', 'test', 'prod']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'environments', 'prod.json'), 'utf8')), { url: 'https://prod.example.com', readOnly: true });

  assert.equal((await call('PUT', '/api/projects/pipeline/environments/bad%20name', { url: 'https://x.example.com' })).status, 400);
  assert.equal((await call('PUT', '/api/projects/pipeline/environments/x', { url: 'ftp://x' })).status, 400);
  const unknown = await call('PUT', '/api/projects/pipeline/environments/x', { url: 'https://x.example.com', '<script>sneaky': 1 });
  assert.equal(unknown.status, 400);
  assert.ok(!unknown.body.includes('sneaky'), 'unknown field names are not echoed');
  const caseClash = await call('PUT', '/api/projects/pipeline/environments/DEV', { url: 'https://dev2.example.com' });
  assert.equal(caseClash.status, 409);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'environments', 'dev.json'), 'utf8')).url, 'https://dev.example.com');

  const cred = await call('PUT', '/api/projects/pipeline/environments/dev/credentials', { username: 'admin', password: PLANTED });
  assert.equal(cred.status, 200);
  assert.deepEqual(cred.json as CredentialsStatus, { username: true, password: true });
  const sid = readMeta(dir).secretsId as string;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal(await store.get(`${sid}/dev/credentials/password`), PLANTED);
  assert.equal(await store.has('pipeline/dev/credentials/password'), false, 'accounts never use the folder name');
  const detail = (await call('GET', '/api/projects/pipeline')).json as ProjectDetail;
  assert.deepEqual(detail.environments[0].credentials, { username: true, password: true });
  assert.deepEqual(detail.environments[1].credentials, { username: false, password: false });
  assert.equal((await call('PUT', '/api/projects/pipeline/environments/nope/credentials', { username: 'a', password: 'b' })).status, 404);

  // Engine env resolution: file + store, secrets as KINETIC_* vars.
  const ref = { id: 'pipeline', dir };
  await setEnvSecret(store, ref, 'dev', 'secret', 'MY_CONN__CLIENT_SECRET', 'conn-secret');
  await setEnvSecret(store, ref, 'dev', 'handler', 'SMTP_V1__SMTP_PASSWORD', 'handler-secret');
  const env = await resolveEnv({ id: 'pipeline', dir }, 'dev', store);
  assert.equal(env.url, 'https://dev.example.com');
  assert.equal(env.password, PLANTED);
  assert.equal(env.vars.KINETIC_DEV_SECRET_MY_CONN__CLIENT_SECRET, 'conn-secret');
  assert.equal(env.vars.KINETIC_DEV_HANDLER_SMTP_V1__SMTP_PASSWORD, 'handler-secret');
  await assert.rejects(resolveEnv({ id: 'pipeline', dir }, 'test', store), /credentials/i);

  // Config and overrides.
  const config = await call('GET', '/api/projects/pipeline/config');
  assert.deepEqual(config.json.data, []);
  const putConfig = await call('PUT', '/api/projects/pipeline/config', { data: [{ kapp: 'services', form: 'lookups', key: ['Code'] }], envBoundAttributes: { kapp: ['Logo'] } });
  assert.equal(putConfig.status, 200);
  await mutated();
  assert.deepEqual(putConfig.json.data, [{ kapp: 'services', form: 'lookups', key: ['Code'] }]);
  assert.equal((await call('PUT', '/api/projects/pipeline/config', { data: [{ kapp: 'services' }] })).status, 400);
  assert.equal((await call('PUT', '/api/projects/pipeline/config', { envBoundAttributes: { kapp: 'Logo' } })).status, 400);
  // Scoped attribute rules and keyless, filtered reference data are accepted alongside the legacy shapes.
  const scoped = {
    data: [{ kapp: 'services', form: 'lookups', filter: [{ field: 'Type', value: 'Lookup' }] }, { kapp: 'services', form: 'codes', key: ['Code'] }],
    envBoundAttributes: { kapp: ['Logo', { name: 'Url', kapp: 'services' }], form: [{ name: 'Queue', kapp: 'services', form: 'lookups' }], team: [{ name: 'Email', team: 'Ops' }], category: [{ name: 'Icon' }] },
  };
  const putScoped = await call('PUT', '/api/projects/pipeline/config', scoped);
  assert.equal(putScoped.status, 200);
  await mutated();
  assert.deepEqual(putScoped.json.data, scoped.data);
  assert.deepEqual(putScoped.json.envBoundAttributes, scoped.envBoundAttributes);
  const rejects = async (body: unknown, message: RegExp) => {
    const r = await call('PUT', '/api/projects/pipeline/config', body);
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, message);
  };
  await rejects({ envBoundAttributes: { kapp: [{ kapp: 'services' }] } }, /entry 1 needs a "name"/);
  await rejects({ envBoundAttributes: { team: [{ name: 'Email', kapp: 'services' }] } }, /"kapp" is not allowed at the team level/);
  await rejects({ envBoundAttributes: { widget: ['x'] } }, /unknown level "widget"/);
  await rejects({ data: [{ kapp: 'services', form: 'lookups', filter: [{ field: 'Type', value: '' }] }] }, /filter condition 1 needs a field and a value/);
  await rejects({ data: [{ kapp: 'services', form: 'lookups', key: 'Code' }] }, /"key" must be a list/);
  // A hand-edited file with an unknown level still loads; the level is reported and ignored.
  const cfgFile = path.join(dir, 'kinetic-sync.config.json');
  const saved = readFileSync(cfgFile, 'utf8');
  writeFileSync(cfgFile, JSON.stringify({ envBoundAttributes: { forms: ['X'], kapp: ['Logo'] } }));
  const tolerant = await call('GET', '/api/projects/pipeline/config');
  assert.equal(tolerant.status, 200);
  assert.deepEqual(tolerant.json.envBoundAttributes, { kapp: ['Logo'] });
  assert.match(tolerant.json.warnings[0], /unknown level "forms"/);
  // Space settings kept per environment: defaults when absent, validated on save, tolerant on load.
  const defaults = ['displayType', 'displayValue', 'trustedFrameDomains', 'trustedResourceDomains', 'allowedIps', 'allowedIpsEnabled'];
  assert.deepEqual(tolerant.json.envBoundSpaceFields, defaults);
  writeFileSync(cfgFile, JSON.stringify({ envBoundSpaceFields: ['displayValue', 'favouriteColour'] }));
  const unknownField = await call('GET', '/api/projects/pipeline/config');
  assert.equal(unknownField.status, 200);
  assert.deepEqual(unknownField.json.envBoundSpaceFields, ['displayType', 'displayValue']);
  assert.match(unknownField.json.warnings[0], /"envBoundSpaceFields": "favouriteColour" cannot be kept per environment; it is ignored\./);
  assert.match(unknownField.json.warnings[1], /"displayType" and "displayValue" go together; both are kept\./);
  writeFileSync(cfgFile, saved);
  await rejects({ envBoundSpaceFields: ['displayValue', 'slug'] }, /"slug" cannot be kept per environment \(choose from /);
  await rejects({ envBoundSpaceFields: 'displayValue' }, /must be a list/);
  await rejects({ envBoundSpaceFields: ['allowedIps'] }, /"allowedIps" and "allowedIpsEnabled" go together; list both or neither/);
  const putSpace = await call('PUT', '/api/projects/pipeline/config', { envBoundSpaceFields: ['loginPage', 'displayValue', 'loginPage', 'displayType'] });
  assert.equal(putSpace.status, 200);
  await mutated();
  // Saved without repeats, in the canonical order.
  assert.deepEqual(putSpace.json.envBoundSpaceFields, ['displayType', 'displayValue', 'loginPage']);
  assert.deepEqual(JSON.parse(readFileSync(cfgFile, 'utf8')).envBoundSpaceFields, ['displayType', 'displayValue', 'loginPage']);
  // Saving another part of the settings leaves the list alone.
  assert.equal((await call('PUT', '/api/projects/pipeline/config', { envBoundAttributes: scoped.envBoundAttributes })).status, 200);
  assert.deepEqual((await call('GET', '/api/projects/pipeline/config')).json.envBoundSpaceFields, ['displayType', 'displayValue', 'loginPage']);
  // Nothing was written by the rejected requests.
  assert.deepEqual((await call('GET', '/api/projects/pipeline/config')).json.envBoundAttributes, scoped.envBoundAttributes);
  const putOv = await call('PUT', '/api/projects/pipeline/overrides/test', { artifacts: { 'space/space': { name: 'Test space' } }, replace: [{ from: 'dev.example.com', to: 'test.example.com' }] });
  assert.equal(putOv.status, 200);
  await mutated();
  assert.deepEqual((await call('GET', '/api/projects/pipeline/overrides/test')).json.replace, [{ from: 'dev.example.com', to: 'test.example.com' }]);
  assert.deepEqual((await call('GET', '/api/projects/pipeline/overrides/prod')).json, { artifacts: {}, replace: [] });
  assert.equal((await call('PUT', '/api/projects/pipeline/overrides/test', { replace: [{ from: '' , to: 'x' }] })).status, 400);
  assert.equal((await call('GET', '/api/projects/pipeline/overrides/ghost')).status, 404);

  // Delete removes the file, the pipeline slot and the stored credentials.
  assert.equal((await call('DELETE', '/api/projects/pipeline/environments/dev')).status, 200);
  await mutated();
  assert.equal(existsSync(path.join(dir, 'environments', 'dev.json')), false);
  assert.equal(await store.has(`${sid}/dev/credentials/password`), false);
  assert.equal(await store.has(`${sid}/dev/secret/MY_CONN__CLIENT_SECRET`), false);
  assert.deepEqual(((await call('GET', '/api/projects/pipeline')).json as ProjectDetail).environments.map((e) => e.name), ['test', 'prod']);
  assert.equal((await call('DELETE', '/api/projects/pipeline/environments/dev')).status, 404);

  // Nothing ever echoed the password; nothing committed it.
  for (const b of bodies) assert.ok(!b.includes(PLANTED), `response leaked the password: ${b.slice(0, 200)}`);
  const head = (await log(dir, { limit: 1 }))[0];
  assert.ok(!JSON.stringify([...(await readTreeAt(dir, head.oid, ''))]).includes(PLANTED));
});

test('test connection reports the failing step without leaking secrets', async (t) => {
  const { call, bodies } = await setup(t, { integratorOk: false });
  await call('POST', '/api/projects', { name: 'conn', environment: { name: 'dev', url: 'https://your-space.kinops.io' } });
  const noCreds = await call('POST', '/api/projects/conn/environments/dev/test');
  assert.equal(noCreds.status, 400);
  await call('PUT', '/api/projects/conn/environments/dev/credentials', { username: 'admin', password: PLANTED });
  const res = await call('POST', '/api/projects/conn/environments/dev/test');
  assert.equal(res.status, 200);
  const r = res.json as ConnectionTestResult;
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['core', true], ['integrator', false]]);
  assert.match(r.steps[1].message ?? '', /401/);
  for (const b of bodies) assert.ok(!b.includes(PLANTED));
});

test('test connection: core failure skips the integrator step; success passes both', async (t) => {
  const bad = await setup(t, { coreStatus: 401 });
  await bad.call('POST', '/api/projects', { name: 'conn', environment: { name: 'dev', url: 'https://your-space.kinops.io' } });
  await bad.call('PUT', '/api/projects/conn/environments/dev/credentials', { username: 'admin', password: PLANTED });
  const r1 = (await bad.call('POST', '/api/projects/conn/environments/dev/test')).json as ConnectionTestResult;
  assert.deepEqual(r1.steps.map((s) => [s.step, s.ok, Boolean(s.skipped)]), [['core', false, false], ['integrator', false, true]]);

  const good = await setup(t, { integratorOk: true });
  await good.call('POST', '/api/projects', { name: 'conn', environment: { name: 'dev', url: 'https://your-space.kinops.io' } });
  await good.call('PUT', '/api/projects/conn/environments/dev/credentials', { username: 'admin', password: PLANTED });
  const r2 = (await good.call('POST', '/api/projects/conn/environments/dev/test')).json as ConnectionTestResult;
  assert.equal(r2.ok, true);
});

test('session reports keychain availability from the store', async (t) => {
  const { call } = await setup(t);
  const s = (await call('GET', '/api/session')).json;
  assert.equal(s.keychain.available, false);
});

test('credentials never collide across workspaces or survive re-creating a same-named project', async (t) => {
  const store = new MemoryStore();
  const a = await startTestServer({ secrets: store });
  const b = await startTestServer({ secrets: store });
  t.after(async () => { await a.cleanup(); await b.cleanup(); });
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const put = (body: unknown) => ({ ...json(body), method: 'PUT' });
  const project = { name: 'Same Name', environment: { name: 'dev', url: 'https://your-space.kinops.io' } };
  assert.equal((await a.api('/api/projects', json(project))).status, 201);
  assert.equal((await b.api('/api/projects', json(project))).status, 201);
  await a.api('/api/projects/same-name/environments/dev/credentials', put({ username: 'admin', password: PLANTED }));
  const inB = JSON.parse((await b.api('/api/projects/same-name')).body) as ProjectDetail;
  assert.deepEqual(inB.environments[0].credentials, { username: false, password: false });

  // Delete the folder in A and create the same name again: nothing inherited.
  const wsA = JSON.parse((await a.api('/api/session')).body).workspace as string;
  rmSync(path.join(wsA, 'same-name'), { recursive: true, force: true });
  assert.equal((await a.api('/api/projects', json(project))).status, 201);
  const again = JSON.parse((await a.api('/api/projects/same-name')).body) as ProjectDetail;
  assert.deepEqual(again.environments[0].credentials, { username: false, password: false });
});

test('a CLI-created project in the workspace gets a secrets id when first used', async (t) => {
  const { call } = await setup(t);
  const ws = JSON.parse((await call('GET', '/api/session')).body).workspace as string;
  const dir = path.join(ws, 'cli-made');
  mkdirSync(path.join(dir, 'environments'), { recursive: true });
  writeFileSync(path.join(dir, 'environments', 'dev.json'), JSON.stringify({ url: 'https://your-space.kinops.io' }));
  assert.equal((await call('PUT', '/api/projects/cli-made/environments/dev/credentials', { username: 'u', password: 'p' })).status, 200);
  assert.match(readMeta(dir).secretsId ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(existsSync(path.join(dir, '.git')));
  assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.env\*$/m);
});

test('opening refuses folders that are not projects and repositories on another branch, and commits only the project layout', async (t) => {
  const { call } = await setup(t);
  const tmp = (prefix: string) => {
    const d = mkdtempSync(path.join(tmpdir(), prefix));
    t.after(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };

  // An infrastructure layout with an environments/ folder but no environment files.
  const infra = tmp('km-infra-');
  mkdirSync(path.join(infra, 'environments', 'prod'), { recursive: true });
  writeFileSync(path.join(infra, 'environments', 'prod', 'main.tf'), 'resource "x" "y" {}');
  writeFileSync(path.join(infra, 'credentials.yaml'), `token: ${PLANTED}`);
  const notProject = await call('POST', '/api/projects/open', { path: infra });
  assert.equal(notProject.status, 400);
  assert.match(notProject.json.error.message, /not a Kinetic project/);
  assert.equal(existsSync(path.join(infra, '.git')), false, 'no repository created');
  assert.equal(existsSync(path.join(infra, 'kinetic-migrate.json')), false, 'nothing written');

  // A project folder inside a repository checked out on another branch.
  const feature = tmp('km-branch-');
  writeFileSync(path.join(feature, 'kinetic-sync.config.json'), '{}');
  await ensureRepo(feature);
  writeFileSync(path.join(feature, 'README.md'), 'x');
  await git.add({ fs, dir: feature, filepath: 'README.md' });
  await git.commit({ fs, dir: feature, message: 'init', author: { name: 'a', email: 'a@example.com' } });
  await git.branch({ fs, dir: feature, ref: 'infra-work', checkout: true });
  const otherBranch = await call('POST', '/api/projects/open', { path: feature });
  assert.equal(otherBranch.status, 400);
  assert.equal(otherBranch.json.error.message, 'This folder is a git repository on branch infra-work; Kinetic Migrator manages projects on main.');
  assert.equal((await log(feature, { limit: 10 })).length, 1, 'nothing committed');
  assert.equal(existsSync(path.join(feature, 'kinetic-migrate.json')), false, 'nothing written');

  // A valid project with stray files outside the layout: only the layout is committed.
  const cli = tmp('km-layout-');
  mkdirSync(path.join(cli, 'environments'));
  writeFileSync(path.join(cli, 'environments', 'test.json'), JSON.stringify({ url: 'https://test.example.com' }));
  mkdirSync(path.join(cli, 'snapshots', 'test'), { recursive: true });
  writeFileSync(path.join(cli, 'snapshots', 'test', 'space.json'), '{}');
  writeFileSync(path.join(cli, 'credentials.yaml'), `token: ${PLANTED}`);
  mkdirSync(path.join(cli, 'terraform'));
  writeFileSync(path.join(cli, 'terraform', 'main.tf'), 'x');
  const opened = await call('POST', '/api/projects/open', { path: cli });
  assert.equal(opened.status, 200, opened.body);
  const head = (await log(cli, { limit: 1 }))[0];
  const files = (await git.listFiles({ fs, dir: cli, ref: head.oid })).sort();
  assert.deepEqual(files, ['.gitattributes', '.gitignore', 'environments/test.json', 'kinetic-migrate.json', 'snapshots/test/space.json']);
  assert.match(readFileSync(path.join(cli, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
  assert.match(readFileSync(path.join(cli, '.gitattributes'), 'utf8'), /^\*\.zip binary$/m);
  assert.equal(existsSync(path.join(cli, 'credentials.yaml')), true, 'left alone on disk');
});

test('environment addresses must be https:// (plain http only for this computer); an existing http:// one still loads but never signs in', async (t) => {
  const store = new MemoryStore();
  const sent: string[] = [];
  const fetchImpl = fakeFetch({ integratorOk: true });
  const server = await startTestServer({ secrets: store, clientFactory: factory(async (url, init) => { sent.push(String(url)); return fetchImpl(url, init); }) });
  t.after(() => server.cleanup());
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await server.api(pathname, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
  };
  const ws = JSON.parse((await call('GET', '/api/session')).body).workspace as string;
  const refused = await call('POST', '/api/projects', { name: 'web', environment: { name: 'dev', url: 'http://your-space.kinops.io' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error.message, /^Start the address with https:\/\//);
  assert.equal((await call('POST', '/api/projects', { name: 'web' })).status, 201);
  const http = await call('PUT', '/api/projects/web/environments/dev', { url: 'http://your-space.kinops.io' });
  assert.equal(http.status, 400);
  assert.match(http.json.error.message, /^Start the address with https:\/\//);
  for (const url of ['http://localhost:8080', 'http://127.0.0.1:9000', 'http://[::1]:7000', 'https://your-space.kinops.io']) {
    assert.equal((await call('PUT', '/api/projects/web/environments/dev', { url })).status, 200, url);
  }

  // A project written before https was required.
  const dir = path.join(ws, 'web');
  writeFileSync(path.join(dir, 'environments', 'dev.json'), JSON.stringify({ url: 'http://your-space.kinops.io', readOnly: false }));
  await call('PUT', '/api/projects/web/environments/dev/credentials', { username: 'admin', password: PLANTED });
  const detail = (await call('GET', '/api/projects/web')).json as ProjectDetail;
  const MESSAGE = 'This address uses http://, which would send your password unencrypted. Change it to https://.';
  assert.equal(detail.environments[0].problem, MESSAGE);
  // Unchanged, it can still be reordered or protected; a different http address cannot be saved.
  assert.equal((await call('PUT', '/api/projects/web/environments/dev', { url: 'http://your-space.kinops.io', readOnly: true })).status, 200);
  assert.equal((await call('PUT', '/api/projects/web/environments/dev', { url: 'http://other.kinops.io' })).status, 400);
  assert.equal((await call('PUT', '/api/projects/web/environments/dev', { url: 'http://your-space.kinops.io', readOnly: false })).status, 200);

  const tested = await call('POST', '/api/projects/web/environments/dev/test');
  assert.equal(tested.status, 400);
  assert.equal(tested.json.error.code, 'insecure_url');
  assert.equal(tested.json.error.message, `Dev: ${MESSAGE}`);
  const snap = await call('POST', '/api/projects/web/snapshots', { env: 'dev' });
  if (snap.status === 202) {
    await server.jobs.wait(snap.json.jobId);
    const info = (await call('GET', `/api/jobs/${snap.json.jobId}`)).json;
    assert.equal(info.status, 'failed');
    assert.match(JSON.stringify(info.error), /would send your password unencrypted/);
  } else {
    assert.equal(snap.status, 400);
    assert.match(snap.json.error.message, /would send your password unencrypted/);
  }
  assert.deepEqual(sent, [], 'nothing was sent to the http address');
  await assert.rejects(resolveEnv({ id: 'web', dir } as any, 'dev', store), /would send your password unencrypted/);
});
