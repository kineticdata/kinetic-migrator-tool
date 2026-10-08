// Space settings kept per environment (config.envBoundSpaceFields): carrying,
// overrides, the plan's warning and drift that survives list changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_ENV_BOUND_SPACE_FIELDS, ENV_BOUND_SPACE_FIELD_CHOICES, envBoundSpaceFieldsError, sanitizeEnvBoundSpaceFields,
} from './env-bound.mjs';
import { hashOf, omit, stateEntry, driftedFrom, parseRecorded, withoutEnvBound } from './normalize.mjs';
import { prepareDesired } from './overrides.mjs';
import { buildPlan, preflightChecks } from './plan.mjs';
import { MODULES } from './artifacts/index.mjs';
import { runApply, runPlan } from './commands.mjs';
import { fakeClient } from './fake-client.mjs';
import { writeTree } from './store.mjs';

const EMPTY_SPACE = {
  'GET core/teams': { teams: [] },
  'GET core/fileResources': { fileResources: [] },
  'GET integrator/connections': [],
  'GET core/kapps': { kapps: [] },
  'GET core/workflows': { workflows: [] },
  'GET task/trees': { trees: [] },
  'GET task/handlers': { handlers: [] },
};

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-space-fields-'));
  mkdirSync(join(dir, 'environments'));
  writeFileSync(join(dir, 'environments', 'prod.json'), JSON.stringify({ url: 'https://prod.example.com' }));
  writeFileSync(join(dir, '.env.prod'), 'KINETIC_PROD_USERNAME=u\nKINETIC_PROD_PASSWORD=p\n');
  return dir;
}

const config = (extra = {}) => ({ data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {}, ...extra });
// What a build without envBoundSpaceFields recorded: only the fixed fields left out.
const legacyHash = (data) => hashOf(omit(data, ['name', 'slug', 'platformComponents', 'bundlePath', 'sharedBundleBase']));

const dev = { name: 'Dev', slug: 'dev', displayType: 'Single Page App', displayValue: 'https://dev.example.com/bundle', defaultLocale: 'fr', loginPage: '/dev-login' };
const prod = { name: 'Prod', slug: 'prod', displayType: 'Single Page App', displayValue: 'https://prod.example.com/bundle', defaultLocale: 'en', loginPage: '/login' };

function plan({ exported = dev, target = prod, state = {}, overrides = {}, cfg = config() }) {
  return buildPlan({
    modules: MODULES, config: cfg, state, overrides, vars: {},
    exported: new Map([['space', exported]]),
    target: target ? new Map([['space', { key: 'space', data: target }]]) : new Map(),
  });
}
const space = (p) => p.items.find((i) => i.key === 'space');

test('the allowed set is the six defaults plus six optional settings, and a PUT is checked against it', () => {
  assert.deepEqual(DEFAULT_ENV_BOUND_SPACE_FIELDS, ['displayType', 'displayValue', 'trustedFrameDomains', 'trustedResourceDomains', 'allowedIps', 'allowedIpsEnabled']);
  assert.equal(ENV_BOUND_SPACE_FIELD_CHOICES.length, 12);
  assert.equal(envBoundSpaceFieldsError(['displayValue', 'loginPage']), null);
  assert.equal(envBoundSpaceFieldsError([]), null);
  assert.match(envBoundSpaceFieldsError(['slug']), /"slug" cannot be kept per environment \(choose from displayType, /);
  assert.match(envBoundSpaceFieldsError('displayValue'), /must be a list/);
  assert.match(envBoundSpaceFieldsError([1]), /must be a list/);
  assert.deepEqual(sanitizeEnvBoundSpaceFields(undefined), { value: DEFAULT_ENV_BOUND_SPACE_FIELDS, warnings: [] });
});

test('defaults apply when the config does not list space settings: the target keeps its display settings', () => {
  const p = plan({ cfg: config() });
  const s = space(p);
  assert.equal(s.desired.displayValue, 'https://prod.example.com/bundle');
  assert.equal(s.desired.name, 'Prod');
  // Not in the defaults: promoted.
  assert.equal(s.desired.defaultLocale, 'fr');
  assert.equal(s.desired.loginPage, '/dev-login');
  assert.deepEqual(s.diff.map((d) => d.path).sort(), ['defaultLocale', 'loginPage']);
});

test('optional settings are kept when the project ticks them; an empty list promotes the display settings', () => {
  const extras = space(plan({ cfg: config({ envBoundSpaceFields: [...DEFAULT_ENV_BOUND_SPACE_FIELDS, 'loginPage', 'defaultLocale'] }) }));
  assert.equal(extras.action, 'unchanged');
  assert.equal(extras.desired.loginPage, '/login');
  const none = space(plan({ cfg: config({ envBoundSpaceFields: [] }) }));
  assert.equal(none.desired.displayValue, 'https://dev.example.com/bundle');
  // The always-kept fields stay with the target whatever the list.
  assert.equal(none.desired.name, 'Prod');
});

test('a space with no value yet (a first install) starts from the source value; false and 0 are values', () => {
  const fresh = { name: 'New', slug: 'new', displayValue: null, trustedFrameDomains: [], allowedIpsEnabled: false };
  const source = { ...dev, trustedFrameDomains: ['dev.example.com'], allowedIpsEnabled: true };
  const s = space(plan({ exported: source, target: fresh }));
  assert.equal(s.desired.displayValue, 'https://dev.example.com/bundle');
  assert.equal(s.desired.displayType, 'Single Page App');
  assert.deepEqual(s.desired.trustedFrameDomains, ['dev.example.com']);
  assert.equal(s.desired.allowedIpsEnabled, false);
  // Neither side has one: nothing to change.
  const both = space(plan({ exported: { name: 'Dev', allowedIps: null }, target: { name: 'New', allowedIps: null } }));
  assert.equal(both.action, 'unchanged');
});

test('an override of a kept setting wins over the target value', () => {
  const overrides = { artifacts: { space: { displayValue: 'https://cdn.example.com/prod' } } };
  const s = space(plan({ overrides }));
  assert.equal(s.desired.displayValue, 'https://cdn.example.com/prod');
  const direct = prepareDesired({ key: 'space', scope: 'space', exported: dev, existing: prod, overrides, vars: {}, envBoundAttributes: {}, envBoundSpaceFields: ['displayValue'] });
  assert.equal(direct.displayValue, 'https://cdn.example.com/prod');
});

test('preflight warns when a kept setting is empty in the target and the source value is used, unless an override sets it', () => {
  const fresh = { name: 'New', slug: 'new', displayValue: '' };
  const check = (overrides) => {
    const p = plan({ target: fresh, overrides });
    return preflightChecks({ plan: p, exported: new Map([['space', dev]]), target: new Map([['space', { key: 'space', data: fresh }]]), config: config(), hasSecrets: () => true })
      .warnings.filter((w) => w.startsWith('space:'));
  };
  assert.deepEqual(check({}), [
    'space: "displayType" is empty in the target, so the source value is used (set an override to choose another)',
    'space: "displayValue" is empty in the target, so the source value is used (set an override to choose another)',
  ]);
  assert.deepEqual(check({ artifacts: { space: { displayValue: 'https://cdn.example.com/new', displayType: 'Redirect' } } }), []);
});

test('the space state entry names the field set it was hashed with; other entries stay plain hashes', () => {
  const entry = stateEntry('space', prod, config({ envBoundSpaceFields: ['displayValue', 'loginPage'] }), 'space');
  assert.match(entry, /^[0-9a-f]{64};space-fields=displayValue,loginPage$/);
  assert.deepEqual(parseRecorded(entry).spaceFields, ['displayValue', 'loginPage']);
  assert.deepEqual(parseRecorded('abc'), { hash: 'abc', spaceFields: null });
  assert.match(stateEntry('team', { name: 'Ops' }, config(), 'teams/Ops'), /^[0-9a-f]{64}$/);
  assert.equal(driftedFrom('team', { name: 'Ops' }, hashOf({ name: 'Ops' }), config(), 'teams/Ops'), false);
});

test('upgrade: state recorded before the list existed shows no drift under the new defaults', () => {
  const state = { space: legacyHash(prod) };
  // The source moved on, so the space is an update; the target is untouched.
  const p = plan({ state, cfg: config() });
  assert.equal(space(p).action, 'update');
  assert.equal(space(p).drift, false);
  // A real change in the target since then is still drift.
  const changed = plan({ state, target: { ...prod, sessionInactiveLimitInSeconds: 60 } });
  assert.equal(space(changed).drift, true);
  assert.equal(space(changed).action, 'skip-drift');
});

test('changing the list never shows drift for an untouched target', () => {
  const recordedWith = config({ envBoundSpaceFields: DEFAULT_ENV_BOUND_SPACE_FIELDS });
  const state = { space: stateEntry('space', prod, recordedWith, 'space') };
  for (const list of [[], ['displayValue'], [...DEFAULT_ENV_BOUND_SPACE_FIELDS, 'loginPage', 'defaultLocale', 'defaultTimezone']]) {
    const s = space(plan({ state, cfg: config({ envBoundSpaceFields: list }) }));
    assert.equal(s.drift, false, `list ${list.join(',')}`);
  }
  // The recorded set decides, not the current one: a change to a field that
  // was kept per environment when recorded is not drift, even after unticking it.
  const s = space(plan({ state, target: { ...prod, displayValue: 'https://prod.example.com/v2' }, cfg: config({ envBoundSpaceFields: [] }) }));
  assert.equal(s.drift, false);
});

test('end to end: an upgraded project applies, records the field set, and a later list change shows no drift', async () => {
  const dir = tempProject();
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayValue: 'https://dev.example.com/b', defaultLocale: 'fr' } }]);
  let live = { name: 'Prod', slug: 'space', displayValue: 'https://prod.example.com/b', defaultLocale: 'fr' };
  const clientFactory = ({ mode }) => {
    const routes = { ...EMPTY_SPACE, 'GET core/space': () => ({ space: live }), 'PUT core/space': ({ body }) => { live = { ...live, ...body }; return { space: live }; } };
    return fakeClient(routes, { mode });
  };
  // State written by a build without the list.
  writeFileSync(join(dir, 'kinetic-sync.config.json'), '{}');
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({ space: legacyHash(live) }));

  const first = await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory });
  assert.equal(space(first.plan).action, 'unchanged');
  assert.equal(space(first.plan).drift, false);

  // The source changes a promoted setting; apply records the current field set.
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayValue: 'https://dev.example.com/b', defaultLocale: 'de' } }]);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory })).code, 0);
  assert.equal(live.displayValue, 'https://prod.example.com/b');
  assert.equal(live.defaultLocale, 'de');
  const recorded = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space;
  assert.deepEqual(parseRecorded(recorded).spaceFields, DEFAULT_ENV_BOUND_SPACE_FIELDS);

  // Ticking defaultLocale, then a source change: still no drift.
  writeFileSync(join(dir, 'kinetic-sync.config.json'), JSON.stringify({ envBoundSpaceFields: ['displayValue', 'defaultLocale'] }));
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayValue: 'https://dev.example.com/b', defaultLocale: 'de', loginPage: '/in' } }]);
  const later = await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory });
  assert.equal(space(later.plan).action, 'update');
  assert.equal(space(later.plan).drift, false);
  assert.equal(withoutEnvBound('space', live, {}, 'space', ['defaultLocale']).defaultLocale, undefined);
});
