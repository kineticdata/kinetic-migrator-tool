// Jobs: registry, write locks, abort, and the jobs API including SSE replay.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JobRegistry } from './jobs.ts';
import { ApiError } from './errors.ts';
import { startTestServer, type TestServer } from './test-helpers.ts';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('a job runs, records events and its result', async () => {
  const jobs = new JobRegistry();
  const id = jobs.createJob('snapshot', async (emit) => {
    emit({ type: 'log', message: 'hello' });
    return { ok: true };
  });
  const job = await jobs.wait(id);
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result, { ok: true });
  assert.equal(job.events.length, 1);
  assert.equal(job.events[0].seq, 1);
  assert.equal(job.events[0].type, 'log');
  assert.deepEqual(job.events[0].data, { type: 'log', message: 'hello' });
});

test('a failing job maps its error and never keeps a stack', async () => {
  const jobs = new JobRegistry();
  const id = jobs.createJob('compare', async () => { throw new ApiError(400, 'bad_input', 'Bad input'); });
  const job = await jobs.wait(id);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.error, { code: 'bad_input', message: 'Bad input' });
});

test('a second write job on the same lock is rejected with 409', async () => {
  const jobs = new JobRegistry();
  const gate = deferred();
  const first = jobs.createJob('apply', () => gate.promise, { lockKey: 'p1/test' });
  assert.throws(() => jobs.createJob('apply', async () => null, { lockKey: 'p1/test' }), (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === 'locked');
  // A different target is fine.
  const other = jobs.createJob('apply', async () => null, { lockKey: 'p1/prod' });
  await jobs.wait(other);
  gate.resolve();
  await jobs.wait(first);
  // Released after the first job settles.
  const again = jobs.createJob('apply', async () => null, { lockKey: 'p1/test' });
  assert.equal((await jobs.wait(again)).status, 'succeeded');
});

test('aborting cancels: the signal fires and the job ends cancelled', async () => {
  const jobs = new JobRegistry();
  const started = deferred();
  const id = jobs.createJob('apply', (emit, signal) => new Promise((resolve, reject) => {
    started.resolve();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'CancelledError' })));
  }), { lockKey: 'p1/test' });
  await started.promise;
  assert.equal(jobs.abort(id), true);
  const job = await jobs.wait(id);
  assert.equal(job.status, 'cancelled');
  // The lock is released.
  assert.equal((await jobs.wait(jobs.createJob('apply', async () => 1, { lockKey: 'p1/test' }))).status, 'succeeded');
});

// ---- HTTP

let s: TestServer;
before(async () => { s = await startTestServer(); });
after(async () => { await s.cleanup(); });

function readSse(port: number, pathname: string, headers: Record<string, string>): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseSse(text: string) {
  return text.split('\n\n').filter((b) => b && !b.startsWith(':')).map((block) => {
    const out: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return out;
  });
}

test('GET /api/jobs/:id reports status and result', async () => {
  const id = s.jobs.createJob('snapshot', async () => ({ snapshot: 'abc' }));
  await s.jobs.wait(id);
  const res = await s.api(`/api/jobs/${id}`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.id, id);
  assert.equal(body.kind, 'snapshot');
  assert.equal(body.status, 'succeeded');
  assert.deepEqual(body.result, { snapshot: 'abc' });
  assert.equal((await s.api('/api/jobs/missing')).status, 404);
});

test('SSE replays earlier events, streams new ones and ends with event: end', async () => {
  const gate = deferred();
  const id = s.jobs.createJob('snapshot', async (emit) => {
    emit({ type: 'progress', phase: 'forms', done: 1, total: 2 });
    emit({ type: 'log', message: 'early' });
    await gate.promise;
    emit({ type: 'log', message: 'late' });
    return { done: true };
  });
  const pending = readSse(s.port, `/api/jobs/${id}/events`, s.good);
  // Let the early events land and the stream connect before releasing.
  await new Promise((r) => setTimeout(r, 50));
  gate.resolve();
  const { status, type, text } = await pending;
  assert.equal(status, 200);
  assert.match(type, /text\/event-stream/);
  const events = parseSse(text);
  assert.deepEqual(events.map((e) => e.event), ['progress', 'log', 'log', 'end']);
  assert.equal(JSON.parse(events[1].data).message, 'early');
  assert.equal(JSON.parse(events[2].data).message, 'late');
  assert.equal(JSON.parse(events[3].data).status, 'succeeded');
});

test('SSE headers arrive before any event', async () => {
  const gate = deferred();
  const id = s.jobs.createJob('snapshot', async () => { await gate.promise; return null; });
  const status = await new Promise<{ status: number; type: string; req: http.ClientRequest }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: `/api/jobs/${id}/events`, headers: { host: `localhost:${s.port}`, ...s.good } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), req });
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(s.jobs.get(id)?.events.length, 0);
  assert.equal(status.status, 200);
  assert.match(status.type, /text\/event-stream/);
  status.req.destroy();
  gate.resolve();
  await s.jobs.wait(id);
});

test('SSE on a finished job replays everything then ends', async () => {
  const id = s.jobs.createJob('compare', async (emit) => { emit({ type: 'log', message: 'one' }); return null; });
  await s.jobs.wait(id);
  const events = parseSse((await readSse(s.port, `/api/jobs/${id}/events`, s.good)).text);
  assert.deepEqual(events.map((e) => e.event), ['log', 'end']);
});

test('SSE requires the same API checks', async () => {
  const id = s.jobs.createJob('compare', async () => null);
  assert.equal((await readSse(s.port, `/api/jobs/${id}/events`, { 'x-kinetic-migrate': '1' })).status, 401);
});

test('DELETE /api/jobs/:id aborts a running job', async () => {
  const id = s.jobs.createJob('apply', (emit, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('stopped'));
  }));
  const res = await s.api(`/api/jobs/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 202);
  const job = await s.jobs.wait(id);
  assert.equal(job.status, 'cancelled');
  assert.equal((await s.api('/api/jobs/missing', { method: 'DELETE' })).status, 404);
});
