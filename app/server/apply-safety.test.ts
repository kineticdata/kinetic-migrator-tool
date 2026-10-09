// Apply and job safety: only planned, non-secret environment values; handler
// secrets for one run; failed applies; redacted job errors; snapshots that
// fail leave the last one in place; stale work folders go at start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PlanResult } from '../shared/sync-api.ts';
import { log, readTreeAt } from './repo.ts';
import { PLANTED, PLANTED_CONN, PLANTED_RUN, assertNoSecret, devRoutes, harness, testRoutes, type Harness } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const FORM = 'kapps/services/forms/it-request/form';
const HANDLER = 'handlers/mail_send_v1/handler';
const TOKEN = 'Planted-Token-q9Wz41';

async function plan(h: Harness, body: unknown): Promise<PlanResult> {
  const job = await h.job('POST', `${P}/plans`, body);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  return job.result as PlanResult;
}

const commits = async (h: Harness) => (await log(h.dir, { limit: 10000 })).length;

test('apply accepts only the planned, non-secret environment values; a rejection writes and commits nothing', async (t) => {
  const h = await harness(t);
  await h.call('PUT', `${P}/config`, { envBoundAttributes: { form: ['Owner'] } });
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops', FORM, 'connections/Ticketing/connection', 'connections/Ticketing/operations/Create Ticket'] });
  const before = await commits(h);
  const base = { acknowledgements: p.needsAttention.map((n) => n.id), confirm: 'test' };
  const secretPath = await h.call('POST', `${P}/plans/${p.planId}/apply`, {
    ...base, values: { [FORM]: { 'attributes.Owner': ['IT'] }, 'connections/Ticketing/connection': { 'config.auth.password': PLANTED_RUN } },
  });
  assert.equal(secretPath.status, 400);
  assert.equal(secretPath.json.error.code, 'secret_value');
  const nested = await h.call('POST', `${P}/plans/${p.planId}/apply`, { ...base, values: { [FORM]: { 'attributes.Owner': ['IT'], 'attributes.Api Token': ['x'] } } });
  assert.equal(nested.json.error.code, 'secret_value');
  const unplanned = await h.call('POST', `${P}/plans/${p.planId}/apply`, { ...base, values: { [FORM]: { 'attributes.Owner': ['IT'], description: 'x' } } });
  assert.equal(unplanned.status, 400);
  assert.match(unplanned.json.error.message, /not in the plan/);
  const otherKey = await h.call('POST', `${P}/plans/${p.planId}/apply`, { ...base, values: { 'teams/Ops': { description: 'x' }, [FORM]: { 'attributes.Owner': ['IT'] } } });
  assert.equal(otherKey.status, 400);
  assert.equal(await commits(h), before, 'nothing committed');
  assert.equal(existsSync(path.join(h.dir, 'overrides', 'test.json')), false, 'nothing written');
  assert.deepEqual(h.writes(), []);
  assertNoSecret(h);
});

test('handler secrets given for one run reach the engine as KINETIC_<ENV>_HANDLER_* vars and are not kept', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: [HANDLER] });
  assert.deepEqual(p.needsAttention.map((n) => n.id), [`handler:${HANDLER}`]);
  assert.deepEqual(p.secretsNeeded.map((s) => [s.id, s.has]), [['handler/MAIL_SEND_V1__PASSWORD', false]]);
  assert.deepEqual(p.environmentValues.map((v) => [v.label, v.from, v.to]), [['Server', 'smtp.dev.example.com', 'smtp.dev.example.com']]);
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, {
    acknowledgements: [`handler:${HANDLER}`], secrets: { 'handler/MAIL_SEND_V1__PASSWORD': PLANTED_RUN }, confirm: 'test',
  });
  assert.equal(job.result.status, 'applied', job.result.error);
  assert.deepEqual(h.writes('test'), ['POST /handlers', 'PUT /handlers/mail_send_v1']);
  const put = h.calls.find((c) => c.method === 'PUT' && c.path === '/handlers/mail_send_v1')!;
  assert.deepEqual((put.body as any).properties, { Password: PLANTED_RUN, Server: 'smtp.dev.example.com' });
  const writer = h.envs.find((e) => e.name === 'test' && e.vars.KINETIC_TEST_HANDLER_MAIL_SEND_V1__PASSWORD);
  assert.equal(writer?.vars.KINETIC_TEST_HANDLER_MAIL_SEND_V1__PASSWORD, PLANTED_RUN);
  const sid = JSON.parse(readFileSync(path.join(h.dir, 'kinetic-migrate.json'), 'utf8')).secretsId;
  assert.equal(await h.store.has(`${sid}/test/handler/MAIL_SEND_V1__PASSWORD`), false);
  // A later plan does not see it either.
  const again = await plan(h, { to: 'test', from: 'dev', selected: [HANDLER] });
  assert.equal(again.secretsNeeded[0].has, false);
  const run = readdirSync(path.join(h.dir, 'runs')).map((f) => readFileSync(path.join(h.dir, 'runs', f), 'utf8')).join('');
  assert.ok(!run.includes(PLANTED_RUN));
  assertNoSecret(h, [job.events]);
});

test('an apply that writes nothing commits "Failed to apply"', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops'] });
  h.spaces.test = () => ({ ...testRoutes(), 'PUT core/teams/ops': () => { throw Object.assign(new Error('PUT failed with 503: busy'), { name: 'HttpError', status: 503 }); } });
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(job.result.status, 'failed');
  assert.match((await log(h.dir, { limit: 1 }))[0].message, /^Failed to apply '1 item from Dev' to Test\n/);
});

test('failed snapshot and plan jobs: the error is redacted in the log and the last snapshot stays in place', async (t) => {
  const h = await harness(t);
  const good = (await h.job('POST', `${P}/snapshots`, { env: 'dev' })).result;
  const failing = () => ({ ...devRoutes(), 'GET core/teams': () => { throw new Error(`upstream said Bearer ${TOKEN} for ${PLANTED}`); } });
  h.spaces.dev = failing;
  const snap = await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  assert.equal(snap.status, 'failed');
  assert.equal(snap.error.message, 'Something went wrong on the server.');
  assert.ok(h.logged.length >= 1);
  for (const line of h.logged) assert.ok(!line.includes(TOKEN) && !line.includes(PLANTED), line);
  // The working tree still matches the last committed snapshot; no export leftovers.
  const committed = await readTreeAt(h.dir, good.commit, 'snapshots/dev');
  assert.ok(committed.size > 0);
  for (const [key, data] of committed) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(h.dir, 'snapshots', 'dev', `${key}.json`), 'utf8')), data);
  }
  assert.deepEqual(readdirSync(path.join(h.dir, 'plans')).filter((n) => n.startsWith('snap-')), []);

  h.spaces.test = () => ({ ...testRoutes(), 'GET core/teams': () => { throw new Error(`target said Bearer ${TOKEN} for ${PLANTED}`); } });
  const logged = h.logged.length;
  const p = await h.job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: ['teams/Ops'] });
  assert.equal(p.status, 'failed');
  assert.ok(h.logged.length > logged);
  for (const line of h.logged) assert.ok(!line.includes(TOKEN) && !line.includes(PLANTED), line);
  assert.deepEqual(readdirSync(path.join(h.dir, 'plans')).filter((n) => n.startsWith('src-')), [], 'the failed plan left no source folder');
  assertNoSecret(h, [snap.events, p.events]);
});

test('stale plan source folders and snapshot exports are removed when the server starts', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'km-ws-stale-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const first = await harness(t, { dev: true } as any, { workspace });
  await first.job('POST', `${P}/snapshots`, { env: 'dev' });
  for (const name of ['src-old', 'snap-old', 'keep-me']) mkdirSync(path.join(first.dir, 'plans', name), { recursive: true });
  // A second server on the same workspace cleans up while starting.
  const { startServer } = await import('./main.ts');
  const { MemoryStore } = await import('./secrets.ts');
  const second = await startServer({ workspace, secrets: new MemoryStore() });
  t.after(() => second.close());
  assert.deepEqual(readdirSync(path.join(first.dir, 'plans')).sort(), ['keep-me']);
});

test('a SQL connection: its password never reaches a snapshot, Explore or Compare, and creating it asks for the password write-only', async (t) => {
  const h = await harness(t);
  const SQL = 'connections/Warehouse DB/connection';
  const withSql = () => {
    const routes = devRoutes();
    return {
      ...routes,
      'GET integrator/connections': [{ id: 'c-1', name: 'Ticketing' }, { id: 'c-sql', name: 'Warehouse DB' }],
      'GET integrator/export/connections/c-sql': {
        connection: {
          id: 'c-sql', name: 'Warehouse DB', type: 'postgres',
          config: { configType: 'postgres', host: 'db.example.com', port: 5432, username: 'reporter', password: PLANTED_CONN, database: 'warehouse', poolSize: 5 },
          operations: [],
        },
      },
    };
  };
  h.spaces.dev = withSql;
  assert.equal((await h.job('POST', `${P}/snapshots`, { env: 'dev' })).status, 'succeeded');
  const file = readFileSync(path.join(h.dir, 'snapshots', 'dev', 'connections', 'Warehouse DB', 'connection.json'), 'utf8');
  assert.ok(!file.includes(PLANTED_CONN), 'the snapshot holds no password');
  assert.deepEqual(JSON.parse(file).strippedSecrets, ['password']);

  const item = (await h.call('GET', `${P}/explore/dev/item?key=${encodeURIComponent(SQL)}`)).json;
  const auth = item.summary.sections.find((s: any) => s.heading === 'Authentication');
  assert.deepEqual(auth.rows, [{ label: 'password', value: 'not set' }]);

  const p = await plan(h, { to: 'test', from: 'dev', selected: [SQL] });
  assert.deepEqual(p.secretsNeeded.map((s) => [s.id, s.label, s.has]), [['secret/WAREHOUSE_DB__PASSWORD', 'Warehouse DB › password', false]]);
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], secrets: { 'secret/WAREHOUSE_DB__PASSWORD': PLANTED_RUN }, confirm: 'test' });
  assert.equal(job.result.status, 'applied', job.result.error);
  const created = h.calls.find((c) => c.env === 'test' && c.path === '/import/connections')!;
  assert.equal((created.body as any).config.password, PLANTED_RUN, 'the password went to config.password');
  assert.equal('auth' in (created.body as any).config, false);
  assert.equal('strippedSecrets' in (created.body as any), false);
  assert.ok(!job.events.includes(PLANTED_RUN));

  // A changed password in the source is no difference.
  const cmp = (await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'raw' })).result;
  const row = (await h.call('GET', `${P}/compare/${cmp.compareId}/item?key=${encodeURIComponent(SQL)}`)).json;
  assert.ok(!JSON.stringify(row).includes(PLANTED_CONN));
  assertNoSecret(h, [job.events]);
});
