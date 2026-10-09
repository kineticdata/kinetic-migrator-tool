import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import routines, { listTrees } from './routines.mjs';
import taskRefs, { referencedDefinitionIds, classifyRefs } from './task-refs.mjs';

test('listTrees pages with limit/offset until a short page', async () => {
  const page = (n, start) => ({ trees: Array.from({ length: n }, (_, i) => ({ name: `r${start + i}`, definitionId: `routine_${start + i}` })) });
  const c = fakeClient({ 'GET task/trees': ({ query }) => (query.offset === 0 ? page(100, 0) : page(3, 100)) });
  assert.equal((await listTrees(c, 'Global Routine')).length, 103);
  assert.deepEqual(c.calls.map((x) => x.query.offset), [0, 100]);
  assert.equal(c.calls[0].query.type, 'Global Routine');
});

test('routines are exported keyed by name, with their title and versionId in meta, and are applyable', async () => {
  const c = fakeClient({ 'GET task/trees': { trees: [{ name: 'Send Email', title: 'Send Email', definitionId: 'routine_send_email_v1', treeJson: {}, versionId: 3, updatedAt: 'x' }] } });
  const [r] = await routines.list(c, { config: TEST_CONFIG });
  assert.deepEqual(r, { key: 'routines/Send Email', data: { name: 'Send Email', definitionId: 'routine_send_email_v1', treeJson: {} }, meta: { title: 'Send Email', versionId: '3' } });
  assert.notEqual(routines.applyable, false);
  assert.equal(typeof routines.prune, 'function');
});

test('referencedDefinitionIds reads workflow treeJson and WebAPI treeXml', () => {
  const ids = referencedDefinitionIds([
    { key: 'a', data: { treeJson: { nodes: [{ definitionId: 'system_start_v1' }, { definitionId: 'smtp_email_send_v1' }] } } },
    { key: 'b', data: { treeXml: '<task definition_id="routine_send_email_v1"/><task definition_id="utilities_echo_v1"/>' } },
    { key: 'c', data: { name: 'no tree' } },
  ]);
  assert.deepEqual([...ids].sort(), ['routine_send_email_v1', 'smtp_email_send_v1', 'system_start_v1', 'utilities_echo_v1']);
});

test('classifyRefs drops system nodes and separates routines from handlers', () => {
  assert.deepEqual(
    classifyRefs(new Set(['system_start_v1', 'smtp_email_send_v1', 'routine_send_email_v1']), new Set(['routine_send_email_v1'])),
    { handlers: ['smtp_email_send_v1'], routines: ['routine_send_email_v1'] },
  );
});

test('task-refs list summarises what the collected artifacts use', async () => {
  const ctx = { config: TEST_CONFIG, collected: [
    { key: 'routines/Send Email', data: { definitionId: 'routine_send_email_v1' } },
    { key: 'kapps/k/forms/f/workflows/E/N', data: { treeJson: { nodes: [{ definitionId: 'routine_send_email_v1' }, { definitionId: 'smtp_email_send_v1' }] } } },
  ] };
  assert.deepEqual(await taskRefs.list(null, ctx), [{
    key: 'task-refs', data: { handlers: ['smtp_email_send_v1'], routines: ['routine_send_email_v1'] }, meta: {},
  }]);
});

test('task-refs preflight reports handlers and routines missing in the target', async () => {
  const c = fakeClient({
    'GET task/handlers/present_v1': { handler: {} },
    'GET task/trees': { trees: [{ definitionId: 'routine_here_v1' }] },
  }, { mode: 'read' });
  const exported = new Map([['task-refs', { handlers: ['present_v1', 'missing_v1'], routines: ['routine_here_v1', 'routine_gone_v1'] }]]);
  const { errors } = await taskRefs.preflight(c, exported);
  assert.deepEqual(errors, [
    'Handler missing_v1 is used by workflows being promoted but is not installed in the target',
    'Routine routine_gone_v1 is used by workflows being promoted but does not exist in the target',
  ]);
});

test('task-refs preflight: an exported routine is created by apply, so it is not looked up or reported', async () => {
  const c = fakeClient({ 'GET task/trees': { trees: [] } }, { mode: 'read' });
  const exported = new Map([
    ['task-refs', { handlers: [], routines: ['routine_new_v1'] }],
    ['routines/New', { name: 'New', definitionId: 'routine_new_v1' }],
  ]);
  assert.deepEqual((await taskRefs.preflight(c, exported)).errors, []);
  assert.equal(c.calls.length, 0);
});

test('task-refs preflight: a missing handler the export will install is not an error; built-ins are never reported', async () => {
  const c = fakeClient({ 'GET task/trees': { trees: [] } }, { mode: 'read' });
  const exported = new Map([
    ['task-refs', { handlers: ['mail_send_v1', 'missing_v1', 'utilities_echo_v1'], routines: [] }],
    ['handlers/mail_send_v1/handler', { definitionId: 'mail_send_v1' }],
  ]);
  const { errors } = await taskRefs.preflight(c, exported);
  assert.deepEqual(errors, ['Handler missing_v1 is used by workflows being promoted but is not installed in the target']);
  assert.ok(!c.calls.some((x) => x.path === '/handlers/utilities_echo_v1'));
});

test('routines are listed with their inputs and outputs (the Task API leaves them empty otherwise), and a create sends them', async () => {
  const inputs = [{ name: 'Submission Id', required: true }];
  const outputs = [{ name: 'Sent' }];
  const c = fakeClient({ 'GET task/trees': ({ query }) => ({ trees: [{ name: 'R', definitionId: 'routine_r_v1', treeJson: { nodes: [] }, ...(String(query.include).split(',').includes('inputs') ? { inputs, outputs } : { inputs: [], outputs: [] }) }] }) });
  const [r] = await routines.list(c, { config: TEST_CONFIG });
  assert.deepEqual(c.calls[0].query.include.split(',').sort(), ['details', 'inputs', 'outputs', 'treeJson']);
  assert.deepEqual([r.data.inputs, r.data.outputs], [inputs, outputs]);
  const w = fakeClient({});
  await routines.apply(w, { key: r.key, desired: r.data, existing: null });
  assert.deepEqual([w.calls[0].body.inputs, w.calls[0].body.outputs], [inputs, outputs]);
});
