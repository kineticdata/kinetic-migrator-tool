// lib/sync/plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffValues, mergeTargetOnly, buildPlan, integrationRefs, preflightChecks } from './plan.mjs';
import { hashOf } from './normalize.mjs';

const mod = (type, re, extra = {}) => ({ type, scope: null, owns: (k) => re.test(k), ...extra });
const MODULES = [
  mod('space', /^space$/, { scope: 'space', namedCollections: [{ field: 'spaceAttributeDefinitions', key: 'name' }] }),
  mod('teams', /^teams\//, { scope: 'team' }),
  mod('connections', /^connections\/[^/]+\/connection$/, { updatable: false }),
  mod('operations', /^connections\/[^/]+\/operations\//),
  mod('forms', /^kapps\/[^/]+\/forms\/[^/]+\/form$/, { scope: 'form' }),
  mod('workflows', /\/workflows\//),
  mod('data', /\/data$/),
  mod('task-refs', /^task-refs$/, { applyable: false }),
];
const CONFIG = { data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {} };
const art = (key, data, meta = {}) => [key, { key, data, meta }];
const plan = (exported, target, extra = {}) => buildPlan({
  modules: MODULES, exported: new Map(exported), target: new Map(target), state: {}, overrides: {}, vars: { targetUrl: 'https://t' }, config: CONFIG, ...extra,
});

test('diffValues reports leaf paths, matching named array items by name', () => {
  assert.deepEqual(diffValues({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 }), [
    { path: 'b.c', from: 2, to: 3 }, { path: 'd', from: undefined, to: 4 },
  ]);
  assert.deepEqual(diffValues({ attributes: [{ name: 'X', values: ['1'] }] }, { attributes: [{ name: 'X', values: ['2'] }] }), [
    { path: 'attributes[X].values.0', from: '1', to: '2' },
  ]);
  assert.deepEqual(diffValues({ l: [1, 2] }, { l: [1, 2, 3] }), [{ path: 'l', from: [1, 2], to: [1, 2, 3] }]);
  assert.deepEqual(diffValues(1, 2), [{ path: '(root)', from: 1, to: 2 }]);
  assert.deepEqual(diffValues({ a: 1 }, { a: 1 }), []);
});

test('mergeTargetOnly appends target-only named items in sorted order', () => {
  const out = mergeTargetOnly({ defs: [{ name: 'b' }] }, { defs: [{ name: 'a' }, { name: 'b', x: 1 }] }, [{ field: 'defs', key: 'name' }]);
  assert.deepEqual(out, { defs: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual(mergeTargetOnly({ defs: [] }, null, [{ field: 'defs', key: 'name' }]), { defs: [] });
});

test('buildPlan classifies create, update and unchanged, and lists target-only applyable artifacts', () => {
  const p = plan(
    [['teams/New', { name: 'New' }], ['teams/Same', { name: 'Same' }], ['teams/Changed', { name: 'Changed', description: 'new' }], ['task-refs', { handlers: [] }]],
    [art('teams/Same', { name: 'Same' }), art('teams/Changed', { name: 'Changed', description: 'old' }), art('teams/Extra', { name: 'Extra' }), art('task-refs', {})],
  );
  assert.deepEqual(p.items.map((i) => [i.key, i.action]), [['teams/Changed', 'update'], ['teams/New', 'create'], ['teams/Same', 'unchanged']]);
  assert.deepEqual(p.items[0].diff, [{ path: 'description', from: 'old', to: 'new' }]);
  assert.deepEqual(p.targetOnly.map((t) => t.key), ['teams/Extra']);
  assert.equal(p.items[0].scope, 'team');
});

test('env-bound fields never show as changes and target-only sub-items are kept', () => {
  const p = plan(
    [['space', { name: 'Dev', spaceAttributeDefinitions: [{ name: 'A' }] }]],
    [art('space', { name: 'Prod', spaceAttributeDefinitions: [{ name: 'A' }, { name: 'TargetOnly' }] })],
  );
  assert.equal(p.items[0].action, 'unchanged');
  assert.deepEqual(p.items[0].desired.spaceAttributeDefinitions.map((d) => d.name), ['A', 'TargetOnly']);
});

test('overrides apply, and an override for an unknown key is a warning', () => {
  const p = plan(
    [['connections/Api/operations/Get', { id: 'o', path: 'DEV/x' }]],
    [art('connections/Api/operations/Get', { id: 'o', path: 'PROD/x' })],
    { overrides: { artifacts: { 'connections/Typo/connection': { a: 1 } }, replace: [{ from: 'DEV', to: 'PROD' }] } },
  );
  assert.equal(p.items[0].action, 'unchanged');
  assert.match(p.warnings[0], /connections\/Typo/);
});

test('drift: changed since last apply is skipped unless overwriteDrift; unrecorded is not drift', () => {
  const exported = [['teams/Ops', { name: 'Ops', description: 'from export' }]];
  const target = [art('teams/Ops', { name: 'Ops', description: 'edited in prod' })];
  const state = { 'teams/Ops': hashOf({ name: 'Ops', description: 'as last applied' }) };
  const skipped = plan(exported, target, { state });
  assert.equal(skipped.items[0].action, 'skip-drift');
  assert.equal(skipped.items[0].drift, true);
  assert.match(skipped.warnings[0], /teams\/Ops.*--overwrite-drift/);
  assert.equal(plan(exported, target, { state, overwriteDrift: true }).items[0].action, 'update');
  assert.equal(plan(exported, target).items[0].action, 'update');
});

test('a changed connection is manual, and an unknown export file is an error', () => {
  const p = plan(
    [['connections/Api/connection', { id: 'c', config: { baseUrl: 'new' } }], ['bogus/file', {}]],
    [art('connections/Api/connection', { id: 'c', config: { baseUrl: 'old' } })],
  );
  assert.equal(p.items[0].action, 'manual');
  assert.match(p.warnings.join('\n'), /connections\/Api.*by hand/);
  assert.deepEqual(p.errors, ['Unrecognized file in export: bogus/file']);
});

test('integrationRefs reads integrations and system_integration_v1 node parameters', () => {
  assert.deepEqual(integrationRefs({
    integrations: [{ connectionId: 'c1', operationId: 'o1' }],
    treeJson: { nodes: [
      { definitionId: 'system_integration_v1', parameters: [{ id: 'connection', value: 'c2' }, { id: 'operation', value: 'o2' }] },
      { definitionId: 'utilities_echo_v1', parameters: [{ id: 'connection', value: 'ignored' }] },
    ] },
  }), [{ connectionId: 'c1', operationId: 'o1' }, { connectionId: 'c2', operationId: 'o2' }]);
});

test('preflight: dangling ids, same-name-different-id, missing secrets, firing workflows, empty env-bound attributes', () => {
  const exported = new Map([
    ['connections/Api/connection', { id: 'c1', name: 'Api' }],
    ['connections/Api/operations/Get', { id: 'o1' }],
    ['connections/New/connection', { id: 'c9', name: 'New' }],
    ['kapps/k/forms/f/form', { integrations: [{ connectionId: 'c1', operationId: 'o-missing' }, { connectionId: '<%= @inputs["c"] %>', operationId: 'o1' }] }],
    ['kapps/k/forms/codes/data', { key: ['Code'], rows: [{ Code: 'A' }] }],
    ['kapps/k/forms/codes/workflows/Submission Submitted/Sync Rows', { name: 'Sync Rows', event: 'Submission Submitted', status: 'Active' }],
  ]);
  const target = new Map([art('connections/Api/connection', { id: 'c-other', name: 'Api' })]);
  const p = buildPlan({
    modules: MODULES, exported, target, state: {}, overrides: {}, vars: {},
    config: { ...CONFIG, envBoundAttributes: { form: ['Environment'] } },
  });
  const { errors, warnings } = preflightChecks({ plan: p, exported, target, config: { ...CONFIG, envBoundAttributes: { form: ['Environment'] } }, hasSecrets: () => false });
  assert.deepEqual(errors, [
    'connections/Api/connection: the target has one with the same name but id c-other (export has c1); reconcile by hand before promoting',
    'kapps/k/forms/f/form: references operation o-missing, which is neither exported nor in the target',
  ]);
  assert.ok(warnings.some((w) => /connections\/New\/connection: will be created without credentials/.test(w)));
  assert.ok(warnings.some((w) => /kapps\/k\/forms\/codes\/data: .*Sync Rows \(Submission Submitted\)/.test(w)));
  assert.ok(warnings.some((w) => /kapps\/k\/forms\/f\/form: environment-bound attribute "Environment"/.test(w)));
});

test('diffValues detects reordered named arrays and falls back on duplicate names', () => {
  assert.deepEqual(
    diffValues({ pages: [{ name: 'A' }, { name: 'B' }] }, { pages: [{ name: 'B' }, { name: 'A' }] }),
    [{ path: 'pages', from: ['A', 'B'], to: ['B', 'A'] }],
  );
  const from = { l: [{ name: 'A' }, { name: 'A', x: 1 }] };
  const to = { l: [{ name: 'A' }, { name: 'A', x: 2 }] };
  assert.deepEqual(diffValues(from, to), [{ path: 'l', from: from.l, to: to.l }]);
});

test('buildPlan treats an element-order-only change as an update', () => {
  const els = (...n) => ({ elements: n.map((name) => ({ name })) });
  const p = plan([['kapps/k/forms/f/form', els('a', 'b')]], [art('kapps/k/forms/f/form', els('b', 'a'))]);
  assert.equal(p.items[0].action, 'update');
  assert.deepEqual(p.items[0].diff, [{ path: 'elements', from: ['b', 'a'], to: ['a', 'b'] }]);
});

test('preflight: an exported connection or operation id held by a different key in the target is a rename error', () => {
  const exported = new Map([
    ['connections/New Name/connection', { id: 'c1', name: 'New Name' }],
    ['connections/New Name/operations/Get', { id: 'o1' }],
  ]);
  const target = new Map([
    art('connections/Old Name/connection', { id: 'c1', name: 'Old Name' }),
    art('connections/Old Name/operations/Get', { id: 'o1' }),
  ]);
  const p = plan([...exported], [...target]);
  const { errors } = preflightChecks({ plan: p, exported, target, config: CONFIG, hasSecrets: () => true });
  assert.deepEqual(errors, [
    'connections/New Name/connection: id c1 already exists in the target as connections/Old Name/connection; it was probably renamed — reconcile by hand before promoting',
    'connections/New Name/operations/Get: id o1 already exists in the target as connections/Old Name/operations/Get; it was probably renamed — reconcile by hand before promoting',
  ]);
});

test('preflight: data warnings include kapp, space and target-only submission workflows, de-duplicated, skipping inactive ones', () => {
  const exported = new Map([
    ['kapps/k/forms/codes/data', { key: ['Code'], rows: [{ Code: 'A' }] }],
    ['kapps/k/workflows/Submission Created/Kapp Audit', { name: 'Kapp Audit', event: 'Submission Created', status: 'Active' }],
    ['kapps/k/forms/codes/workflows/Submission Updated/Shared', { name: 'Shared', event: 'Submission Updated', status: 'Active' }],
    ['kapps/other/workflows/Submission Created/Elsewhere', { name: 'Elsewhere', event: 'Submission Created', status: 'Active' }],
  ]);
  const target = new Map([
    art('workflows/Submission Submitted/Space Hook', { name: 'Space Hook', event: 'Submission Submitted', status: 'Active' }),
    art('kapps/k/forms/codes/workflows/Submission Updated/Shared', { name: 'Shared', event: 'Submission Updated', status: 'Active' }),
    art('kapps/k/forms/codes/workflows/Submission Created/Off', { name: 'Off', event: 'Submission Created', status: 'Inactive' }),
    art('workflows/User Created/Welcome', { name: 'Welcome', event: 'User Created', status: 'Active' }),
  ]);
  const p = plan([...exported], [...target]);
  const { warnings } = preflightChecks({ plan: p, exported, target, config: CONFIG, hasSecrets: () => true });
  const w = warnings.find((x) => x.startsWith('kapps/k/forms/codes/data:'));
  assert.equal(w, 'kapps/k/forms/codes/data: creating/updating rows will run these workflows in the target: Kapp Audit (Submission Created), Shared (Submission Updated), Space Hook (Submission Submitted)');
});
