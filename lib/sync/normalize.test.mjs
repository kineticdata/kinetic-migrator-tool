import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMeta, omit, pick, sortBy, stableStringify, isEqual, hashOf,
  withoutEnvBound, carryEnvBound, ENV_BOUND_FIELDS, compareText,
} from './normalize.mjs';

test('stripMeta removes audit fields at every depth but keeps status', () => {
  const raw = {
    name: 'Form', status: 'Active', createdAt: 'x', updatedBy: 'y', lockVersion: 3,
    pages: [{ name: 'Page 1', insertedAt: 'z', elements: [{ name: 'F', createdBy: 'q' }] }],
  };
  assert.deepEqual(stripMeta(raw), {
    name: 'Form', status: 'Active', pages: [{ name: 'Page 1', elements: [{ name: 'F' }] }],
  });
});

test('omit and pick copy without mutating', () => {
  const o = { a: 1, b: 2, c: 3 };
  assert.deepEqual(omit(o, ['b']), { a: 1, c: 3 });
  assert.deepEqual(pick(o, ['a', 'z']), { a: 1 });
  assert.deepEqual(o, { a: 1, b: 2, c: 3 });
});

test('sortBy orders by name, by a named key, or by a function, and tolerates null', () => {
  assert.deepEqual(sortBy([{ name: 'b' }, { name: 'a' }]).map((x) => x.name), ['a', 'b']);
  assert.deepEqual(sortBy([{ slug: 'z' }, { slug: 'm' }], 'slug').map((x) => x.slug), ['m', 'z']);
  assert.deepEqual(sortBy([{ c: { s: 'b' } }, { c: { s: 'a' } }], (x) => x.c.s).map((x) => x.c.s), ['a', 'b']);
  assert.deepEqual(sortBy(undefined), []);
});

test('compareText orders by code point and sortBy uses locale-independent sorting', () => {
  assert.deepEqual(['b', 'B', 'a', 'A'].sort(compareText), ['A', 'B', 'a', 'b']);
  assert.deepEqual(sortBy([{ name: 'b' }, { name: 'B' }]).map((x) => x.name), ['B', 'b']);
});

test('stableStringify is independent of key insertion order and ends with a newline', () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
  assert.equal(a.split('\n')[1], '  "a": {');
});

test('stableStringify keeps array order (arrays can be semantically ordered)', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('isEqual and hashOf agree with stableStringify', () => {
  assert.equal(isEqual({ a: 1, b: [1] }, { b: [1], a: 1 }), true);
  assert.equal(isEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(isEqual(undefined, null), true);
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.match(hashOf({}), /^[0-9a-f]{64}$/);
});

test('ENV_BOUND_FIELDS covers space identity and locations, and kapp bundlePath', () => {
  assert.deepEqual(ENV_BOUND_FIELDS.space, ['name', 'slug', 'platformComponents', 'bundlePath', 'sharedBundleBase']);
  assert.deepEqual(ENV_BOUND_FIELDS.kapp, ['bundlePath']);
});

test('withoutEnvBound drops env-bound fields and listed attributes, including category attributes on kapps', () => {
  const kapp = {
    slug: 'k', bundlePath: 'ui',
    attributes: [{ name: 'Region', values: ['eu'] }, { name: 'Icon', values: ['x'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Env', values: ['dev'] }, { name: 'Icon', values: ['y'] }] }],
  };
  const eba = { kapp: ['Region'], category: ['Env'] };
  assert.deepEqual(withoutEnvBound('kapp', kapp, eba), {
    slug: 'k',
    attributes: [{ name: 'Icon', values: ['x'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Icon', values: ['y'] }] }],
  });
  assert.equal(withoutEnvBound(null, kapp, eba), kapp);
});

test('carryEnvBound copies the target values back in, sorted, and adds nothing when target lacks them', () => {
  const desired = { slug: 'k', attributes: [{ name: 'Icon', values: ['x'] }], categories: [{ slug: 'c1', attributes: [] }] };
  const existing = {
    slug: 'k', bundlePath: 'prod-ui',
    attributes: [{ name: 'Region', values: ['us'] }, { name: 'Icon', values: ['old'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Env', values: ['prod'] }] }],
  };
  const eba = { kapp: ['Region'], category: ['Env'] };
  assert.deepEqual(carryEnvBound('kapp', desired, existing, eba), {
    slug: 'k', bundlePath: 'prod-ui',
    attributes: [{ name: 'Icon', values: ['x'] }, { name: 'Region', values: ['us'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Env', values: ['prod'] }] }],
  });
  assert.deepEqual(carryEnvBound('kapp', desired, null, eba), desired);
  assert.deepEqual(carryEnvBound('kapp', { slug: 'k' }, { slug: 'k' }, eba), { slug: 'k' });
});

test('withoutEnvBound drops every handler property value', () => {
  const data = { definitionId: 'h', properties: [{ name: 'a', type: 'Plaintext', value: 'x' }, { name: 'b', type: 'Encrypted' }] };
  assert.deepEqual(withoutEnvBound('handler', data).properties, [{ name: 'a', type: 'Plaintext' }, { name: 'b', type: 'Encrypted' }]);
  assert.equal(data.properties[0].value, 'x');
});
