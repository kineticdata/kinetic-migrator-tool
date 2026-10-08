import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import workflows, { normalizeWorkflow, workflowBase } from './workflows.mjs';
import webapis from './webapis.mjs';

const tree = { nodes: [{ id: 'start', definitionId: 'system_start_v1' }], connectors: [] };
const wf = (over) => ({
  id: 'w-1', name: 'Notify', event: 'Submission Submitted', filter: '', status: 'Active', versionId: 7,
  platformItemId: 'uuid', platformItemType: 'Form', createdAt: 'x', treeJson: tree, ...over,
});

test('normalizeWorkflow keeps only portable fields and requires treeJson', () => {
  assert.deepEqual(normalizeWorkflow({ workflow: wf() }), {
    name: 'Notify', event: 'Submission Submitted', filter: '', status: 'Active', treeJson: tree,
  });
  assert.throws(() => normalizeWorkflow(wf({ treeJson: undefined })), /without treeJson/);
});

test('workflowBase maps keys to the right scope endpoint', () => {
  assert.equal(workflowBase('workflows/User Created/Welcome'), '/workflows');
  assert.equal(workflowBase('kapps/k/workflows/Submission Created/Audit'), '/kapps/k/workflows');
  assert.equal(workflowBase('kapps/k/forms/f/workflows/Submission Submitted/Notify'), '/kapps/k/forms/f/workflows');
});

test('workflows list space, kapp and form workflows, keyed by event and name, id in meta', async () => {
  const c = fakeClient({
    'GET core/workflows': { workflows: [wf({ id: 's1', name: 'Welcome', event: 'User Created', platformItemType: 'Space' })] },
    'GET core/kapps': { kapps: [{ slug: 'k' }] },
    'GET core/kapps/k': { kapp: { slug: 'k', forms: [{ slug: 'f' }] } },
    'GET core/kapps/k/workflows': { workflows: [wf({ id: 'k1', name: 'Audit', event: 'Submission Created', platformItemType: 'Kapp' })] },
    'GET core/kapps/k/forms/f/workflows': { workflows: [{ id: 'w-1', name: 'Notify' }] },
    'GET core/kapps/k/forms/f/workflows/w-1': { workflow: wf() },
  }, { mode: 'read' });
  const list = await workflows.list(c, { config: TEST_CONFIG });
  assert.deepEqual(list.map((w) => [w.key, w.meta.id]), [
    ['workflows/User Created/Welcome', 's1'],
    ['kapps/k/workflows/Submission Created/Audit', 'k1'],
    ['kapps/k/forms/f/workflows/Submission Submitted/Notify', 'w-1'],
  ]);
  assert.equal(c.calls.find((x) => x.path === '/workflows').query.include, 'treeJson');
});

test('space and kapp workflows missing treeJson in the list are fetched individually', async () => {
  const c = fakeClient({
    'GET core/workflows': { workflows: [{ id: 's1', name: 'Welcome', event: 'User Created', platformItemType: 'Space' }] },
    'GET core/workflows/s1': wf({ id: 's1', name: 'Welcome', event: 'User Created', platformItemType: 'Space' }),
    'GET core/kapps': { kapps: [{ slug: 'k' }] },
    'GET core/kapps/k': { kapp: { slug: 'k', forms: [] } },
    'GET core/kapps/k/workflows': { workflows: [{ id: 'k1', name: 'Audit', event: 'Submission Created', platformItemType: 'Kapp' }] },
    'GET core/kapps/k/workflows/k1': wf({ id: 'k1', name: 'Audit', event: 'Submission Created', platformItemType: 'Kapp' }),
  }, { mode: 'read' });
  const list = await workflows.list(c, { config: TEST_CONFIG });
  assert.equal(list.length, 2);
  assert.ok(list.every((w) => w.data.treeJson));
});

test('new workflows are created then given their tree; existing ones are PUT on the scoped path', async () => {
  const c = fakeClient({ 'POST core/kapps/k/forms/f/workflows': { workflow: { id: 'new-id' } } });
  const desired = normalizeWorkflow(wf());
  const key = 'kapps/k/forms/f/workflows/Submission Submitted/Notify';
  await workflows.apply(c, { key, desired, existing: null }, {});
  await workflows.apply(c, { key, desired, existing: { data: desired, meta: { id: 'old-id' } } }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /kapps/k/forms/f/workflows', 'PUT /kapps/k/forms/f/workflows/new-id', 'PUT /kapps/k/forms/f/workflows/old-id',
  ]);
  assert.equal('treeJson' in c.calls[0].body, false);
  assert.deepEqual(c.calls[1].body, desired);
});

test('webapis export space and kapp WebAPIs via /export and import with force', async () => {
  const c = fakeClient({
    'GET core/space': { space: { webApis: [{ slug: 'token' }] } },
    'GET core/webApis/token/export': { webApi: { slug: 'token', method: 'POST', treeXml: '<tree/>', updatedAt: 'x' } },
    'GET core/kapps': { kapps: [{ slug: 'k' }] },
    'GET core/kapps/k': { kapp: { slug: 'k', webApis: [{ slug: 'lookup' }] } },
    'GET core/kapps/k/webApis/lookup/export': { webApi: { slug: 'lookup', method: 'GET', treeXml: '<tree/>' } },
  }, { mode: 'read' });
  const list = await webapis.list(c, { config: TEST_CONFIG });
  assert.deepEqual(list.map((w) => w.key), ['webapis/token', 'kapps/k/webapis/lookup']);
  assert.deepEqual(list[0].data, { slug: 'token', method: 'POST', treeXml: '<tree/>' });

  const w = fakeClient();
  await webapis.apply(w, { key: 'kapps/k/webapis/lookup', desired: list[1].data, existing: null }, {});
  assert.deepEqual([w.calls[0].method, w.calls[0].path, w.calls[0].query], ['POST', '/kapps/k/webApiImport', { force: 'true' }]);
});

test('a space WebAPI whose import endpoint is missing becomes a warning, not a failure', async () => {
  const c = {
    async request() { const e = new Error('404'); e.status = 404; throw e; },
  };
  const warnings = [];
  const r = await webapis.apply(c, { key: 'webapis/token', desired: { slug: 'token' }, existing: null }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(r, { skipped: true });
  assert.match(warnings[0], /webapis\/token.*by hand/);
});
