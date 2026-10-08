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
import { log, readTreeAt } from './repo.ts';
import { MemoryStore } from './secrets.ts';
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
  assert.equal((await call('PUT', '/api/projects/pipeline/environments/x', { url: 'https://x.example.com', extra: 1 })).status, 400);

  const cred = await call('PUT', '/api/projects/pipeline/environments/dev/credentials', { username: 'admin', password: PLANTED });
  assert.equal(cred.status, 200);
  assert.deepEqual(cred.json as CredentialsStatus, { username: true, password: true });
  assert.equal(await store.get('pipeline/dev/credentials/password'), PLANTED);
  const detail = (await call('GET', '/api/projects/pipeline')).json as ProjectDetail;
  assert.deepEqual(detail.environments[0].credentials, { username: true, password: true });
  assert.deepEqual(detail.environments[1].credentials, { username: false, password: false });
  assert.equal((await call('PUT', '/api/projects/pipeline/environments/nope/credentials', { username: 'a', password: 'b' })).status, 404);

  // Engine env resolution: file + store, secrets as KINETIC_* vars.
  await setEnvSecret(store, 'pipeline', 'dev', 'secret', 'MY_CONN__CLIENT_SECRET', 'conn-secret');
  await setEnvSecret(store, 'pipeline', 'dev', 'handler', 'SMTP_V1__SMTP_PASSWORD', 'handler-secret');
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
  assert.equal(await store.has('pipeline/dev/credentials/password'), false);
  assert.equal(await store.has('pipeline/dev/secret/MY_CONN__CLIENT_SECRET'), false);
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
