// Logger: unexpected errors reach stderr (redacted); clients get a generic body.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, formatError } from './log.ts';
import { JobRegistry } from './jobs.ts';
import { startTestServer, type TestServer } from './test-helpers.ts';

const PLANTED = 'sEcReT-planted-123';

test('formatError includes name, message and stack, with secrets redacted', () => {
  const err = new TypeError(`Bearer ${PLANTED} rejected; body {"password":"${PLANTED}"}`);
  const text = formatError('ctx', err);
  assert.match(text, /ctx/);
  assert.match(text, /TypeError/);
  assert.match(text, /rejected/);
  assert.match(text, /at /); // stack
  assert.ok(!text.includes(PLANTED), text);
});

test('the default logger writes to the given sink', () => {
  const lines: string[] = [];
  createLogger((s) => lines.push(s)).error('here', new Error('boom'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /here.*boom/s);
});

let s: TestServer;
const lines: string[] = [];
before(async () => { s = await startTestServer({ logger: createLogger((t) => lines.push(t)) }); });
after(async () => { await s.cleanup(); });

test('a throwing route logs a redacted line and the response stays generic', async () => {
  lines.length = 0;
  s.router.get('/api/test-boom', () => { throw new Error(`Basic ${PLANTED} failed`); });
  const res = await s.api('/api/test-boom');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: { code: 'internal_error', message: 'Something went wrong on the server.' } });
  assert.ok(!res.body.includes(PLANTED));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /failed/);
  assert.ok(!lines[0].includes(PLANTED), lines[0]);
});

test('expected client errors (4xx) are not logged', async () => {
  lines.length = 0;
  await s.api('/api/nope');
  assert.equal(lines.length, 0);
});

test('every failed job is logged, redacted', async () => {
  const out: string[] = [];
  const jobs = new JobRegistry({ logger: createLogger((t) => out.push(t)) });
  const id = jobs.createJob('apply', async () => { throw new Error(`token {"apiKey":"${PLANTED}"}`); });
  const job = await jobs.wait(id);
  assert.equal(job.status, 'failed');
  assert.equal(out.length, 1);
  assert.match(out[0], /apply/);
  assert.ok(!out[0].includes(PLANTED), out[0]);
});
