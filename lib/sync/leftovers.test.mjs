// lib/sync/leftovers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSourceHostStrings, uncoveredFor } from './leftovers.mjs';

const SRC = 'https://dev-space.kinops.io';
const artifacts = [
  { key: 'space', data: { platformComponents: { task: { url: `${SRC}/kinetic-task` } }, attributes: [{ name: 'Web Server Url', values: [SRC] }] } },
  { key: 'connections/Self/connection', data: { config: { baseUrl: SRC, auth: { tokenUrl: `${SRC}/app/token` } } } },
  { key: 'teams/Ops', data: { description: 'no urls here' } },
];
const scopeOf = (k) => (k === 'space' ? 'space' : null);

test('findSourceHostStrings reports name-addressed paths and skips env-bound fields', () => {
  assert.deepEqual(findSourceHostStrings(artifacts, SRC, scopeOf).map((h) => `${h.key} ${h.path}`), [
    'space attributes.Web Server Url.values.0',
    'connections/Self/connection config.baseUrl',
    'connections/Self/connection config.auth.tokenUrl',
  ]);
});

test('uncoveredFor drops hits handled by an artifact override path or a replace rule', () => {
  const hits = findSourceHostStrings(artifacts, SRC, scopeOf);
  const overrides = {
    artifacts: { space: { 'attributes.Web Server Url': ['{{targetUrl}}'] }, 'connections/Self/connection': { 'config.baseUrl': 'x' } },
    replace: [],
  };
  assert.deepEqual(uncoveredFor(hits, overrides, SRC).map((h) => h.path), ['config.auth.tokenUrl']);
  assert.deepEqual(uncoveredFor(hits, { artifacts: {}, replace: [{ from: 'dev-space.kinops.io', to: 'prod.kinops.io' }] }, SRC), []);
});
