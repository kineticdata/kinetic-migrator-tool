// Scaffold smoke test: proves the server test runner (node --test via tsx) works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_PORT } from './config.ts';

test('dev port is a fixed local port', () => {
  assert.equal(typeof DEV_PORT, 'number');
  assert.ok(DEV_PORT > 1024 && DEV_PORT < 65536);
});
