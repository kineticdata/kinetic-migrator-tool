// Settings → Repository: commit author, remote URL and a write-only token,
// and pushing as a job with the last push status. Every response is checked
// for the planted token, which may reach only the remote itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RepositorySettings } from '../shared/repository-api.ts';
import { log } from './repo.ts';
import { MemoryStore } from './secrets.ts';
import { startTestServer, type RawResponse } from './test-helpers.ts';

const TOKEN = 'Planted-Git-Token-v8Wn41';
const P = '/api/projects/repo-test';

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const store = new MemoryStore();
  const server = await startTestServer({ secrets: store, logger: { error: () => {} } });
  t.after(() => server.cleanup());
  const bodies: string[] = [];
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res: RawResponse = await server.api(pathname, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    bodies.push(res.body);
    let json: any;
    try { json = res.body ? JSON.parse(res.body) : undefined; } catch { json = undefined; }
    return { ...res, json };
  };
  const created = await call('POST', '/api/projects', { name: 'Repo Test' });
  assert.equal(created.status, 201, created.body);
  const job = async (pathname: string) => {
    const started = await call('POST', pathname, {});
    assert.equal(started.status, 202, started.body);
    await server.jobs.wait(started.json.jobId);
    const info = (await call('GET', `/api/jobs/${started.json.jobId}`)).json;
    bodies.push((await call('GET', `/api/jobs/${started.json.jobId}/events`)).body);
    return info;
  };
  const noToken = () => {
    for (const b of bodies) assert.ok(!b.includes(TOKEN), `a response leaked the token: ${b}`);
  };
  return { server, store, call, job, bodies, noToken, dir: created.json.path as string };
}

// A remote that demands auth: 401 without credentials, 403 with them. It
// records every Authorization header it receives.
async function fakeRemote(t: { after: (fn: () => Promise<void> | void) => void }) {
  const auths: string[] = [];
  const server = http.createServer((req, res) => {
    const a = req.headers.authorization;
    if (!a) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
      res.end('auth required');
      return;
    }
    auths.push(a);
    res.writeHead(403);
    res.end(`denied for ${a}`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/team/project.git`, auths };
}

test('repository settings: author, remote and a write-only token', async (t) => {
  const h = await setup(t);
  const empty = (await h.call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.deepEqual(empty, {
    author: { name: 'kinetic-migrate', email: 'kinetic-migrate@localhost' },
    remote: { url: null, token: { has: false } },
    lastPush: null,
  });

  const put = await h.call('PUT', `${P}/repository`, {
    author: { name: 'Pat Example', email: 'pat@example.com' }, remoteUrl: 'https://git.example.com/team/project.git', token: TOKEN,
  });
  assert.equal(put.status, 200, put.body);
  assert.deepEqual(put.json, {
    author: { name: 'Pat Example', email: 'pat@example.com' },
    remote: { url: 'https://git.example.com/team/project.git', token: { has: true } },
    lastPush: null,
  });
  assert.deepEqual((await h.call('GET', `${P}/repository`)).json, put.json);

  // The author is committed with the project and used for later commits.
  const [latest] = await log(h.dir, { limit: 1 });
  assert.equal(latest.message, 'Updated repository settings');
  assert.deepEqual(latest.author, { name: 'Pat Example', email: 'pat@example.com' });
  const meta = readFileSync(path.join(h.dir, 'kinetic-migrate.json'), 'utf8');
  assert.match(meta, /Pat Example/);

  // The token never lands in project files or git config.
  assert.ok(!readFileSync(path.join(h.dir, '.git', 'config'), 'utf8').includes(TOKEN));
  assert.ok(!meta.includes(TOKEN));
  const stored = [...(h.store as any).values.entries()] as Array<[string, string]>;
  assert.ok(stored.some(([account, v]) => /\/_project\/git\/token$/.test(account) && v === TOKEN));

  // Leaving the token out keeps it; null clears it.
  const kept = (await h.call('PUT', `${P}/repository`, { remoteUrl: 'https://git.example.com/team/other.git' })).json as RepositorySettings;
  assert.deepEqual(kept.remote, { url: 'https://git.example.com/team/other.git', token: { has: true } });
  const cleared = (await h.call('PUT', `${P}/repository`, { token: null })).json as RepositorySettings;
  assert.equal(cleared.remote.token.has, false);
  await h.call('PUT', `${P}/repository`, { token: TOKEN });
  // Disconnecting the remote forgets its token too.
  const gone = (await h.call('PUT', `${P}/repository`, { remoteUrl: null })).json as RepositorySettings;
  assert.deepEqual(gone.remote, { url: null, token: { has: false } });

  // Validation, without echoing what was sent.
  const withCreds = await h.call('PUT', `${P}/repository`, { remoteUrl: `https://user:${TOKEN}@git.example.com/x.git` });
  assert.equal(withCreds.status, 400);
  assert.equal(withCreds.json.error.code, 'bad_request');
  for (const bad of [{ remoteUrl: 'ftp://git.example.com/x.git' }, { remoteUrl: 'not a url' }, { author: { name: '', email: 'a@example.com' } },
    { author: { name: 'Pat', email: 'nope' } }, { token: 42 }, { token: 'two\nlines' }, []]) {
    assert.equal((await h.call('PUT', `${P}/repository`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await h.call('GET', '/api/projects/nope/repository')).status, 404);
  h.noToken();
});

test('a remote set outside the app is shown without credentials in its URL', async (t) => {
  const h = await setup(t);
  const { setRemote } = await import('./repo.ts');
  await setRemote(h.dir, `https://someone:${TOKEN}@git.example.com/team/project.git`);
  const got = (await h.call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.equal(got.remote.url, 'https://git.example.com/team/project.git');
  h.noToken();
});

test('push: a job that sends the token only to the remote and records the last push', async (t) => {
  const h = await setup(t);
  // No remote yet.
  const none = await h.call('POST', `${P}/repository/push`, {});
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, 'no_remote');

  const remote = await fakeRemote(t);
  await h.call('PUT', `${P}/repository`, { remoteUrl: remote.url });
  // Without a token the remote's 401 becomes a plain message.
  const anon = await h.job(`${P}/repository/push`);
  assert.equal(anon.status, 'failed');
  assert.match(anon.error.message, /needs a token/i);

  await h.call('PUT', `${P}/repository`, { token: TOKEN });
  const denied = await h.job(`${P}/repository/push`);
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error.code, 'push_failed');
  assert.match(denied.error.message, /refused/i);
  // The token went to the remote, as basic auth.
  assert.ok(remote.auths.length >= 1);
  assert.ok(remote.auths.every((a) => Buffer.from(a.replace(/^Basic /, ''), 'base64').toString('utf8').startsWith(`${TOKEN}:`)));

  const settings = (await h.call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.equal(settings.lastPush?.ok, false);
  assert.match(settings.lastPush?.message ?? '', /refused/i);
  assert.ok(settings.lastPush?.at);
  h.noToken();
});

test('push succeeds: last push records the commit pushed', async (t) => {
  const h = await setup(t);
  const { setPushImplementation } = await import('./repository.ts');
  const seen: string[] = [];
  const restore = setPushImplementation(async (dir, opts) => {
    seen.push(String(await opts.store.get(opts.account)));
  });
  t.after(restore);
  await h.call('PUT', `${P}/repository`, { remoteUrl: 'https://git.example.com/team/project.git', token: TOKEN });
  const ok = await h.job(`${P}/repository/push`);
  assert.equal(ok.status, 'succeeded', JSON.stringify(ok.error));
  assert.deepEqual(seen, [TOKEN]);
  const [head] = await log(h.dir, { limit: 1 });
  assert.deepEqual(ok.result, { ok: true, commit: head.oid, at: ok.result.at, message: null });
  const settings = (await h.call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.deepEqual(settings.lastPush, ok.result);
  h.noToken();
});
