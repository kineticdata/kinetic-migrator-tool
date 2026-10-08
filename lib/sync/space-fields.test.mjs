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
import { hashOf, omit, stateEntry, driftedFrom, driftStatus, parseRecorded, SPACE_DRIFT_SKIPPED } from './normalize.mjs';
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
  assert.equal(envBoundSpaceFieldsError(['trustedFrameDomains', 'loginPage']), null);
  assert.equal(envBoundSpaceFieldsError([]), null);
  assert.match(envBoundSpaceFieldsError(['slug']), /"slug" cannot be kept per environment \(choose from displayType, /);
  assert.match(envBoundSpaceFieldsError('displayValue'), /must be a list/);
  assert.match(envBoundSpaceFieldsError([1]), /must be a list/);
  assert.deepEqual(sanitizeEnvBoundSpaceFields(undefined), { value: DEFAULT_ENV_BOUND_SPACE_FIELDS, warnings: [] });
});

test('linked settings go as pairs: half a pair is refused on save and stands for the whole pair on load', () => {
  assert.equal(envBoundSpaceFieldsError(['displayType', 'displayValue', 'allowedIps', 'allowedIpsEnabled']), null);
  assert.match(envBoundSpaceFieldsError(['displayValue']), /"displayType" and "displayValue" go together; list both or neither\./);
  assert.match(envBoundSpaceFieldsError(['allowedIpsEnabled', 'loginPage']), /"allowedIps" and "allowedIpsEnabled" go together/);
  const loaded = sanitizeEnvBoundSpaceFields(['displayValue', 'allowedIps']);
  assert.deepEqual(loaded.value, ['displayType', 'displayValue', 'allowedIps', 'allowedIpsEnabled']);
  assert.deepEqual(loaded.warnings, [
    '"envBoundSpaceFields": "displayType" and "displayValue" go together; both are kept.',
    '"envBoundSpaceFields": "allowedIps" and "allowedIpsEnabled" go together; both are kept.',
  ]);
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

test('a kept setting is never taken from the source: an empty or missing target value stays as it is, and pairs stay together', () => {
  const fresh = { name: 'New', slug: 'new', displayType: 'Display Page', displayValue: null, trustedFrameDomains: [], allowedIpsEnabled: false };
  const source = { ...dev, displayType: 'Custom', trustedFrameDomains: ['localhost:3000'], allowedIps: '10.0.0.0/8', allowedIpsEnabled: true };
  const s = space(plan({ exported: source, target: fresh }));
  assert.equal(s.desired.displayType, 'Display Page');
  assert.equal(s.desired.displayValue, null);
  assert.deepEqual(s.desired.trustedFrameDomains, []);
  assert.equal(s.desired.allowedIpsEnabled, false);
  // Missing in the target: left out, so the apply does not send it.
  assert.equal('allowedIps' in s.desired, false);
  assert.equal('trustedResourceDomains' in s.desired, false);
  // A setting an admin cleared after an earlier promotion stays cleared.
  const cleared = space(plan({ exported: source, target: { ...prod, trustedFrameDomains: [] }, state: { space: stateEntry('space', prod, config(), 'space') } }));
  assert.deepEqual(cleared.desired.trustedFrameDomains, []);
  assert.equal(cleared.drift, false);
});

test('an override of a kept setting wins over the target value', () => {
  const overrides = { artifacts: { space: { displayValue: 'https://cdn.example.com/prod' } } };
  const s = space(plan({ overrides }));
  assert.equal(s.desired.displayValue, 'https://cdn.example.com/prod');
  const direct = prepareDesired({ key: 'space', scope: 'space', exported: dev, existing: prod, overrides, vars: {}, envBoundAttributes: {}, envBoundSpaceFields: ['displayValue'] });
  assert.equal(direct.displayValue, 'https://cdn.example.com/prod');
});

test('preflight notes a kept setting that is empty in the target while the source has a value, unless an override sets it', () => {
  const fresh = { name: 'New', slug: 'new', displayValue: '' };
  const check = (overrides, state = {}) => {
    const p = plan({ target: fresh, overrides, state });
    return preflightChecks({ plan: p, exported: new Map([['space', dev]]), target: new Map([['space', { key: 'space', data: fresh }]]), config: config(), hasSecrets: () => true })
      .warnings.filter((w) => w.startsWith('space:'));
  };
  const note = (f) => `space: "${f}" is kept per environment and empty in the target; the source has a value, which is not copied (set an override to use it)`;
  assert.deepEqual(check({}), [note('displayType'), note('displayValue')]);
  assert.deepEqual(check({ artifacts: { space: { displayValue: 'https://cdn.example.com/new', displayType: 'Redirect' } } }), []);
  // Not for a drifted space, which is left alone anyway.
  assert.deepEqual(check({}, { space: stateEntry('space', { ...fresh, description: 'before' }, config(), 'space') }), []);
});

test('the space state entry names the field set it was hashed with; other entries stay plain hashes', () => {
  const entry = stateEntry('space', prod, config({ envBoundSpaceFields: ['displayValue', 'loginPage'] }), 'space');
  assert.match(entry, /^[0-9a-f]{64};space-fields=displayValue,loginPage$/);
  assert.deepEqual(parseRecorded(entry).spaceFields, ['displayValue', 'loginPage']);
  assert.deepEqual(parseRecorded('abc'), { hash: 'abc', spaceFields: null });
  assert.match(stateEntry('team', { name: 'Ops' }, config(), 'teams/Ops'), /^[0-9a-f]{64}$/);
  assert.equal(driftedFrom('team', { name: 'Ops' }, hashOf({ name: 'Ops' }), config(), 'teams/Ops'), false);
});

test('upgrade: state recorded before the list existed skips the space drift check, with a warning, instead of guessing', () => {
  const state = { space: legacyHash(prod) };
  // Untouched target, and one changed in a now-kept setting by hand: neither is reported as drift.
  for (const target of [prod, { ...prod, displayValue: 'https://prod.example.com/fixed' }]) {
    const p = plan({ state, target, cfg: config() });
    assert.equal(space(p).action, 'update');
    assert.equal(space(p).drift, false);
    assert.ok(p.warnings.includes(SPACE_DRIFT_SKIPPED));
  }
  assert.equal(SPACE_DRIFT_SKIPPED, 'Drift check for the space skipped: kept settings changed since the last promotion');
  // The old list (none chosen) still checks precisely.
  const same = plan({ state, target: { ...prod, sessionInactiveLimitInSeconds: 60 }, cfg: config({ envBoundSpaceFields: [] }) });
  assert.equal(space(same).drift, true);
  assert.equal(space(same).action, 'skip-drift');
  assert.equal(same.warnings.includes(SPACE_DRIFT_SKIPPED), false);
});

test('with the recorded list, drift is checked as usual; a changed list skips the check (no false drift) until the next apply', () => {
  const recordedWith = config({ envBoundSpaceFields: DEFAULT_ENV_BOUND_SPACE_FIELDS });
  const state = { space: stateEntry('space', prod, recordedWith, 'space') };
  assert.equal(driftStatus('space', prod, state.space, recordedWith, 'space'), 'clean');
  assert.equal(driftStatus('space', { ...prod, displayValue: 'x' }, state.space, recordedWith, 'space'), 'clean');
  assert.equal(driftStatus('space', { ...prod, loginPage: '/other' }, state.space, recordedWith, 'space'), 'drifted');
  assert.equal(space(plan({ state, target: { ...prod, loginPage: '/other' }, cfg: recordedWith })).action, 'skip-drift');
  for (const list of [[], ['displayType', 'displayValue'], [...DEFAULT_ENV_BOUND_SPACE_FIELDS, 'defaultLocale']]) {
    const cfg = config({ envBoundSpaceFields: list });
    assert.equal(driftStatus('space', { ...prod, defaultLocale: 'de' }, state.space, cfg, 'space'), 'unknown', `list ${list.join(',')}`);
    const p = plan({ state, target: { ...prod, defaultLocale: 'de' }, cfg });
    assert.equal(space(p).drift, false);
    assert.ok(p.warnings.includes(SPACE_DRIFT_SKIPPED));
  }
  // The same list in another order is the same list.
  assert.equal(driftStatus('space', prod, state.space, config({ envBoundSpaceFields: [...DEFAULT_ENV_BOUND_SPACE_FIELDS].reverse() }), 'space'), 'clean');
});

test('end to end: an upgraded project skips the space drift check, apply records the field set, checks resume, and a later list change skips again', async () => {
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
  // A target changed since the old promotion: the check is skipped, not guessed.
  live = { ...live, sessionInactiveLimitInSeconds: 60 };

  // The source changes a promoted setting; apply records the current field set.
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayValue: 'https://dev.example.com/b', defaultLocale: 'de' } }]);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory })).code, 0);
  assert.equal(live.displayValue, 'https://prod.example.com/b');
  assert.equal(live.defaultLocale, 'de');
  const recorded = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space;
  assert.deepEqual(parseRecorded(recorded).spaceFields, DEFAULT_ENV_BOUND_SPACE_FIELDS);

  // Normal checks again with the recorded list: a change in the target is drift.
  live = { ...live, loginPage: '/by-hand' };
  const checked = await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory });
  assert.equal(space(checked.plan).drift, true);
  live = { ...live, loginPage: undefined };

  // Ticking defaultLocale, then a source change: no false drift, the check is skipped.
  writeFileSync(join(dir, 'kinetic-sync.config.json'), JSON.stringify({ envBoundSpaceFields: ['displayType', 'displayValue', 'defaultLocale'] }));
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayValue: 'https://dev.example.com/b', defaultLocale: 'de', loginPage: '/in' } }]);
  const later = await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory });
  assert.equal(space(later.plan).action, 'update');
  assert.equal(space(later.plan).drift, false);
  assert.ok(later.plan.warnings.includes(SPACE_DRIFT_SKIPPED));
});
