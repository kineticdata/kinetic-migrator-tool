// Fake mode (KINETIC_MIGRATE_FAKE=1): off unless the variable is set; when on,
// the server talks to synthetic in-memory Dev and Test spaces whose writes
// stick, so a full snapshot → compare → plan → apply → re-plan round trip works
// without a live server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMode } from './fake-mode.ts';
import { MemoryStore } from './secrets.ts';
import { startServer } from './main.ts';
import { startTestServer } from './test-helpers.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const P = '/api/projects/demo';
const FORM = 'kapps/services/forms/it-request/form';

test('fake mode is off unless KINETIC_MIGRATE_FAKE=1', () => {
  assert.equal(fakeMode({}), undefined);
  assert.equal(fakeMode({ KINETIC_MIGRATE_FAKE: '0' }), undefined);
  assert.equal(fakeMode({ KINETIC_MIGRATE_FAKE: 'true' }), undefined);
  const on = fakeMode({ KINETIC_MIGRATE_FAKE: '1' });
  assert.ok(on);
  assert.ok(on.secrets instanceof MemoryStore);
  assert.equal(typeof on.clientFactory, 'function');
});

test('startServer turns fake mode on from the environment and says so', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'km-fake-'));
  const saved = process.env.KINETIC_MIGRATE_FAKE;
  process.env.KINETIC_MIGRATE_FAKE = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.KINETIC_MIGRATE_FAKE; else process.env.KINETIC_MIGRATE_FAKE = saved;
    rmSync(workspace, { recursive: true, force: true });
  });
  const on = await startServer({ workspace });
  await on.close();
  assert.equal(on.fake, true);
  delete process.env.KINETIC_MIGRATE_FAKE;
  const off = await startServer({ workspace, secrets: new MemoryStore() });
  await off.close();
  assert.equal(off.fake, false);
});

test('a fake read-only environment refuses a write client', () => {
  const { clientFactory } = fakeMode({ KINETIC_MIGRATE_FAKE: '1' })!;
  const env = { name: 'test', url: 'https://test.example.com', readOnly: true, username: 'a', password: 'b', vars: {} };
  assert.throws(() => clientFactory({ env, mode: 'write' }), /read-only/i);
  assert.equal(clientFactory({ env, mode: 'read' }).mode, 'read');
});

test('fake Dev and Test: differences, a suggestion, an apply that sticks, a re-plan with nothing to do', async (t) => {
  const fake = fakeMode({ KINETIC_MIGRATE_FAKE: '1' })!;
  const server = await startTestServer({ ...fake });
  t.after(() => server.cleanup());
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await server.api(pathname, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
  };
  const job = async (method: string, pathname: string, body?: unknown) => {
    const started = await call(method, pathname, body);
    assert.equal(started.status, 202, started.body);
    await server.jobs.wait(started.json.jobId);
    const info = (await call('GET', `/api/jobs/${started.json.jobId}`)).json;
    assert.equal(info.status, 'succeeded', JSON.stringify(info.error));
    return info.result;
  };

  assert.equal((await call('POST', '/api/projects', { name: 'Demo' })).status, 201);
  let position = 0;
  for (const env of ['dev', 'test']) {
    await call('PUT', `${P}/environments/${env}`, { url: `https://${env}.example.com`, readOnly: env === 'dev', position: position++ });
    await call('PUT', `${P}/environments/${env}/credentials`, { username: 'admin', password: 'any' });
    assert.equal((await call('POST', `${P}/environments/${env}/test`)).json.ok, true);
    await job('POST', `${P}/snapshots`, { env });
  }

  const cmp = await job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' });
  assert.ok(cmp.counts.new > 0 && cmp.counts.changed > 0, JSON.stringify(cmp.counts));
  const root = (await call('GET', `${P}/compare/${cmp.compareId}/tree`)).body;
  for (const label of ['Kapps', 'Connections', 'Handlers', 'Teams']) assert.match(root, new RegExp(label, 'i'), `differences under ${label}: ${root}`);
  const sug = (await call('POST', `${P}/compare/${cmp.compareId}/suggestions`, { selected: [FORM] })).json;
  const keys = sug.map((s: { key: string }) => s.key);
  assert.ok(keys.includes('connections/Ticketing/connection'), JSON.stringify(keys));

  // Also a new and a changed workflow, a changed team and the new handler.
  const selected = [FORM, ...keys, 'handlers/mail_send_v1/handler', 'teams/Operations',
    'kapps/services/forms/leave/workflows/Submission Submitted/Manager Approval',
    'kapps/services/forms/it-request/workflows/Submission Submitted/Create Ticket'];
  // The Create Ticket workflow runs a routine Test does not have: suggested, and needed.
  const wfSug = (await call('POST', `${P}/compare/${cmp.compareId}/suggestions`, { selected })).json;
  assert.ok(wfSug.some((s: { key: string; reason: string }) => s.key === 'routines/Notify Requester' && /runs routine "Notify Requester"/.test(s.reason)), JSON.stringify(wfSug));
  const missing = await job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected });
  assert.ok(missing.errors.some((e: string) => e.includes('routines/Notify Requester')), JSON.stringify(missing.errors));
  selected.push('routines/Notify Requester');
  const remove = ['teams/Contractors'];
  const plan = async () => job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected, remove });
  const p = await plan();
  assert.deepEqual(p.errors, []);
  assert.equal(p.counts.delete, 1);
  assert.ok(p.counts.create >= 4 && p.counts.update >= 3, JSON.stringify(p.items.map((i: { key: string; action: string }) => [i.key, i.action])));
  const values: Record<string, Record<string, unknown>> = {};
  for (const v of p.environmentValues) (values[v.key] ??= {})[v.path] = v.to ?? v.from ?? 'x';
  const started = await call('POST', `${P}/plans/${p.planId}/apply`, {
    acknowledgements: p.needsAttention.map((n: { id: string }) => n.id), values, confirm: 'test',
  });
  assert.equal(started.status, 202, started.body);
  await server.jobs.wait(started.json.jobId);
  const applied = (await call('GET', `/api/jobs/${started.json.jobId}`)).json.result;
  assert.equal(applied.status, 'applied', JSON.stringify(applied));

  const again = await plan();
  assert.equal(again.counts.create + again.counts.update, 0, JSON.stringify(again.items.map((i: { key: string; action: string }) => [i.key, i.action])));
  assert.deepEqual(again.removals.map((r: { key: string; action: string }) => [r.key, r.action]), [['teams/Contractors', 'gone']]);
  assert.equal(again.counts.delete, 0);
  const routine = again.items.find((i: { key: string }) => i.key === 'routines/Notify Requester');
  assert.equal(routine.action, 'unchanged', 'the routine was created with its tree, inputs and outputs');
});
