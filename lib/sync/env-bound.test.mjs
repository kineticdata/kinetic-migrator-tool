import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envBoundNames, envBoundNamesFor, itemIdentity, ruleApplies, envBoundAttributesError } from './env-bound.mjs';
import { withoutEnvBound, carryEnvBound, hashOf } from './normalize.mjs';
import { prepareDesired } from './overrides.mjs';
import { buildPlan, preflightChecks } from './plan.mjs';

const attrs = (...names) => names.map((n) => ({ name: n, values: [`${n}-v`] }));
const names = (set) => [...set].sort();

test('itemIdentity reads kapp, form and team from the key, falling back to the data', () => {
  assert.deepEqual(itemIdentity('kapp', 'kapps/services/kapp', { slug: 'other' }), { kapp: 'services' });
  assert.deepEqual(itemIdentity('kapp', null, { slug: 'services' }), { kapp: 'services' });
  assert.deepEqual(itemIdentity('form', 'kapps/services/forms/it-request/form', {}), { kapp: 'services', form: 'it-request' });
  assert.deepEqual(itemIdentity('team', 'teams/Ops_Admins', { name: 'Ops/Admins' }), { team: 'Ops/Admins' });
  assert.deepEqual(itemIdentity('space', 'space', {}), {});
});

test('legacy string rules apply to every item at their level', () => {
  const eba = { kapp: ['Url'], form: ['Queue'], team: ['Email'], space: ['Host'], category: ['Icon'] };
  assert.deepEqual(names(envBoundNamesFor(eba, 'kapp', 'kapps/a/kapp')), ['Url']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'form', 'kapps/a/forms/b/form')), ['Queue']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'team', 'teams/T', { name: 'T' })), ['Email']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'space', 'space')), ['Host']);
  assert.deepEqual(names(envBoundNames(eba, 'category', { kapp: 'a', category: 'c' })), ['Icon']);
  assert.deepEqual(names(envBoundNamesFor(eba, null, 'x')), []);
});

test('scoped rules apply only where their where-parts match', () => {
  const eba = {
    space: [{ name: 'Host' }],
    kapp: [{ name: 'Url', kapp: 'services' }, { name: 'Any' }],
    form: [{ name: 'Queue', kapp: 'services' }, { name: 'Owner', kapp: 'services', form: 'leave' }, { name: 'Tag', form: 'leave' }],
    team: [{ name: 'Email', team: 'Ops' }],
    category: [{ name: 'Icon', kapp: 'services', category: 'hardware' }, { name: 'Color', category: 'software' }],
  };
  assert.deepEqual(names(envBoundNamesFor(eba, 'space', 'space')), ['Host']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'kapp', 'kapps/services/kapp')), ['Any', 'Url']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'kapp', 'kapps/hr/kapp')), ['Any']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'form', 'kapps/services/forms/leave/form')), ['Owner', 'Queue', 'Tag']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'form', 'kapps/services/forms/it/form')), ['Queue']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'form', 'kapps/hr/forms/leave/form')), ['Tag']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'team', 'teams/Ops', { name: 'Ops' })), ['Email']);
  assert.deepEqual(names(envBoundNamesFor(eba, 'team', 'teams/Dev', { name: 'Dev' })), []);
  // A category is matched by slug only (its name can differ between environments).
  assert.deepEqual(names(envBoundNames(eba, 'category', { kapp: 'services', category: 'hardware' })), ['Icon']);
  assert.deepEqual(names(envBoundNames(eba, 'category', { kapp: 'hr', category: 'hardware' })), []);
  assert.deepEqual(names(envBoundNames(eba, 'category', { kapp: 'hr', category: 'software' })), ['Color']);
  assert.deepEqual(names(envBoundNames(eba, 'category', { kapp: 'hr', category: 'Software' })), []);
  assert.equal(ruleApplies('kapp', 42, { kapp: 'x' }), false);
});

test('envBoundAttributesError accepts both shapes and explains malformed ones', () => {
  assert.equal(envBoundAttributesError({}), null);
  assert.equal(envBoundAttributesError({ kapp: ['Url', { name: 'X', kapp: 'k' }], category: [{ name: 'I', kapp: 'k', category: 'c' }] }), null);
  assert.match(envBoundAttributesError([]), /must map each level/);
  assert.match(envBoundAttributesError({ form: 'Queue' }), /must be a list/);
  assert.match(envBoundAttributesError({ form: [7] }), /entry 1 must be an attribute name or an object/);
  assert.match(envBoundAttributesError({ space: [{ name: 'H', kapp: 'k' }] }), /"kapp" is not allowed at the space level/);
});

test('withoutEnvBound and carryEnvBound honour scoped rules, including categories nested in a kapp', () => {
  const eba = { kapp: [{ name: 'Url', kapp: 'services' }], category: [{ name: 'Icon', kapp: 'services', category: 'hardware' }, 'Shared'] };
  const kapp = (slug, url, icon) => ({
    slug,
    attributes: attrs('Name', 'Url').map((a) => (a.name === 'Url' ? { ...a, values: [url] } : a)),
    categories: [
      { slug: 'hardware', name: 'Hardware', attributes: [{ name: 'Icon', values: [icon] }, { name: 'Shared', values: [icon] }, { name: 'Label', values: ['h'] }] },
      { slug: 'software', name: 'Software', attributes: [{ name: 'Icon', values: [icon] }] },
    ],
  });
  const dev = kapp('services', 'dev-url', 'dev-icon');
  const portable = withoutEnvBound('kapp', dev, eba, 'kapps/services/kapp');
  assert.deepEqual(portable.attributes.map((a) => a.name), ['Name']);
  assert.deepEqual(portable.categories[0].attributes.map((a) => a.name), ['Label']);
  // Only the scoped category loses Icon.
  assert.deepEqual(portable.categories[1].attributes.map((a) => a.name), ['Icon']);

  // Another kapp keeps the kapp-scoped attributes; the unscoped category rule still applies.
  const other = withoutEnvBound('kapp', kapp('hr', 'u', 'i'), eba, 'kapps/hr/kapp');
  assert.deepEqual(other.attributes.map((a) => a.name), ['Name', 'Url']);
  assert.deepEqual(other.categories[0].attributes.map((a) => a.name), ['Icon', 'Label']);

  const prod = kapp('services', 'prod-url', 'prod-icon');
  const carried = carryEnvBound('kapp', portable, prod, eba, dev, 'kapps/services/kapp');
  assert.deepEqual(carried.attributes.find((a) => a.name === 'Url').values, ['prod-url']);
  assert.deepEqual(carried.categories[0].attributes.find((a) => a.name === 'Icon').values, ['prod-icon']);
  assert.deepEqual(carried.categories[0].attributes.find((a) => a.name === 'Shared').values, ['prod-icon']);
  // Not env-bound there: the source value is promoted.
  assert.deepEqual(carried.categories[1].attributes.find((a) => a.name === 'Icon').values, ['dev-icon']);
});

test('prepareDesired keeps a form-scoped attribute only on the matching form', () => {
  const eba = { form: [{ name: 'Queue', kapp: 'services', form: 'leave' }] };
  const exported = { slug: 'leave', attributes: [{ name: 'Queue', values: ['dev'] }] };
  const existing = { slug: 'leave', attributes: [{ name: 'Queue', values: ['prod'] }] };
  const run = (key) => prepareDesired({ key, scope: 'form', exported, existing, overrides: {}, vars: {}, envBoundAttributes: eba });
  assert.deepEqual(run('kapps/services/forms/leave/form').attributes, [{ name: 'Queue', values: ['prod'] }]);
  assert.deepEqual(run('kapps/hr/forms/leave/form').attributes, [{ name: 'Queue', values: ['dev'] }]);
});

const MODULES = [
  { type: 'kapps', scope: 'kapp', owns: (k) => /^kapps\/[^/]+\/kapp$/.test(k) },
  { type: 'forms', scope: 'form', owns: (k) => /\/form$/.test(k) },
  { type: 'teams', scope: 'team', owns: (k) => /^teams\//.test(k) },
];

test('a promoted item does not show drift because of scoped rules (state hash matches plan hash)', () => {
  const eba = { form: [{ name: 'Queue', kapp: 'services', form: 'leave' }], team: [{ name: 'Email', team: 'Ops' }] };
  const config = { data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: eba };
  // After a promotion the target holds the promoted config plus its own env-bound values.
  const formKey = 'kapps/services/forms/leave/form';
  const target = { slug: 'leave', description: 'v1', attributes: [{ name: 'Queue', values: ['prod'] }] };
  const team = { name: 'Ops', description: 'v1', attributes: [{ name: 'Email', values: ['ops@prod'] }] };
  // recordState hashes exactly this.
  const state = {
    [formKey]: hashOf(withoutEnvBound('form', target, eba, formKey)),
    'teams/Ops': hashOf(withoutEnvBound('team', team, eba, 'teams/Ops')),
  };
  // Someone changes only the env-bound value in the target; then the source moves on.
  const changedTarget = { ...target, attributes: [{ name: 'Queue', values: ['prod-2'] }] };
  const changedTeam = { ...team, attributes: [{ name: 'Email', values: ['ops2@prod'] }] };
  const exported = new Map([
    [formKey, { slug: 'leave', description: 'v2', attributes: [{ name: 'Queue', values: ['dev'] }] }],
    ['teams/Ops', { name: 'Ops', description: 'v2', attributes: [{ name: 'Email', values: ['ops@dev'] }] }],
  ]);
  const p = buildPlan({
    modules: MODULES, exported, config, state, overrides: {}, vars: {},
    target: new Map([[formKey, { key: formKey, data: changedTarget }], ['teams/Ops', { key: 'teams/Ops', data: changedTeam }]]),
  });
  assert.deepEqual(p.items.map((i) => [i.key, i.action, i.drift]), [[formKey, 'update', false], ['teams/Ops', 'update', false]]);
  assert.deepEqual(p.items[0].desired.attributes, [{ name: 'Queue', values: ['prod-2'] }]);
});

test('preflight warns about empty env-bound attributes only where a scoped rule applies', () => {
  const eba = { form: [{ name: 'Queue', kapp: 'services' }] };
  const config = { data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: eba };
  const exported = new Map([
    ['kapps/services/forms/a/form', { slug: 'a' }],
    ['kapps/hr/forms/b/form', { slug: 'b' }],
  ]);
  const target = new Map();
  const plan = buildPlan({ modules: MODULES, exported, target, config, state: {}, overrides: {}, vars: {} });
  const { warnings } = preflightChecks({ plan, exported, target, config, hasSecrets: () => true });
  assert.deepEqual(warnings.filter((w) => /environment-bound/.test(w)), [
    'kapps/services/forms/a/form: environment-bound attribute "Queue" is empty in the target and no override sets it',
  ]);
});

test('a legacy all-names config hashes exactly as before scoped rules existed', () => {
  // Pinned output of the pre-rules implementation for this input.
  const eba = { kapp: ['Url'], category: ['Icon'] };
  const kapp = {
    slug: 'services', bundlePath: 'x', attributes: [{ name: 'Name', values: ['n'] }, { name: 'Url', values: ['u'] }],
    categories: [{ slug: 'hardware', attributes: [{ name: 'Icon', values: ['i'] }, { name: 'Label', values: ['l'] }] }, { slug: 'bare' }],
  };
  const out = withoutEnvBound('kapp', kapp, eba, 'kapps/services/kapp');
  assert.deepEqual(out, {
    slug: 'services', attributes: [{ name: 'Name', values: ['n'] }],
    categories: [{ slug: 'hardware', attributes: [{ name: 'Label', values: ['l'] }] }, { slug: 'bare', attributes: undefined }],
  });
  assert.equal(hashOf(out), hashOf({ slug: 'services', attributes: [{ name: 'Name', values: ['n'] }], categories: [{ slug: 'hardware', attributes: [{ name: 'Label', values: ['l'] }] }, { slug: 'bare' }] }));
});
