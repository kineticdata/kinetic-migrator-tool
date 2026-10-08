import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import teams from './teams.mjs';
import models from './models.mjs';
import fileResources from './file-resources.mjs';

const ctx = () => ({ config: TEST_CONFIG });

test('teams list keys by encoded name, drops slug and memberships, keeps the slug in meta', async () => {
  const c = fakeClient({ 'GET core/teams': { teams: [
    { name: 'Departments::IT', slug: 'abc', description: 'd', memberships: [{ user: {} }], createdAt: 'x',
      attributes: [{ name: 'Z', values: [] }, { name: 'A', values: [] }] },
  ] } }, { mode: 'read' });
  const [t] = await teams.list(c, ctx());
  assert.equal(t.key, 'teams/Departments%3A%3AIT');
  assert.deepEqual(t.data, { name: 'Departments::IT', description: 'd', attributes: [{ name: 'A', values: [] }, { name: 'Z', values: [] }] });
  assert.deepEqual(t.meta, { slug: 'abc' });
  assert.equal(c.calls[0].query.include, 'attributes');
});

test('teams apply PUTs by the target slug, POSTs new teams, prunes by slug', async () => {
  const c = fakeClient();
  const desired = { name: 'Ops', description: 'new' };
  await teams.apply(c, { key: 'teams/Ops', desired, existing: { data: { name: 'Ops' }, meta: { slug: 's1' } } }, {});
  await teams.apply(c, { key: 'teams/New', desired: { name: 'New' }, existing: null }, {});
  await teams.prune(c, { key: 'teams/Old', data: {}, meta: { slug: 's2' } });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['PUT /teams/s1', 'POST /teams', 'DELETE /teams/s2']);
  assert.deepEqual(c.calls[0].body, desired);
});

test('models come from the space export; new models are created minimally then fully PUT', async () => {
  const c = fakeClient({ 'GET core/space': { space: { models: [
    { name: 'People', status: 'Active', attributes: [{ name: 'b' }, { name: 'a' }], mappings: [], qualifications: [] },
  ] } } });
  const [m] = await models.list(c, ctx());
  assert.equal(m.key, 'models/People');
  assert.deepEqual(m.data.attributes.map((a) => a.name), ['a', 'b']);
  const w = fakeClient();
  await models.apply(w, { key: m.key, desired: m.data, existing: null }, {});
  assert.deepEqual(w.calls.map((x) => `${x.method} ${x.path}`), ['POST /models', 'PUT /models/People']);
  assert.deepEqual(w.calls[0].body, { name: 'People', status: 'Active' });
});

test('file resources list and upsert by name', async () => {
  const c = fakeClient({ 'GET core/fileResources': { fileResources: [{ slug: 'docs', agentSlug: 'system', filestoreSlug: 'store', updatedAt: 'x' }] } });
  const [f] = await fileResources.list(c, ctx());
  assert.deepEqual(f, { key: 'file-resources/docs', data: { slug: 'docs', agentSlug: 'system', filestoreSlug: 'store' }, meta: {} });
  const w = fakeClient();
  await fileResources.apply(w, { key: f.key, desired: f.data, existing: f }, {});
  await fileResources.apply(w, { key: f.key, desired: f.data, existing: null }, {});
  assert.deepEqual(w.calls.map((x) => `${x.method} ${x.path}`), ['PUT /fileResources/docs', 'POST /fileResources']);
});

test('models keep target-only attributes, qualifications and mappings by name', () => {
  assert.deepEqual(models.namedCollections, [
    { field: 'attributes', key: 'name' }, { field: 'qualifications', key: 'name' }, { field: 'mappings', key: 'name' },
  ]);
});
