import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, parseTokenFromLocation, redact, ReadOnlyError, HttpError, IntegratorAuthUnavailable, implicitGrant, retryWait } from './http.mjs';

// The implicit grant alone (6.x), as the version-independent tests below need.
const implicitOnly = [implicitGrant];
import { describePlatformError, describeFailureMessage, emptyRequiredNames, platformErrorDetail } from './http.mjs';

const env = { name: 'dev', url: 'https://your-space.kinops.io', readOnly: false, username: 'u', password: 'p' };

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), ...init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected request ${url}`);
    const bodyStr = r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body));
    return new Response(bodyStr, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};

test('parseTokenFromLocation reads the fragment', () => {
  assert.deepEqual(
    parseTokenFromLocation('https://x/app#access_token=abc&expires_in=600&token_type=bearer'),
    { token: 'abc', expiresIn: 600 },
  );
  assert.throws(() => parseTokenFromLocation('https://x/app?error=denied'), /access_token/);
});

test('redact hides auth headers and secret-looking JSON values', () => {
  const out = redact('Authorization: Basic dXNlcjpwYXNz {"password":"hunter2","name":"ok"} Bearer eyJ.abc');
  assert.doesNotMatch(out, /dXNlcjpwYXNz|hunter2|eyJ\.abc/);
  assert.match(out, /"name":"ok"/);
});

test('redact handles escaped quotes in password and case-insensitive auth', () => {
  const out = redact('{"password":"ab\\"cd"} bearer xyz123');
  assert.doesNotMatch(out, /ab|cd|xyz123/);
});

test('redact uses the shared secret-name rule (spaces and hyphens too) and masks name/value secret properties', () => {
  const out = redact('{"Private Key":"k1","x-api-key":"k2","tokenUrl":"https://ok","properties":[{"name":"API Key","type":"Plaintext","value":"k3"},{"name":"server","value":"smtp.ok"},{"value":"k4","name":"prod_private_key_b64"}]}');
  assert.doesNotMatch(out, /k1|k2|k3|k4/);
  assert.match(out, /https:\/\/ok/);
  assert.match(out, /smtp\.ok/);
});

test('redact handles secret keys with variants like client_secret, refresh_token', () => {
  const out = redact('{"client_secret":"s1","refresh_token":"t1","id_token":"t2","passwordConfirmation":"p1"}');
  assert.doesNotMatch(out, /s1|t1|t2|p1/);
});

test('core GET uses Basic auth, the v1 base and query params', async () => {
  const f = fakeFetch([{ body: { space: { name: 'S' } } }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await c.get('core', '/space', { export: 'true', skip: undefined }), { space: { name: 'S' } });
  assert.equal(f.calls[0].url, 'https://your-space.kinops.io/app/api/v1/space?export=true');
  assert.equal(f.calls[0].headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
});

test('read mode blocks every non-GET before any request is sent', async () => {
  const f = fakeFetch([]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(c.request('core', m, '/teams', { body: {} }), ReadOnlyError);
  }
  assert.equal(f.calls.length, 0);
});

test('a readOnly environment cannot get a write client', () => {
  assert.throws(() => createClient({ env: { ...env, readOnly: true }, mode: 'write' }), ReadOnlyError);
});

test('integrator calls fetch a token once via manual redirect, cache it, and refresh on 401', async () => {
  const loc = (t) => ({ status: 302, headers: { location: `https://x/#access_token=${t}&expires_in=43200` } });
  const f = fakeFetch([loc('t1'), { body: [] }, { body: [] }, { status: 401, body: {} }, loc('t2'), { body: [{ id: 'c' }] }]);
  const c = createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: f, sleep: noSleep });
  await c.get('integrator', '/connections');
  await c.get('integrator', '/connections');
  assert.deepEqual(await c.get('integrator', '/connections'), [{ id: 'c' }]);
  const authorize = f.calls.filter((x) => x.url.includes('/app/oauth/authorize'));
  assert.equal(authorize.length, 2);
  assert.equal(authorize[0].redirect, 'manual');
  assert.match(authorize[0].url, /grant_type=implicit&response_type=token&client_id=system/);
  assert.equal(f.calls[1].url, 'https://your-space.kinops.io/app/integrator/api/connections');
  assert.equal(f.calls[1].headers.Authorization, 'Bearer t1');
  assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer t2');
});

test('GET retries 5xx then succeeds; errors carry status and a redacted body', async () => {
  const f = fakeFetch([{ status: 502 }, { status: 503 }, { body: { ok: true } }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await c.get('core', '/kapps'), { ok: true });

  const g = fakeFetch([{ status: 400, body: { error: 'bad', password: 'secret1' } }]);
  const c2 = createClient({ env, mode: 'read', fetchImpl: g, sleep: noSleep });
  await assert.rejects(c2.get('core', '/kapps'), (e) => e instanceof HttpError && e.status === 400 && !e.body.includes('secret1'));
});

test('POST is never retried on 5xx (would duplicate creates) but is retried on 429', async () => {
  const f = fakeFetch([{ status: 500, body: {} }]);
  const c = createClient({ env, mode: 'write', fetchImpl: f, sleep: noSleep });
  await assert.rejects(c.request('core', 'POST', '/teams', { body: { name: 'T' } }), (e) => e.status === 500);
  assert.equal(f.calls.length, 1);

  const g = fakeFetch([{ status: 429 }, { body: { team: {} } }]);
  const c2 = createClient({ env, mode: 'write', fetchImpl: g, sleep: noSleep });
  await c2.request('core', 'POST', '/teams', { body: { name: 'T' } });
  assert.equal(g.calls.length, 2);
  assert.equal(g.calls[0].body, JSON.stringify({ name: 'T' }));
});

test('empty responses return null', async () => {
  const f = fakeFetch([{ status: 204 }]);
  const c = createClient({ env, mode: 'write', fetchImpl: f, sleep: noSleep });
  assert.equal(await c.request('core', 'DELETE', '/teams/x'), null);
});

test('2xx response with non-JSON body throws HttpError mentioning expected JSON', async () => {
  const f = fakeFetch([{ status: 200, raw: '<html>login</html>' }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  await assert.rejects(
    c.get('core', '/kapps'),
    (e) => e instanceof HttpError && e.status === 200 && e.body.includes('expected JSON'),
  );
});

test('error classes have correct .name properties', () => {
  assert.equal(new HttpError({ method: 'GET', url: '/test', status: 400, body: 'error' }).name, 'HttpError');
  assert.equal(new ReadOnlyError('blocked').name, 'ReadOnlyError');
});

test('getBinary returns the body as a Buffer and a 404 as an HttpError with status 404', async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
  const f = async (url, init) => {
    f.calls.push({ url: String(url), ...init });
    return String(url).endsWith('/gone/zip') ? new Response('not found', { status: 404 }) : new Response(bytes, { status: 200 });
  };
  f.calls = [];
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  const got = await c.getBinary('task', '/handlers/h_v1/zip');
  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual(got, bytes);
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].url, 'https://your-space.kinops.io/app/components/task/app/api/v2/handlers/h_v1/zip');
  assert.equal(f.calls[0].headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  await assert.rejects(c.getBinary('task', '/handlers/gone/zip'), (e) => e instanceof HttpError && e.status === 404);
});

test('getBinary retries 5xx like any GET', async () => {
  const f = fakeFetch([{ status: 502 }, { raw: 'zipbytes' }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  assert.equal((await c.getBinary('task', '/handlers/h/zip')).toString(), 'zipbytes');
  assert.equal(f.calls.length, 2);
});

test('multipart POST sends FormData without a JSON content type, is blocked in read mode and never retried on 5xx', async () => {
  const form = () => { const fd = new FormData(); fd.append('package', new Blob([Buffer.from('zip')]), 'package.zip'); return fd; };
  const f = fakeFetch([{ body: { handler: {} } }]);
  const c = createClient({ env, mode: 'write', fetchImpl: f, sleep: noSleep });
  await c.request('task', 'POST', '/handlers', { query: { force: 'true' }, form: form() });
  assert.ok(f.calls[0].body instanceof FormData);
  assert.equal(f.calls[0].body.get('package').size, 3);
  assert.equal('Content-Type' in f.calls[0].headers, false);
  assert.match(f.calls[0].url, /\/handlers\?force=true$/);

  const r = fakeFetch([]);
  await assert.rejects(createClient({ env, mode: 'read', fetchImpl: r, sleep: noSleep }).request('task', 'POST', '/handlers', { form: form() }), ReadOnlyError);
  assert.equal(r.calls.length, 0);

  const g = fakeFetch([{ status: 500, body: {} }]);
  await assert.rejects(createClient({ env, mode: 'write', fetchImpl: g, sleep: noSleep }).request('task', 'POST', '/handlers', { form: form() }), (e) => e.status === 500);
  assert.equal(g.calls.length, 1);
});

test('an Integrator sign-in the platform does not offer (404) is IntegratorAuthUnavailable, with the version, asked once per client', async () => {
  const f = fakeFetch([
    { status: 404, body: { error: 'No endpoint GET /your-space/app/oauth/authorize.' } },
    { body: { version: { version: '7.0.0-rc3', build: 'x' } } },
  ]);
  const c = createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: f, sleep: noSleep });
  const check = (e) => e instanceof IntegratorAuthUnavailable && e.name === 'IntegratorAuthUnavailable'
    && e.status === 404 && e.unsupported && e.version === '7.0.0-rc3'
    && e.message === "your-space.kinops.io runs Kinetic Platform 7.0.0-rc3, which doesn't offer the sign-in this tool uses for the Integrator yet.";
  await assert.rejects(c.get('integrator', '/connections'), check);
  await assert.rejects(c.get('integrator', '/connections'), check);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, 'https://your-space.kinops.io/app/integrator/api/version');
  assert.equal(f.calls[1].headers.Authorization, undefined);
});

for (const [label, response, pattern] of [
  ['401', { status: 401, body: {} }, /^The Integrator rejected the sign-in \(401\): check the username and password\.$/],
  ['403', { status: 403, body: {} }, /^The Integrator rejected the sign-in \(403\)/],
  ['405', { status: 405, body: {} }, /^The Integrator sign-in failed \(405\)/],
  ['a 200 login page', { status: 200, raw: '<html>login</html>' }, /failed \(200\)/],
  ['a 302 to a login page', { status: 302, headers: { location: 'https://x/app/login' } }, /did not return a token \(302, redirected without one\): check the username and password/],
]) {
  test(`an Integrator sign-in answered with ${label} fails loudly (IntegratorSignInFailed), is not cached, and asks no version`, async () => {
    const f = fakeFetch([response, response]);
    const c = createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: f, sleep: noSleep });
    const check = (e) => e.name === 'IntegratorSignInFailed' && !(e instanceof IntegratorAuthUnavailable) && pattern.test(e.message);
    await assert.rejects(c.get('integrator', '/connections'), check);
    await assert.rejects(c.get('integrator', '/connections'), check);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every((x) => x.url.includes('/app/oauth/authorize')));
  });
}

test('a network error during the sign-in propagates as it is', async () => {
  const c = createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: async () => { throw new TypeError('fetch failed'); }, sleep: noSleep });
  await assert.rejects(c.get('integrator', '/connections'), (e) => e instanceof TypeError);
});

test('sign-in strategies are tried in order: an unsupported one falls through to the next, which is kept', async () => {
  const tried = [];
  const first = async () => { tried.push('first'); return { unsupported: 404 }; };
  const second = async () => { tried.push('second'); return { token: 'tok', expiresIn: 1 }; };
  const f = fakeFetch([{ body: [] }, { body: [] }]);
  let t = 0;
  const c = createClient({ env, mode: 'read', integratorAuth: [first, second], fetchImpl: f, sleep: noSleep, now: () => (t += 10_000) });
  await c.get('integrator', '/connections');
  await c.get('integrator', '/connections');
  assert.deepEqual(tried, ['first', 'second', 'second']);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok');
});


const REFUSED = JSON.stringify({ message: 'Unable to save task handler', errors: ['a_id may not be empty', 'b_key may not be empty'] });

test('describePlatformError shows the platform message and errors of a refused write', () => {
  assert.equal(describePlatformError({ status: 400, method: 'PUT', body: REFUSED }),
    'The Kinetic Platform rejected the change (400): Unable to save task handler — a_id may not be empty; b_key may not be empty');
  assert.equal(describePlatformError({ status: 404, method: 'GET', body: '{"message":"Not found"}' }), 'The Kinetic Platform returned an error (404): Not found');
  assert.equal(describePlatformError({ status: 500, method: 'POST', body: '{"errors":["boom"]}' }), 'The Kinetic Platform returned an error (500): boom');
  for (const body of ['', 'busy', '<html>nope</html>', '[]', '{"message":42}', '{"other":"x"}', undefined]) {
    assert.equal(describePlatformError({ status: 503, method: 'PUT', body }), 'The Kinetic Platform returned an error (503).', String(body));
  }
});

test('describePlatformError redacts, strips control characters, caps each part and the list, and reads a cut-short body', () => {
  const body = JSON.stringify({ message: 'Bad\nrequest\u0007 with Bearer abc.def', errors: Array.from({ length: 12 }, (_, i) => `f${i} may not be empty`) });
  const text = describePlatformError({ status: 400, method: 'PUT', body });
  assert.match(text, /^The Kinetic Platform rejected the change \(400\): Bad request with Bearer \[REDACTED\] — f0 may not be empty; .*f7 may not be empty; and 4 more$/);
  assert.doesNotMatch(text, /abc\.def|\n|\u0007/);
  const long = describePlatformError({ status: 400, method: 'PUT', body: JSON.stringify({ message: 'x'.repeat(5000), errors: ['y'.repeat(5000)] }) });
  assert.ok(long.length < 700, String(long.length));
  // An HttpError message keeps only the first 500 characters of a body.
  const cut = REFUSED.slice(0, REFUSED.length - 20);
  assert.deepEqual(platformErrorDetail(cut), { message: 'Unable to save task handler', errors: ['a_id may not be empty'] });
  assert.deepEqual(platformErrorDetail('{"message":"Unable to save'), null);
  assert.deepEqual(platformErrorDetail(JSON.stringify({ message: 'm', errors: [{ password: 'x' }, 'ok'] })), { message: 'm', errors: ['ok'] });
});

test('describeFailureMessage reads an HttpError message; emptyRequiredNames only when every error is "may not be empty"', () => {
  assert.equal(describeFailureMessage(`PUT /app/components/task/app/api/v2/handlers/x failed with 400: ${REFUSED}`),
    'The Kinetic Platform rejected the change (400): Unable to save task handler — a_id may not be empty; b_key may not be empty');
  assert.equal(describeFailureMessage('PUT /x failed with 500: busy'), 'The Kinetic Platform returned an error (500).');
  assert.equal(describeFailureMessage('something else'), null);
  assert.deepEqual(emptyRequiredNames(REFUSED), ['a_id', 'b_key']);
  assert.equal(emptyRequiredNames(JSON.stringify({ errors: ['a may not be empty', 'b is invalid'] })), null);
  assert.equal(emptyRequiredNames('{"message":"x"}'), null);
  assert.equal(emptyRequiredNames('nope'), null);
});

test('an HttpError from a refused write carries the redacted body the description is built from', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, headers: new Map(), text: async () => JSON.stringify({ message: 'Unable to save', errors: ['password may not be empty'], password: 'hunter2' }) });
  const c = createClient({ env: { name: 'x', url: 'https://x.example.com', username: 'u', password: 'p' }, mode: 'write', fetchImpl });
  const e = await c.request('task', 'PUT', '/handlers/h', { body: {} }).catch((x) => x);
  assert.ok(e instanceof HttpError);
  const text = describePlatformError(e);
  assert.equal(text, 'The Kinetic Platform rejected the change (400): Unable to save — password may not be empty');
  assert.doesNotMatch(e.body + text, /hunter2/);
});

const loc = (t) => ({ status: 302, headers: { location: `https://x/#access_token=${t}&expires_in=43200` } });

test('a transient sign-in failure (5xx, 429, network) is tried again with backoff, then succeeds', async () => {
  const waits = [];
  const f = fakeFetch([{ status: 502 }, { status: 503 }, loc('t1'), { body: [] }]);
  const c = createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } });
  await c.get('integrator', '/connections');
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer t1');

  let n = 0;
  const flaky = async (url, init) => { if (n++ === 0) throw new TypeError('fetch failed'); return f2(url, init); };
  const f2 = fakeFetch([loc('t2'), { body: [] }]);
  await createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: flaky, sleep: noSleep }).get('integrator', '/connections');
  assert.equal(f2.calls.at(-1).headers.Authorization, 'Bearer t2');
});

test('a sign-in still failing after 3 attempts says so plainly; it is not cached', async () => {
  const f = fakeFetch(Array.from({ length: 6 }, () => ({ status: 503, body: {} })));
  const c = createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: f, sleep: noSleep });
  const check = (e) => e.name === 'IntegratorSignInFailed' && e.status === 503 && e.attempts === 3
    && e.message === 'The Integrator sign-in failed (503) after 3 attempts; try again later.';
  await assert.rejects(c.get('integrator', '/connections'), check);
  await assert.rejects(c.get('integrator', '/connections'), check);
  assert.equal(f.calls.length, 6);
});

test('Retry-After is honoured (seconds or a date) and capped at 10 s; refusals are never retried', async () => {
  const waits = [];
  const f = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 503, headers: { 'retry-after': '3600' } }, loc('t1'), { body: [] }]);
  await createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } }).get('integrator', '/connections');
  assert.deepEqual(waits, [2000, 10_000]);
  assert.equal(retryWait('Thu, 01 Jan 2026 00:00:05 GMT', 1, () => Date.parse('Thu, 01 Jan 2026 00:00:00 GMT')), 5000);
  assert.equal(retryWait('soon', 2), 1000);
  const r = fakeFetch([{ status: 401, body: {} }]);
  await assert.rejects(createClient({ env, mode: 'read', integratorAuth: implicitOnly, fetchImpl: r, sleep: noSleep }).get('integrator', '/connections'), /rejected the sign-in \(401\)/);
  assert.equal(r.calls.length, 1);
});
