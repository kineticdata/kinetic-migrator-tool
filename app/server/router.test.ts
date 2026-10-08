// Router: method + path pattern matching with params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from './router.ts';

const noop = async () => ({ json: null });

test('matches method and path params', () => {
  const r = new Router();
  r.add('GET', '/api/jobs/:id', noop);
  r.add('GET', '/api/jobs/:id/events', noop);
  const m = r.match('GET', '/api/jobs/abc%20d/events');
  assert.ok(m && 'handler' in m);
  assert.deepEqual(m.params, { id: 'abc d' });
  assert.equal(r.match('GET', '/api/jobs'), null);
});

test('known path with another method reports method_not_allowed', () => {
  const r = new Router();
  r.add('GET', '/api/jobs/:id', noop);
  const m = r.match('PUT', '/api/jobs/1');
  assert.ok(m && 'methodNotAllowed' in m);
  assert.deepEqual(m.allowed, ['GET']);
});
