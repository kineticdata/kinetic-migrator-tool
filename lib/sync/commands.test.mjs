// lib/sync/commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient } from './fake-client.mjs';
import { runInit, runExport, runPlan, runApply, runCompare, computePlan } from './commands.mjs';
import { ReadOnlyError } from './http.mjs';
import { readTree, writeTree } from './store.mjs';

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
  assert.equal(await runExport({ projectDir: dir, envName: 'dev', log: (m) => out.push(m), clientFactory }), 0);
  assert.deepEqual(modes, ['read']);
  const tree = readTree(join(dir, 'export'));
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
  assert.equal(await runPlan({ projectDir: dir, envName: 'prod', log: (m) => out.push(m), clientFactory }), 0);
  assert.deepEqual(modes, ['read']);
  const text = out.join('\n');
  assert.match(text, /~ update\s+space\s+space/);
  assert.match(text, /displayType: "Display Page" → "Redirect"/);
  assert.match(text, /\+ create\s+teams\s+teams\/Ops/);
  assert.equal(readdirSync(join(dir, 'plans')).length, 1);

  writeTree(join(dir, 'export'), [{ key: 'bogus/thing', data: {} }]);
  assert.equal(await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory }), 1);
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
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory: h.clientFactory, confirm: async () => false }), 1);
  writeTree(join(dir, 'export'), [{ key: 'bogus/thing', data: {} }]);
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory }), 1);
  assert.deepEqual(h.writes(), []);
});

test('apply with nothing to change records a drift baseline and writes nothing', async () => {
  const dir = promotable();
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayType: 'Display Page' } }]);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const out = [];
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory }), 0);
  assert.equal(h.writes().some((w) => w.startsWith('DELETE')), false);
  h = applyHarness(routes);
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, prune: ['teams'], log: () => {}, clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runApply({ projectDir: p.dir, envName: 'prod', yes: true, prune: ['data'], log: () => {}, clientFactory: h.clientFactory }), 0);
  assert.deepEqual(h.writes(), []);

  p = dataProject(
    [{ key: 'space', data: { name: 'Dev', displayType: 'Redirect' } }],
    [{ id: 's1', createdAt: '2020', values: { Code: 'A', V: '1' } }],
  );
  h = applyHarness(p.routes);
  const out = [];
  assert.equal(await runApply({ projectDir: p.dir, envName: 'prod', yes: true, prune: ['data'], log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runApply({ projectDir: p.dir, envName: 'prod', yes: true, prune: ['data'], log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runCompare({ projectDir: h.dir, from: 'dev', to: 'prod', raw: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
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
  assert.equal(await runExport({ projectDir: dir, envName: 'dev', log: () => {}, clientFactory: ({ mode }) => fakeClient(devRoutes, { mode }) }), 0);
  assert.deepEqual(readFileSync(join(dir, 'export', 'handlers', 'mail_send_v1', 'package.zip')), zip);
  const exported = readTree(join(dir, 'export'));
  assert.equal(exported.get('handlers/mail_send_v1/handler').packageSha256, createHash('sha256').update(zip).digest('hex'));

  writeTree(join(dir, 'export'), [
    { key: 'space', data: exported.get('space') },
    { key: 'handlers/mail_send_v1/handler', data: exported.get('handlers/mail_send_v1/handler'), files: { 'package.zip': zip } },
    { key: 'webapis/lookup', data: { slug: 'lookup', treeXml: '<task definition_id="mail_send_v1"/>' } },
    { key: 'task-refs', data: { handlers: ['mail_send_v1'], routines: [] } },
  ]);
  const h = applyHarness({ ...emptySpaceRoutes(), 'GET task/handlers': { handlers: [handler('other_v1')] }, 'GET task/handlers/other_v1/zip': other });
  const out = [];
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
  assert.deepEqual(h.writes(), ['POST /handlers', 'PUT /handlers/mail_send_v1', 'POST /webApiImport']);
  const [backup] = readdirSync(join(dir, 'backups'));
  assert.deepEqual(readFileSync(join(dir, 'backups', backup, 'handlers', 'other_v1', 'package.zip')), other);
});
