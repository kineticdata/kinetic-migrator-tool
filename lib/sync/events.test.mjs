// lib/sync/events.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter, cancelled, CancelledError } from './events.mjs';

test('emitter builds typed events and is a no-op without a callback', () => {
  const seen = [];
  const e = createEmitter((ev) => seen.push(ev));
  e.progress('export', 1, 4, 'teams');
  e.item('space', 'running');
  e.item('space', 'failed', 'boom');
  e.warning('careful');
  e.log('hello');
  assert.deepEqual(seen, [
    { type: 'progress', phase: 'export', done: 1, total: 4, key: 'teams' },
    { type: 'item', key: 'space', status: 'running', message: undefined },
    { type: 'item', key: 'space', status: 'failed', message: 'boom' },
    { type: 'warning', message: 'careful' },
    { type: 'log', message: 'hello' },
  ]);
  const quiet = createEmitter();
  quiet.progress('x', 0, 0);
  quiet.log('nothing listens');
});

test('cancelled throws CancelledError only for an aborted signal', () => {
  cancelled(undefined);
  const c = new AbortController();
  cancelled(c.signal);
  c.abort();
  assert.throws(() => cancelled(c.signal), CancelledError);
});
