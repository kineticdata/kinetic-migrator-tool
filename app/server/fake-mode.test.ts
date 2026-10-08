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

test('fake Dev and Test: Task categories compare, are suggested for a handler, promote with their members and are removed', async (t) => {
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
    await job('POST', `${P}/snapshots`, { env });
  }
  const NOTIFY = 'task-categories/Notifications';
  const HANDLER = 'handlers/mail_send_v1/handler';
  const ROUTINE = 'routines/Notify Requester';

  const cmp = await job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' });
  const root = (await call('GET', `${P}/compare/${cmp.compareId}/tree`)).json as Array<{ id: string; label: string }>;
  const group = root.find((n) => n.id === 'group:task-categories');
  assert.equal(group?.label, 'Task categories');
  const kids = (await call('GET', `${P}/compare/${cmp.compareId}/tree?parent=group:task-categories`)).json as Array<{ key: string; status: string; kind: string }>;
  assert.deepEqual(kids.map((k) => [k.key, k.status, k.kind]), [
    ['task-categories/Legacy Tools', 'only-target', 'task-category'],
    [NOTIFY, 'changed', 'task-category'],
    ['task-categories/System Controls', 'manual', 'task-category'],
  ], 'only Stored categories; Dev\'s Stored System Controls shares its name with the built-in one, so it is set by hand');
  const item = (await call('GET', `${P}/compare/${cmp.compareId}/item?key=${encodeURIComponent(NOTIFY)}`)).json;
  // Members as whole lists; Test's own member is kept (and removable).
  assert.deepEqual(item.diff, [
    { path: 'description', from: 'Email', to: 'Email and alerts' },
    { path: 'handlers', from: ['utilities_echo_v1'], to: ['mail_send_v1', 'utilities_echo_v1'] },
    { path: 'routines', from: [], to: ['routine_notify_requester_v1'] },
  ]);
  assert.deepEqual(item.current.handlers, ['utilities_echo_v1']);
  assert.deepEqual(item.targetOnlyEntries, [{ key: `${NOTIFY}#handlers/utilities_echo_v1`, collection: 'handlers', name: 'utilities_echo_v1', word: 'handler' }]);

  const sug = (await call('POST', `${P}/compare/${cmp.compareId}/suggestions`, { selected: [HANDLER] })).json as Array<{ key: string; reason: string }>;
  const forCategory = sug.find((s) => s.key === NOTIFY);
  assert.match(forCategory?.reason ?? '', /Mail Send belongs to Task category "Notifications", so Mail Send appears in the workflow builder/);

  // The category alone: its handler and routine are not in Test, so they are
  // left out with a warning (not an error). The routine alone: in no category.
  const alone = await job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: [NOTIFY] });
  assert.deepEqual(alone.errors, []);
  assert.ok(alone.warnings.includes(`${NOTIFY}: mail_send_v1 is not in test; promote it to add it to the category`), JSON.stringify(alone.warnings));
  const routineOnly = await job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: [ROUTINE] });
  assert.ok(routineOnly.warnings.some((w: string) => w.startsWith(`${ROUTINE}: will be in no Task category in test`)), JSON.stringify(routineOnly.warnings));

  const selected = [HANDLER, ROUTINE, NOTIFY];
  const remove = ['task-categories/Legacy Tools', `${NOTIFY}#handlers/utilities_echo_v1`];
  const plan = async () => job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected, remove });
  const p = await plan();
  assert.deepEqual(p.errors, []);
  const notify = p.items.find((i: { key: string }) => i.key === NOTIFY);
  assert.equal(notify.action, 'update');
  assert.deepEqual(p.removals.map((r: { key: string; label: string; action: string }) => [r.key, r.label, r.action]), [
    ['task-categories/Legacy Tools', 'Legacy Tools', 'delete'],
    [`${NOTIFY}#handlers/utilities_echo_v1`, 'utilities_echo_v1 (handler of Notifications)', 'delete'],
  ]);
  const values: Record<string, Record<string, unknown>> = {};
  for (const v of p.environmentValues) (values[v.key] ??= {})[v.path] = v.to ?? v.from ?? 'x';
  const started = await call('POST', `${P}/plans/${p.planId}/apply`, {
    acknowledgements: p.needsAttention.map((n: { id: string }) => n.id), values, confirm: 'test',
  });
  assert.equal(started.status, 202, started.body);
  await server.jobs.wait(started.json.jobId);
  const applied = (await call('GET', `/api/jobs/${started.json.jobId}`)).json.result;
  assert.equal(applied.status, 'applied', JSON.stringify(applied));

  // Test now holds the category with Dev's members and nothing else.
  const env = { name: 'test', url: 'https://test.example.com', readOnly: false, username: 'a', password: 'b', vars: {} };
  const listed = await fake.clientFactory({ env, mode: 'read' }).get('task', '/categories', { include: 'details,handlers,trees' }) as { categories: Array<{ name: string; type: string; description: string; handlers: Array<{ definitionId: string }>; trees: Array<{ definitionId: string }> }> };
  assert.deepEqual(listed.categories.map((c) => [c.name, c.type, c.description, c.handlers.map((h) => h.definitionId), c.trees.map((r) => r.definitionId)]), [
    ['Notifications', 'Stored', 'Email and alerts', ['mail_send_v1'], ['routine_notify_requester_v1']],
    ['System Controls', 'Integrated', '', ['system_join_v1', 'system_junction_v1'], []],
  ]);

  const again = await plan();
  assert.equal(again.items.find((i: { key: string }) => i.key === NOTIFY).action, 'unchanged');
  assert.deepEqual(again.removals.map((r: { action: string }) => r.action), ['gone', 'gone']);
  assert.ok(!again.warnings.some((w: string) => /Task categor|workflow builder/.test(w)), JSON.stringify(again.warnings));
});
