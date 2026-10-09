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
  // The hint names the snapshot folder, not the legacy export/ one.
  const named = plan([], [], { sourceName: 'dev', overrides: { artifacts: { 'teams/Typo': { a: 1 } } } });
  assert.equal(named.warnings[0], 'Override for "teams/Typo" matches nothing in the source snapshot (check the key against the file paths under snapshots/dev/)');
  assert.doesNotMatch(named.warnings[0], /export\//);
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
  assert.deepEqual(p.errors, ['Unrecognized file in the source snapshot: bogus/file']);
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
    'connections/Api/connection: the target has one with the same name but id c-other (the source has c1); reconcile by hand before promoting',
    'kapps/k/forms/f/form: references operation o-missing, which is neither in the source snapshot nor in the target',
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

test('select: unselected items are excluded (with what they would be), target-only items are flagged, and excluded drift is silent', () => {
  const state = { 'teams/Drifted': hashOf({ name: 'Drifted', description: 'as last applied' }) };
  const p = plan(
    [['teams/New', { name: 'New' }], ['teams/Changed', { name: 'Changed', description: 'new' }], ['teams/Same', { name: 'Same' }], ['teams/Drifted', { name: 'Drifted', description: 'new' }]],
    [art('teams/Changed', { name: 'Changed', description: 'old' }), art('teams/Same', { name: 'Same' }), art('teams/Drifted', { name: 'Drifted', description: 'edited' }), art('teams/Extra', { name: 'Extra' }), art('teams/Gone', { name: 'Gone' })],
    { state, select: new Set(['teams/New', 'teams/Gone']) },
  );
  assert.deepEqual(p.items.map((i) => [i.key, i.action, i.wouldBe]), [
    ['teams/Changed', 'excluded', 'update'], ['teams/Drifted', 'excluded', 'skip-drift'], ['teams/New', 'create', undefined], ['teams/Same', 'excluded', 'unchanged'],
  ]);
  assert.deepEqual(p.targetOnly.map((t) => [t.key, Boolean(t.excluded)]), [['teams/Extra', true], ['teams/Gone', false]]);
  assert.deepEqual(p.warnings, []);
});

test('resolutions: overwrite turns one drifted item into an update, keep leaves it skipped', () => {
  const exported = [['teams/A', { name: 'A', description: 'new' }], ['teams/B', { name: 'B', description: 'new' }]];
  const target = [art('teams/A', { name: 'A', description: 'edited' }), art('teams/B', { name: 'B', description: 'edited' })];
  const state = { 'teams/A': hashOf({ name: 'A' }), 'teams/B': hashOf({ name: 'B' }) };
  const p = plan(exported, target, { state, resolutions: { 'teams/A': 'overwrite', 'teams/B': 'keep' } });
  assert.deepEqual(p.items.map((i) => [i.key, i.action, i.drift]), [['teams/A', 'update', true], ['teams/B', 'skip-drift', true]]);
  assert.match(p.warnings.join('\n'), /teams\/A.*will be overwritten/);
});

test('preflight with a selection: a selected form needing an unselected new operation is an error; selected or target deps are fine', () => {
  const exported = new Map([
    ['connections/Api/connection', { id: 'c1', name: 'Api' }],
    ['connections/Api/operations/Create', { id: 'o-new' }],
    ['connections/Api/operations/Get', { id: 'o1' }],
    ['kapps/k/forms/f/form', { integrations: [{ connectionId: 'c1', operationId: 'o-new' }, { connectionId: 'c1', operationId: 'o1' }] }],
    ['kapps/k/forms/other/form', { integrations: [{ connectionId: 'c1', operationId: 'o-missing' }] }],
  ]);
  const target = new Map([art('connections/Api/connection', { id: 'c1', name: 'Api' }), art('connections/Api/operations/Get', { id: 'o1' }), art('kapps/k/kapp', {})]);
  const check = (select) => {
    const p = plan([...exported], [...target], { select });
    return preflightChecks({ plan: p, exported, target, config: CONFIG, hasSecrets: () => true, select }).errors;
  };
  assert.deepEqual(check(new Set(['kapps/k/forms/f/form'])), [
    'kapps/k/forms/f/form needs connections/Api/operations/Create (references operation o-new), which is not selected and not in the target',
  ]);
  assert.deepEqual(check(new Set(['kapps/k/forms/f/form', 'connections/Api/operations/Create'])), []);
});

test('preflight with a selection: a selected workflow needing an unselected exported handler not in the target is an error', () => {
  const exported = new Map([
    ['handlers/mail_send_v1/handler', { definitionId: 'mail_send_v1' }],
    ['kapps/k/workflows/Submission Created/Notify', { name: 'Notify', treeXml: '<task definition_id="mail_send_v1"/><task definition_id="utilities_echo_v1"/>' }],
  ]);
  const modules = [...MODULES, mod('handlers', /^handlers\//)];
  const target = new Map([art('kapps/k/kapp', {})]);
  const run = (select) => {
    const p = buildPlan({ modules, exported, target, state: {}, overrides: {}, vars: {}, config: CONFIG, select });
    return preflightChecks({ plan: p, exported, target, config: CONFIG, hasSecrets: () => true, select }).errors;
  };
  assert.deepEqual(run(new Set(['kapps/k/workflows/Submission Created/Notify'])), [
    'kapps/k/workflows/Submission Created/Notify needs handlers/mail_send_v1/handler (runs handler mail_send_v1), which is not selected and not in the target',
  ]);
  assert.deepEqual(run(new Set(['kapps/k/workflows/Submission Created/Notify', 'handlers/mail_send_v1/handler'])), []);
});

const MODULES_WITH_KAPPS = [...MODULES, mod('kapps', /^kapps\/[^/]+\/kapp$/, { scope: 'kapp' })];
const selectionErrors = (exported, target, select, modules = MODULES_WITH_KAPPS) => {
  const ex = new Map(exported);
  const tg = new Map(target);
  const p = buildPlan({ modules, exported: ex, target: tg, state: {}, overrides: {}, vars: {}, config: CONFIG, select });
  return preflightChecks({ plan: p, exported: ex, target: tg, config: CONFIG, hasSecrets: () => true, select }).errors;
};

test('preflight with a selection: a dependency is satisfied by the target only by id, never by key, and its name checks still run', () => {
  const errors = selectionErrors(
    [['connections/Api/connection', { id: 'c1', name: 'Api' }], ['connections/Api/operations/Create', { id: 'o-new', connectionId: 'c1' }],
      ['kapps/k/forms/f/form', { integrations: [{ connectionId: 'c1', operationId: 'o-new' }] }]],
    [art('connections/Api/connection', { id: 'c1', name: 'Api' }), art('connections/Api/operations/Create', { id: 'o-old', connectionId: 'c1' }),
      art('kapps/k/kapp', { slug: 'k' }), art('kapps/k/forms/f/form', {})],
    new Set(['kapps/k/forms/f/form']),
  );
  assert.deepEqual(errors, [
    'connections/Api/operations/Create: the target has one with the same name but id o-old (the source has o-new); reconcile by hand before promoting',
    'kapps/k/forms/f/form needs connections/Api/operations/Create (references operation o-new), which is not selected and not in the target',
  ]);
});

test('preflight with a selection: a selected new operation needs its connection selected or in the target by id', () => {
  const exported = [['connections/New/connection', { id: 'c9', name: 'New' }], ['connections/New/operations/Get', { id: 'o9', connectionId: 'c9' }]];
  assert.deepEqual(selectionErrors(exported, [], new Set(['connections/New/operations/Get'])), [
    'connections/New/operations/Get needs connections/New/connection (operation of connection c9), which is not selected and not in the target',
  ]);
  assert.deepEqual(selectionErrors(exported, [], new Set(['connections/New/operations/Get', 'connections/New/connection'])), []);
  assert.deepEqual(selectionErrors(exported, [art('connections/New/connection', { id: 'c9', name: 'New' })], new Set(['connections/New/operations/Get'])), []);
});

test('preflight with a selection: a selected new form needs its kapp, a workflow its form or kapp', () => {
  const exported = [
    ['kapps/k/kapp', { slug: 'k' }],
    ['kapps/k/forms/f/form', { slug: 'f' }],
    ['kapps/k/forms/f/workflows/Submission Created/Notify', { name: 'Notify' }],
    ['kapps/k/workflows/Submission Created/Audit', { name: 'Audit' }],
  ];
  assert.deepEqual(selectionErrors(exported, [], new Set(['kapps/k/forms/f/form'])), [
    'kapps/k/forms/f/form needs kapps/k/kapp (form in kapp k), which is not selected and not in the target',
  ]);
  assert.deepEqual(selectionErrors(exported, [art('kapps/k/kapp', { slug: 'k' })], new Set(['kapps/k/forms/f/workflows/Submission Created/Notify', 'kapps/k/workflows/Submission Created/Audit'])), [
    'kapps/k/forms/f/workflows/Submission Created/Notify needs kapps/k/forms/f/form (workflow on form f), which is not selected and not in the target',
  ]);
  assert.deepEqual(selectionErrors(exported, [], new Set(['kapps/k/workflows/Submission Created/Audit'])), [
    'kapps/k/workflows/Submission Created/Audit needs kapps/k/kapp (workflow on kapp k), which is not selected and not in the target',
  ]);
  assert.deepEqual(selectionErrors(exported, [], new Set(exported.map(([k]) => k))), []);
});
