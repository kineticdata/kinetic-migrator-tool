import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capabilities, crossVersionWarning, detectPlatform, parseVersion, platformLabel } from './platform.mjs';
import { createClient, HttpError, IntegratorAuthUnavailable, redact, strategiesFor, implicitGrant, pkceGrant } from './http.mjs';
import { fakePlatform } from './fake-platform.mjs';
import { runExport } from './commands.mjs';
import { loadTree } from './layout.mjs';

const noSleep = async () => {};
const clock = (start = 1_700_000_000_000) => {
  const c = { t: start, now: () => c.t, advance: (s) => { c.t += s * 1000; } };
  return c;
};
const client = (fake, opts = {}) => createClient({ env: fake.env(), mode: 'read', fetchImpl: fake.fetch, sleep: noSleep, ...opts });
const integratorRoutes = (connections = []) => ({ api, method, path }) => {
  if (api !== 'integrator' || method !== 'GET') return undefined;
  if (path === '/connections') return connections.map(({ id, name }) => ({ id, name }));
  const m = /^\/export\/connections\/([^/]+)$/.exec(path);
  const c = m && connections.find((x) => x.id === decodeURIComponent(m[1]));
  return c ? { connection: { ...c, operations: [] } } : undefined;
};

test('parseVersion reads platform and Task versions; others are null', () => {
  assert.deepEqual(parseVersion('7.0.0-rc3'), { version: '7.0.0-rc3', major: 7, minor: 0 });
  assert.deepEqual(parseVersion('6.1.7'), { version: '6.1.7', major: 6, minor: 1 });
  assert.deepEqual(parseVersion('06.01.07'), { version: '06.01.07', major: 6, minor: 1 });
  for (const v of [undefined, null, '', 'latest', '<b>7</b>', 'x'.repeat(50), 7]) assert.equal(parseVersion(v), null, String(v));
});

test('detectPlatform: 6.1.7 and 7.0.0-rc3 from the open Integrator endpoint', async () => {
  for (const [version, major, minor] of [['6.1.7', 6, 1], ['7.0.0-rc3', 7, 0]]) {
    const fake = fakePlatform({ version });
    const p = await detectPlatform(fake.env(), { fetchImpl: fake.fetch });
    assert.deepEqual({ ...p }, { version, major, minor, source: 'integrator' });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].headers.Authorization, undefined);
  }
});

test('detectPlatform falls back to Core (Basic auth), then to unknown; a network failure is unknown', async () => {
  const fake = fakePlatform({ version: '6.1.7' });
  const fetchImpl = async (url, init) => (String(url).includes('/integrator/') ? new Response('nope', { status: 503 }) : fake.fetch(url, init));
  const basic = `Basic ${Buffer.from('u:p').toString('base64')}`;
  assert.deepEqual({ ...(await detectPlatform(fake.env(), { fetchImpl, basic })) }, { version: '6.1.7', major: 6, minor: 1, source: 'core' });
  // 6.x's Core endpoint wants Basic auth.
  assert.equal((await detectPlatform(fake.env(), { fetchImpl })).major, null);
  const none = fakePlatform({ versionEndpoints: false });
  assert.deepEqual({ ...(await detectPlatform(none.env(), { fetchImpl: none.fetch })) }, { version: null, major: null, minor: null, source: null });
  assert.equal((await detectPlatform({ url: 'https://x' }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).major, null);
});

test('client.platform() detects once per client', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3' });
  const c = client(fake);
  const [a, b] = await Promise.all([c.platform(), c.platform()]);
  assert.equal(a.version, '7.0.0-rc3');
  assert.equal(a, b);
  assert.equal(await c.platform(), a);
  assert.equal(fake.calls.length, 1);
});

test('capabilities: 6 → implicit, 7+ → pkce, unknown → unknown (implicit, then pkce)', () => {
  assert.equal(capabilities({ major: 6 }).integratorAuth, 'implicit');
  assert.equal(capabilities({ major: 7 }).integratorAuth, 'pkce');
  assert.equal(capabilities({ major: 8 }).integratorAuth, 'pkce');
  assert.equal(capabilities({ major: null }).integratorAuth, 'unknown');
  assert.equal(capabilities(undefined).integratorAuth, 'unknown');
  assert.deepEqual(strategiesFor({ major: 6 }), [implicitGrant]);
  assert.deepEqual(strategiesFor({ major: 7 }), [pkceGrant]);
  assert.deepEqual(strategiesFor({ major: null }), [implicitGrant, pkceGrant]);
});

test('crossVersionWarning only for different major versions; platformLabel', () => {
  const v6 = { version: '6.1.7', major: 6 };
  const v7 = { version: '7.0.0-rc3', major: 7 };
  assert.equal(crossVersionWarning({ name: 'Dev', platform: v6 }, { name: 'Prod', platform: v7 }), 'Dev runs 6.1.7 and Prod runs 7.0.0-rc3 — review differences carefully.');
  assert.equal(crossVersionWarning({ name: 'Dev', platform: v7 }, { name: 'Prod', platform: { version: '7.1.0', major: 7 } }), null);
  assert.equal(crossVersionWarning({ name: 'Dev', platform: v6 }, { name: 'Prod', platform: { major: null } }), null);
  assert.equal(crossVersionWarning({ name: 'Dev' }, { name: 'Prod', platform: v7 }), null);
  assert.equal(platformLabel(v7), 'Kinetic Platform 7.0.0-rc3');
  assert.equal(platformLabel({ major: null }), 'Kinetic Platform (version unknown)');
});

test('6.x: the Integrator token comes from the implicit grant; no 7.x sign-in is tried', async () => {
  const fake = fakePlatform({ version: '6.1.7', handle: integratorRoutes([{ id: 'c1', name: 'One' }]) });
  const c = client(fake);
  assert.deepEqual(await c.get('integrator', '/connections'), [{ id: 'c1', name: 'One' }]);
  await c.get('integrator', '/connections');
  assert.equal(fake.counts.implicit, 1);
  assert.equal(fake.calls.some((x) => /login\.do|oauth2|meta\/spa/.test(x.url)), false);
});

test('7.x: login.do with the XSRF header and cookies, then code + PKCE, then the bearer token', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3', handle: integratorRoutes([{ id: 'c1', name: 'One' }]) });
  const c = client(fake);
  assert.deepEqual(await c.get('integrator', '/connections'), [{ id: 'c1', name: 'One' }]);
  const paths = fake.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`);
  assert.deepEqual(paths, [
    'GET /app/integrator/api/version', 'GET /app/api/v1/meta/spa', 'POST /app/login.do', 'GET /app/oauth2/authorize', 'POST /app/oauth2/token', 'GET /app/integrator/api/connections',
  ]);
  assert.equal(fake.calls.some((x) => x.url.includes('/app/oauth/authorize')), false);
  const login = fake.calls[2];
  assert.equal(login.redirect, 'manual');
  assert.equal(login.headers['content-type'], 'application/json');
  assert.match(login.headers.cookie, /XSRF-TOKEN=[0-9a-f]+/);
  assert.equal(login.headers['X-XSRF-TOKEN'], /XSRF-TOKEN=([0-9a-f]+)/.exec(login.headers.cookie)[1]);
  assert.deepEqual(JSON.parse(login.body), { j_username: 'u', j_password: 'p' });
  const authorize = new URL(fake.calls[3].url);
  assert.equal(fake.calls[3].redirect, 'manual');
  assert.match(fake.calls[3].headers.cookie, /JSESSIONID=sid-/);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://your-space.kinops.io/app/oauth/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(fake.calls[5].headers.Authorization, /^Bearer tok-/);
  // Core and Task keep Basic auth.
  assert.equal(fake.counts.token, 1);
});

test('7.x without the XSRF header is refused (as the platform does) and reads as a rejected sign-in', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3' });
  const r = await fake.fetch(`${fake.url}/app/login.do`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('version unknown: the implicit grant answers 404, so the 7.x sign-in is used and kept', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3', versionEndpoints: false, handle: integratorRoutes() });
  const c = client(fake);
  await c.get('integrator', '/connections');
  assert.equal(fake.calls.filter((x) => x.url.includes('/app/oauth/authorize')).length, 1);
  assert.equal(fake.counts.token, 1);
  fake.revokeTokens();
  await c.get('integrator', '/connections');
  // The kept strategy: no second implicit attempt.
  assert.equal(fake.calls.filter((x) => x.url.includes('/app/oauth/authorize')).length, 1);
  assert.equal(fake.counts.token, 2);
});

test('neither sign-in offered: IntegratorAuthUnavailable (connections are left out)', async () => {
  const fetchImpl = async (url) => (String(url).endsWith('/app/integrator/api/version')
    ? new Response(JSON.stringify({ version: { version: '9.0.0' } })) : new Response('{}', { status: 404 }));
  const c = createClient({ env: fakePlatform().env(), mode: 'read', fetchImpl, sleep: noSleep });
  await assert.rejects(c.get('integrator', '/connections'), (e) => e instanceof IntegratorAuthUnavailable && e.version === '9.0.0');
});

test('7.x wrong password: rejected, check the username and password', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3' });
  const c = createClient({ env: { ...fake.env(), password: 'wrong' }, mode: 'read', fetchImpl: fake.fetch, sleep: noSleep });
  await assert.rejects(c.get('integrator', '/connections'), (e) => e.name === 'IntegratorSignInFailed' && e.status === 401 && !e.sso
    && e.message === 'The Integrator rejected the sign-in (401): check the username and password.');
});

for (const sso of ['refuse', 'redirect']) {
  test(`7.x single-sign-on-only space (${sso}): a clear message`, async () => {
    const fake = fakePlatform({ version: '7.0.0-rc3', sso });
    const c = client(fake);
    await assert.rejects(c.get('integrator', '/connections'), (e) => e.name === 'IntegratorSignInFailed' && e.sso === true
      && e.message === 'This space signs in with single sign-on; kinetic-migrate needs a local account with a password.');
  });
}

test('7.x: the 5-minute token is renewed 30 s before it expires, reusing the session; an ended session signs in again', async () => {
  const c0 = clock();
  const fake = fakePlatform({ version: '7.0.0-rc3', now: c0.now, handle: integratorRoutes() });
  const c = client(fake, { now: c0.now });
  await c.get('integrator', '/connections');
  c0.advance(200);
  await c.get('integrator', '/connections');
  assert.equal(fake.counts.token, 1);
  c0.advance(75); // 275 s: within 30 s of expiry
  await c.get('integrator', '/connections');
  assert.deepEqual({ login: fake.counts.login, token: fake.counts.token }, { login: 1, token: 2 });
  fake.endSessions();
  c0.advance(300);
  await c.get('integrator', '/connections');
  assert.deepEqual({ login: fake.counts.login, token: fake.counts.token }, { login: 2, token: 3 });
});

test('a 401 from the Integrator (token expired early) signs in again once and retries; a second 401 is an error', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3', handle: integratorRoutes() });
  const c = client(fake);
  await c.get('integrator', '/connections');
  fake.revokeTokens();
  assert.deepEqual(await c.get('integrator', '/connections'), []);
  assert.equal(fake.counts.token, 2);
  const always = fakePlatform({ version: '7.0.0-rc3', handle: () => ({ raw: true, status: 401, body: { error: 'no' } }) });
  await assert.rejects(client(always).get('integrator', '/connections'), (e) => e instanceof HttpError && e.status === 401);
  assert.equal(always.counts.token, 2);
});

test('concurrent Integrator calls share one sign-in', async () => {
  const fake = fakePlatform({ version: '7.0.0-rc3', handle: integratorRoutes() });
  const c = client(fake);
  await Promise.all(Array.from({ length: 5 }, () => c.get('integrator', '/connections')));
  assert.deepEqual({ login: fake.counts.login, token: fake.counts.token }, { login: 1, token: 1 });
});

test('a long export against 7.x keeps working across several token lifetimes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-v7-'));
  mkdirSync(join(dir, 'environments'));
  writeFileSync(join(dir, 'environments', 'dev.json'), JSON.stringify({ url: 'https://your-space.kinops.io', readOnly: true }));
  writeFileSync(join(dir, '.env.dev'), 'KINETIC_DEV_USERNAME=u\nKINETIC_DEV_PASSWORD=p\n');
  const connections = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Conn ${String(i).padStart(2, '0')}`, type: 'http', config: { baseUrl: 'https://x.example.com' } }));
  const c0 = clock();
  const routes = integratorRoutes(connections);
  const empty = {
    'core /space': { space: { name: 'Space', slug: 'space' } }, 'core /teams': { teams: [] }, 'core /fileResources': { fileResources: [] },
    'core /kapps': { kapps: [] }, 'core /workflows': { workflows: [] }, 'task /trees': { trees: [] }, 'task /handlers': { handlers: [] },
  };
  const fake = fakePlatform({
    version: '7.0.0-rc3', now: c0.now,
    handle: (req) => {
      // Each Integrator call takes two minutes.
      if (req.api === 'integrator') c0.advance(120);
      return routes(req) ?? (req.method === 'GET' ? empty[`${req.api} ${req.path}`] : undefined);
    },
  });
  const r = await runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ env, mode }) => createClient({ env, mode, fetchImpl: fake.fetch, sleep: noSleep, now: c0.now }) });
  assert.equal(r.code, 0);
  assert.deepEqual(r.omitted, []);
  assert.equal([...loadTree(join(dir, 'snapshots', 'dev')).keys()].filter((k) => k.startsWith('connections/')).length, 12);
  assert.ok(fake.counts.token >= 5, String(fake.counts.token));
  assert.equal(fake.counts.login, 1);
});

test('sign-in material never reaches an error: cookies, codes, verifiers, tokens and the login.do body', async () => {
  // The Integrator echoes the request headers in its error body.
  const fake = fakePlatform({
    version: '7.0.0-rc3',
    handle: ({ headers }) => ({ raw: true, status: 400, body: { message: 'bad', authorization: headers.Authorization, echo: `Authorization: ${headers.Authorization}` } }),
  });
  const c = client(fake);
  const err = await c.get('integrator', '/connections').catch((e) => e);
  assert.ok(err instanceof HttpError);
  const secrets = new Set();
  for (const call of fake.calls) {
    for (const m of String(call.headers.cookie ?? '').matchAll(/=([^;]+)/g)) secrets.add(m[1]);
    const u = new URL(call.url);
    for (const k of ['code', 'code_challenge']) if (u.searchParams.get(k)) secrets.add(u.searchParams.get(k));
    if (call.url.endsWith('/oauth2/token')) {
      const f = new URLSearchParams(call.body);
      secrets.add(f.get('code'));
      secrets.add(f.get('code_verifier'));
    }
    const bearer = /^Bearer (.+)$/.exec(call.headers.Authorization ?? '')?.[1];
    if (bearer) secrets.add(bearer);
  }
  assert.ok(secrets.size >= 6, String(secrets.size));
  const text = `${err.message}\n${err.body}\n${err.stack}`;
  for (const s of secrets) assert.equal(text.includes(s), false, `leaked ${s.slice(0, 6)}…`);
});

test('redact masks cookies, OAuth codes and verifiers, and JSESSIONID values in JSON', () => {
  const out = redact([
    'cookie: JSESSIONID=sid-1; XSRF-TOKEN=x1; AWSALB=lb1',
    'Set-Cookie: JSESSIONID=sid-2; Path=/; HttpOnly',
    'Location: https://s.example.com/app/oauth/callback?code=code-1&state=st1',
    'grant_type=authorization_code&code=code-2&redirect_uri=https%3A%2F%2Fs&client_id=system&code_verifier=ver-1',
    '{"JSESSIONID":"sid-3","username":"u","XSRF-TOKEN":"x2"}',
    'JSESSIONID=sid-4 AWSALBCORS=lb2 access_token=tok-1',
  ].join('\n'));
  for (const s of ['sid-1', 'x1', 'lb1', 'sid-2', 'code-1', 'st1', 'code-2', 'ver-1', 'sid-3', 'x2', 'sid-4', 'lb2', 'tok-1']) {
    assert.equal(out.includes(s), false, `${s} in ${out}`);
  }
  assert.match(out, /"username":"u"/);
  assert.match(out, /client_id=system/);
});
