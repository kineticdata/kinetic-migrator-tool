import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient, fakeTaskCategories, TEST_CONFIG } from '../fake-client.mjs';
import { writeTree } from '../store.mjs';
import { buildPlan, preflightChecks } from '../plan.mjs';
import { runApply, computePlan } from '../commands.mjs';
import { buildRelationships, suggest } from '../relationships.mjs';
import { MODULES, APPLY_ORDER, moduleFor } from './index.mjs';
import { isEntryKey, parseEntryKey } from '../entries.mjs';
import categories, { normalizeCategory } from './task-categories.mjs';

const writes = (c) => c.calls.filter((x) => x.method !== 'GET').map((x) => ({ method: x.method, path: x.path, body: x.body }));
const KEY = 'task-categories/Notifications';
const cat = (extra = {}) => ({ name: 'Notifications', description: 'Email', handlers: [], routines: [], policyRules: [], ...extra });
const seed = (name, type, handlers = [], trees = [], extra = {}) => ({
  name, type, description: `${name} (${type})`, handlers: handlers.map((definitionId) => ({ definitionId })),
  trees: trees.map(([definitionId, title]) => ({ definitionId, name: title, title })), policyRules: [], ...extra,
});

test('only Stored categories are listed (a built-in Integrated one of the same name is not); routines are named by definitionId', async () => {
  const store = fakeTaskCategories([
    seed('System Controls', 'Integrated', ['system_join_v1']),
    seed('System Controls', 'Stored', ['utilities_echo_v1', 'mail_send_v1'], [['routine_b_v1', 'B'], ['routine_a_v1', 'A']], { policyRules: [{ name: 'Admins' }] }),
  ]);
  const c = fakeClient({}, { fallback: store.handle });
  const list = await categories.list(c, { collected: [] });
  assert.deepEqual(list.map((a) => [a.key, a.data]), [['task-categories/System Controls', {
    name: 'System Controls', description: 'System Controls (Stored)', handlers: ['mail_send_v1', 'utilities_echo_v1'],
    routines: ['routine_a_v1', 'routine_b_v1'], policyRules: ['Admins'],
  }]]);
  assert.deepEqual(c.calls[0].query, { include: 'details,handlers,trees' });
});

test('routines listed without a definitionId are matched by title or name to the routines collected, else to the routines list', async () => {
  const store = fakeTaskCategories([seed('Tools', 'Stored', [], [['routine_a_v1', 'A'], ['routine_x_v1', 'X']])], { treeDefinitionIds: false });
  const collected = [{ key: 'routines/A', data: { name: 'A', definitionId: 'routine_a_v1' }, meta: { title: 'A' } }];
  const c = fakeClient({ 'GET task/trees': { trees: [{ name: 'X', title: 'X', type: 'Global Routine', definitionId: 'routine_x_v1' }] } }, { fallback: store.handle });
  const [item] = await categories.list(c, { collected });
  assert.deepEqual(item.data.routines, ['routine_a_v1', 'routine_x_v1']);
  // All found among those collected: no extra routines read.
  const c2 = fakeClient({}, { fallback: fakeTaskCategories([seed('Tools', 'Stored', [], [['routine_a_v1', 'A']])], { treeDefinitionIds: false }).handle });
  assert.deepEqual((await categories.list(c2, { collected }))[0].data.routines, ['routine_a_v1']);
  assert.ok(!c2.calls.some((x) => x.path === '/trees'));
});

test('a Task API without the categories endpoint lists none', async () => {
  assert.deepEqual(await categories.list(fakeClient({}), { collected: [] }), []);
});

test('a new category is created as Stored with name and description only, then each member is added with its own POST', async () => {
  const store = fakeTaskCategories([]);
  const c = fakeClient({}, { fallback: store.handle });
  await categories.apply(c, { key: KEY, desired: cat({ handlers: ['mail_send_v1'], routines: ['routine_notify_v1'] }), existing: null });
  assert.deepEqual(writes(c), [
    { method: 'POST', path: '/categories', body: { name: 'Notifications', description: 'Email', type: 'Stored' } },
    { method: 'POST', path: '/categories/Notifications/handlers', body: { definitionId: 'mail_send_v1' } },
    { method: 'POST', path: '/categories/Notifications/routines', body: { definitionId: 'routine_notify_v1' } },
  ]);
  assert.deepEqual(store.categories[0].trees.map((t) => t.definitionId), ['routine_notify_v1']);
  assert.deepEqual(store.categories[0].handlers.map((h) => h.definitionId), ['mail_send_v1']);
});

test('a description change is a PUT of name and description only (member lists in a PUT clear or break members); new members are POSTed', async () => {
  const store = fakeTaskCategories([seed('Notifications', 'Stored', ['mail_send_v1'], [['routine_notify_v1', 'Notify']])]);
  const c = fakeClient({}, { fallback: store.handle });
  const existing = { key: KEY, data: cat({ handlers: ['mail_send_v1'], routines: ['routine_notify_v1'] }), meta: { name: 'Notifications' } };
  await categories.apply(c, { key: KEY, desired: cat({ description: 'Email and alerts', handlers: ['mail_send_v1', 'sms_send_v1'], routines: ['routine_notify_v1'] }), existing });
  assert.deepEqual(writes(c), [
    { method: 'PUT', path: '/categories/Notifications', body: { name: 'Notifications', description: 'Email and alerts' } },
    { method: 'POST', path: '/categories/Notifications/handlers', body: { definitionId: 'sms_send_v1' } },
  ]);
  for (const w of writes(c).filter((x) => x.method === 'PUT')) {
    for (const f of ['handlers', 'trees', 'routines', 'policyRules']) assert.ok(!(f in w.body), `a PUT never sends ${f}`);
  }
  // The routine survived the PUT (a `trees` list would have cleared it).
  assert.deepEqual(store.categories[0].trees.map((t) => t.definitionId), ['routine_notify_v1']);
  assert.equal(store.categories[0].description, 'Email and alerts');
  const same = { ...existing, data: { ...existing.data, description: 'Email and alerts', handlers: ['mail_send_v1', 'sms_send_v1'] } };
  assert.deepEqual(await categories.apply(c, { key: KEY, desired: same.data, existing: same }), { skipped: true });
});

test('the fake endpoint behaves like the platform: a PUT with trees clears routines, objects in a list fail, /trees is 404', async () => {
  const store = fakeTaskCategories([seed('N', 'Stored', [], [['routine_a_v1', 'A']])]);
  const c = fakeClient({}, { fallback: store.handle });
  await c.request('task', 'PUT', '/categories/N', { body: { name: 'N', trees: ['A'] } });
  assert.deepEqual(store.categories[0].trees, []);
  await assert.rejects(c.request('task', 'PUT', '/categories/N', { body: { name: 'N', handlers: [{ definitionId: 'x' }] } }), (e) => e.status === 500);
  await assert.rejects(c.request('task', 'POST', '/categories/N/trees', { body: { definitionId: 'routine_a_v1' } }), (e) => e.status === 404);
});

test('a category and a member entry are removed with DELETEs on the Task API', async () => {
  const store = fakeTaskCategories([seed('Old', 'Stored', ['x_v1']), seed('Old', 'Integrated', ['system_v1'])]);
  const c = fakeClient({}, { fallback: store.handle });
  await categories.prune(c, { key: 'task-categories/Old', data: cat({ name: 'Old' }), meta: { name: 'Old' } });
  assert.deepEqual(writes(c), [{ method: 'DELETE', path: '/categories/Old', body: undefined }]);
  assert.deepEqual(store.categories.map((x) => x.type), ['Integrated'], 'the built-in one of the same name stays');
  assert.ok(isEntryKey('task-categories/A#B#handlers/x_v1'));
  assert.deepEqual(parseEntryKey('task-categories/A#B#handlers/x_v1'), { itemKey: 'task-categories/A#B', field: 'handlers', segment: 'x_v1' });
  assert.ok(!isEntryKey('task-categories/A#B'));
  assert.equal(moduleFor('task-categories/A#B').type, 'task-categories');
});

test('task categories are applied after handlers and routines (their members) and before what calls them', () => {
  const order = APPLY_ORDER.map((m) => m.type);
  for (const t of ['handlers', 'routines']) assert.ok(order.indexOf(t) < order.indexOf('task-categories'), t);
  for (const t of ['webapis', 'workflows']) assert.ok(order.indexOf('task-categories') < order.indexOf(t), t);
  const listed = MODULES.map((m) => m.type);
  assert.ok(listed.indexOf('routines') < listed.indexOf('task-categories'));
});

// ---- Plans -----------------------------------------------------------------

const plan = (exported, target, extra = {}) => buildPlan({
  modules: MODULES, exported: new Map(Object.entries(exported)), config: TEST_CONFIG, targetName: 'test',
  target: new Map(Object.entries(target).map(([key, data]) => [key, { key, data }])), ...extra,
});

test('memberships only in the target are kept and are no difference; the target\'s policy rules stand', () => {
  const p = plan(
    { [KEY]: cat({ handlers: ['utilities_echo_v1'] }) },
    { [KEY]: cat({ handlers: ['local_only_v1', 'utilities_echo_v1'], routines: ['routine_local_v1'], policyRules: ['Admins'] }) },
  );
  assert.equal(p.items[0].action, 'unchanged');
  assert.deepEqual(p.items[0].diff, []);
  assert.deepEqual(p.warnings, []);
});

test('a member the target lacks is left out with a warning (not an error); one created by the same run is added', () => {
  const routine = { name: 'Notify', definitionId: 'routine_notify_v1', treeJson: { nodes: [] } };
  const exported = { [KEY]: cat({ handlers: ['missing_v1', 'utilities_echo_v1'], routines: ['routine_notify_v1'] }), 'routines/Notify': routine };
  const p = plan(exported, { [KEY]: cat() });
  const item = p.items.find((i) => i.key === KEY);
  assert.equal(item.action, 'update');
  assert.deepEqual(item.desired.handlers, ['utilities_echo_v1'], 'built-in handlers exist everywhere');
  assert.deepEqual(item.desired.routines, ['routine_notify_v1']);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, [`${KEY}: missing_v1 is not in test; promote it to add it to the category`]);
  assert.deepEqual(item.diff, [{ path: 'handlers', from: [], to: ['utilities_echo_v1'] }, { path: 'routines', from: [], to: ['routine_notify_v1'] }], 'members differ as whole lists');
  // Not selected: the routine is not created, so it is not added either.
  const only = plan(exported, { [KEY]: cat() }, { select: new Set([KEY]) });
  assert.deepEqual(only.items.find((i) => i.key === KEY).desired.routines, []);
  assert.ok(only.warnings.some((w) => w.includes('routine_notify_v1 is not in test')));
  // A handler installed in the target but in no category (so not listed) is there.
  const installed = plan({ [KEY]: cat({ handlers: ['missing_v1'] }) }, {}, { inputs: { 'task-categories': { installedHandlers: ['missing_v1'] } } });
  assert.deepEqual(installed.items[0].desired.handlers, ['missing_v1']);
  assert.deepEqual(installed.warnings, []);
});

test('a source category\'s policy rules the target lacks are a warning; they are never sent', () => {
  const p = plan({ [KEY]: cat({ policyRules: ['Admins', 'Ops'] }) }, { [KEY]: cat({ policyRules: ['Ops'] }) });
  assert.deepEqual(p.warnings, [`${KEY}: its policy rules (Admins) are not carried; set them in test`]);
  assert.equal(p.items[0].action, 'unchanged');
});

test('a handler or routine the plan creates in no Task category is a warning; one a planned category holds is not', () => {
  const r = (name, id) => ({ name, definitionId: id, treeJson: { nodes: [] } });
  const exported = new Map(Object.entries({ 'routines/A': r('A', 'routine_a_v1'), 'routines/B': r('B', 'routine_b_v1'), [KEY]: cat({ routines: ['routine_b_v1'] }) }));
  const target = new Map();
  const p = buildPlan({ modules: MODULES, exported, target, config: TEST_CONFIG, targetName: 'test' });
  const checks = preflightChecks({ plan: p, exported, target, config: TEST_CONFIG, hasSecrets: () => true, targetName: 'test' });
  assert.deepEqual(checks.warnings, ['routines/A: will be in no Task category in test, so it will not appear in the workflow builder; promote a Task category that holds it']);
});

test('promoting a handler or routine suggests its category when the target\'s copy does not hold it', () => {
  const source = [
    { key: 'handlers/mail_send_v1/handler', data: { definitionId: 'mail_send_v1', name: 'Mail Send' } },
    { key: 'routines/Notify', data: { name: 'Notify', definitionId: 'routine_notify_v1' } },
    { key: KEY, data: cat({ handlers: ['mail_send_v1'], routines: ['routine_notify_v1'] }) },
  ];
  const relationships = buildRelationships(source);
  const changedKeys = new Set(source.map((a) => a.key));
  const got = suggest({ selected: new Set(['handlers/mail_send_v1/handler']), relationships, changedKeys, targetOf: () => undefined });
  assert.deepEqual(got.map((s) => [s.key, s.kind, s.reason]), [[KEY, 'in-category', 'Mail Send belongs to Task category "Notifications", so Mail Send appears in the workflow builder']]);
  const routine = suggest({ selected: new Set(['routines/Notify']), relationships, changedKeys, targetOf: () => cat({ routines: [] }) });
  assert.deepEqual(routine.map((s) => s.key), [KEY]);
  const held = suggest({ selected: new Set(['routines/Notify']), relationships, changedKeys, targetOf: () => cat({ routines: ['routine_notify_v1'] }) });
  assert.deepEqual(held, [], 'the target\'s category already holds it');
});

test('normalizeCategory sorts members and takes routines from trees', () => {
  assert.deepEqual(normalizeCategory({ name: 'N', handlers: [{ definitionId: 'b' }, { definitionId: 'a' }], trees: [{ definitionId: 'r' }] }), {
    name: 'N', description: '', handlers: ['a', 'b'], routines: ['r'], policyRules: [],
  });
});

// ---- Apply, removal, drift (engine commands) --------------------------------

function project(source) {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-cats-'));
  mkdirSync(join(dir, 'environments'));
  writeFileSync(join(dir, 'environments', 'prod.json'), JSON.stringify({ url: 'https://prod.example.com' }));
  writeFileSync(join(dir, '.env.prod'), 'KINETIC_PROD_USERNAME=u\nKINETIC_PROD_PASSWORD=p\n');
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Space' } }, ...source]);
  return dir;
}

// A target whose routines and categories keep what is written to them.
function target(seeds, routines = []) {
  const store = fakeTaskCategories(seeds, { routineName: (id) => routines.find((r) => r.definitionId === id)?.name ?? id });
  const routes = {
    'GET core/space': { space: { name: 'Space' } },
    'GET core/teams': { teams: [] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [],
    'GET core/kapps': { kapps: [] },
    'GET core/workflows': { workflows: [] },
    'GET task/trees': () => ({ trees: structuredClone(routines) }),
    'GET task/handlers': { handlers: [] },
    'POST task/trees': ({ body }) => { routines.push({ ...structuredClone(body), title: body.name, versionId: '0' }); return {}; },
  };
  const calls = [];
  const clientFactory = ({ mode }) => fakeClient(routes, { mode, calls, fallback: store.handle });
  const written = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.api}${c.path}`);
  return { store, clientFactory, written, calls };
}

const run = (dir, t, extra = {}) => runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: t.clientFactory, ...extra });
const NOTIFY = { name: 'Notify', definitionId: 'routine_notify_v1', status: 'Active', notes: '', treeJson: { nodes: [], connectors: [] } };

test('apply creates the routine first, then the category and its members; a re-plan has nothing to do', async () => {
  const dir = project([{ key: 'routines/Notify', data: NOTIFY }, { key: KEY, data: cat({ handlers: ['utilities_echo_v1'], routines: ['routine_notify_v1'] }) }]);
  const t = target([seed('Notifications', 'Integrated', ['system_v1'])]);
  assert.equal((await run(dir, t)).code, 0);
  assert.deepEqual(t.written(), [
    'POST task/trees',
    'POST task/categories',
    'POST task/categories/Notifications/handlers',
    'POST task/categories/Notifications/routines',
  ]);
  const again = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: t.clientFactory });
  assert.deepEqual(again.plan.items.filter((i) => i.key.startsWith('task-') || i.key.startsWith('routines/')).map((i) => [i.key, i.action]), [
    ['routines/Notify', 'unchanged'], [KEY, 'unchanged'],
  ]);
  assert.deepEqual(again.plan.warnings, []);
});

test('a target-only category and a target-only member are removed; the category\'s state is re-recorded, so a later change is no drift', async () => {
  const dir = project([{ key: KEY, data: cat({ handlers: ['utilities_echo_v1'] }) }]);
  const t = target([seed('Notifications', 'Stored', ['utilities_echo_v1', 'utilities_old_v1']), seed('Legacy', 'Stored', ['utilities_echo_v1'])]);
  // Promoted once, so the category has recorded state.
  t.store.categories[0].description = 'Email';
  assert.equal((await run(dir, t)).code, 0);
  const before = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'))[KEY];
  assert.ok(before);
  const ENTRY = `${KEY}#handlers/utilities_old_v1`;
  // Nothing selected to promote (the category is not part of the run).
  const res = await run(dir, t, { remove: ['task-categories/Legacy', ENTRY], select: new Set() });
  assert.equal(res.code, 0);
  assert.deepEqual(t.written(), ['DELETE task/categories/Legacy', 'DELETE task/categories/Notifications/handlers/utilities_old_v1']);
  assert.deepEqual(t.store.categories.map((c) => [c.name, c.handlers.map((h) => h.definitionId)]), [['Notifications', ['utilities_echo_v1']]]);
  const state = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'));
  assert.ok(!('task-categories/Legacy' in state));
  assert.notEqual(state[KEY], before, 'the category is re-recorded as it is after the entry removal');
  // The source's description changes: an update, not drift.
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Space' } }, { key: KEY, data: cat({ description: 'New', handlers: ['utilities_echo_v1'] }) }]);
  const next = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: t.clientFactory });
  assert.equal(next.plan.items.find((i) => i.key === KEY).action, 'update');
});

test('a member entry in the source too, or an Integrated category, cannot be removed', async () => {
  const dir = project([{ key: KEY, data: cat({ handlers: ['utilities_echo_v1'] }) }]);
  const t = target([seed('Notifications', 'Stored', ['utilities_echo_v1']), seed('System Controls', 'Integrated', ['system_v1'])]);
  const { plan: p } = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: t.clientFactory, remove: [`${KEY}#handlers/utilities_echo_v1`, 'task-categories/System Controls'] });
  assert.ok(p.warnings.some((w) => w.includes('still exists in')), JSON.stringify(p.warnings));
  assert.deepEqual(p.removals.map((r) => [r.key, r.action]), [['task-categories/System Controls', 'gone']]);
});
