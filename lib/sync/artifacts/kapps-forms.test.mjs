import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import kapps, { normalizeKapp } from './kapps.mjs';
import forms, { normalizeForm } from './forms.mjs';

const RAW_KAPP = {
  slug: 'services', name: 'Services', createdAt: 'x', bundlePath: null,
  forms: [{ slug: 'b-form', name: 'B' }, { slug: 'a-form', name: 'A', status: 'Active', updatedAt: 'y' }],
  webApis: [{ slug: 'w' }], webhooks: [],
  categories: [{ slug: 'z', name: 'Z' }, { slug: 'a', name: 'A' }],
  formTypes: [{ name: 'Service' }],
  integrations: [{ name: 'Lookup', connectionId: 'c-1', operationId: 'o-1' }],
  indexDefinitions: [{ name: 'values[B]', status: 'Built', parts: ['values[B]'] }],
  securityPolicies: [{ endpoint: 'Kapp Display', name: 'Everyone' }],
};

test('normalizeKapp drops nested forms/webApis/webhooks, metadata and index status; sorts collections', () => {
  const k = normalizeKapp(RAW_KAPP);
  for (const f of ['forms', 'webApis', 'webhooks', 'createdAt']) assert.equal(f in k, false, f);
  assert.deepEqual(k.categories.map((c) => c.slug), ['a', 'z']);
  assert.deepEqual(k.indexDefinitions, [{ name: 'values[B]', parts: ['values[B]'] }]);
});

test('kapps and forms list from one kapp export per kapp and honour exclusions', async () => {
  const c = fakeClient({
    'GET core/kapps': { kapps: [{ slug: 'services' }, { slug: 'skipme' }] },
    'GET core/kapps/services': { kapp: RAW_KAPP },
  }, { mode: 'read' });
  const ctx = { config: { ...TEST_CONFIG, exclude: { kapps: ['skipme'], forms: ['services/b-form'] } } };
  const [k] = await kapps.list(c, ctx);
  assert.equal(k.key, 'kapps/services/kapp');
  const fs = await forms.list(c, ctx);
  assert.deepEqual(fs.map((f) => f.key), ['kapps/services/forms/a-form/form']);
  assert.deepEqual(fs[0].data, { slug: 'a-form', name: 'A', status: 'Active' });
  assert.equal(c.calls.filter((x) => x.path === '/kapps/services').length, 1);
  assert.deepEqual(c.calls.find((x) => x.path === '/kapps/services').query, { export: 'true' });
});

test('a new kapp is created, then its sub-collections upserted, then its settings PUT, then indexes built', async () => {
  const c = fakeClient({ 'GET core/kapps/services': { kapp: { slug: 'services', name: 'Services' } } });
  const desired = normalizeKapp(RAW_KAPP);
  await kapps.apply(c, { key: 'kapps/services/kapp', desired, existing: null }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /kapps',
    'GET /kapps/services',
    'POST /kapps/services/formTypes',
    'POST /kapps/services/categories',
    'POST /kapps/services/categories',
    'POST /kapps/services/integrations',
    'PUT /kapps/services',
    'POST /kapps/services/backgroundJobs',
  ]);
  assert.deepEqual(c.calls[0].body, { slug: 'services', name: 'Services' });
  const settings = c.calls[6].body;
  for (const f of ['categories', 'formTypes', 'integrations']) assert.equal(f in settings, false, f);
  assert.ok('indexDefinitions' in settings);
});

test('a new kapp updates the definitions the platform created by default instead of duplicating them', async () => {
  const c = fakeClient({
    'GET core/kapps/services': { kapp: { slug: 'services', name: 'Services', securityPolicyDefinitions: [{ name: 'Admins', type: 'Kapp', rule: 'identity(\'spaceAdmin\')' }] } },
  });
  const desired = normalizeKapp({
    slug: 'services', name: 'Services',
    securityPolicyDefinitions: [
      { name: 'Admins', type: 'Kapp', rule: 'identity(\'spaceAdmin\')', message: 'Admins only' },
      { name: 'Everyone', type: 'Kapp', rule: 'true' },
    ],
  });
  await kapps.apply(c, { key: 'kapps/services/kapp', desired, existing: null }, {});
  const spd = c.calls.filter((x) => x.path.includes('securityPolicyDefinitions')).map((x) => `${x.method} ${x.path}`);
  assert.deepEqual(spd, ['PUT /kapps/services/securityPolicyDefinitions/Admins', 'POST /kapps/services/securityPolicyDefinitions']);
});

test('an unchanged kapp makes no calls', async () => {
  const c = fakeClient();
  const data = normalizeKapp(RAW_KAPP);
  await kapps.apply(c, { key: 'kapps/services/kapp', desired: data, existing: { data, meta: {} } }, {});
  assert.equal(c.calls.length, 0);
});

test('normalizeForm sorts named lists and strips index status', () => {
  const f = normalizeForm({
    slug: 'f', createdBy: 'x', attributes: [{ name: 'b' }, { name: 'a' }],
    indexDefinitions: [{ name: 'values[A]', status: 'New', parts: ['values[A]'] }],
    securityPolicies: [{ endpoint: 'Submission Access', name: 'X' }, { endpoint: 'Display', name: 'Y' }],
    categorizations: [{ category: { slug: 'z' } }, { category: { slug: 'a' } }],
    pages: [{ name: 'P2' }, { name: 'P1' }],
  });
  assert.deepEqual(f.attributes.map((a) => a.name), ['a', 'b']);
  assert.deepEqual(f.indexDefinitions, [{ name: 'values[A]', parts: ['values[A]'] }]);
  assert.deepEqual(f.securityPolicies.map((p) => p.endpoint), ['Display', 'Submission Access']);
  assert.deepEqual(f.categorizations.map((x) => x.category.slug), ['a', 'z']);
  assert.deepEqual(f.pages.map((p) => p.name), ['P2', 'P1'], 'page order is meaningful and kept');
});

test('forms: POST new, PUT existing, build changed indexes, prune', async () => {
  const c = fakeClient();
  const desired = { slug: 'f', indexDefinitions: [{ name: 'values[A]', parts: ['values[A]'] }] };
  await forms.apply(c, { key: 'kapps/k/forms/f/form', desired, existing: null }, {});
  await forms.apply(c, { key: 'kapps/k/forms/f/form', desired, existing: { data: desired, meta: {} } }, {});
  await forms.prune(c, { key: 'kapps/k/forms/f/form', data: desired, meta: {} });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /kapps/k/forms', 'POST /kapps/k/forms/f/backgroundJobs',
    'PUT /kapps/k/forms/f',
    'DELETE /kapps/k/forms/f',
  ]);
});
