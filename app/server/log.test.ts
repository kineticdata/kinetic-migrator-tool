// Logger: unexpected errors reach stderr (redacted); clients get a generic body.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PlanResult } from '../shared/sync-api.ts';
import { createLogger, formatError, logDir, upstreamSummary, workspaceLogger } from './log.ts';
import { PLANTED as PLANTED_PASSWORD, PLANTED_RUN, devRoutes, harness, testRoutes } from './sync-fixtures.ts';
import { JobRegistry } from './jobs.ts';
import { startTestServer, type TestServer } from './test-helpers.ts';

const PLANTED = 'sEcReT-planted-123';
const P = '/api/projects/sync-test';
const HANDLER = 'handlers/mail_send_v1/handler';
const TOKEN = 'Planted-Token-z8Kd20';

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

// ---- The workspace log file ----------------------------------------------

test('the log file is per day, time-stamped, rotates at midnight and keeps the newest 14 days', () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'km-log-'));
  const dir = logDir(ws);
  mkdirSync(dir, { recursive: true });
  for (let d = 1; d <= 20; d++) writeFileSync(path.join(dir, `kinetic-migrate-2026-09-${String(d).padStart(2, '0')}.log`), 'old\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'kept');
  let now = new Date(2026, 9, 7, 23, 59, 30);
  const errOut: string[] = [];
  const logger = workspaceLogger(ws, { now: () => now, stderr: (t) => errOut.push(t) });
  logger.error('first', new Error('one'));
  assert.equal(logger.file!(), path.join(dir, 'kinetic-migrate-2026-10-07.log'));
  now = new Date(2026, 9, 8, 0, 0, 5);
  logger.error('second', new Error('two'));
  logger.info!('quiet one', { quiet: true });
  const files = readdirSync(dir).sort();
  assert.ok(files.includes('notes.txt'));
  const logs = files.filter((f) => f.endsWith('.log'));
  assert.equal(logs.length, 14);
  assert.equal(logs.at(-1), 'kinetic-migrate-2026-10-08.log');
  assert.equal(logs[0], 'kinetic-migrate-2026-09-09.log'); // 12 old days, plus Oct 7 and Oct 8
  const today = readFileSync(path.join(dir, 'kinetic-migrate-2026-10-08.log'), 'utf8');
  assert.match(today, /^\d{4}-\d{2}-\d{2}T\S+Z \[kinetic-migrate\] second: Error: two$/m);
  assert.match(today, /quiet one/);
  // stderr gets the same lines, without the time stamp, and not the quiet one.
  assert.equal(errOut.length, 2);
  assert.ok(errOut[1].startsWith('[kinetic-migrate] second: Error: two'));
  assert.ok(today.includes(errOut[1].split('\n')[0]));
});

test('failed jobs log the upstream message and the names of its errors, never their values', () => {
  const body = JSON.stringify({ message: 'Invalid handler', errors: [{ field: 'Password', value: PLANTED }, { name: 'Server' }], validationErrors: [{ path: '/config/auth/token', error: 'Missing field' }] });
  const err = Object.assign(new Error(`POST /handlers failed with 400: ${body}`), { name: 'HttpError', status: 400, body });
  assert.equal(upstreamSummary(err), 'upstream 400: message: "Invalid handler"; errors: Password, Server, /config/auth/token');
  assert.equal(upstreamSummary(new Error('x')), null);
});

test('secrets given to the server (password, handler secret for one run, tokens) never reach the log file', async (t) => {
  const ws = mkdtempSync(path.join(tmpdir(), 'km-log-ws-'));
  const logger = workspaceLogger(ws, { stderr: () => {} });
  const h = await harness(t, { dev: true, test: false, prod: true }, { workspace: ws, logger });
  // The test space refuses the handler, echoing what it was sent.
  const echo = () => {
    const body = JSON.stringify({ message: 'Handler rejected', errors: [{ field: 'Password', value: PLANTED_RUN }], hint: `Bearer ${TOKEN}` });
    throw Object.assign(new Error(`POST /handlers failed with 400: ${body} password=${PLANTED_PASSWORD} secret=${PLANTED_RUN}`), { name: 'HttpError', status: 400, body });
  };
  h.spaces.test = () => ({ ...testRoutes(), 'POST task/handlers': echo });
  assert.equal((await h.job('POST', `${P}/snapshots`, { env: 'dev' })).status, 'succeeded');
  const planned = await h.job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: [HANDLER] });
  assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const p = planned.result as PlanResult;
  const applied = await h.job('POST', `${P}/plans/${p.planId}/apply`, {
    acknowledgements: p.needsAttention.map((n) => n.id), secrets: Object.fromEntries(p.secretsNeeded.map((s) => [s.id, PLANTED_RUN])), confirm: 'test',
  });
  assert.equal(applied.result?.status, 'failed', JSON.stringify(applied.result ?? applied.error));
  // A failing snapshot job and a throwing route log too.
  h.spaces.dev = () => ({ ...devRoutes(), 'GET core/teams': () => { throw Object.assign(new Error(`teams failed: Basic ${TOKEN} ${PLANTED_PASSWORD}`), { name: 'HttpError', status: 500, body: '{}' }); } });
  assert.equal((await h.job('POST', `${P}/snapshots`, { env: 'dev' })).status, 'failed');
  h.server.router.get('/api/test-log-boom', () => { throw new Error(`boom ${PLANTED_PASSWORD} ${PLANTED_RUN}`); });
  assert.equal((await h.call('GET', '/api/test-log-boom')).status, 500);

  const text = readdirSync(logDir(ws)).map((f) => readFileSync(path.join(logDir(ws), f), 'utf8')).join('');
  assert.match(text, /apply .* to test failed at handlers\/mail_send_v1\/handler/);
  assert.match(text, /upstream 400: message: "Handler rejected"; errors: Password/);
  assert.match(text, /job snapshot .* failed/);
  assert.match(text, /GET \/api\/test-log-boom: Error: boom/);
  for (const secret of [PLANTED_PASSWORD, PLANTED_RUN, TOKEN]) assert.ok(!text.includes(secret), `${secret} reached the log file:\n${text}`);
  const session = (await h.call('GET', '/api/session')).json;
  assert.equal(session.logFile, logger.file!());
});

test('the log folder and files are private to this user, and JWTs or access_token parameters are masked', { skip: process.platform === 'win32' }, () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'km-log-mode-'));
  const logger = workspaceLogger(ws, { stderr: () => {} });
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  logger.error('ctx', new Error(`redirect https://x/#access_token=tok-123abc&expires_in=1 and ${jwt}`));
  assert.equal(statSync(logDir(ws)).mode & 0o777, 0o700);
  const file = logger.file!()!;
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('tok-123abc') && !text.includes(jwt), text);
  assert.match(text, /access_token=\[REDACTED\]&expires_in=1/);
});

test('a secret saved through Settings is masked in the log from then on', async (t) => {
  const SAVED = 'Saved-Password-r5Tn77';
  const lines: string[] = [];
  const h = await harness(t, { dev: true, test: false, prod: true }, { logger: createLogger((x) => lines.push(x)) });
  await h.call('PUT', `${P}/environments/test/credentials`, { password: SAVED });
  h.server.router.get('/api/test-saved-boom', () => { throw new Error(`boom ${SAVED}`); });
  await h.call('GET', '/api/test-saved-boom');
  assert.ok(lines.some((l) => l.includes('boom')));
  assert.ok(!lines.join('').includes(SAVED));
});
