import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient } from '../fake-client.mjs';
import routines, { orderRoutines } from './routines.mjs';

const calls = (c) => c.calls.filter((x) => x.method !== 'GET').map((x) => ({ method: x.method, path: x.path, body: x.body }));
const node = (definitionId) => ({ id: definitionId, definitionId });
const routine = (name, definitionId, calls = [], extra = {}) => ({
  name, definitionId, status: 'Active', notes: '', inputs: [{ name: 'In' }], outputs: [{ name: 'Out' }],
  treeJson: { nodes: [node('system_start_v1'), ...calls.map(node)], connectors: [] }, ...extra,
});

test('a new routine is created with one POST on the Task API trees endpoint, as a Global Routine with "-" source and group', async () => {
  const c = fakeClient({});
  const desired = routine('Send Email', 'routine_send_email_v1');
  await routines.apply(c, { key: 'routines/Send Email', desired, existing: null });
  assert.deepEqual(calls(c), [{
    method: 'POST', path: '/trees',
    body: { sourceName: '-', sourceGroup: '-', type: 'Global Routine', ...desired },
  }]);
  assert.equal(c.calls[0].api, 'task');
});

test('an existing routine is updated by title with only the changed fields and its current versionId as a string', async () => {
  const c = fakeClient({ 'GET task/trees/Send%20Email': { name: 'Send Email', versionId: 4 } });
  const cur = routine('Send Email', 'routine_send_email_v1');
  const desired = { ...cur, notes: 'new', treeJson: { nodes: [node('system_start_v1'), node('smtp_v1')], connectors: [] } };
  await routines.apply(c, { key: 'routines/Send Email', desired, existing: { key: 'routines/Send Email', data: cur, meta: { title: 'Send Email', versionId: '2' } } });
  assert.deepEqual(calls(c), [{ method: 'PUT', path: '/trees/Send%20Email', body: { notes: 'new', treeJson: desired.treeJson, versionId: '4' } }]);
});

test('an update falls back to the exported versionId when the tree cannot be read, and inputs and outputs are sent when they change', async () => {
  const c = fakeClient({});
  const cur = routine('R', 'routine_r_v1');
  const desired = { ...cur, inputs: [{ name: 'In' }, { name: 'Extra' }], outputs: [] };
  await routines.apply(c, { key: 'routines/R', desired, existing: { key: 'routines/R', data: cur, meta: { title: 'R', versionId: '7' } } });
  assert.deepEqual(calls(c), [{ method: 'PUT', path: '/trees/R', body: { inputs: desired.inputs, outputs: [], versionId: '7' } }]);
});

test('an update with nothing the API can change is skipped', async () => {
  const c = fakeClient({});
  const cur = routine('R', 'routine_r_v1');
  assert.deepEqual(await routines.apply(c, { key: 'routines/R', desired: cur, existing: { key: 'routines/R', data: cur, meta: {} } }), { skipped: true });
  assert.deepEqual(calls(c), []);
});

test('a routine is deleted by its title', async () => {
  const c = fakeClient({});
  await routines.prune(c, { key: 'routines/A/B', data: routine('A/B', 'routine_ab_v1'), meta: { title: 'A/B' } });
  assert.deepEqual(calls(c), [{ method: 'DELETE', path: '/trees/A%2FB', body: undefined }]);
});

test('orderRoutines puts a routine after the routines it calls; reverse puts callers first; cycles and outside calls do not break it', () => {
  const items = [
    { key: 'routines/A', desired: routine('A', 'routine_a', ['routine_b']) },
    { key: 'routines/B', desired: routine('B', 'routine_b', ['routine_c', 'routine_elsewhere']) },
    { key: 'routines/C', desired: routine('C', 'routine_c') },
    { key: 'routines/D', desired: routine('D', 'routine_d') },
  ];
  assert.deepEqual(orderRoutines(items).map((i) => i.key), ['routines/C', 'routines/B', 'routines/A', 'routines/D']);
  assert.deepEqual(orderRoutines(items, { reverse: true }).map((i) => i.key), ['routines/D', 'routines/A', 'routines/B', 'routines/C']);
  // Target-only entries carry their data under existing.
  const deletes = items.map((i) => ({ key: i.key, existing: { data: i.desired } }));
  assert.deepEqual(orderRoutines(deletes, { reverse: true }).map((i) => i.key), ['routines/D', 'routines/A', 'routines/B', 'routines/C']);
  const cycle = [
    { key: 'routines/X', desired: routine('X', 'routine_x', ['routine_y']) },
    { key: 'routines/Y', desired: routine('Y', 'routine_y', ['routine_x']) },
  ];
  assert.deepEqual(orderRoutines(cycle).map((i) => i.key).sort(), ['routines/X', 'routines/Y']);
});

test('a create leaves out empty inputs and outputs, which would override the tree\'s own', async () => {
  const c = fakeClient({});
  await routines.apply(c, { key: 'routines/R', desired: routine('R', 'routine_r_v1', [], { inputs: [], outputs: [] }), existing: null });
  assert.equal('inputs' in c.calls[0].body, false);
  assert.equal('outputs' in c.calls[0].body, false);
});
