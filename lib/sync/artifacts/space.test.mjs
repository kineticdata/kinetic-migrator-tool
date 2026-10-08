import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import { listAll, upsertByName, buildChangedIndexes } from './common.mjs';
import space from './space.mjs';

test('listAll follows nextPageToken', async () => {
  const pages = [{ teams: [{ name: 'a' }], nextPageToken: 't1' }, { teams: [{ name: 'b' }] }];
  const c = fakeClient({ 'GET core/teams': () => pages.shift() });
  assert.deepEqual((await listAll(c, 'core', '/teams', 'teams')).map((t) => t.name), ['a', 'b']);
  assert.equal(c.calls[1].query.pageToken, 't1');
});

test('upsertByName PUTs changed, POSTs missing, skips equal, never deletes', async () => {
  const c = fakeClient();
  await upsertByName(c, 'core', '/spaceAttributeDefinitions',
    [{ name: 'a', d: 1 }, { name: 'b', d: 2 }, { name: 'c', d: 3 }],
    [{ name: 'a', d: 1 }, { name: 'b', d: 0 }, { name: 'z', d: 9 }]);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'PUT /spaceAttributeDefinitions/b', 'POST /spaceAttributeDefinitions',
  ]);
});

test('buildChangedIndexes starts one Build Index job for new or changed definitions only', async () => {
  const c = fakeClient();
  await buildChangedIndexes(c, '/kapps/k/forms/f',
    [{ name: 'values[A]', parts: ['values[A]'] }, { name: 'values[B]', parts: ['values[B]'] }],
    [{ name: 'values[A]', parts: ['values[A]'] }]);
  assert.deepEqual(c.calls, [{
    api: 'core', method: 'POST', path: '/kapps/k/forms/f/backgroundJobs', query: undefined,
    body: { type: 'Build Index', content: { indexes: ['values[B]'] } },
  }]);
  const d = fakeClient();
  await buildChangedIndexes(d, '/x', [{ name: 'a' }], [{ name: 'a' }]);
  assert.equal(d.calls.length, 0);
});

const RAW_SPACE = {
  name: 'Dev Space', slug: 'dev', oauthSigningKey: 'SIGNING-KEY', createdAt: 't', updatedBy: 'u',
  kapps: [{ slug: 'k' }], teams: [{}], models: [{}], webApis: [{}], webhooks: [],
  displayType: 'Display Page',
  spaceAttributeDefinitions: [{ name: 'b' }, { name: 'a' }],
  securityPolicyDefinitions: [{ name: 'Z', rule: 'true' }, { name: 'A', rule: 'false' }],
  securityPolicies: [{ endpoint: 'Team Access', name: 'Z' }, { endpoint: 'Discussion Creation', name: 'A' }],
  attributes: [{ name: 'Theme', values: ['x'] }, { name: 'Alpha', values: [] }],
  platformComponents: { task: { url: 'https://your-space.kinops.io/kinetic-task' } },
};

test('space list strips the signing key, nested collections and metadata, and sorts named lists', async () => {
  const c = fakeClient({ 'GET core/space': { space: RAW_SPACE } }, { mode: 'read' });
  const [a] = await space.list(c, { config: TEST_CONFIG });
  assert.equal(a.key, 'space');
  for (const k of ['oauthSigningKey', 'kapps', 'teams', 'models', 'webApis', 'webhooks', 'createdAt', 'updatedBy']) {
    assert.equal(k in a.data, false, k);
  }
  assert.deepEqual(a.data.spaceAttributeDefinitions.map((d) => d.name), ['a', 'b']);
  assert.deepEqual(a.data.securityPolicies.map((p) => p.endpoint), ['Discussion Creation', 'Team Access']);
  assert.deepEqual(a.data.attributes.map((p) => p.name), ['Alpha', 'Theme']);
  assert.deepEqual(c.calls[0].query, { export: 'true' });
});

test('space apply upserts definitions and PUTs settings only when changed, leaving unchanged platformComponents out', async () => {
  const existing = {
    name: 'Prod', slug: 'prod', displayType: 'Display Page',
    platformComponents: { task: { url: 'https://prod/kinetic-task' } },
    spaceAttributeDefinitions: [{ name: 'a', description: 'old' }],
  };
  const desired = { ...existing, displayType: 'Redirect', spaceAttributeDefinitions: [{ name: 'a', description: 'new' }, { name: 'b' }] };
  const c = fakeClient();
  await space.apply(c, { key: 'space', desired, source: desired, existing: { key: 'space', data: existing, meta: {} } }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'PUT /spaceAttributeDefinitions/a', 'POST /spaceAttributeDefinitions', 'PUT /space',
  ]);
  const body = c.calls.at(-1).body;
  assert.equal(body.displayType, 'Redirect');
  assert.equal('platformComponents' in body, false);
  assert.equal('slug' in body, false);
  assert.equal('spaceAttributeDefinitions' in body, false);

  const d = fakeClient();
  await space.apply(d, { key: 'space', desired: existing, source: existing, existing: { key: 'space', data: existing, meta: {} } }, {});
  assert.equal(d.calls.length, 0);
});

test('space apply sends platformComponents when an override changed it', async () => {
  const existing = { name: 'Prod', platformComponents: { app: { location: 'https://old' } } };
  const desired = { name: 'Prod', platformComponents: { app: { location: 'https://new' } } };
  const c = fakeClient();
  await space.apply(c, { key: 'space', desired, source: desired, existing: { key: 'space', data: existing, meta: {} } }, {});
  assert.deepEqual(c.calls.at(-1).body.platformComponents, { app: { location: 'https://new' } });
});
