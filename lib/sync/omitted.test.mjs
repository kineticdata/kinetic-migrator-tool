// When the Integrator sign-in is unavailable (Kinetic Platform 7.0.0-rc3
// answers 404), exports leave connections and operations out and say so;
// plans and comparisons then leave them out on both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient, integratorAuthUnavailable } from './fake-client.mjs';
import { runExport, runCompare, computePlan, runApply } from './commands.mjs';
import { createClient, IntegratorSignInFailed } from './http.mjs';
import { writeTree, MARKER } from './store.mjs';
import { loadTree } from './layout.mjs';
import { markerOmitted, markerLines, omittedBetween, withoutOmitted } from './omitted.mjs';

const emptySpaceRoutes = (space = {}) => ({
  'GET core/space': { space: { name: 'Space', slug: 'space', ...space } },
  'GET core/teams': { teams: [] },
  'GET core/fileResources': { fileResources: [] },
  'GET integrator/connections': [],
  'GET core/kapps': { kapps: [] },
  'GET core/workflows': { workflows: [] },
  'GET task/trees': { trees: [] },
  'GET task/handlers': { handlers: [] },
});

function tempProject(envs = { dev: { url: 'https://dev.example.com', readOnly: true } }) {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-omitted-'));
  mkdirSync(join(dir, 'environments'));
  for (const [name, def] of Object.entries(envs)) {
    writeFileSync(join(dir, 'environments', `${name}.json`), JSON.stringify(def));
    const k = name.toUpperCase();
    writeFileSync(join(dir, `.env.${name}`), `KINETIC_${k}_USERNAME=u\nKINETIC_${k}_PASSWORD=p\n`);
  }
  return dir;
}

const CONN = { id: 'c-1', name: 'Billing', type: 'http', config: { baseUrl: 'https://billing.example.com' } };
const OP = { id: 'o-1', name: 'Get invoice', connectionId: 'c-1', config: { method: 'GET', path: '/invoices' } };
const withConnection = (space = {}) => ({
  ...emptySpaceRoutes(space),
  'GET integrator/connections': [{ id: CONN.id, name: CONN.name }],
  [`GET integrator/export/connections/${CONN.id}`]: { connection: { ...CONN, operations: [OP] } },
});
const CONN_KEYS = ['connections/Billing/connection', 'connections/Billing/operations/Get invoice'];
const noIntegrator = integratorAuthUnavailable({ host: 'prod.example.com' });

test('export leaves connections and operations out when the Integrator sign-in answers 404, keeps the rest, records why, and warns', async () => {
  const dir = tempProject();
  const events = [];
  const r = await runExport({
    projectDir: dir, envName: 'dev', log: () => {}, onEvent: (e) => events.push(e),
    clientFactory: ({ mode }) => fakeClient(withConnection(), { mode, integratorAuth: noIntegrator }),
  });
  assert.equal(r.code, 0);
  const tree = loadTree(join(dir, 'snapshots', 'dev'));
  assert.deepEqual([...tree.keys()].sort(), ['space', 'task-refs']);
  assert.equal(tree.omitted.length, 1);
  assert.deepEqual(tree.omitted[0].types, ['connections', 'operations']);
  assert.equal(tree.omitted[0].status, 404);
  assert.equal(tree.omitted[0].version, '7.0.0-rc3');
  const message = "Connections and operations were left out: prod.example.com runs Kinetic Platform 7.0.0-rc3, which doesn't offer the sign-in this tool uses for the Integrator yet.";
  assert.deepEqual(r.warnings, [message]);
  assert.ok(events.some((e) => e.type === 'warning' && e.message === message));
  assert.match(readFileSync(join(dir, 'snapshots', 'dev', MARKER), 'utf8'), /^layout: 2\nomitted: \{/m);
});

test('an export with the Integrator available records no omission', async () => {
  const dir = tempProject();
  await runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(withConnection(), { mode }) });
  const tree = loadTree(join(dir, 'snapshots', 'dev'));
  for (const k of CONN_KEYS) assert.ok(tree.has(k), k);
  assert.deepEqual(tree.omitted, []);
  assert.doesNotMatch(readFileSync(join(dir, 'snapshots', 'dev', MARKER), 'utf8'), /omitted/);
});

test('other export failures still fail the export', async () => {
  const dir = tempProject();
  const routes = withConnection();
  routes['GET core/teams'] = () => { throw Object.assign(new Error('500 boom'), { status: 500 }); };
  await assert.rejects(runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(routes, { mode, integratorAuth: noIntegrator }) }), /boom/);
});

test('marker lines round-trip; unreadable lines record nothing', () => {
  const o = { types: ['connections', 'operations'], reason: 'integrator-auth', status: 404, version: '7.0.0-rc3', message: 'm' };
  assert.deepEqual(markerOmitted(`Generated\nlayout: 2\n${markerLines([o])}omitted: {bad\n`), [o]);
  assert.deepEqual(markerOmitted(undefined), []);
});

test('withoutOmitted drops connections/ keys and keeps tree info', () => {
  const m = Object.defineProperty(new Map([['space', {}], [CONN_KEYS[0], {}], [CONN_KEYS[1], {}]]), 'unresolved', { value: new Map([['x', 'y']]) });
  const { types, notes } = omittedBetween([{ name: 'prod', omitted: [{ types: ['connections', 'operations'], message: 'Why.' }] }, { name: 'dev', omitted: [] }]);
  const out = withoutOmitted(m, types);
  assert.deepEqual([...out.keys()], ['space']);
  assert.equal(out.unresolved.get('x'), 'y');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /prod's snapshot has none recorded\. Why\. They are not compared, created or removed\./);
});

// dev (source) has the connection, prod (target) cannot be signed in to.
function harness({ targetDown = true, sourceDown = false, devTeams = [] } = {}) {
  const dir = tempProject({ dev: { url: 'https://dev.example.com', readOnly: true }, prod: { url: 'https://prod.example.com' } });
  const calls = [];
  const clientFactory = ({ env, mode }) => {
    const down = env.name === 'prod' ? targetDown : sourceDown;
    return fakeClient(env.name === 'prod' ? emptySpaceRoutes({ name: 'Space' }) : { ...withConnection({ name: 'Space' }), 'GET core/teams': { teams: devTeams } }, { mode, calls, integratorAuth: down ? noIntegrator : undefined });
  };
  return { dir, calls, clientFactory };
}

test('a plan into a target without connections creates none and offers no removals, with a note', async () => {
  const h = harness();
  await runExport({ projectDir: h.dir, envName: 'dev', log: () => {}, clientFactory: h.clientFactory });
  // The source snapshot has them; the target's export cannot read them.
  const { plan } = await computePlan({ projectDir: h.dir, envName: 'prod', from: 'dev', clientFactory: h.clientFactory });
  for (const k of CONN_KEYS) {
    assert.equal(plan.items.some((i) => i.key === k), false, k);
    assert.equal(plan.targetOnly.some((t) => t.key === k), false, k);
  }
  assert.deepEqual(plan.omitted, ['connections', 'operations']);
  assert.ok(plan.warnings.some((w) => /Connections and operations are left out of this comparison: prod's connections couldn't be read/.test(w)), plan.warnings.join('\n'));
  assert.deepEqual(plan.errors, []);
});

test('a source snapshot without connections never reads as removals of the target\'s connections', async () => {
  const h = harness({ targetDown: false, sourceDown: true });
  // dev cannot be signed in to; prod's live export has a connection.
  const clientFactory = ({ env, mode }) => fakeClient(env.name === 'prod' ? withConnection({ name: 'Space' }) : emptySpaceRoutes({ name: 'Space' }), { mode, integratorAuth: env.name === 'dev' ? noIntegrator : undefined });
  await runExport({ projectDir: h.dir, envName: 'dev', log: () => {}, clientFactory });
  const { plan } = await computePlan({ projectDir: h.dir, envName: 'prod', from: 'dev', clientFactory, select: new Set(['space', CONN_KEYS[0]]) });
  assert.equal(plan.targetOnly.some((t) => t.key.startsWith('connections/')), false);
  assert.equal(plan.removals.length, 0);
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => /dev's snapshot has none recorded/.test(w)));
  // The selection filter: a selected connection key is not "selected but missing".
  assert.equal(plan.items.some((i) => i.key.startsWith('connections/')), false);
  // Asking to remove the target's connection drops that removal with a
  // warning (it could not be checked); the rest of the plan is not blocked.
  const asked = await computePlan({ projectDir: h.dir, envName: 'prod', from: 'dev', clientFactory, remove: [CONN_KEYS[0]], select: new Set(['space']) });
  assert.equal(asked.plan.removals.length, 0);
  assert.deepEqual(asked.plan.errors, []);
  assert.ok(asked.plan.items.some((i) => i.key === 'space'));
  assert.deepEqual(asked.plan.warnings.filter((w) => w.includes('not removed')), [`${CONN_KEYS[0]}: not removed — couldn't check dev's connections: prod.example.com runs Kinetic Platform 7.0.0-rc3, which doesn't offer the sign-in this tool uses for the Integrator yet.`]);
});

test('references to connections are not checked (no false errors) when connections were left out', async () => {
  const h = harness();
  writeTree(join(h.dir, 'snapshots', 'dev'), [
    { key: 'space', data: { name: 'Space', integrations: [{ name: 'Lookup', connectionId: 'c-404', operationId: 'o-404' }] } },
  ], { omitted: [] });
  const { plan } = await computePlan({ projectDir: h.dir, envName: 'prod', from: 'dev', clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => /1 item\(s\) call connections or operations that couldn't be checked, because connections were left out: space/.test(w)), plan.warnings.join('\n'));
});

test('apply never writes connections when the target has none recorded, and its backup records the omission', async () => {
  const h = harness({ devTeams: [{ name: 'Ops', slug: 'ops' }] });
  await runExport({ projectDir: h.dir, envName: 'dev', log: () => {}, clientFactory: h.clientFactory });
  const r = await runApply({ projectDir: h.dir, envName: 'prod', from: 'dev', yes: true, prune: ['connections'], log: () => {}, clientFactory: h.clientFactory });
  assert.equal(r.code, 0);
  assert.equal(h.calls.some((c) => c.api === 'integrator' && c.method !== 'GET'), false);
  assert.equal(r.done, 1);
  const backups = existsSync(join(h.dir, 'backups')) ? readdirSync(join(h.dir, 'backups')) : [];
  assert.equal(backups.length, 1);
  for (const b of backups) assert.match(readFileSync(join(h.dir, 'backups', b, MARKER), 'utf8'), /omitted: /);
});

test('compare (preview and raw) leaves connections out on both sides with a note', async () => {
  const h = harness();
  const out = [];
  const preview = await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', log: (m) => out.push(m), clientFactory: h.clientFactory });
  assert.equal(preview.items.some((i) => i.key.startsWith('connections/')), false);
  assert.ok(preview.plan.warnings.some((w) => /left out of this comparison/.test(w)));
  const raw = await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', raw: true, log: (m) => out.push(m), clientFactory: h.clientFactory });
  assert.equal(raw.result.items.some((i) => i.key.startsWith('connections/')), false);
  assert.ok(out.some((m) => /WARN {2}Connections and operations are left out of this comparison: prod/.test(m)));
});

test('an Integrator HTTP error while reading connections fails the export (only an unsupported sign-in is left out)', async () => {
  const dir = tempProject();
  const routes = withConnection();
  routes['GET integrator/connections'] = () => { throw Object.assign(new Error('500 integrator down'), { name: 'HttpError', status: 500 }); };
  await assert.rejects(runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(routes, { mode }) }), /integrator down/);
});

test('a refused or failed Integrator sign-in fails the export; an IntegratorAuthUnavailable without unsupported is not left out either', async () => {
  for (const err of [
    new IntegratorSignInFailed({ status: 401 }), new IntegratorSignInFailed({ status: 503 }), new IntegratorSignInFailed({ status: 302, redirected: true }),
    Object.assign(new Error('odd'), { name: 'IntegratorAuthUnavailable', unsupported: false }),
  ]) {
    const dir = tempProject();
    await assert.rejects(runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(withConnection(), { mode, integratorAuth: err }) }), (e) => e === err);
  }
});

test('a real client against a sign-in answering 401 or 503 fails the export; 404 (from both sign-ins) leaves connections out', async () => {
  for (const [status, ok] of [[401, false], [503, false], [404, true]]) {
    const dir = tempProject();
    // The version is not known (both endpoints fail), so the implicit grant
    // is tried first and, on a 404, the 7.x sign-in (login.do 404 here too).
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/app/oauth/authorize')) return new Response(JSON.stringify({ statusCode: status }), { status });
      if (u.endsWith('/version')) return new Response('{}', { status: 404 });
      if (u.endsWith('/app/login.do') || u.endsWith('/meta/spa')) return new Response('{}', { status: 404 });
      const path = new URL(u).pathname.replace(/^\/app\/(api\/v1|components\/task\/app\/api\/v2)/, '');
      const api = u.includes('/components/task/') ? 'task' : 'core';
      const body = emptySpaceRoutes()[`GET ${api}${path}`];
      return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
    };
    const run = runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ env, mode }) => createClient({ env, mode, fetchImpl, sleep: async () => {} }) });
    if (ok) assert.deepEqual((await run).omitted.map((o) => o.status), [404]);
    else await assert.rejects(run, (e) => e.name === 'IntegratorSignInFailed' && e.status === status);
  }
});
