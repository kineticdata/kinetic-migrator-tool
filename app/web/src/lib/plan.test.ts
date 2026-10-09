// Plan and apply rules: what must be ticked, which environment values are
// sent (and which are missing), plain fixes for plan errors, the apply phases
// and the live checklist built from streamed job events.
import { expect, test } from 'vitest';
import type { EnvironmentValue, PlanItemOut, PlanResult } from '../../../shared/sync-api';
import {
  PHASES, planWithRemovals, removalRows, applyOutcome, carryOver, satisfied, settleChecklist, attentionList, checklistFrom, errorFix, groupByPhase, parseValueText, restoreHref, backupHref, valueText, valuesPayload, writes,
} from './plan';

const item = (key: string, type: string, action: PlanItemOut['action'] = 'create', drift = false): PlanItemOut => ({
  key, type, label: key.split('/').at(-2) ?? key, action, drift, diff: [],
});

function plan(over: Partial<PlanResult> = {}): PlanResult {
  return {
    planId: 'pl1', name: '2 items from Dev', to: 'test', from: 'dev', changesetId: null, sourceCommit: 'c1', selected: [], remove: [], removals: [],
    items: [], counts: { create: 0, update: 0, unchanged: 0, manual: 0, 'skip-drift': 0, delete: 0 },
    needsAttention: [], environmentValues: [], secretsNeeded: [], errors: [], warnings: [], ...over,
  };
}

const ev = (id: string, over: Partial<EnvironmentValue> = {}): EnvironmentValue => ({
  id, key: id.split('#')[0], path: id.split('#')[1], label: id, from: 'a', to: 'b', origin: 'attribute', required: false, ...over,
});

test('the attention list keeps server entries, skips kept drift and adds the other preflight warnings', () => {
  const p = plan({
    items: [item('kapps/hr/forms/a/form', 'forms', 'update', true), item('kapps/hr/forms/b/form', 'forms', 'skip-drift', true)],
    needsAttention: [
      { id: 'drift:kapps/hr/forms/a/form', kind: 'drift', key: 'kapps/hr/forms/a/form', message: 'A was changed.' },
      { id: 'drift:kapps/hr/forms/b/form', kind: 'drift', key: 'kapps/hr/forms/b/form', message: 'B was changed.' },
      { id: 'handler:handlers/x/handler', kind: 'handler', key: 'handlers/x/handler', message: 'Installs handler X.' },
    ],
    warnings: [
      'kapps/hr/forms/c/data: creating/updating rows will run these workflows in the target: Notify',
      'connections/tickets/connection: will be created without credentials (set …)',
      'kapps/hr/kapp: environment-bound attribute "Web Server Url" is empty in the target and no override sets it',
    ],
  });
  const list = attentionList(p);
  expect(list.map((a) => a.id)).toEqual(['drift:kapps/hr/forms/a/form', 'handler:handlers/x/handler', 'warning:2']);
  expect(list.map((a) => a.send)).toEqual([true, true, false]);
  expect(list[2]).toMatchObject({ kind: 'warning', key: 'kapps/hr/kapp', message: 'Web Server Url of hr is empty in Test and nothing sets it.' });
  expect(list[2].valueId).toBeUndefined();
});

test('a handler setting the platform requires is taken care of by entering its secret or value, or by a tick', () => {
  const H = 'handlers/token_v1/handler';
  const p = plan({
    needsAttention: [
      { id: `handler-settings:${H}#key_b64`, kind: 'handler-settings', key: H, valueId: 'handler/TOKEN_V1__KEY_B64', message: 'Token needs key_b64 before its settings can be saved in Test.' },
      { id: `handler-settings:${H}#client_id`, kind: 'handler-settings', key: H, valueId: `${H}#properties.client_id.value`, message: 'Token needs client_id before its settings can be saved in Test.' },
    ],
  });
  const [secret, value] = attentionList(p);
  expect(secret).toMatchObject({ kind: 'handler-settings', send: true, valueId: 'handler/TOKEN_V1__KEY_B64' });
  expect(secret.message).toBe('Token needs key_b64 before its settings can be saved in Test. Enter it under Environment values, or tick to go ahead without it.');
  expect(satisfied(secret, new Set(), new Set())).toBe(false);
  expect(satisfied(secret, new Set(), new Set(['handler/TOKEN_V1__KEY_B64']))).toBe(true);
  expect(satisfied(value, new Set(), new Set([`${H}#properties.client_id.value`]))).toBe(true);
  expect(satisfied(value, new Set([value.id]), new Set())).toBe(true);
});

test('warnings read plainly; a missing attribute is taken care of by filling its value', () => {
  const p = plan({
    environmentValues: [ev('kapps/hr/kapp#attributes.Web Server Url', { label: 'Web Server Url', origin: 'attribute', to: null, required: true })],
    warnings: [
      'kapps/hr/kapp: environment-bound attribute "Web Server Url" is empty in the target and no override sets it',
      'Override for "kapps/old/kapp" matches nothing in the source snapshot (check the key against the file paths under snapshots/dev/)',
      'Something new',
    ],
  });
  const [attr, override, other] = attentionList(p);
  expect(attr).toMatchObject({ valueId: 'kapps/hr/kapp#attributes.Web Server Url', message: expect.stringMatching(/Fill it in under Environment values/) });
  expect(override.message).toBe('A saved environment value for old matches nothing being promoted, so it is ignored.');
  expect(other).toMatchObject({ key: null, message: 'Something new' });
  expect(satisfied(attr, new Set(), new Set())).toBe(false);
  expect(satisfied(attr, new Set(), new Set(['kapps/hr/kapp#attributes.Web Server Url']))).toBe(true);
  expect(satisfied(other, new Set(['warning:2']), new Set())).toBe(true);
});

test('kept space settings: the "not copied" note is covered by Environment values; a skipped space drift check reads plainly', () => {
  const list = attentionList(plan({
    warnings: [
      'space: "displayValue" is kept per environment and empty in the target; the source has a value, which is not copied (set an override to use it)',
      'Drift check for the space skipped: kept settings changed since the last promotion',
    ],
  }));
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: 'warning:1', key: 'space', message: expect.stringMatching(/^The space's kept settings changed since it was last promoted to Test, so changes made to it in Test since then cannot be detected this time/) });
});

test('plan errors come with a plain fix', () => {
  expect(errorFix('Routine Notify Manager is used by exported workflows but does not exist in the target', 'dev', 'test').fix)
    .toMatch(/Add the routine to the changeset, or create it in Test first/);
  expect(errorFix('Handler smtp_send_v1 is used by exported workflows but is not installed in the target', 'dev', 'test').fix)
    .toMatch(/install it in Test/);
  expect(errorFix('kapps/hr/forms/a/form: not in the source snapshot', 'dev', 'test').fix).toMatch(/new snapshot of Dev/);
  expect(errorFix('kapps/hr/forms/a/form: id 12 already exists in the target as kapps/hr/forms/b/form; it was probably renamed — reconcile by hand before promoting', 'dev', 'test').fix)
    .toMatch(/Reconcile it by hand in Test/);
  expect(errorFix('Something odd', 'dev', 'test')).toEqual({ message: 'Something odd', fix: 'Fix the cause in Dev or Test, then plan again.' });
});

test('value text round-trips by the original type', () => {
  expect(valueText(null)).toBe('');
  expect(valueText(undefined)).toBe('');
  expect(valueText('https://api.example.com')).toBe('https://api.example.com');
  expect(valueText(30)).toBe('30');
  expect(valueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  expect(parseValueText('42', 30)).toEqual({ value: 42 });
  expect(parseValueText('forty', 30)).toEqual({ error: 'Enter a number.' });
  expect(parseValueText('', 30)).toEqual({ error: 'Enter a number.' });
  expect(parseValueText('false', true)).toEqual({ value: false });
  expect(parseValueText('{"a":2}', { a: 1 })).toEqual({ value: { a: 2 } });
  expect(parseValueText('{oops', { a: 1 })).toEqual({ error: 'Enter valid JSON.' });
  expect(parseValueText('x', null)).toEqual({ value: 'x' });
});

test('only edited values are sent, required ones must be filled', () => {
  const values = [
    ev('kapps/hr/kapp#attributes[Web Server Url]', { from: 'https://dev.example.com', to: 'https://test.example.com' }),
    ev('connections/tickets/connection#baseUrl', { from: 'https://api.example.com', to: null, required: true }),
    ev('handlers/x/handler#properties[timeout]', { from: 30, to: 60 }),
  ];
  const none = valuesPayload(values, {});
  expect(none.values).toEqual({});
  expect(none.missing).toEqual(['connections/tickets/connection#baseUrl']);

  const filled = valuesPayload(values, {
    'connections/tickets/connection#baseUrl': ' https://api.test.example.com ',
    'kapps/hr/kapp#attributes[Web Server Url]': 'https://test.example.com',
    'handlers/x/handler#properties[timeout]': '90',
  });
  expect(filled.missing).toEqual([]);
  expect(filled.errors).toEqual({});
  expect(filled.values).toEqual({
    'connections/tickets/connection': { baseUrl: 'https://api.test.example.com' },
    'handlers/x/handler': { 'properties[timeout]': 90 },
  });

  expect(filled.filled).toHaveLength(3);

  const cleared = valuesPayload(values, { 'connections/tickets/connection#baseUrl': '   ', 'kapps/hr/kapp#attributes[Web Server Url]': '' });
  expect(cleared.missing).toEqual(['connections/tickets/connection#baseUrl']);
  // An optional value cleared is not sent: the target keeps its own.
  expect(cleared.blank).toEqual(['kapps/hr/kapp#attributes[Web Server Url]']);
  expect(cleared.values).toEqual({});

  expect(valuesPayload(values, { 'handlers/x/handler#properties[timeout]': 'soon' }).errors).toEqual({ 'handlers/x/handler#properties[timeout]': 'Enter a number.' });
});

test('items are grouped by apply phase in the order the apply runs', () => {
  const items = [
    item('kapps/hr/forms/a/form', 'forms'),
    item('handlers/x/handler', 'handlers'),
    item('connections/t/operations/create', 'operations'),
    item('connections/t/connection', 'connections'),
    item('kapps/hr/kapp', 'kapps', 'unchanged'),
    item('kapps/hr/forms/a/data', 'data', 'update'),
  ];
  expect(items.filter(writes).map((i) => i.key)).not.toContain('kapps/hr/kapp');
  const groups = groupByPhase(items.filter(writes));
  expect(groups.map((g) => g.label)).toEqual(['Connections', 'Handlers', 'Forms', 'Reference data']);
  expect(groups[0].items.map((i) => i.key)).toEqual(['connections/t/connection', 'connections/t/operations/create']);
});

test('the checklist follows step and item events', () => {
  expect(checklistFrom([])).toEqual({ backup: 'pending', items: {} });
  const s = checklistFrom([
    { type: 'step', step: 'backup', status: 'running' },
    { type: 'progress', phase: 'backup', done: 1, total: 4 },
    { type: 'step', step: 'backup', status: 'done' },
    { type: 'item', key: 'a', status: 'running' },
    { type: 'item', key: 'a', status: 'done' },
    { type: 'item', key: 'b', status: 'running' },
    { type: 'item', key: 'b', status: 'failed', message: 'The Kinetic Platform returned an error (500).' },
  ]);
  expect(s.backup).toBe('done');
  expect(s.items).toEqual({ a: { status: 'done' }, b: { status: 'failed', message: 'The Kinetic Platform returned an error (500).' } });
  // A resumed run starts from what the previous runs finished.
  const resumed = checklistFrom([{ type: 'item', key: 'b', status: 'running' }], { a: { status: 'done' }, b: { status: 'failed' } });
  expect(resumed.items).toEqual({ a: { status: 'done' }, b: { status: 'running' } });
});

test('links to the backup and to a restore from it', () => {
  expect(backupHref('demo', 'abc123')).toBe('/p/demo/history?commit=abc123');
  expect(restoreHref('demo', 'abc123', 'test')).toBe('/p/demo/compare?restore=abc123&to=test');
});

test('the outcome of a finished apply, with or without a result', () => {
  const list = checklistFrom([{ type: 'item', key: 'a', status: 'done' }, { type: 'item', key: 'b', status: 'running' }]);
  const result = { status: 'cancelled' as const, done: 1, error: 'The apply was cancelled.', backupCommit: 'c-b' };
  expect(applyOutcome({ status: 'succeeded', result, error: null }, list)).toEqual({ ...result, warnings: [] });
  const warned = { status: 'applied' as const, done: 2, error: null, backupCommit: 'c-b', warnings: ['The changes were applied, but the snapshot of Test afterwards failed: x. Take a snapshot before comparing again.'] };
  expect(applyOutcome({ status: 'succeeded', result: warned, error: null }, list)).toEqual(warned);
  expect(applyOutcome({ status: 'failed', error: 'Lost contact with the job.' }, list)).toEqual({ status: 'failed', done: 1, error: 'Lost contact with the job.', backupCommit: null, warnings: [] });
  expect(applyOutcome({ status: 'cancelled', error: null }, list)).toEqual({ status: 'cancelled', done: 1, error: 'The apply was cancelled.', backupCommit: null, warnings: [] });
});

test('a finished run leaves nothing running, and Resume carries only finished rows', () => {
  const s = checklistFrom([
    { type: 'step', step: 'backup', status: 'done' },
    { type: 'item', key: 'a', status: 'done' },
    { type: 'item', key: 'b', status: 'running' },
  ]);
  const rows = [{ key: 'a', action: 'update' }, { key: 'b', action: 'create' }, { key: 'c', action: 'update' }] as const;
  expect(settleChecklist(s, null, [...rows])).toBe(s);
  expect(settleChecklist(s, 'failed', [...rows]).items).toEqual({ a: { status: 'done' }, b: { status: 'failed', message: 'Stopped before it finished.' } });
  expect(settleChecklist(s, 'cancelled', [...rows]).items.b).toEqual({ status: 'skipped', message: 'Cancelled before it finished.' });
  // A write never reached is not passed off as skipped-because-as-wanted.
  expect(settleChecklist(s, 'applied', [...rows]).items).toEqual({ a: { status: 'done' }, b: { status: 'done' } });
  // Only rows the plan marked unchanged settle as skipped.
  expect(settleChecklist(s, 'applied', [...rows, { key: 'd', action: 'unchanged' }]).items.d).toEqual({ status: 'skipped', message: 'Already up to date.' });
  // A skip the server reported keeps its reason.
  const skipped = checklistFrom([{ type: 'item', key: 'c', status: 'skipped', message: 'Changed in Test since you reviewed it — not applied.' }]);
  expect(settleChecklist(skipped, 'partial', [...rows]).items.c).toEqual({ status: 'skipped', message: 'Changed in Test since you reviewed it — not applied.' });
  expect(settleChecklist(checklistFrom([{ type: 'step', step: 'backup', status: 'running' }]), 'failed', []).backup).toBe('failed');
  // A row done in an earlier run stays done when the resumed run finds it up to date.
  expect(checklistFrom([{ type: 'item', key: 'a', status: 'skipped', message: 'Already up to date in Test.' }], { a: { status: 'done' } }).items.a).toEqual({ status: 'done' });
  expect(carryOver(checklistFrom([
    { type: 'item', key: 'a', status: 'done' }, { type: 'item', key: 'b', status: 'running' }, { type: 'item', key: 'c', status: 'failed' }, { type: 'item', key: 'd', status: 'skipped' },
  ]))).toEqual({ a: { status: 'done' }, d: { status: 'skipped' } });
});

test('removal warnings are shown with the removals, not as things to tick; routines apply after handlers', () => {
  const p = plan({ warnings: [
    'routines/R: still used by workflows/E/W; removing it may break them',
    'teams/Gone: already gone from the target',
    'teams/Old: changed in the target since it was reviewed; it is not removed',
    'Something else',
  ] });
  expect(attentionList(p).map((a) => a.message)).toEqual(['Something else']);
  const order = PHASES.map((ph) => ph.id);
  expect(order.indexOf('handlers')).toBeLessThan(order.indexOf('routines'));
  expect(order.indexOf('routines')).toBeLessThan(order.indexOf('workflows'));
  expect(errorFix('space: The space itself can never be removed', 'dev', 'test').fix).toMatch(/out of the removals/);
});

test('planWithRemovals re-plans with the same inputs plus the extra removals; removalRows lists children after their parent', () => {
  const removals = [{ key: 'kapps/k/kapp', type: 'kapps', label: 'K', action: 'delete' as const, children: [{ key: 'kapps/k/forms/f/form', type: 'forms', label: 'F' }], usedBy: [], notes: [], restore: null }];
  const p = plan({ selected: ['teams/A'], remove: ['kapps/k/kapp'], removals, items: [item('teams/A', 'teams', 'update', true)] });
  expect(planWithRemovals(p, ['teams/Z'])).toEqual({
    to: 'test', from: 'dev', selected: ['teams/A'], remove: ['kapps/k/kapp', 'teams/Z'], sourceCommit: 'c1', resolutions: { 'teams/A': 'overwrite' },
  });
  expect(planWithRemovals({ ...p, changesetId: 'cs-1' }, ['teams/Z'])).toEqual({ to: 'test', changesetId: 'cs-1', remove: ['kapps/k/kapp', 'teams/Z'], resolutions: { 'teams/A': 'overwrite' } });
  expect(removalRows(p)).toEqual([{ key: 'kapps/k/kapp', label: 'K' }, { key: 'kapps/k/forms/f/form', label: 'F', sub: 'with K' }]);
});
