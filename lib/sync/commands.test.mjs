// lib/sync/commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient } from './fake-client.mjs';
import { runInit, runExport, runPlan, runApply, runCompare, computePlan, snapshotDir, sourceDirFor } from './commands.mjs';
import { ReadOnlyError } from './http.mjs';
import { CancelledError } from './events.mjs';
import { readTree, writeTree } from './store.mjs';
import { MODULES } from './artifacts/index.mjs';

export function emptySpaceRoutes(space = {}) {
  return {
    'GET core/space': { space: { name: 'Space', slug: 'space', ...space } },
    'GET core/teams': { teams: [] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [],
    'GET core/kapps': { kapps: [] },
    'GET core/workflows': { workflows: [] },
    'GET task/trees': { trees: [] },
    'GET task/handlers': { handlers: [] },
  };
}

export function tempProject(envs = { dev: { url: 'https://dev.example.com', readOnly: true } }) {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-project-'));
  mkdirSync(join(dir, 'environments'));
  for (const [name, def] of Object.entries(envs)) {
    writeFileSync(join(dir, 'environments', `${name}.json`), JSON.stringify(def));
    const k = name.toUpperCase();
    writeFileSync(join(dir, `.env.${name}`), `KINETIC_${k}_USERNAME=u\nKINETIC_${k}_PASSWORD=p\n`);
  }
  return dir;
}

test('init scaffolds a project and never overwrites existing files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-init-'));
  const out = [];
  assert.equal(await runInit({ projectDir: dir, log: (m) => out.push(m) }), 0);
  for (const f of ['kinetic-sync.config.json', 'environments/dev.json', '.gitignore']) assert.ok(existsSync(join(dir, f)), f);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\.env\.\*/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^compares\/$/m);
  writeFileSync(join(dir, 'environments/dev.json'), '{"url":"https://mine"}');
  await runInit({ projectDir: dir, log: (m) => out.push(m) });
  assert.equal(readFileSync(join(dir, 'environments/dev.json'), 'utf8'), '{"url":"https://mine"}');
  assert.ok(out.some((m) => m.includes('exists')));
});

test('export reads with a read-only client and writes the export tree', async () => {
  const dir = tempProject();
  const modes = [];
  const clientFactory = ({ mode }) => { modes.push(mode); return fakeClient(emptySpaceRoutes({ oauthSigningKey: 'k' }), { mode }); };
  const out = [];
  assert.equal((await runExport({ projectDir: dir, envName: 'dev', log: (m) => out.push(m), clientFactory })).code, 0);
  assert.deepEqual(modes, ['read']);
  const tree = readTree(join(dir, 'snapshots', 'dev'));
  assert.deepEqual([...tree.keys()].sort(), ['space', 'task-refs']);
  assert.equal('oauthSigningKey' in tree.get('space'), false);
  assert.ok(out[0].startsWith('Exported 2 artifacts from dev'));
});

test('plan reads the target with a read-only client, prints the plan, records it, and exits 1 on errors', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'teams/Ops', data: { name: 'Ops' } },
  ]);
  const modes = [];
  const clientFactory = ({ mode }) => { modes.push(mode); return fakeClient(emptySpaceRoutes({ displayType: 'Display Page' }), { mode }); };
  const out = [];
  assert.equal((await runPlan({ projectDir: dir, envName: 'prod', log: (m) => out.push(m), clientFactory })).code, 0);
  assert.deepEqual(modes, ['read']);
  const text = out.join('\n');
  assert.match(text, /~ update\s+space\s+space/);
  assert.match(text, /displayType: "Display Page" → "Redirect"/);
  assert.match(text, /\+ create\s+teams\s+teams\/Ops/);
  assert.equal(readdirSync(join(dir, 'plans')).length, 1);

  writeTree(join(dir, 'export'), [{ key: 'bogus/thing', data: {} }]);
  assert.equal((await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory })).code, 1);
});

function applyHarness(routes) {
  const calls = [];
  const modes = [];
  const clientFactory = ({ env, mode }) => {
    if (mode === 'write' && env.readOnly) throw new ReadOnlyError('readOnly');
    modes.push(mode);
    return fakeClient(routes, { mode, calls });
  };
  const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  return { clientFactory, writes, modes };
}

function promotable() {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' }, dev: { url: 'https://dev.example.com', readOnly: true } });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'teams/Ops', data: { name: 'Ops' } },
  ]);
  return dir;
}

test('apply backs up, writes in dependency order, and records drift state', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const out = [];
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), ['PUT /space', 'POST /teams']);
  assert.deepEqual(h.modes, ['read', 'write', 'read']);
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  assert.ok(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space);
});

test('apply refuses a readOnly environment before reading or writing anything', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes());
  await assert.rejects(runApply({ projectDir: dir, envName: 'dev', yes: true, log: () => {}, clientFactory: h.clientFactory }), ReadOnlyError);
  assert.deepEqual(h.modes, []);
});

test('apply makes no writes when confirmation is declined or the plan has errors', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory: h.clientFactory, confirm: async () => false })).code, 1);
  writeTree(join(dir, 'export'), [{ key: 'bogus/thing', data: {} }]);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory })).code, 1);
  assert.deepEqual(h.writes(), []);
});

test('apply with nothing to change records a drift baseline and writes nothing', async () => {
  const dir = promotable();
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayType: 'Display Page' } }]);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const out = [];
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), []);
  assert.ok(out.includes('Nothing to apply.'));
  assert.ok(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space);
});

test('apply rejects an unknown --prune type', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes());
  await assert.rejects(runApply({ projectDir: dir, envName: 'prod', yes: true, prune: ['space'], log: () => {}, clientFactory: h.clientFactory }), /--prune space/);
});

function dataProject(exportArts, subs, state) {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeFileSync(join(dir, 'kinetic-sync.config.json'), JSON.stringify({ data: [{ kapp: 'k', form: 'f', key: ['Code'] }] }));
  writeTree(join(dir, 'export'), exportArts);
  if (state) { mkdirSync(join(dir, 'state')); writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify(state)); }
  const routes = { ...emptySpaceRoutes({ displayType: 'Display Page' }), 'GET core/kapps/k/forms/f/submissions': { submissions: subs } };
  return { dir, routes };
}

test('apply --prune teams deletes target-only teams after all writes; without prune it does not', async () => {
  const dir = promotable();
  const routes = { ...emptySpaceRoutes({ displayType: 'Display Page' }), 'GET core/teams': { teams: [{ name: 'Old', slug: 'old-slug' }] } };
  let h = applyHarness(routes);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory })).code, 0);
  assert.equal(h.writes().some((w) => w.startsWith('DELETE')), false);
  h = applyHarness(routes);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, prune: ['teams'], log: () => {}, clientFactory: h.clientFactory })).code, 0);
  const w = h.writes();
  assert.equal(w[w.length - 1], 'DELETE /teams/old-slug');
  assert.deepEqual(w.slice(0, 2), ['PUT /space', 'POST /teams']);
});

test('apply stops at the first failed write, logs it, and rethrows', async () => {
  const dir = promotable();
  const routes = {
    ...emptySpaceRoutes({ displayType: 'Display Page' }),
    'PUT core/space': () => { const e = new Error('500 boom'); e.status = 500; throw e; },
  };
  const h = applyHarness(routes);
  const out = [];
  await assert.rejects(runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), /boom/);
  assert.deepEqual(h.writes(), ['PUT /space']);
  assert.ok(out.some((m) => m.includes('Stopped after')));
});

test('apply skips drifted items and keeps their old state hash', async () => {
  const dir = promotable();
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({ 'teams/Ops': 'oldhash' }));
  const routes = { ...emptySpaceRoutes({ displayType: 'Display Page' }), 'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'changed' }] } };
  const h = applyHarness(routes);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), ['PUT /space']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'))['teams/Ops'], 'oldhash');
});

test('apply --prune data never touches drifted data or target-only data', async () => {
  const key = 'kapps/k/forms/f/data';
  let p = dataProject(
    [{ key: 'space', data: { name: 'Dev', displayType: 'Display Page' } }, { key, data: { key: ['Code'], rows: [{ Code: 'A', V: 'source' }] } }],
    [{ id: 's1', createdAt: '2020', values: { Code: 'A', V: 'changed-in-target' } }],
    { [key]: 'oldhash' },
  );
  let h = applyHarness(p.routes);
  assert.equal((await runApply({ projectDir: p.dir, envName: 'prod', yes: true, prune: ['data'], log: () => {}, clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), []);

  p = dataProject(
    [{ key: 'space', data: { name: 'Dev', displayType: 'Redirect' } }],
    [{ id: 's1', createdAt: '2020', values: { Code: 'A', V: '1' } }],
  );
  h = applyHarness(p.routes);
  const out = [];
  assert.equal((await runApply({ projectDir: p.dir, envName: 'prod', yes: true, prune: ['data'], log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), ['PUT /space']);
  assert.equal(out.join('\n').includes('DELETE'), false);
});

test('apply --prune data shows the target-only rows it will delete, then deletes them', async () => {
  const key = 'kapps/k/forms/f/data';
  const p = dataProject(
    [{ key: 'space', data: { name: 'Dev', displayType: 'Display Page' } }, { key, data: { key: ['Code'], rows: [{ Code: 'A' }] } }],
    [{ id: 's1', createdAt: '2021', values: { Code: 'A' } }, { id: 's2', createdAt: '2020', values: { Code: 'Z' } }],
  );
  const h = applyHarness(p.routes);
  const out = [];
  assert.equal((await runApply({ projectDir: p.dir, envName: 'prod', yes: true, prune: ['data'], log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.match(out.join('\n'), /Rows only in the target \(will be deleted by --prune data\):\n {2}- DELETE row k\/f \["Z"\]/);
  assert.deepEqual(h.writes(), ['DELETE /submissions/s2']);
});

test('init warns when an existing .gitignore does not ignore .env.*', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-init-'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const out = [];
  await runInit({ projectDir: dir, log: (m) => out.push(m) });
  assert.ok(out.includes('  WARN     .gitignore does not ignore .env.* — add it so credentials are never committed'));
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n');
  const ok = [];
  writeFileSync(join(dir, '.gitignore'), '.env.*\ncompares/\n');
  await runInit({ projectDir: dir, log: (m) => ok.push(m) });
  assert.equal(ok.some((m) => m.includes('WARN')), false);
});

test('apply logs a skipped space WebAPI and does not count it as applied', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'webapis/token', data: { slug: 'token', method: 'POST' } },
  ]);
  const routes = {
    ...emptySpaceRoutes({ displayType: 'Display Page' }),
    'POST core/webApiImport': () => { const e = new Error('404 missing'); e.status = 404; throw e; },
  };
  const h = applyHarness(routes);
  const out = [];
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.ok(out.includes('  skipped  webapis/token'));
  assert.ok(out.some((m) => m.includes('Applied 1 change(s) to prod.')));
});


test('init warns when an existing .gitignore does not ignore compares/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-init-'));
  writeFileSync(join(dir, '.gitignore'), '.env.*\n');
  const out = [];
  await runInit({ projectDir: dir, log: (m) => out.push(m) });
  assert.ok(out.includes('  WARN     .gitignore does not ignore compares/ — add it so comparison reports are not committed'));
  const ok = [];
  writeFileSync(join(dir, '.gitignore'), '.env.*\ncompares/\n');
  await runInit({ projectDir: dir, log: (m) => ok.push(m) });
  assert.equal(ok.some((m) => m.includes('WARN')), false);
});

function compareHarness() {
  const dir = tempProject({ dev: { url: 'https://dev.example.com', readOnly: true }, prod: { url: 'https://prod.example.com', readOnly: true } });
  const spaces = { dev: { name: 'Dev', displayType: 'Redirect' }, prod: { name: 'Prod', displayType: 'Redirect' } };
  const opened = [];
  const clientFactory = ({ env, mode }) => {
    opened.push(`${env.name}:${mode}`);
    return fakeClient(emptySpaceRoutes(spaces[env.name]), { mode });
  };
  return { dir, opened, clientFactory };
}

test('compare previews a promotion with two read-only clients and never touches export/', async () => {
  const h = compareHarness();
  const out = [];
  assert.equal((await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.opened.sort(), ['dev:read', 'prod:read']);
  const text = out.join('\n');
  assert.match(text, /^Plan for prod \(preview of promoting dev\)/);
  assert.doesNotMatch(text, /name: "Prod"/);
  assert.equal(existsSync(join(h.dir, 'export')), false);
  const files = readdirSync(join(h.dir, 'compares')).sort();
  assert.equal(files.length, 2);
  assert.match(files[0], /^dev-vs-prod-.*\.html$/);
  assert.match(files[1], /^dev-vs-prod-.*\.json$/);
  for (const f of files) assert.ok(text.includes(join(h.dir, 'compares', f)), f);
  const record = JSON.parse(readFileSync(join(h.dir, 'compares', files[1]), 'utf8'));
  assert.equal(record.mode, 'preview');
  assert.equal(record.from, 'dev');
  assert.equal(record.to, 'prod');
});

test('compare --raw reports an env-bound difference the preview hides', async () => {
  const h = compareHarness();
  const out = [];
  assert.equal((await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', raw: true, log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.opened.sort(), ['dev:read', 'prod:read']);
  const text = out.join('\n');
  assert.match(text, /^Compare dev → prod \(raw\)/);
  assert.match(text, /~ differs\s+space\s+space\n\s+name: "Dev" → "Prod"/);
  const files = readdirSync(join(h.dir, 'compares'));
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
  assert.equal(files.filter((f) => f.endsWith('.html')).length, 1);
  const record = JSON.parse(readFileSync(join(h.dir, 'compares', files.find((f) => f.endsWith('.json'))), 'utf8'));
  assert.equal(record.mode, 'raw');
  assert.deepEqual(record.items.find((i) => i.key === 'space').diff, [{ path: 'name', from: 'Dev', to: 'Prod' }]);
});

function compareRecord(dir, mode) {
  const file = readdirSync(join(dir, 'compares')).find((f) => f.endsWith('.json') && f.includes(`-vs-`));
  const record = JSON.parse(readFileSync(join(dir, 'compares', file), 'utf8'));
  assert.equal(record.mode, mode);
  return record;
}
const statusOf = (record, key) => record.items.find((i) => i.key === key)?.status;

function planEngineHarness({ dev, prod, files = {} }) {
  const dir = tempProject({ dev: { url: 'https://dev.example.com', readOnly: true }, prod: { url: 'https://prod.example.com', readOnly: true } });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), JSON.stringify(content));
  }
  const clientFactory = ({ env, mode }) => fakeClient({ ...emptySpaceRoutes(), ...(env.name === 'dev' ? dev : prod) }, { mode });
  return { dir, clientFactory };
}

async function compareBoth(h) {
  const preview = (await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', log: () => {}, clientFactory: h.clientFactory }), compareRecord(h.dir, 'preview'));
  for (const f of readdirSync(join(h.dir, 'compares'))) rmSync(join(h.dir, 'compares', f));
  await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', raw: true, log: () => {}, clientFactory: h.clientFactory });
  return { preview, raw: compareRecord(h.dir, 'raw') };
}

test('compare preview applies overrides/<to>.json that raw ignores', async () => {
  const h = planEngineHarness({
    dev: emptySpaceRoutes({ name: 'Same', displayType: 'Redirect' }),
    prod: emptySpaceRoutes({ name: 'Same', displayType: 'Display Page' }),
    files: { 'overrides/prod.json': { artifacts: { space: { displayType: 'Display Page' } } } },
  });
  const { preview, raw } = await compareBoth(h);
  assert.equal(statusOf(preview, 'space'), 'unchanged');
  assert.equal(statusOf(raw, 'space'), 'differs');
});

test('compare preview hides envBoundAttributes that raw shows', async () => {
  const h = planEngineHarness({
    dev: emptySpaceRoutes({ name: 'Same', attributes: [{ name: 'Environment', values: ['dev'] }] }),
    prod: emptySpaceRoutes({ name: 'Same', attributes: [{ name: 'Environment', values: ['prod'] }] }),
    files: { 'kinetic-sync.config.json': { envBoundAttributes: { space: ['Environment'] } } },
  });
  const { preview, raw } = await compareBoth(h);
  assert.equal(statusOf(preview, 'space'), 'unchanged');
  assert.equal(statusOf(raw, 'space'), 'differs');
  assert.ok(raw.items.find((i) => i.key === 'space').diff.some((d) => d.path.includes('Environment')));
});

test('compare preview reports skip-drift for a target changed since the recorded state', async () => {
  const team = (description) => ({ 'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description }] } });
  const h = planEngineHarness({
    dev: { ...emptySpaceRoutes({ name: 'Same' }), ...team('from dev') },
    prod: { ...emptySpaceRoutes({ name: 'Same' }), ...team('changed in prod') },
    files: { 'state/prod.json': { 'teams/Ops': 'oldhash' } },
  });
  const { preview, raw } = await compareBoth(h);
  assert.equal(statusOf(preview, 'teams/Ops'), 'skip-drift');
  assert.equal(statusOf(raw, 'teams/Ops'), 'differs');
});

test('compare refuses the same environment on both sides', async () => {
  const h = compareHarness();
  await assert.rejects(runCompare({ projectDir: h.dir, from: 'dev', to: 'dev', log: () => {}, clientFactory: h.clientFactory }), /compare needs two different environments/);
  assert.deepEqual(h.opened, []);
});

test('computePlan with sourceArtifacts does not read the project export', async () => {
  const h = compareHarness();
  const { plan } = await computePlan({
    projectDir: h.dir, envName: 'prod', clientFactory: h.clientFactory,
    sourceArtifacts: [{ key: 'space', data: { name: 'Dev', displayType: 'Display Page' } }, { key: 'teams/Ops', data: { name: 'Ops' } }],
  });
  assert.deepEqual(plan.items.map((i) => [i.key, i.action]), [['space', 'update'], ['teams/Ops', 'create']]);
});

test('handlers: export writes the package; apply installs it before the WebAPI that uses it and backs up target packages', async () => {
  const { createHash } = await import('node:crypto');
  const zip = Buffer.from('PK\x03\x04 mail');
  const other = Buffer.from('PK\x03\x04 other');
  const handler = (definitionId) => ({ definitionId, name: definitionId, properties: [{ name: 'server', type: 'Plaintext', value: 'smtp.dev.example.com' }] });
  const dir = tempProject({ prod: { url: 'https://prod.example.com' }, dev: { url: 'https://dev.example.com', readOnly: true } });

  const devRoutes = { ...emptySpaceRoutes(), 'GET task/handlers': { handlers: [handler('mail_send_v1')] }, 'GET task/handlers/mail_send_v1/zip': zip };
  assert.equal((await runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(devRoutes, { mode }) })).code, 0);
  assert.deepEqual(readFileSync(join(dir, 'snapshots', 'dev', 'handlers', 'mail_send_v1', 'package.zip')), zip);
  const exported = readTree(join(dir, 'snapshots', 'dev'));
  assert.equal(exported.get('handlers/mail_send_v1/handler').packageSha256, createHash('sha256').update(zip).digest('hex'));

  writeTree(snapshotDir(dir, 'dev'), [
    { key: 'space', data: exported.get('space') },
    { key: 'handlers/mail_send_v1/handler', data: exported.get('handlers/mail_send_v1/handler'), files: { 'package.zip': zip } },
    { key: 'webapis/lookup', data: { slug: 'lookup', treeXml: '<task definition_id="mail_send_v1"/>' } },
    { key: 'task-refs', data: { handlers: ['mail_send_v1'], routines: [] } },
  ]);
  const h = applyHarness({ ...emptySpaceRoutes(), 'GET task/handlers': { handlers: [handler('other_v1')] }, 'GET task/handlers/other_v1/zip': other });
  const out = [];
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', from: 'dev', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), ['POST /handlers', 'PUT /handlers/mail_send_v1', 'POST /webApiImport']);
  const [backup] = readdirSync(join(dir, 'backups'));
  assert.deepEqual(readFileSync(join(dir, 'backups', backup, 'handlers', 'other_v1', 'package.zip')), other);
});

test('export emits one progress event per module and returns structured results', async () => {
  const dir = tempProject();
  const events = [];
  const result = await runExport({
    projectDir: dir, envName: 'dev', log: () => {}, onEvent: (e) => events.push(e),
    clientFactory: ({ mode }) => fakeClient(emptySpaceRoutes(), { mode }),
  });
  const progress = events.filter((e) => e.type === 'progress');
  assert.equal(progress.length, MODULES.length);
  assert.ok(progress.every((e) => e.phase === 'export' && e.total === MODULES.length));
  assert.deepEqual(progress.map((e) => e.key), MODULES.map((m) => m.type));
  assert.equal(result.code, 0);
  assert.equal(result.artifacts, 2);
  assert.deepEqual(result.counts, { space: 1, 'task-refs': 1 });
  assert.deepEqual(result.leftovers, []);
  assert.ok(events.some((e) => e.type === 'log' && e.message.startsWith('Exported 2 artifacts')));
});

test('an injected env skips .env loading (project has no .env file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-noenv-'));
  const env = { name: 'dev', url: 'https://dev.example.com', readOnly: true, username: 'u', password: 'p', vars: {} };
  const clientFactory = ({ mode }) => fakeClient(emptySpaceRoutes(), { mode });
  assert.equal((await runExport({ projectDir: dir, envName: 'dev', env, log: () => {}, clientFactory })).code, 0);
  const prod = { ...env, name: 'prod', url: 'https://prod.example.com', readOnly: false };
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', from: 'dev', env: prod, clientFactory });
  assert.deepEqual(plan.items.map((i) => [i.key, i.action]), [['space', 'unchanged']]);
  const r = await runPlan({ projectDir: dir, envName: 'prod', from: 'dev', env: prod, log: () => {}, clientFactory });
  assert.equal(r.code, 0);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  writeTree(snapshotDir(dir, 'dev'), [{ key: 'space', data: { name: 'Dev', displayType: 'Redirect' } }]);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', from: 'dev', env: prod, yes: true, log: () => {}, clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), ['PUT /space']);
  const envs = { from: env, to: { ...prod, readOnly: true } };
  assert.equal((await runCompare({ projectDir: dir, from: 'dev', to: 'prod', envs, log: () => {}, clientFactory })).code, 0);
});

test('apply emits running/done per item in apply order', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const events = [];
  await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, onEvent: (e) => events.push(e), clientFactory: h.clientFactory });
  assert.deepEqual(events.filter((e) => e.type === 'item').map((e) => `${e.key}:${e.status}`),
    ['space:running', 'space:done', 'teams/Ops:running', 'teams/Ops:done']);
  assert.deepEqual(events.filter((e) => e.type === 'progress' && e.phase === 'apply').map((e) => [e.done, e.total]), [[1, 2], [2, 2]]);
});

test('a failed apply item emits failed and stops', async () => {
  const dir = promotable();
  const routes = {
    ...emptySpaceRoutes({ displayType: 'Display Page' }),
    'PUT core/space': () => { const e = new Error('500 boom'); e.status = 500; throw e; },
  };
  const h = applyHarness(routes);
  const events = [];
  await assert.rejects(runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, onEvent: (e) => events.push(e), clientFactory: h.clientFactory }), /boom/);
  const items = events.filter((e) => e.type === 'item').map((e) => `${e.key}:${e.status}`);
  assert.deepEqual(items, ['space:running', 'space:failed']);
  assert.deepEqual(h.writes(), ['PUT /space']);
});

test('an aborted signal stops apply between items with no further writes', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const ac = new AbortController();
  const onEvent = (e) => { if (e.type === 'item' && e.key === 'space' && e.status === 'done') ac.abort(); };
  await assert.rejects(
    runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, onEvent, signal: ac.signal, clientFactory: h.clientFactory }),
    CancelledError,
  );
  assert.deepEqual(h.writes(), ['PUT /space']);
});

test('snapshotDir is snapshots/<env> under the project', () => {
  assert.equal(snapshotDir('/p', 'dev'), join('/p', 'snapshots', 'dev'));
});

test('export lands in snapshots/<env>, not the legacy export folder', async () => {
  const dir = tempProject();
  await runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(emptySpaceRoutes(), { mode }) });
  assert.ok(existsSync(join(dir, 'snapshots', 'dev', 'space.json')));
  assert.equal(existsSync(join(dir, 'export')), false);
});

test('plan and apply with from read that environment\'s snapshot', async () => {
  const dir = tempProject({ dev: { url: 'https://dev.example.com', readOnly: true }, prod: { url: 'https://prod.example.com' } });
  writeTree(snapshotDir(dir, 'dev'), [{ key: 'space', data: { name: 'Dev', displayType: 'Redirect' } }]);
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Legacy', displayType: 'Display Page' } }]);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', from: 'dev', clientFactory: h.clientFactory });
  assert.deepEqual(plan.items.map((i) => [i.key, i.action]), [['space', 'update']]);
  assert.equal((await runPlan({ projectDir: dir, envName: 'prod', from: 'dev', log: () => {}, clientFactory: h.clientFactory })).code, 0);
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', from: 'dev', yes: true, log: () => {}, clientFactory: h.clientFactory })).code, 0);
  assert.deepEqual(h.writes(), ['PUT /space']);
});

test('without from, a legacy export/ folder is still read', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayType: 'Redirect' } }]);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: h.clientFactory });
  assert.deepEqual(plan.items.map((i) => [i.key, i.action]), [['space', 'update']]);
});

test('without from and without a legacy export/, plan and apply say to specify --from', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  const h = applyHarness(emptySpaceRoutes());
  const msg = /Specify --from <env> \(snapshots\/<env> holds each environment's export\)/;
  await assert.rejects(runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory: h.clientFactory }), msg);
  await assert.rejects(runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory }), msg);
});

test('sourceDirFor: legacy export/ only when there is no snapshots/; both present needs --from', () => {
  const dir = tempProject();
  const msg = /Specify --from <env> \(snapshots\/<env> holds each environment's export\)/;
  assert.throws(() => sourceDirFor(dir), msg);
  mkdirSync(join(dir, 'export'));
  assert.equal(sourceDirFor(dir), join(dir, 'export'));
  mkdirSync(join(dir, 'snapshots', 'dev'), { recursive: true });
  assert.throws(() => sourceDirFor(dir), msg);
  assert.equal(sourceDirFor(dir, 'dev'), snapshotDir(dir, 'dev'));
});

test('sourceDirFor validates from and requires its snapshot to exist', () => {
  const dir = tempProject();
  assert.throws(() => sourceDirFor(dir, '../etc'), /^Error: Invalid environment name "\.\.\/etc"/);
  assert.throws(() => sourceDirFor(dir, 'test'), /^Error: No snapshot for "test"; run export --env test$/);
});

function selectionProject() {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'teams/Ops', data: { name: 'Ops' } },
    { key: 'teams/Same', data: { name: 'Same' } },
  ]);
  const routes = {
    ...emptySpaceRoutes({ displayType: 'Display Page' }),
    'GET core/teams': { teams: [{ name: 'Same', slug: 'same' }, { name: 'Old', slug: 'old' }] },
  };
  return { dir, routes };
}

test('apply with a selection never writes unselected items, prunes only selected target-only items, and records state only for the selection', async () => {
  const { dir, routes } = selectionProject();
  const h = applyHarness(routes);
  const out = [];
  const r = await runApply({ projectDir: dir, envName: 'prod', yes: true, prune: ['teams'], select: new Set(['space']), log: (m) => out.push(m), clientFactory: h.clientFactory });
  assert.equal(r.code, 0);
  assert.deepEqual(h.writes(), ['PUT /space']);
  assert.match(out.join('\n'), /excluded 2 \(not selected\)/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'))), ['space']);

  const h2 = applyHarness(routes);
  await runApply({ projectDir: dir, envName: 'prod', yes: true, prune: ['teams'], select: new Set(['teams/Same', 'teams/Old']), log: () => {}, clientFactory: h2.clientFactory });
  assert.deepEqual(h2.writes(), ['DELETE /teams/old']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'))).sort(), ['space', 'teams/Same']);
});

test('with a selection, the handler check ignores unselected workflows and WebAPIs', async () => {
  const { dir, routes } = selectionProject();
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'webapis/lookup', data: { slug: 'lookup', treeXml: '<task definition_id="missing_v1"/>' } },
    { key: 'task-refs', data: { handlers: ['missing_v1'], routines: [] } },
  ]);
  const h = applyHarness(routes);
  const all = await computePlan({ projectDir: dir, envName: 'prod', clientFactory: h.clientFactory });
  assert.match(all.plan.errors.join('\n'), /Handler missing_v1/);
  const some = await computePlan({ projectDir: dir, envName: 'prod', select: new Set(['space']), clientFactory: h.clientFactory });
  assert.deepEqual(some.plan.errors, []);
});

test('apply resolutions: overwrite replaces one drifted item, keep leaves another and its state hash', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [{ key: 'teams/A', data: { name: 'A', description: 'new' } }, { key: 'teams/B', data: { name: 'B', description: 'new' } }]);
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'prod.json'), JSON.stringify({ 'teams/A': 'oldA', 'teams/B': 'oldB' }));
  const routes = { ...emptySpaceRoutes(), 'GET core/teams': { teams: [{ name: 'A', slug: 'a', description: 'edited' }, { name: 'B', slug: 'b', description: 'edited' }] } };
  const h = applyHarness(routes);
  await runApply({ projectDir: dir, envName: 'prod', yes: true, resolutions: { 'teams/A': 'overwrite', 'teams/B': 'keep' }, log: () => {}, clientFactory: h.clientFactory });
  assert.deepEqual(h.writes(), ['PUT /teams/a']);
  const state = JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8'));
  assert.notEqual(state['teams/A'], 'oldA');
  assert.equal(state['teams/B'], 'oldB');
});

test('skipped items count toward apply progress so it reaches the total', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayType: 'Redirect' } }, { key: 'webapis/token', data: { slug: 'token' } }]);
  const routes = { ...emptySpaceRoutes({ displayType: 'Display Page' }), 'POST core/webApiImport': () => { const e = new Error('404'); e.status = 404; throw e; } };
  const h = applyHarness(routes);
  const events = [];
  const r = await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, onEvent: (e) => events.push(e), clientFactory: h.clientFactory });
  const progress = events.filter((e) => e.type === 'progress' && e.phase === 'apply').map((e) => [e.done, e.total]);
  assert.deepEqual(progress.at(-1), [2, 2]);
  assert.equal(r.done, 1);
});

test('an abort after the last write still records state (the post-apply read is not cancellable)', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const ac = new AbortController();
  const onEvent = (e) => { if (e.type === 'item' && e.key === 'teams/Ops' && e.status === 'done') ac.abort(); };
  const r = await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, onEvent, signal: ac.signal, clientFactory: h.clientFactory });
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space);
});

test('with a selection, a selected WebAPI whose handler is neither installed nor exported is flagged by the scoped handler check', async () => {
  const { dir, routes } = selectionProject();
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'webapis/lookup', data: { slug: 'lookup', treeXml: '<task definition_id="missing_v1"/>' } },
    { key: 'task-refs', data: { handlers: ['missing_v1'], routines: [] } },
  ]);
  const h = applyHarness(routes);
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', select: new Set(['webapis/lookup']), clientFactory: h.clientFactory });
  assert.deepEqual(plan.errors, ['Handler missing_v1 is used by exported workflows but is not installed in the target']);
});

test('plan and apply with sourceDir read that folder (a pinned source), not snapshots/<from>', async () => {
  const dir = tempProject({ dev: { url: 'https://dev.example.com', readOnly: true }, prod: { url: 'https://prod.example.com' } });
  writeTree(snapshotDir(dir, 'dev'), [{ key: 'space', data: { name: 'Dev', displayType: 'Current' } }]);
  const pinned = mkdtempSync(join(tmpdir(), 'ksync-pinned-'));
  writeTree(pinned, [{ key: 'space', data: { name: 'Dev', displayType: 'Pinned' } }]);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const { plan } = await computePlan({ projectDir: dir, envName: 'prod', from: 'dev', sourceDir: pinned, clientFactory: h.clientFactory });
  assert.deepEqual(plan.items.map((i) => [i.key, i.action, i.desired.displayType]), [['space', 'update', 'Pinned']]);
  const calls = [];
  const clientFactory = ({ env, mode }) => fakeClient(emptySpaceRoutes({ displayType: 'Display Page' }), { mode, calls });
  assert.equal((await runApply({ projectDir: dir, envName: 'prod', sourceDir: pinned, yes: true, log: () => {}, clientFactory })).code, 0);
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').map((c) => c.body.displayType), ['Pinned']);
  rmSync(pinned, { recursive: true, force: true });
});
