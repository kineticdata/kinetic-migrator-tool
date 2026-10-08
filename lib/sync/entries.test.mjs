// lib/sync/entries.test.mjs: removing single sub-collection entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient } from './fake-client.mjs';
import { runApply, computePlan } from './commands.mjs';
import { writeTree } from './store.mjs';
import { entryKey, parseEntryKey, targetOnlyEntries, entryUsers } from './entries.mjs';
import { planRemovals } from './removals.mjs';
import { MODULES, moduleFor } from './artifacts/index.mjs';

const SPACE_FIELDS = ['spaceAttributeDefinitions', 'teamAttributeDefinitions', 'userAttributeDefinitions', 'userProfileAttributeDefinitions', 'securityPolicyDefinitions'];
const KAPP_FIELDS = [
  ['kappAttributeDefinitions', 'name'], ['formAttributeDefinitions', 'name'], ['categoryAttributeDefinitions', 'name'],
  ['securityPolicyDefinitions', 'name'], ['formTypes', 'name'], ['categories', 'slug'], ['integrations', 'name'],
];

const keep = (k = 'name') => ({ [k]: 'Keep' });
const extra = (k = 'name') => ({ [k]: 'Old Thing', description: 'only in target' });
const spaceData = (withExtra) => Object.fromEntries([['name', 'Space'], ...SPACE_FIELDS.map((f) => [f, withExtra ? [keep(), extra()] : [keep()]])]);
const kappData = (withExtra) => ({
  slug: 'services', name: 'Services', ...Object.fromEntries(KAPP_FIELDS.map(([f, k]) => [f, withExtra ? [keep(k), extra(k)] : [keep(k)]])),
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-entries-'));
  mkdirSync(join(dir, 'environments'));
  writeFileSync(join(dir, 'environments', 'prod.json'), JSON.stringify({ url: 'https://prod.example.com' }));
  writeFileSync(join(dir, '.env.prod'), 'KINETIC_PROD_USERNAME=u\nKINETIC_PROD_PASSWORD=p\n');
  writeTree(join(dir, 'export'), [{ key: 'space', data: spaceData(false) }, { key: 'kapps/services/kapp', data: kappData(false) }]);
  return dir;
}

function target(over = {}) {
  return {
    'GET core/space': { space: spaceData(true) },
    'GET core/teams': { teams: [] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [],
    'GET core/kapps': { kapps: [{ slug: 'services' }] },
    'GET core/kapps/services': { kapp: { ...kappData(true), forms: [], webApis: [] } },
    'GET core/workflows': { workflows: [] },
    'GET core/kapps/services/workflows': { workflows: [] },
    'GET task/trees': { trees: [] },
    'GET task/handlers': { handlers: [] },
    ...over,
  };
}

const harness = (routes = target()) => {
  const calls = [];
  return { calls, clientFactory: ({ mode }) => fakeClient(routes, { mode, calls }), writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`) };
};

const ALL = [
  ...SPACE_FIELDS.map((f) => entryKey('space', f, 'Old Thing')),
  ...KAPP_FIELDS.map(([f]) => entryKey('kapps/services/kapp', f, 'Old Thing')),
];

test('entry keys encode the name like a key segment and parse back', () => {
  assert.equal(entryKey('kapps/services/kapp', 'categories', 'a/b'), 'kapps/services/kapp#categories/a%2Fb');
  assert.deepEqual(parseEntryKey('kapps/services/kapp#categories/a%2Fb'), { itemKey: 'kapps/services/kapp', field: 'categories', segment: 'a%2Fb' });
  assert.equal(parseEntryKey('space#nofield'), null);
});

test('target-only entries are found per collection; they never make the item differ', async () => {
  const space = moduleFor('space');
  assert.deepEqual(targetOnlyEntries(space, 'space', spaceData(false), spaceData(true)).map((e) => e.collection), [...SPACE_FIELDS].sort());
  const h = harness();
  const { plan } = await computePlan({ projectDir: project(), envName: 'prod', clientFactory: h.clientFactory });
  assert.deepEqual(plan.items.map((i) => [i.key, i.action]), [['kapps/services/kapp', 'unchanged'], ['space', 'unchanged']]);
});

test('each chosen entry of every space and kapp collection is deleted through its own endpoint after the other changes; unlisted ones stay', async () => {
  const h = harness();
  const res = await runApply({ projectDir: project(), envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory, remove: ALL });
  assert.equal(res.code, 0);
  assert.deepEqual(h.writes().sort(), [
    ...SPACE_FIELDS.map((f) => `DELETE /${f}/Old%20Thing`),
    ...KAPP_FIELDS.map(([f]) => `DELETE /kapps/services/${f}/Old%20Thing`),
  ].sort());
  // Kapp entries go before the space's (reverse dependency order).
  const w = h.writes();
  assert.ok(w.findIndex((x) => x.startsWith('DELETE /kapps')) < w.findIndex((x) => x === 'DELETE /spaceAttributeDefinitions/Old%20Thing'));

  const one = harness();
  await runApply({ projectDir: project(), envName: 'prod', yes: true, log: () => {}, clientFactory: one.clientFactory, remove: [entryKey('kapps/services/kapp', 'categories', 'Old Thing')] });
  assert.deepEqual(one.writes(), ['DELETE /kapps/services/categories/Old%20Thing']);
});

test('an entry in the source too, an unknown collection, or a missing entry are refused or reported', () => {
  const exported = new Map([['space', spaceData(true)]]);
  const tgt = new Map([['space', { key: 'space', data: spaceData(true), meta: {} }]]);
  const r = planRemovals({ modules: MODULES, exported, target: tgt, remove: [entryKey('space', 'spaceAttributeDefinitions', 'Old Thing'), 'space#attributes/X', 'space#nope'] });
  assert.deepEqual(r.errors, [
    'space#attributes/X: entries of attributes cannot be removed',
    'space#nope: not an item kinetic-migrate knows; it cannot be removed',
  ]);
  assert.deepEqual(r.removals, []);
  assert.deepEqual(r.warnings, ['space#spaceAttributeDefinitions/Old Thing: still exists in the source — not removed']);
  const g = planRemovals({ modules: MODULES, exported: new Map([['space', spaceData(false)]]), target: tgt, remove: [entryKey('space', 'teamAttributeDefinitions', 'Never')] });
  assert.deepEqual(g.removals.map((x) => x.action), ['gone']);
});

test('in use: attribute definitions set on items, categories assigned to forms, policies referenced, form types used (a warning)', () => {
  const kapp = { slug: 'k', name: 'K', kappAttributeDefinitions: [{ name: 'Owner' }], formAttributeDefinitions: [{ name: 'Queue' }], categoryAttributeDefinitions: [{ name: 'Icon' }],
    categories: [{ slug: 'hw', name: 'Hardware', attributes: [{ name: 'Icon', values: ['x'] }] }], formTypes: [{ name: 'Service' }], securityPolicyDefinitions: [{ name: 'Admins' }],
    attributes: [{ name: 'Owner', values: ['a'] }], securityPolicies: [{ endpoint: 'Display', name: 'Admins' }] };
  const form = { slug: 'f', name: 'F', type: 'Service', attributes: [{ name: 'Queue', values: ['q'] }], categorizations: [{ category: { slug: 'hw' } }], securityPolicies: [{ endpoint: 'Modification', name: 'Admins' }] };
  const space = { name: 'S', spaceAttributeDefinitions: [{ name: 'Env' }], teamAttributeDefinitions: [{ name: 'Mail' }], securityPolicyDefinitions: [{ name: 'Everyone' }], attributes: [{ name: 'Env' }], securityPolicies: [{ endpoint: 'Discussion', name: 'Everyone' }] };
  const team = { name: 'Ops', attributes: [{ name: 'Mail', values: ['m'] }] };
  const world = new Map([['space', space], ['kapps/k/kapp', kapp], ['kapps/k/forms/f/form', form], ['teams/Ops', team]]);
  const users = (item, field, name) => entryUsers(world, item, field, name).map((u) => [u.key, u.reason]);
  assert.deepEqual(users('kapps/k/kapp', 'kappAttributeDefinitions', 'Owner'), [['kapps/k/kapp', 'Kapp "K" sets attribute "Owner"']]);
  assert.deepEqual(users('kapps/k/kapp', 'formAttributeDefinitions', 'Queue'), [['kapps/k/forms/f/form', 'Form "F" sets attribute "Queue"']]);
  assert.deepEqual(users('kapps/k/kapp', 'categoryAttributeDefinitions', 'Icon'), [['kapps/k/kapp', 'Category "Hardware" sets attribute "Icon"']]);
  assert.deepEqual(users('kapps/k/kapp', 'categories', 'hw'), [['kapps/k/forms/f/form', 'Form "F" is in category "hw"']]);
  assert.deepEqual(users('kapps/k/kapp', 'formTypes', 'Service'), [['kapps/k/forms/f/form', 'Form "F" is of type "Service"']]);
  assert.deepEqual(users('kapps/k/kapp', 'securityPolicyDefinitions', 'Admins').map(([k]) => k), ['kapps/k/forms/f/form', 'kapps/k/kapp']);
  assert.deepEqual(users('space', 'spaceAttributeDefinitions', 'Env'), [['space', 'The space sets attribute "Env"']]);
  assert.deepEqual(users('space', 'teamAttributeDefinitions', 'Mail'), [['teams/Ops', 'Team "Ops" sets attribute "Mail"']]);
  assert.deepEqual(users('space', 'securityPolicyDefinitions', 'Everyone'), [['space', 'S is secured by policy "Everyone"']]);
  // A kapp's own definition of the same name is what its forms use.
  assert.deepEqual(users('space', 'securityPolicyDefinitions', 'Admins'), []);
  assert.deepEqual(users('kapps/k/kapp', 'integrations', 'Anything'), []);
});

test('an entry still in use is removed anyway, with the warning in the plan', async () => {
  const routes = target({
    'GET core/kapps/services': { kapp: { ...kappData(true), forms: [{ slug: 'f', name: 'F', type: 'Old Thing' }], webApis: [] } },
    'GET core/kapps/services/forms/f/workflows': { workflows: [] },
  });
  const h = harness(routes);
  const key = entryKey('kapps/services/kapp', 'formTypes', 'Old Thing');
  const { plan } = await computePlan({ projectDir: project(), envName: 'prod', remove: [key], clientFactory: h.clientFactory });
  assert.deepEqual(plan.removals[0].usedBy.map((u) => [u.key, u.reason, u.onlyTarget]), [['kapps/services/forms/f/form', 'Form "F" is of type "Old Thing"', true]]);
  assert.ok(plan.warnings.some((w) => w.startsWith(`${key}: still used by kapps/services/forms/f/form`)));
  const res = await runApply({ projectDir: project(), envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory, remove: [key] });
  assert.equal(res.code, 0);
  assert.deepEqual(h.writes(), ['DELETE /kapps/services/formTypes/Old%20Thing']);
});

test('an entry changed in the target since review is not deleted', async () => {
  const h = harness();
  const key = entryKey('space', 'securityPolicyDefinitions', 'Old Thing');
  const { plan } = await computePlan({ projectDir: project(), envName: 'prod', remove: [key], clientFactory: h.clientFactory });
  const reviewed = plan.removals[0].hash;
  const changed = spaceData(true);
  changed.securityPolicyDefinitions[1].rule = 'edited';
  const h2 = harness(target({ 'GET core/space': { space: changed } }));
  let seen;
  await runApply({ projectDir: project(), envName: 'prod', yes: true, log: () => {}, clientFactory: h2.clientFactory, remove: [key], removeExpected: { [key]: reviewed }, onPlan: (p) => { seen = p; } });
  assert.deepEqual(h2.writes(), []);
  assert.equal(seen.removals[0].action, 'skip-drift');
});

test('an entry of a kapp that is itself removed goes with the kapp', () => {
  const tgt = new Map([['kapps/old/kapp', { key: 'kapps/old/kapp', data: { slug: 'old', categories: [{ slug: 'x' }] }, meta: {} }]]);
  const r = planRemovals({ modules: MODULES, exported: new Map(), target: tgt, remove: ['kapps/old/kapp', entryKey('kapps/old/kapp', 'categories', 'x')] });
  assert.deepEqual(r.removals.map((x) => x.key), ['kapps/old/kapp']);
});

test('a key with # in an item name is an item, not an entry', () => {
  assert.equal(parseEntryKey('teams/R&D #1'), null);
  const tgt = new Map([['teams/R&D #1', { key: 'teams/R&D #1', data: { name: 'R&D #1' }, meta: { slug: 'rd-1' } }]]);
  const r = planRemovals({ modules: MODULES, exported: new Map(), target: tgt, remove: ['teams/R&D #1'] });
  assert.deepEqual([r.errors, r.removals.map((x) => x.action)], [[], ['delete']]);
});
