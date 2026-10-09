// Projects inside a repository the user already has (external mode): a
// monorepo with the project in apps/config/kinetic/ on branch feature/x,
// unrelated staged and unstaged changes elsewhere and a root .gitignore.
// Everything works (open, snapshot, changeset, compare, plan, apply, backup,
// restore, history) while the user's repository stays byte-for-byte the same:
// HEAD, index, refs, config, the root .gitignore and every other file. The
// private history lives in the app's data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import type { HistoryEvent } from '../shared/sync-api.ts';
import type { RepositorySettings } from '../shared/repository-api.ts';
import {
  READ_ONLY_FS, appDataDir, findEnclosingRepository, gitFs, isInside, projectRepo, statusSettled, userChangedFiles,
} from './project-repo.ts';
import { log } from './repo.ts';
import { PLANTED, assertNoSecret, devRoutes, fakeFactory, testRoutes, type Call } from './sync-fixtures.ts';
import { MemoryStore } from './secrets.ts';
import { startTestServer } from './test-helpers.ts';

process.env.KINETIC_MIGRATOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'km-data-'));
const PROJECT = 'apps/config/kinetic';
const author = { name: 'Dev Person', email: 'dev@example.com' };
type T = { after: (fn: () => Promise<void> | void) => void };

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// The user's monorepo, built with isomorphic-git as the user's own tool.
async function monorepo(t: T, opts: { dirty?: boolean } = {}): Promise<{ root: string; project: string }> {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'km-monorepo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  write(root, '.gitignore', 'node_modules/\n*.log\n');
  write(root, 'README.md', '# Monorepo\n');
  write(root, 'packages/app/index.js', 'console.log("app");\n');
  write(root, `${PROJECT}/kinetic-sync.config.json`, '{}\n');
  write(root, `${PROJECT}/environments/dev.json`, '{\n  "url": "https://dev.example.com"\n}\n');
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({ fs, dir: root, message: 'Initial', author });
  // Another branch where the project's dev environment points elsewhere.
  await git.branch({ fs, dir: root, ref: 'other', checkout: true });
  write(root, `${PROJECT}/environments/dev.json`, '{\n  "url": "https://dev2.example.com"\n}\n');
  await git.add({ fs, dir: root, filepath: `${PROJECT}/environments/dev.json` });
  await git.commit({ fs, dir: root, message: 'Point dev elsewhere', author });
  await git.checkout({ fs, dir: root, ref: 'main' });
  await git.branch({ fs, dir: root, ref: 'feature/x', checkout: true });
  if (opts.dirty !== false) {
    // Unrelated work in progress: one staged change, one unstaged, one untracked.
    write(root, 'packages/app/index.js', 'console.log("staged");\n');
    await git.add({ fs, dir: root, filepath: 'packages/app/index.js' });
    write(root, 'README.md', '# Monorepo (unstaged edit)\n');
    write(root, 'notes.txt', 'untracked\n');
  }
  // A tracked project file touched but unchanged: a status that refreshed
  // the user's index would rewrite .git/index (caught by the fingerprint).
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, PROJECT, 'kinetic-sync.config.json'), later, later);
  return { root, project: path.join(root, PROJECT) };
}

// Every byte of the user's repository outside the project folder, .git included.
function fingerprint(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel === PROJECT) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

function assertUnchanged(before: Map<string, string>, root: string): void {
  const after = fingerprint(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added to or removed from the user repository');
  for (const [rel, sum] of before) assert.equal(after.get(rel), sum, `${rel} changed`);
}

async function server(t: T) {
  const calls: Call[] = [];
  const spaces: Record<string, () => Record<string, unknown>> = { dev: devRoutes, test: testRoutes };
  const s = await startTestServer({ secrets: new MemoryStore(), clientFactory: fakeFactory(spaces, calls) });
  t.after(() => s.cleanup());
  const bodies: string[] = [];
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await s.api(pathname, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    bodies.push(res.body);
    let json: any;
    try { json = res.body ? JSON.parse(res.body) : undefined; } catch { json = undefined; }
    return { ...res, json };
  };
  const job = async (method: string, pathname: string, body?: unknown) => {
    const started = await call(method, pathname, body);
    if (started.status !== 202) throw new Error(`job did not start: ${started.status} ${started.body}`);
    await s.jobs.wait(started.json.jobId);
    const info = (await call('GET', `/api/jobs/${started.json.jobId}`)).json;
    const events = (await call('GET', `/api/jobs/${started.json.jobId}/events`)).body;
    bodies.push(events);
    return { ...info, events };
  };
  return { s, calls, spaces, bodies, call, job };
}

// Persists the team in Test so an apply and a restore can be seen.
function persistingTeam(spaces: Record<string, () => Record<string, unknown>>): void {
  let team: Record<string, unknown> = { name: 'Ops', slug: 'ops', description: 'Operations' };
  spaces.test = () => ({
    ...testRoutes(),
    'GET core/teams': () => ({ teams: [structuredClone(team)] }),
    'PUT core/teams/ops': ({ body }: { body: Record<string, unknown> }) => {
      team = { ...team, ...body };
      return { team };
    },
  });
}

test('a project in a monorepo subfolder on a feature branch: everything works and the user repository is untouched', async (t) => {
  const { root, project } = await monorepo(t);
  const before = fingerprint(root);
  const { call, job, spaces, bodies } = await server(t);
  persistingTeam(spaces);

  const opened = await call('POST', '/api/projects/open', { path: project });
  assert.equal(opened.status, 200, opened.body);
  const P = `/api/projects/${opened.json.id}`;
  const ref = { dir: project };
  const repo = await projectRepo(ref);
  assert.equal(repo.mode, 'external');
  assert.ok(isInside(repo.gitdir, appDataDir()), 'the private history is in the data folder');
  assert.ok(!isInside(repo.gitdir, root), 'never inside the user repository');

  for (const env of ['dev', 'test']) {
    assert.equal((await call('PUT', `${P}/environments/${env}`, { url: `https://${env}.example.com`, readOnly: env === 'dev' })).status, 200);
    assert.equal((await call('PUT', `${P}/environments/${env}/credentials`, { username: 'admin', password: PLANTED })).status, 200);
  }
  for (const env of ['dev', 'test']) assert.equal((await job('POST', `${P}/snapshots`, { env })).status, 'succeeded');
  const cs = await call('POST', `${P}/changesets`, { name: 'Team text', from: 'dev', keys: ['teams/Ops'] });
  assert.equal(cs.status, 201, cs.body);
  const cmp = await job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' });
  assert.equal(cmp.status, 'succeeded', JSON.stringify(cmp.error));
  const plan = (await job('POST', `${P}/plans`, { to: 'test', changesetId: cs.json.id })).result;
  const applied = (await job('POST', `${P}/plans/${plan.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result;
  assert.equal(applied.status, 'applied', applied.error);
  assert.ok(applied.backupCommit);

  // History reads the private history, with the same titles as managed mode.
  const events = (await call('GET', `${P}/history`)).json as HistoryEvent[];
  const types = events.map((e) => e.type);
  for (const type of ['snapshot', 'changeset', 'applied', 'backup', 'project']) assert.ok(types.includes(type as never), `${type} in History`);
  assert.ok(events.some((e) => e.title === 'Started managing this project'));
  const entries = await log(repo, { limit: 100 });
  assert.ok(entries.some((e) => /^Saved changeset 'Team text'\n\nChangeset: .+\nEnvironment: dev$/.test(e.message)), entries.map((e) => e.message).join('\n---\n'));

  // Restore from the backup.
  const restore = await job('POST', `${P}/restore`, { commit: applied.backupCommit });
  assert.equal(restore.status, 'succeeded', JSON.stringify(restore.error));
  assert.deepEqual(restore.result.preselected, ['teams/Ops']);
  const rp = (await job('POST', `${P}/plans`, { to: 'test', from: 'test', sourceCommit: restore.result.sourceCommit, selected: ['teams/Ops'], restore: true, resolutions: { 'teams/Ops': 'overwrite' } })).result;
  const acks = (rp.needsAttention as Array<{ id: string }>).map((n) => n.id);
  const done = (await job('POST', `${P}/plans/${rp.planId}/apply`, { acknowledgements: acks, confirm: 'test' })).result;
  assert.equal(done.status, 'applied', done.error);
  assert.ok(((await call('GET', `${P}/history`)).json as HistoryEvent[]).slice(0, 2).some((e) => e.type === 'restore'));

  // The project's files changed on disk, and the user sees them as changes.
  assert.ok(existsSync(path.join(project, 'snapshots', 'dev')));
  assert.ok(existsSync(path.join(project, 'changesets', `${cs.json.id}.json`)));
  const first = (await call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.equal(first.external!.checking, true, 'counted in the background');
  await statusSettled(repo.user!);
  const settings = (await call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.equal(settings.mode, 'external');
  assert.equal(settings.external!.checking, false);
  assert.equal(settings.external!.branch, 'feature/x');
  assert.equal(settings.external!.subfolder, PROJECT);
  assert.equal(settings.external!.root, root);
  assert.equal(settings.external!.operation, null);
  assert.ok((settings.external!.changedFiles ?? 0) > 5, `changed files: ${settings.external!.changedFiles}`);
  assert.equal(settings.remote.url, null);
  // Only the project's own .gitignore lines were added (the file was absent).
  assert.match(readFileSync(path.join(project, '.gitignore'), 'utf8'), /^plans\/$/m);
  assert.equal(existsSync(path.join(project, '.gitattributes')), false, 'the user’s line-ending rules are theirs');

  // Remotes, tokens and pushes are refused; the author applies to the private history.
  assert.equal((await call('PUT', `${P}/repository`, { remoteUrl: 'https://git.example.com/x.git' })).json.error.code, 'external_repository');
  assert.equal((await call('POST', `${P}/repository/push`)).json.error.code, 'external_repository');
  const put = await call('PUT', `${P}/repository`, { author: { name: 'Pat Example', email: 'pat@example.com' } });
  assert.equal(put.status, 200, put.body);
  assert.deepEqual(put.json.author, { name: 'Pat Example', email: 'pat@example.com' });
  assert.ok(!readFileSync(path.join(project, 'kinetic-migrate.json'), 'utf8').includes('Pat Example'), 'not in the shared project files');
  await call('PUT', `${P}/environments/test`, { url: 'https://test2.example.com' });
  assert.deepEqual((await log(repo, { limit: 1 }))[0].author, { name: 'Pat Example', email: 'pat@example.com' });

  assertUnchanged(before, root);
  // The user's own git still reads its repository as it was.
  assert.equal(await git.currentBranch({ fs, dir: root }), 'feature/x');
  assertNoSecret({ bodies } as never);
});

test('a branch switch underneath is recorded in the private history before the next write; nothing is lost', async (t) => {
  const { root, project } = await monorepo(t, { dirty: false });
  const { call } = await server(t);
  const opened = await call('POST', '/api/projects/open', { path: project });
  assert.equal(opened.status, 200, opened.body);
  const P = `/api/projects/${opened.json.id}`;
  const repo = await projectRepo({ dir: project });
  await call('PUT', `${P}/environments/test`, { url: 'https://test.example.com' });

  // The user checks out another branch (their tool, their repository).
  await git.checkout({ fs, dir: root, ref: 'other' });
  const detail = (await call('GET', P)).json;
  assert.equal(detail.environments.find((e: { name: string }) => e.name === 'dev').url, 'https://dev2.example.com', 'state comes from the files on disk');
  const titles = () => log(repo, { limit: 50 }).then((l) => l.map((e) => e.message.split('\n')[0]));
  assert.equal((await titles())[0], 'Files changed outside Kinetic Migrator');
  assert.match((await log(repo, { limit: 1 }))[0].message, /on branch other of /);

  // Back again, then a write: the outside change is its own commit first.
  await git.checkout({ fs, dir: root, ref: 'feature/x' });
  await call('PUT', `${P}/environments/prod`, { url: 'https://prod.example.com' });
  const list = await titles();
  assert.deepEqual(list.slice(0, 2), ['Added environment Prod', 'Files changed outside Kinetic Migrator']);
  assert.ok(list.includes('Added environment Test'), 'the earlier write is kept');
});

test('while git is merging in the user repository the project is read-only', async (t) => {
  const { root, project } = await monorepo(t, { dirty: false });
  const { call } = await server(t);
  const opened = await call('POST', '/api/projects/open', { path: project });
  const P = `/api/projects/${opened.json.id}`;
  const head = readFileSync(path.join(root, '.git', 'refs', 'heads', 'other'), 'utf8');
  writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), head);
  const before = fingerprint(root);
  const refused = await call('PUT', `${P}/environments/test`, { url: 'https://test.example.com' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'repository_busy');
  assert.match(refused.json.error.message, /has a merge in progress/);
  assert.equal(existsSync(path.join(project, 'environments', 'test.json')), false);
  assert.equal((await call('GET', P)).status, 200, 'reading still works');
  assert.equal(((await call('GET', `${P}/repository`)).json as RepositorySettings).external!.operation, 'merge');
  await statusSettled(findEnclosingRepository(project)!);
  // Opening again while busy works, read-only.
  assert.equal((await call('POST', '/api/projects/open', { path: project })).status, 200);
  assertUnchanged(before, root);
});

test('a new project in a workspace inside the user repository is external from the start', async (t) => {
  const { root } = await monorepo(t, { dirty: false });
  const workspace = path.join(root, 'apps', 'config');
  const before = fingerprint(root);
  const s = await startTestServer({ secrets: new MemoryStore(), workspace });
  const created = await s.api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New One' }) });
  assert.equal(created.status, 201, created.body);
  const dir = path.join(workspace, 'new-one');
  assert.equal(existsSync(path.join(dir, '.git')), false, 'no repository inside the user repository');
  const repo = await projectRepo({ dir });
  assert.equal(repo.mode, 'external');
  assert.equal((await log(repo, { limit: 5 }))[0].message, 'Created project New One');
  await s.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(workspace, '.kinetic-migrate'), { recursive: true, force: true });
  rmSync(path.join(workspace, '.kinetic-migrate-workspace.json'), { force: true });
  // Kinetic Migrator's log folder aside, nothing outside the project changed.
  const after = fingerprint(root);
  for (const [rel, sum] of before) assert.equal(after.get(rel), sum, `${rel} changed`);
});

test('a linked worktree (a .git file) is detected and read without writing to the main repository', async (t) => {
  const { root } = await monorepo(t, { dirty: false });
  const main = path.join(root, '.git');
  // `git worktree add ../wt other`, by hand.
  const wt = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'km-worktree-')));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const admin = path.join(main, 'worktrees', 'wt');
  mkdirSync(admin, { recursive: true });
  writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/other\n');
  writeFileSync(path.join(admin, 'commondir'), '../..\n');
  writeFileSync(path.join(admin, 'gitdir'), `${path.join(wt, '.git')}\n`);
  writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  const oid = await git.resolveRef({ fs, dir: root, ref: 'other' });
  for (const f of await git.listFiles({ fs, dir: root, ref: oid })) {
    const { blob } = await git.readBlob({ fs, dir: root, oid, filepath: f });
    mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    writeFileSync(path.join(wt, f), blob);
  }
  const before = fingerprint(root);
  const project = path.join(wt, PROJECT);
  const found = findEnclosingRepository(project)!;
  assert.deepEqual([found.kind, found.root, found.gitdir, found.commondir, found.subfolder], ['worktree', wt, admin, main, PROJECT]);
  assert.equal(await userChangedFiles(found), 0);
  write(wt, `${PROJECT}/environments/test.json`, '{}');
  assert.equal(await userChangedFiles(found), 1);

  const { call } = await server(t);
  const opened = await call('POST', '/api/projects/open', { path: project });
  assert.equal(opened.status, 200, opened.body);
  const settings = (await call('GET', `/api/projects/${opened.json.id}/repository`)).json as RepositorySettings;
  assert.deepEqual([settings.mode, settings.external!.kind, settings.external!.branch], ['external', 'worktree', 'other']);
  await statusSettled(found);
  assertUnchanged(before, root);
});

test('a bare repository and a broken .git file are refused with plain messages', async (t) => {
  const bare = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'km-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  await git.init({ fs, dir: bare, bare: true });
  write(bare, 'proj/kinetic-sync.config.json', '{}');
  const { call } = await server(t);
  const r = await call('POST', '/api/projects/open', { path: path.join(bare, 'proj') });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /bare git repository/);

  const broken = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'km-broken-')));
  t.after(() => rmSync(broken, { recursive: true, force: true }));
  writeFileSync(path.join(broken, '.git'), 'gitdir: /nowhere/at/all\n');
  write(broken, 'proj/kinetic-sync.config.json', '{}');
  const b = await call('POST', '/api/projects/open', { path: path.join(broken, 'proj') });
  assert.equal(b.status, 400);
  assert.match(b.json.error.message, /points to a git folder that does not exist/);
});

test('by construction: the file systems handed to git refuse writes into the user repository', async (t) => {
  const { root, project } = await monorepo(t, { dirty: false });
  const repo = await projectRepo({ dir: project });
  assert.equal(repo.mode, 'external');
  await assert.rejects(gitFs(repo).promises.writeFile(path.join(root, '.git', 'index'), 'x'), /refused/);
  await assert.rejects(gitFs(repo).promises.writeFile(path.join(project, 'x.json'), 'x'), /refused/);
  await assert.rejects(READ_ONLY_FS.promises.mkdir(path.join(tmpdir(), 'anything')), /refused/);
  // isomorphic-git's own status refreshes the index: through the read-only fs it cannot.
  await assert.rejects(
    (async () => {
      write(root, 'README.md', '# Monorepo\n');
      await new Promise((r) => setTimeout(r, 1100));
      fs.utimesSync(path.join(root, 'README.md'), new Date(), new Date());
      await git.statusMatrix({ fs: READ_ONLY_FS, dir: root });
    })(),
    /refused/,
  );
});

test('the data folder per operating system', () => {
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(appDataDir(env, 'darwin', '/Users/pat'), '/Users/pat/Library/Application Support/Kinetic Migrator');
  assert.equal(appDataDir({ APPDATA: 'C:\\Users\\pat\\AppData\\Roaming' } as NodeJS.ProcessEnv, 'win32', 'C:\\Users\\pat'), 'C:\\Users\\pat\\AppData\\Roaming\\Kinetic Migrator');
  assert.equal(appDataDir(env, 'linux', '/home/pat'), '/home/pat/.local/share/kinetic-migrator');
  assert.equal(appDataDir({ XDG_DATA_HOME: '/data' } as NodeJS.ProcessEnv, 'linux', '/home/pat'), '/data/kinetic-migrator');
  assert.equal(appDataDir({ KINETIC_MIGRATOR_DATA_DIR: '/tmp/km' } as NodeJS.ProcessEnv, 'linux', '/home/pat'), '/tmp/km');
});

test('managed projects stay managed: their own repository, with the marker', async (t) => {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'km-managed-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'kinetic-sync.config.json', '{}');
  const { call } = await server(t);
  assert.equal((await call('POST', '/api/projects/open', { path: dir })).status, 200);
  const repo = await projectRepo({ dir });
  assert.deepEqual([repo.mode, repo.gitdir], ['managed', path.join(dir, '.git')]);
  assert.ok(existsSync(path.join(dir, '.git', 'kinetic-migrator.json')));
  // A managed repository from before the marker: still managed.
  rmSync(path.join(dir, '.git', 'kinetic-migrator.json'));
  assert.equal((await projectRepo({ dir })).mode, 'managed');
  // A user-made repository at the project folder with other files is external.
  const own = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'km-own-')));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  write(own, 'kinetic-sync.config.json', '{}');
  write(own, 'kinetic-migrate.json', '{}');
  write(own, 'README.md', 'mine');
  await git.init({ fs, dir: own, defaultBranch: 'trunk' });
  await git.add({ fs, dir: own, filepath: '.' });
  await git.commit({ fs, dir: own, message: 'mine', author });
  assert.equal((await projectRepo({ dir: own })).mode, 'external');
});

test('a project folder in a submodule is external, read through the superproject’s modules folder', async (t) => {
  const { root } = await monorepo(t, { dirty: false });
  // A submodule at vendor/config whose git folder is .git/modules/vendor/config.
  const modules = path.join(root, '.git', 'modules', 'vendor', 'config');
  const sub = path.join(root, 'vendor', 'config');
  mkdirSync(sub, { recursive: true });
  await git.init({ fs, dir: sub, gitdir: modules, defaultBranch: 'main' });
  write(sub, 'kinetic-sync.config.json', '{}');
  await git.add({ fs, dir: sub, gitdir: modules, filepath: 'kinetic-sync.config.json' });
  await git.commit({ fs, dir: sub, gitdir: modules, message: 'sub', author });
  writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/vendor/config\n');
  const found = findEnclosingRepository(sub)!;
  assert.deepEqual([found.kind, found.root, found.gitdir, found.subfolder], ['submodule', sub, modules, '']);
  const repo = await projectRepo({ dir: sub });
  assert.equal(repo.mode, 'external');
  assert.equal(await userChangedFiles(found), 0);
});
