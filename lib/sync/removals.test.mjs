// lib/sync/removals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient } from './fake-client.mjs';
import { runApply, computePlan } from './commands.mjs';
import { writeTree } from './store.mjs';
import { planRemovals, notRemovable, removalHash } from './removals.mjs';
import { MODULES, moduleFor } from './artifacts/index.mjs';
import { formatPlan } from './report.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-remove-'));
  mkdirSync(join(dir, 'environments'));
  for (const [name, def] of Object.entries({ prod: { url: 'https://prod.example.com' } })) {
    writeFileSync(join(dir, 'environments', `${name}.json`), JSON.stringify(def));
    writeFileSync(join(dir, `.env.${name}`), 'KINETIC_PROD_USERNAME=u\nKINETIC_PROD_PASSWORD=p\n');
  }
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Space' } }]);
  return dir;
}

// A target with a team, a routine a target-only workflow runs, and a kapp
// with two forms (one with a workflow and reference data rows).
function targetRoutes() {
  const tree = (ids) => ({ nodes: ids.map((definitionId) => ({ id: definitionId, definitionId })) });
  return {
    'GET core/space': { space: { name: 'Space' } },
    'GET core/teams': { teams: [{ name: 'Old', slug: 'old' }, { name: 'Keep', slug: 'keep' }] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [],
    'GET core/kapps': { kapps: [{ slug: 'legacy' }] },
    'GET core/kapps/legacy': { kapp: { slug: 'legacy', name: 'Legacy', webApis: [], forms: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }] } },
    'GET core/workflows': { workflows: [{ id: 'w1', name: 'Welcome', event: 'User Created', platformItemType: 'Space', treeJson: tree(['routine_r_v1']) }] },
    'GET core/kapps/legacy/workflows': { workflows: [] },
    'GET core/kapps/legacy/forms/a/workflows': { workflows: [{ id: 'fw1', name: 'Notify' }] },
    'GET core/kapps/legacy/forms/a/workflows/fw1': { workflow: { id: 'fw1', name: 'Notify', event: 'Submission Submitted', treeJson: tree([]) } },
    'GET core/kapps/legacy/forms/b/workflows': { workflows: [] },
    'GET task/trees': { trees: [{ name: 'R', title: 'R', definitionId: 'routine_r_v1', treeJson: tree([]), type: 'Global Routine' }] },
    'GET task/handlers': { handlers: [] },
  };
}

function harness(routes = targetRoutes()) {
  const calls = [];
  const events = [];
  const clientFactory = ({ mode }) => fakeClient(routes, { mode, calls });
  const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.api}${c.path}`);
  return { clientFactory, writes, events, calls, onEvent: (e) => events.push(e) };
}

const apply = (dir, h, extra) => runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory, onEvent: h.onEvent, ...extra });

test('removing one target-only team deletes it after every other change and forgets its drift state', async () => {
  const dir = project();
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({}));
  const h = harness();
  const res = await apply(dir, h, { remove: ['teams/Old'] });
  assert.equal(res.code, 0);
  assert.deepEqual(h.writes(), ['DELETE core/teams/old']);
  assert.ok(h.events.some((e) => e.type === 'item' && e.key === 'teams/Old' && e.status === 'done'));
  assert.ok(!('teams/Old' in JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'))));
  assert.ok(existsSync(join(dir, 'backups')), 'backed up before deleting');
});

test('without --remove (or --prune), nothing is deleted', async () => {
  const dir = project();
  const h = harness();
  assert.equal((await apply(dir, h, {})).code, 0);
  assert.deepEqual(h.writes(), []);
});

// The target as the platform would answer after a cascading kapp delete.
function cascading() {
  const routes = targetRoutes();
  let gone = false;
  const live = (k, empty) => () => (gone ? empty : structuredClone(routes[k]));
  return {
    ...routes,
    'GET core/kapps': live('GET core/kapps', { kapps: [] }),
    'DELETE core/kapps/legacy': () => { gone = true; return {}; },
  };
}

test('removing a kapp lists what it takes with it and issues one delete; a form inside it asked for too is not deleted separately', async () => {
  const dir = project();
  const h = harness(cascading());
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', remove: ['kapps/legacy/kapp', 'kapps/legacy/forms/a/form'], clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.removals.length, 1);
  const [r] = plan.removals;
  assert.equal(r.key, 'kapps/legacy/kapp');
  assert.deepEqual(r.children.map((c) => c.key), [
    'kapps/legacy/forms/a/form', 'kapps/legacy/forms/a/workflows/Submission Submitted/Notify', 'kapps/legacy/forms/b/form',
  ]);
  assert.match(r.restore, /not its other submissions/);
  assert.match(formatPlan(plan, 'prod'), /REMOVE kapps\s+kapps\/legacy\/kapp\n\s+with forms\s+kapps\/legacy\/forms\/a\/form/);

  assert.equal((await apply(dir, h, { remove: ['kapps/legacy/kapp', 'kapps/legacy/forms/a/form'] })).code, 0);
  // Its workflows go first, through Core (a kapp delete leaves their Task trees).
  assert.deepEqual(h.writes(), ['DELETE core/kapps/legacy/forms/a/workflows/fw1', 'DELETE core/kapps/legacy']);
  const done = h.events.filter((e) => e.type === 'item' && e.status === 'done').map((e) => [e.key, e.message]);
  assert.deepEqual(done, [
    ['kapps/legacy/forms/a/workflows/Submission Submitted/Notify', 'Removed with kapps/legacy/kapp'],
    ['kapps/legacy/kapp', 'Removed'],
    ['kapps/legacy/forms/a/form', 'Removed with kapps/legacy/kapp'],
    ['kapps/legacy/forms/b/form', 'Removed with kapps/legacy/kapp'],
  ]);
});

test('children a parent delete did not take with it are deleted on their own (callers first) and confirmed; a failing one is reported and kept in state', async () => {
  const dir = project();
  // A platform that does not cascade: the kapp listing still shows everything.
  let h = harness();
  assert.equal((await apply(dir, h, { remove: ['kapps/legacy/kapp'] })).code, 0);
  assert.deepEqual(h.writes(), [
    'DELETE core/kapps/legacy/forms/a/workflows/fw1',
    'DELETE core/kapps/legacy',
    'DELETE core/kapps/legacy/forms/a/workflows/fw1',
    'DELETE core/kapps/legacy/forms/a', 'DELETE core/kapps/legacy/forms/b',
  ]);
  assert.ok(h.events.some((e) => e.key === 'kapps/legacy/forms/b/form' && e.status === 'done' && /did not go with kapps\/legacy\/kapp/.test(e.message)));

  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({ 'kapps/legacy/forms/b/form': 'h' }));
  const routes = { ...targetRoutes(), 'DELETE core/kapps/legacy/forms/b': () => { const e = new Error('500 nope'); e.status = 500; throw e; } };
  h = harness(routes);
  const res = await apply(dir, h, { remove: ['kapps/legacy/kapp'] });
  assert.deepEqual(res.failed, ['kapps/legacy/forms/b/form']);
  assert.ok(h.events.some((e) => e.key === 'kapps/legacy/forms/b/form' && e.status === 'failed'));
  assert.ok(!h.events.some((e) => e.key === 'kapps/legacy/forms/b/form' && e.status === 'done'));
  const state = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'));
  assert.equal(state['kapps/legacy/forms/b/form'], 'h', 'a child not confirmed deleted keeps its drift state');
});

test('an item still in use is removed with a warning naming what uses it (never blocked); only-target users are marked', async () => {
  const dir = project();
  const h = harness();
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', remove: ['routines/R'], clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, []);
  const [r] = plan.removals;
  assert.deepEqual(r.usedBy, [{ key: 'workflows/User Created/Welcome', kind: 'runs', reason: 'Welcome runs routine "R"', onlyTarget: true }]);
  assert.ok(plan.warnings.some((w) => /^routines\/R: still used by workflows\/User Created\/Welcome/.test(w)));
  assert.equal((await apply(dir, h, { remove: ['routines/R'] })).code, 0);
  assert.deepEqual(h.writes(), ['DELETE task/trees/R']);
});

test('removing the user too clears the warning; callers are deleted before what they call', async () => {
  const dir = project();
  const h = harness();
  const remove = ['routines/R', 'workflows/User Created/Welcome'];
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', remove, clientFactory: h.clientFactory });
  assert.ok(plan.removals.every((r) => r.usedBy.length === 0));
  assert.equal((await apply(dir, h, { remove })).code, 0);
  assert.deepEqual(h.writes(), ['DELETE core/workflows/w1', 'DELETE task/trees/R']);
});

test('a removal whose target item changed since it was reviewed is not deleted (skipped, with a warning)', async () => {
  const dir = project();
  const h = harness();
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', remove: ['teams/Old'], clientFactory: h.clientFactory });
  const reviewed = plan.removals[0].hash;
  // Same content: deleted.
  let h2 = harness();
  assert.equal((await apply(dir, h2, { remove: ['teams/Old'], removeExpected: { 'teams/Old': reviewed } })).code, 0);
  assert.deepEqual(h2.writes(), ['DELETE core/teams/old']);
  // Changed since: kept.
  const changed = { ...targetRoutes(), 'GET core/teams': { teams: [{ name: 'Old', slug: 'old', description: 'edited' }] } };
  h2 = harness(changed);
  let seen;
  assert.equal((await apply(dir, h2, { remove: ['teams/Old'], removeExpected: { 'teams/Old': reviewed }, onPlan: (p) => { seen = p; } })).code, 0);
  assert.deepEqual(h2.writes(), []);
  assert.equal(seen.removals[0].action, 'skip-drift');
  assert.ok(seen.warnings.some((w) => /teams\/Old: changed in the target since it was reviewed/.test(w)));
});

test('a kapp whose form changed (or gained a form) since review is not deleted', async () => {
  const dir = project();
  const h = harness();
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', remove: ['kapps/legacy/kapp'], clientFactory: h.clientFactory });
  const routes = targetRoutes();
  routes['GET core/kapps/legacy'] = { kapp: { ...routes['GET core/kapps/legacy'].kapp, forms: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B edited' }] } };
  const h2 = harness(routes);
  await apply(dir, h2, { remove: ['kapps/legacy/kapp'], removeExpected: { 'kapps/legacy/kapp': plan.removals[0].hash } });
  assert.deepEqual(h2.writes(), []);
});

test('items that can never be removed are refused with a clear error and nothing is written', async () => {
  const dir = project();
  const h = harness();
  const out = [];
  const res = await runApply({
    projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory,
    remove: ['space', 'handlers/system_wait_v1/handler', 'handlers/utilities_echo_v1/handler', 'kapps/legacy/forms/a/data', 'task-refs', 'nonsense/x'],
  });
  assert.equal(res.code, 1);
  assert.deepEqual(h.writes(), []);
  const text = out.join('\n');
  assert.match(text, /The space itself can never be removed/);
  assert.match(text, /handlers\/system_wait_v1\/handler: built-in handlers \(utilities_\*, system_\*\) can never be removed/);
  assert.match(text, /handlers\/utilities_echo_v1\/handler: built-in handlers/);
  assert.match(text, /kapps\/legacy\/forms\/a\/data: reference data records are never removed as an item/);
  assert.match(text, /task-refs: is a summary/);
  assert.match(text, /nonsense\/x: not an item kinetic-migrate knows/);
});

test('an item that still exists in the source is dropped with a warning; one already gone is reported, not an error', () => {
  const target = new Map([['teams/Both', { key: 'teams/Both', data: { name: 'Both' }, meta: { slug: 'both' } }]]);
  const exported = new Map([['teams/Both', { name: 'Both' }]]);
  const r = planRemovals({ modules: MODULES, exported, target, remove: ['teams/Both', 'teams/Gone'], sourceName: 'dev' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.removals.map((x) => [x.key, x.action]), [['teams/Gone', 'gone']]);
  assert.deepEqual(r.warnings, ['teams/Both: still exists in dev — not removed', 'teams/Gone: already gone from the target']);
});

test('removing a team notes that memberships are lost; a connection takes its operations with it', () => {
  const target = new Map([
    ['teams/Ops', { key: 'teams/Ops', data: { name: 'Ops' }, meta: { slug: 'ops' } }],
    ['connections/Api/connection', { key: 'connections/Api/connection', data: { id: 'c', name: 'Api' }, meta: { id: 'c' } }],
    ['connections/Api/operations/Get', { key: 'connections/Api/operations/Get', data: { id: 'o', name: 'Get', connectionId: 'c' }, meta: { id: 'o', connectionId: 'c' } }],
    ['kapps/k/forms/f/form', { key: 'kapps/k/forms/f/form', data: { slug: 'f', integrations: [{ connectionId: 'c', operationId: 'o' }] }, meta: {} }],
  ]);
  const r = planRemovals({ modules: MODULES, exported: new Map(), target, remove: ['teams/Ops', 'connections/Api/connection'] });
  const team = r.removals.find((x) => x.key === 'teams/Ops');
  assert.match(team.notes[0], /memberships/);
  const conn = r.removals.find((x) => x.key === 'connections/Api/connection');
  assert.deepEqual(conn.children.map((c) => c.key), ['connections/Api/operations/Get']);
  assert.match(conn.restore, /without credentials/);
  assert.deepEqual(conn.usedBy.map((u) => [u.key, u.kind]), [['kapps/k/forms/f/form', 'calls']]);
});

test('creates and updates in the same plan count as users of a removed item', () => {
  const target = new Map([['routines/R', { key: 'routines/R', data: { name: 'R', definitionId: 'routine_r_v1' }, meta: {} }]]);
  const items = [{ key: 'workflows/E/W', action: 'create', desired: { name: 'W', treeJson: { nodes: [{ definitionId: 'routine_r_v1' }] } } }];
  const r = planRemovals({ modules: MODULES, exported: new Map([['workflows/E/W', {}]]), target, remove: ['routines/R'], items });
  assert.deepEqual(r.removals[0].usedBy.map((u) => [u.key, u.onlyTarget]), [['workflows/E/W', false]]);
});

test('notRemovable and removalHash', () => {
  assert.equal(notRemovable('teams/X', moduleFor('teams/X')), null);
  assert.equal(notRemovable('handlers/mail_send_v1/handler', moduleFor('handlers/mail_send_v1/handler')), null);
  assert.match(notRemovable('space', moduleFor('space')), /space/);
  const a = removalHash({ data: { n: 1 } }, []);
  assert.equal(a, removalHash({ data: { n: 1 } }, []));
  assert.notEqual(a, removalHash({ data: { n: 1 } }, [{ key: 'x', existing: { data: {} } }]));
});

test('routines are promoted: created callees first, before the workflows that run them, and planned like other items', async () => {
  const dir = project();
  const tree = (ids) => ({ nodes: ids.map((definitionId) => ({ id: definitionId, definitionId })) });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Space' } },
    { key: 'routines/Outer', data: { name: 'Outer', definitionId: 'routine_outer_v1', status: 'Active', treeJson: tree(['routine_inner_v1']) } },
    { key: 'routines/Inner', data: { name: 'Inner', definitionId: 'routine_inner_v1', status: 'Active', treeJson: tree([]) } },
    { key: 'routines/Same', data: { name: 'Same', definitionId: 'routine_same_v1', status: 'Active', treeJson: tree([]) } },
    { key: 'workflows/User Created/Welcome', data: { name: 'Welcome', event: 'User Created', treeJson: tree(['routine_outer_v1']) } },
    { key: 'task-refs', data: { handlers: [], routines: ['routine_inner_v1', 'routine_outer_v1'] } },
  ]);
  const routes = {
    ...targetRoutes(),
    'GET core/teams': { teams: [] },
    'GET core/kapps': { kapps: [] },
    'GET core/workflows': { workflows: [] },
    'GET task/trees': { trees: [{ name: 'Same', title: 'Same', definitionId: 'routine_same_v1', status: 'Inactive', treeJson: tree([]), versionId: 1 }] },
    'GET task/trees/Same': { name: 'Same', versionId: 2 },
  };
  const h = harness(routes);
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.items.filter((i) => i.type === 'routines').map((i) => [i.key, i.action]), [
    ['routines/Inner', 'create'], ['routines/Outer', 'create'], ['routines/Same', 'update'],
  ]);
  assert.deepEqual(plan.items.find((i) => i.key === 'routines/Same').diff, [{ path: 'status', from: 'Inactive', to: 'Active' }]);
  assert.equal((await apply(dir, h, {})).code, 0);
  assert.deepEqual(h.writes(), [
    'POST task/trees', 'POST task/trees', 'PUT task/trees/Same', 'POST core/workflows', 'PUT core/workflows/undefined',
  ]);
  const posted = h.events.filter((e) => e.type === 'item' && e.status === 'running').map((e) => e.key);
  assert.deepEqual(posted.slice(0, 3), ['routines/Inner', 'routines/Outer', 'routines/Same']);
  const state = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'));
  assert.ok(state['routines/Inner'] === undefined || typeof state['routines/Inner'] === 'string');
});

test('with a selection, a workflow that runs an unselected new routine is a plan error naming the routine (reported once)', async () => {
  const dir = project();
  const tree = (ids) => ({ nodes: ids.map((definitionId) => ({ id: definitionId, definitionId })) });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Space' } },
    { key: 'routines/Outer', data: { name: 'Outer', definitionId: 'routine_outer_v1', treeJson: tree([]) } },
    { key: 'workflows/User Created/Welcome', data: { name: 'Welcome', event: 'User Created', treeJson: tree(['routine_outer_v1']) } },
    { key: 'task-refs', data: { handlers: [], routines: ['routine_outer_v1'] } },
  ]);
  const routes = { ...targetRoutes(), 'GET core/kapps': { kapps: [] }, 'GET core/workflows': { workflows: [] }, 'GET task/trees': { trees: [] } };
  const h = harness(routes);
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', select: new Set(['workflows/User Created/Welcome']), clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, ['workflows/User Created/Welcome needs routines/Outer (calls routine routine_outer_v1), which is not selected and not in the target']);
  // The target has it under another name: satisfied by definitionId.
  const h2 = harness({ ...routes, 'GET task/trees': { trees: [{ name: 'Renamed', definitionId: 'routine_outer_v1', treeJson: tree([]) }] } });
  const again = await computePlan({ projectDir: dir, envName: 'prod', select: new Set(['workflows/User Created/Welcome']), clientFactory: h2.clientFactory });
  assert.deepEqual(again.plan.errors, []);
});

test('with reviewed hashes given, only keys reviewed as deletes are deleted; a key without one never is', async () => {
  const dir = project();
  const h = harness();
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', remove: ['teams/Old', 'teams/Keep'], clientFactory: h.clientFactory });
  const hash = plan.removals.find((r) => r.key === 'teams/Old').hash;
  const h2 = harness();
  let seen;
  await apply(dir, h2, { remove: ['teams/Old', 'teams/Keep'], removeExpected: { 'teams/Old': hash }, onPlan: (p) => { seen = p; } });
  assert.deepEqual(h2.writes(), ['DELETE core/teams/old']);
  assert.equal(seen.removals.find((r) => r.key === 'teams/Keep').action, 'skip-drift');
  assert.ok(seen.warnings.includes('teams/Keep: not reviewed as a removal; it is not removed'));
});

test('without reviewed hashes (CLI), drift state decides: unchanged since the last promotion is deleted, changed is kept', async () => {
  const dir = project();
  const h = harness();
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, []);
  // Record the team as last promoted, then remove it unchanged.
  const { stateEntry } = await import('./normalize.mjs');
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({ 'teams/Old': stateEntry('team', { name: 'Old' }, {}, 'teams/Old') }));
  let h2 = harness();
  assert.equal((await apply(dir, h2, { remove: ['teams/Old'] })).code, 0);
  assert.deepEqual(h2.writes(), ['DELETE core/teams/old']);
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({ 'teams/Old': stateEntry('team', { name: 'Old', description: 'then' }, {}, 'teams/Old') }));
  h2 = harness();
  let seen;
  await apply(dir, h2, { remove: ['teams/Old'], onPlan: (p) => { seen = p; } });
  assert.deepEqual(h2.writes(), []);
  assert.ok(seen.warnings.includes('teams/Old: changed in the target since it was last promoted; it is not removed'));
});

test('--prune teams with --remove of the same team deletes it once', async () => {
  const dir = project();
  const h = harness();
  assert.equal((await apply(dir, h, { prune: ['teams'], remove: ['teams/Old'] })).code, 0);
  assert.deepEqual(h.writes().filter((w) => w === 'DELETE core/teams/old'), ['DELETE core/teams/old']);
});

test('removing a routine and the routine it calls deletes the caller first', async () => {
  const dir = project();
  const tree = (ids) => ({ nodes: ids.map((definitionId) => ({ id: definitionId, definitionId })) });
  const routes = { ...targetRoutes(), 'GET task/trees': { trees: [
    { name: 'A', title: 'A', definitionId: 'routine_a_v1', treeJson: tree(['routine_b_v1']) },
    { name: 'B', title: 'B', definitionId: 'routine_b_v1', treeJson: tree([]) },
  ] }, 'GET core/workflows': { workflows: [] } };
  const h = harness(routes);
  assert.equal((await apply(dir, h, { remove: ['routines/B', 'routines/A'] })).code, 0);
  assert.deepEqual(h.writes(), ['DELETE task/trees/A', 'DELETE task/trees/B']);
});

test('teams, models and file resources: what may still use them is a warning', () => {
  const target = new Map(Object.entries({
    'teams/Ops': { name: 'Ops' },
    'models/People': { name: 'People' },
    'file-resources/docs': { slug: 'docs', name: 'Docs' },
    space: { name: 'S', securityPolicyDefinitions: [{ name: 'Ops only', rule: "identity('teams').includes('Ops')" }] },
    'kapps/k/forms/f/form': { slug: 'f', name: 'F', attributes: [{ name: 'Owning Team', values: ['Ops'] }], bridgedResources: [{ name: 'Person', model: 'People' }] },
    'kapps/k/forms/g/form': { slug: 'g', name: 'G', pages: [{ elements: [{ type: 'content', text: '/app/fileResources/docs/guide.pdf' }] }] },
  }).map(([key, data]) => [key, { key, data, meta: { slug: data.slug ?? 'ops' } }]));
  const r = planRemovals({ modules: MODULES, exported: new Map(), target, remove: ['teams/Ops', 'models/People', 'file-resources/docs'] });
  const users = (k) => r.removals.find((x) => x.key === k).usedBy.map((u) => [u.key, u.reason]);
  assert.deepEqual(users('teams/Ops'), [
    ['kapps/k/forms/f/form', 'F may use team "Ops" (attribute "Owning Team")'],
    ['space', 'S may use team "Ops" (named in security policy "Ops only")'],
  ]);
  assert.deepEqual(users('models/People'), [['kapps/k/forms/f/form', 'F uses model "People" in a bridged resource']]);
  assert.deepEqual(users('file-resources/docs'), [['kapps/k/forms/g/form', 'G may use file resource "Docs"']]);
  assert.deepEqual(r.errors, []);
});

test('a new routine whose definitionId the target has under another name gets a warning', async () => {
  const dir = project();
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Space' } },
    { key: 'routines/Notify Requester', data: { name: 'Notify Requester', definitionId: 'routine_r_v1', treeJson: { nodes: [] } } },
  ]);
  const h = harness();
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: h.clientFactory });
  assert.ok(plan.warnings.some((w) => w.startsWith('routines/Notify Requester: prod already has routine routines/R with the same definitionId')), plan.warnings.join('\n'));
});

test('a removed kapp\'s workflow trees: none left when Core deletes them; a leftover tree is deleted by title; one that cannot be is reported failed', async () => {
  const TITLE = 'Kinetic Request CE :: fw1 :: Notify';
  const tree = { name: 'Notify', title: TITLE, sourceName: 'Kinetic Request CE', sourceGroup: 'fw1', type: 'Tree' };
  const unrelated = { name: 'Notify', title: 'Kinetic Request CE :: other :: Notify', sourceGroup: 'other', type: 'Tree' };
  const routine = { name: 'R', title: 'R', definitionId: 'routine_r_v1', treeJson: { nodes: [] }, type: 'Global Routine' };
  const withTrees = (opts) => {
    const routes = cascading();
    let flowGone = false;
    routes['GET task/trees'] = ({ query }) => ({ trees: [routine, ...(flowGone && opts.coreRemovesTree ? [] : [tree]), unrelated].filter((t) => !query?.type || t.type === query.type) });
    routes['DELETE core/kapps/legacy/forms/a/workflows/fw1'] = () => { flowGone = true; return {}; };
    if (opts.treeDeleteFails) routes[`DELETE task/trees/${encodeURIComponent(TITLE)}`] = () => { const e = new Error('500 no'); e.status = 500; throw e; };
    return routes;
  };
  const dir = project();
  // Core's workflow delete removes the tree: nothing more to do.
  let h = harness(withTrees({ coreRemovesTree: true }));
  assert.equal((await apply(dir, h, { remove: ['kapps/legacy/kapp'] })).code, 0);
  assert.deepEqual(h.writes(), ['DELETE core/kapps/legacy/forms/a/workflows/fw1', 'DELETE core/kapps/legacy']);
  // The tree outlived it: deleted by title (never the unrelated tree of the same name).
  h = harness(withTrees({}));
  const res = await apply(dir, h, { remove: ['kapps/legacy/kapp'] });
  assert.deepEqual(res.failed, []);
  assert.deepEqual(h.writes(), ['DELETE core/kapps/legacy/forms/a/workflows/fw1', 'DELETE core/kapps/legacy', `DELETE task/trees/${encodeURIComponent(TITLE)}`]);
  const listed = h.calls.find((c) => c.method === 'GET' && c.path === '/trees' && c.query?.type === 'Tree');
  assert.ok(listed, 'trees are checked through the Task API');
  // And one that cannot be deleted is reported failed.
  h = harness(withTrees({ treeDeleteFails: true }));
  const bad = await apply(dir, h, { remove: ['kapps/legacy/kapp'] });
  assert.deepEqual(bad.failed, ['kapps/legacy/forms/a/workflows/Submission Submitted/Notify']);
  assert.ok(h.events.some((e) => e.status === 'failed' && /Task tree "Kinetic Request CE :: fw1 :: Notify" is still in the target/.test(e.message)));
});

test('removing a form deletes its workflows through Core first', async () => {
  const dir = project();
  const h = harness();
  assert.equal((await apply(dir, h, { remove: ['kapps/legacy/forms/a/form'] })).code, 0);
  assert.deepEqual(h.writes().slice(0, 2), ['DELETE core/kapps/legacy/forms/a/workflows/fw1', 'DELETE core/kapps/legacy/forms/a']);
});
