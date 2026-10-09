// Platform versions: Test connection detects and remembers them (locally),
// project details show them, snapshot commits record them, and Compare and
// Plan warn when the two environments run different major versions. Against
// a 7.x space through the real client, no sign-in material (cookies, codes,
// verifiers, tokens, the login.do body) reaches the log file or a response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompareResult, PlanResult } from '../shared/sync-api.ts';
import type { ConnectionTestResult, ProjectDetail } from '../shared/api.ts';
import type { ClientFactory } from './engine.ts';
import { logDir, workspaceLogger } from './log.ts';
import { log, managedRepo } from './repo.ts';
// @ts-expect-error -- untyped engine module
import { fakePlatform } from '../../lib/sync/fake-platform.mjs';
// @ts-expect-error -- untyped engine module
import { createClient } from '../../lib/sync/http.mjs';
import { harness, PLANTED, testRoutes, V6, V7 } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';

test('Test connection detects the version, remembers it locally, and the project shows it', async (t) => {
  const h = await harness(t);
  h.platforms.set('test', V7);
  // (Core login fails in this fake: it has no /me; the version is read regardless.)
  const r = (await h.call('POST', `${P}/environments/test/test`)).json as ConnectionTestResult;
  assert.equal(r.platform?.version, '7.0.0-rc3');
  assert.equal(r.platform?.major, 7);
  const detail = (await h.call('GET', P)).json as ProjectDetail;
  assert.equal(detail.environments.find((e) => e.name === 'test')?.platform?.version, '7.0.0-rc3');
  assert.equal(detail.environments.find((e) => e.name === 'dev')?.platform, null);
  // Local state under plans/ (gitignored), never committed.
  const file = path.join(h.dir, 'plans', 'platforms.json');
  assert.ok(existsSync(file));
  assert.match(readFileSync(path.join(h.dir, '.gitignore'), 'utf8'), /^plans\/$/m);
  // An unknown version later keeps the last one known.
  h.platforms.delete('test');
  const again = (await h.call('POST', `${P}/environments/test/test`)).json as ConnectionTestResult;
  assert.equal(again.platform?.version, '7.0.0-rc3');
  // Removing the environment forgets it.
  assert.equal((await h.call('DELETE', `${P}/environments/test`)).status < 300, true);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /"test"/);
});

test('a snapshot commit records the platform version in a trailer', async (t) => {
  const h = await harness(t);
  h.platforms.set('dev', V6);
  const job = await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const head = (await log(managedRepo(h.dir), { limit: 1 }))[0];
  assert.match(head.message, /^Platform: 6\.1\.7$/m);
  assert.equal(((await h.call('GET', P)).json as ProjectDetail).environments.find((e) => e.name === 'dev')?.platform?.version, '6.1.7');
});

test('Compare and Plan warn when the environments run different major versions; not when they match', async (t) => {
  const h = await harness(t);
  h.platforms.set('dev', V6);
  h.platforms.set('test', V7);
  assert.equal((await h.job('POST', `${P}/snapshots`, { env: 'dev' })).status, 'succeeded');
  const warning = 'Dev runs 6.1.7 and Test runs 7.0.0-rc3 — review differences carefully.';
  const cmp = await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' });
  assert.equal(cmp.status, 'succeeded', JSON.stringify(cmp.error));
  assert.equal((cmp.result as CompareResult).crossVersion, warning);
  const plan = await h.job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: ['space'] });
  assert.equal(plan.status, 'succeeded', JSON.stringify(plan.error));
  assert.equal((plan.result as PlanResult).crossVersion, warning);
  // Cross-major promotion is allowed: the warning blocks nothing.
  assert.equal((plan.result as PlanResult).errors.length, 0, JSON.stringify((plan.result as PlanResult).errors));

  h.platforms.set('test', { ...V6, version: '6.2.0', minor: 2 });
  const same = await h.job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: ['space'] });
  assert.equal((same.result as PlanResult).crossVersion, undefined);
});

// ---- Redaction against 7.x through the real client --------------------------

const routeTable = (table: Record<string, unknown>) => ({ api, method, path: p }: { api: string; method: string; path: string }) => {
  const hit = table[`${method} ${api}${p}`];
  return hit === undefined ? undefined : structuredClone(hit);
};

test('7.x sign-in material never reaches the log file, job events or API responses', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'km-v7-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  let failIntegrator = false;
  const fakes: Record<string, ReturnType<typeof fakePlatform>> = {};
  for (const name of ['dev', 'test', 'prod']) {
    const table = { ...testRoutes(), 'GET integrator/connections': [] };
    const fake = fakePlatform({
      version: '7.0.0-rc3', url: `https://${name}.example.com`, username: 'admin', password: PLANTED,
      handle: (req: { api: string; method: string; path: string; headers: Record<string, string> }) => {
        if (req.api === 'integrator' && failIntegrator) {
          // A misbehaving server echoing every piece of sign-in material, labelled.
          // Newest first and terse, so all of it fits in the part of a body
          // an error message keeps (500 characters).
          const signIn = fake.calls.filter((c: { url: string }) => /oauth2|login\.do/.test(c.url)).slice(-3).reverse();
          const seen = [`Authorization: ${req.headers.Authorization ?? ''}`, ...signIn.map((c: { url: string; headers: Record<string, string>; body?: unknown }) => [
            c.url.includes('?') ? `?${c.url.split('?')[1]}` : '', c.headers.cookie ? `cookie: ${c.headers.cookie}` : '',
            typeof c.body === 'string' && !c.body.startsWith('{') ? ` ${c.body}` : '',
          ].filter(Boolean).join(' '))].join(' ');
          return { raw: true, status: 500, body: { message: 'Internal error', trace: seen, session: { JSESSIONID: [...sessionIds(fake)][0] ?? '' } } };
        }
        return routeTable(table)(req);
      },
    });
    fakes[name] = fake;
  }
  const clientFactory: ClientFactory = ({ env, mode }) => createClient({ env, mode, fetchImpl: fakes[env.name].fetch, sleep: async () => {} });
  const logger = workspaceLogger(workspace, { stderr: () => {} });
  const h = await harness(t, undefined, { workspace, logger, clientFactory });

  const ok = (await h.call('POST', `${P}/environments/test/test`)).json as ConnectionTestResult;
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.platform?.version, '7.0.0-rc3');
  const snap = await h.job('POST', `${P}/snapshots`, { env: 'test' });
  assert.equal(snap.status, 'succeeded', JSON.stringify(snap.error));
  failIntegrator = true;
  const failed = await h.job('POST', `${P}/snapshots`, { env: 'test' });
  assert.equal(failed.status, 'failed');
  const tested = (await h.call('POST', `${P}/environments/test/test`)).json as ConnectionTestResult;
  assert.equal(tested.ok, false);

  // Everything sign-in related the fake saw.
  const material = new Set<string>();
  for (const c of fakes.test.calls as Array<{ url: string; headers: Record<string, string>; body?: unknown }>) {
    for (const m of String(c.headers.cookie ?? '').matchAll(/=([^;]+)/g)) material.add(m[1]);
    const u = new URL(c.url);
    for (const k of ['code', 'code_challenge']) if (u.searchParams.get(k)) material.add(u.searchParams.get(k)!);
    if (u.pathname === '/app/oauth2/token') {
      const f = new URLSearchParams(String(c.body));
      material.add(f.get('code')!);
      material.add(f.get('code_verifier')!);
    }
    const bearer = /^Bearer (.+)$/.exec(c.headers.Authorization ?? '')?.[1];
    if (bearer) material.add(bearer);
  }
  for (const s of sessionIds(fakes.test)) material.add(s);
  assert.ok(material.size >= 8, String(material.size));

  const logs = readdirSync(logDir(workspace)).map((f) => readFileSync(path.join(logDir(workspace), f), 'utf8')).join('\n');
  assert.match(logs, /failed with 500/);
  // The echo reached the log (redacted), so the checks below mean something.
  assert.match(logs, /code=\[REDACTED\]/);
  assert.match(logs, /cookie: \[REDACTED\]/);
  const texts = [logs, ...h.bodies, JSON.stringify(failed), JSON.stringify(tested)];
  for (const s of material) {
    for (const text of texts) assert.equal(text.includes(s), false, `leaked ${s.slice(0, 8)}… in ${text.slice(Math.max(0, text.indexOf(s) - 80), text.indexOf(s) + 20)}`);
  }
  assert.equal(texts.some((x) => x.includes(PLANTED)), false);
});

// Session ids the fake issued (from its login.do answers' cookies).
function sessionIds(fake: { calls: Array<{ url: string; headers: Record<string, string> }> }): Set<string> {
  const out = new Set<string>();
  for (const c of fake.calls) for (const m of String(c.headers.cookie ?? '').matchAll(/JSESSIONID=([^;]+)/g)) out.add(m[1]);
  return out;
}
