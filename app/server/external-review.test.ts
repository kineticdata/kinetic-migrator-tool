// Regression tests from the external-mode review (reproducers zz-review,
// zz-review2, zz-home, zz-perf and zz-clones, turned into assertions):
// - C1: a repository the app did not create is never treated as managed
//   (CLI init + git init + commit on a feature branch, no commits yet, an
//   unreadable HEAD), and the user's repository stays byte-identical.
// - I1: an external project's private history and credentials are keyed by
//   the folder's real path: a branch without kinetic-migrate.json keeps
//   History and credentials, and reads write no file.
// - I2: a data folder inside a home folder kept in git is fine; only one
//   inside the project folder or the user's .git is refused.
// - I3: GET /repository is fast once the changed-files count is cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import type { HistoryEvent } from '../shared/sync-api.ts';
import type { RepositorySettings } from '../shared/repository-api.ts';
// @ts-expect-error -- untyped engine module
import { runInit } from '../../lib/sync/commands.mjs';
import { commitChange } from './project-meta.ts';
import { findEnclosingRepository, projectRepo, statusSettled } from './project-repo.ts';
import { createProject } from './projects.ts';
import { log } from './repo.ts';
import { devRoutes, fakeFactory, testRoutes, type Call } from './sync-fixtures.ts';
import { MemoryStore } from './secrets.ts';
import { startTestServer } from './test-helpers.ts';

process.env.KINETIC_MIGRATOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'km-data-'));
const author = { name: 'User', email: 'u@example.com' };
type T = { after: (fn: () => Promise<void> | void) => void };

function write(root: string, rel: string, text: string): void {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
}

const temp = (t: T, prefix: string) => {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

// Every byte under `root` (optionally leaving one folder out).
function fingerprint(root: string, skip?: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (skip && rel === skip) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

async function server(t: T) {
  const calls: Call[] = [];
  const s = await startTestServer({ secrets: new MemoryStore(), clientFactory: fakeFactory({ dev: devRoutes, test: testRoutes }, calls) });
  t.after(() => s.cleanup());
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await s.api(pathname, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any;
    try { json = JSON.parse(res.body); } catch { json = undefined; }
    return { ...res, json };
  };
  const job = async (method: string, pathname: string, body?: unknown) => {
    const started = await call(method, pathname, body);
    await s.jobs.wait(started.json.jobId);
    return (await call('GET', `/api/jobs/${started.json.jobId}`)).json;
  };
  return { s, call, job };
}

async function cliRepo(t: T, commit: boolean): Promise<string> {
  const root = temp(t, 'km-cli-');
  await runInit({ projectDir: root, log: () => {} });
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  if (commit) {
    await git.add({ fs, dir: root, filepath: '.' });
    await git.commit({ fs, dir: root, message: 'My own repo', author });
    await git.branch({ fs, dir: root, ref: 'feature/x', checkout: true });
  }
  return root;
}

test('C1: a CLI project the user put in git themselves stays theirs: external, nothing written to the repository', async (t) => {
  const root = await cliRepo(t, true);
  const before = fingerprint(root);
  assert.equal((await projectRepo({ dir: root })).mode, 'external');
  const { call } = await server(t);
  const opened = await call('POST', '/api/projects/open', { path: root });
  assert.equal(opened.status, 200, opened.body);
  assert.equal((await projectRepo({ dir: root })).mode, 'external', 'opening never flips the mode');
  await call('GET', `/api/projects/${opened.json.id}`);
  await call('GET', `/api/projects/${opened.json.id}/history`);
  assert.equal(existsSync(path.join(root, '.git', 'kinetic-migrator.json')), false, 'no marker in the user’s .git');
  assert.deepEqual((await git.log({ fs, dir: root })).map((c) => c.commit.message.trim()), ['My own repo']);
  assert.equal(await git.currentBranch({ fs, dir: root }), 'feature/x');
  // The project folder is the repository root: not even its .gitignore is edited.
  assert.deepEqual(fingerprint(root), before, 'the user repository is byte-identical');
});

test('C1: a repository with no commits yet is external, and stays empty', async (t) => {
  const root = await cliRepo(t, false);
  const before = fingerprint(root);
  const { call } = await server(t);
  assert.equal((await call('POST', '/api/projects/open', { path: root })).status, 200);
  assert.equal((await projectRepo({ dir: root })).mode, 'external');
  await assert.rejects(git.log({ fs, dir: root }), 'still no commits');
  assert.deepEqual(fingerprint(root), before);
});

test('C1: an unreadable HEAD is external, even for a repository that otherwise looks like the app’s', async (t) => {
  const dir = temp(t, 'km-legacy-');
  write(dir, 'kinetic-sync.config.json', '{}');
  write(dir, 'kinetic-migrate.json', '{}');
  await git.init({ fs, dir, defaultBranch: 'main' });
  await git.add({ fs, dir, filepath: '.' });
  await git.commit({ fs, dir, message: 'Started managing this project', author: { name: 'kinetic-migrate', email: 'kinetic-migrate@localhost' } });
  assert.equal((await projectRepo({ dir })).mode, 'managed', 'the legacy signature matches');
  writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'not-an-object-id\n');
  assert.equal((await projectRepo({ dir })).mode, 'external');
  // A legacy-looking repository with one of the user's own files in it is theirs.
  const mine = temp(t, 'km-legacy-mine-');
  write(mine, 'kinetic-sync.config.json', '{}');
  write(mine, 'README.md', 'mine');
  await git.init({ fs, dir: mine, defaultBranch: 'main' });
  await git.add({ fs, dir: mine, filepath: '.' });
  await git.commit({ fs, dir: mine, message: 'Started managing this project', author });
  assert.equal((await projectRepo({ dir: mine })).mode, 'external');
});

test('C1: a project the app manages, from before the marker existed, is still managed', async (t) => {
  const dir = temp(t, 'km-oldmanaged-');
  write(dir, 'kinetic-sync.config.json', '{}');
  const { call } = await server(t);
  assert.equal((await call('POST', '/api/projects/open', { path: dir })).status, 200);
  rmSync(path.join(dir, '.git', 'kinetic-migrator.json'));
  assert.equal((await projectRepo({ dir })).mode, 'managed');
  assert.equal(existsSync(path.join(dir, '.git', 'kinetic-migrator.json')), false, 'the marker is not written after the fact');
});

test('I1: a branch without kinetic-migrate.json keeps History and credentials, and reads write nothing', async (t) => {
  const root = temp(t, 'km-mono-');
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  write(root, 'README.md', 'x');
  write(root, 'p/kinetic-sync.config.json', '{}\n');
  write(root, 'p/environments/dev.json', '{\n  "url": "https://dev.example.com"\n}\n');
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({ fs, dir: root, message: 'init', author });
  await git.branch({ fs, dir: root, ref: 'feature/x', checkout: true });
  const project = path.join(root, 'p');
  const { call, job } = await server(t);
  const opened = await call('POST', '/api/projects/open', { path: project });
  const P = `/api/projects/${opened.json.id}`;
  await call('PUT', `${P}/environments/dev`, { url: 'https://dev.example.com' });
  await call('PUT', `${P}/environments/dev/credentials`, { username: 'a', password: 'b' });
  assert.equal((await job('POST', `${P}/snapshots`, { env: 'dev' })).status, 'succeeded');
  const repo = await projectRepo({ dir: project });
  const titles = async () => ((await call('GET', `${P}/history`)).json as HistoryEvent[]).map((e) => e.title);
  const onFeature = await titles();
  assert.ok(onFeature.includes('Snapshot of Dev'));

  // The user commits the project on feature/x (kinetic-migrate.json may or may
  // not be there) and checks out main, which has none of it.
  await git.add({ fs, dir: root, filepath: 'p' });
  await git.commit({ fs, dir: root, message: 'project', author });
  await git.checkout({ fs, dir: root, ref: 'main' });
  assert.equal(existsSync(path.join(project, 'kinetic-migrate.json')), false);
  const before = fingerprint(project);
  const detail = await call('GET', P);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.environments.find((e: { name: string }) => e.name === 'dev').credentials, { username: true, password: true }, 'credentials intact');
  const onMain = await titles();
  assert.ok(onMain.includes('Snapshot of Dev'), 'History intact');
  assert.equal(onMain[0], 'Files changed outside Kinetic Migrator');
  await call('GET', `${P}/repository`);
  await statusSettled(repo.user!);
  assert.deepEqual(fingerprint(project), before, 'no project file written by reads');
  assert.equal((await projectRepo({ dir: project })).gitdir, repo.gitdir, 'the same private history');
});

test('I1: two checkouts of one repository get their own private histories', async (t) => {
  const A = temp(t, 'km-A-');
  await git.init({ fs, dir: A, defaultBranch: 'main' });
  write(A, 'README.md', 'x');
  write(A, 'p/kinetic-sync.config.json', '{}');
  write(A, 'p/kinetic-migrate.json', JSON.stringify({ secretsId: '11111111-2222-3333-4444-555555555555' }));
  write(A, 'p/environments/dev.json', '{"url":"https://x"}');
  await git.add({ fs, dir: A, filepath: '.' });
  await git.commit({ fs, dir: A, message: 'i', author });
  const B = temp(t, 'km-B-');
  cpSync(A, B, { recursive: true });
  const pa = { id: 'a', dir: path.join(A, 'p') };
  const pb = { id: 'b', dir: path.join(B, 'p') };
  await commitChange(pa, 'A one');
  await commitChange(pb, 'B one');
  const [ra, rb] = [await projectRepo(pa), await projectRepo(pb)];
  assert.notEqual(ra.gitdir, rb.gitdir);
  assert.deepEqual((await log(ra, { limit: 5 })).map((e) => e.message), ['A one']);
  assert.deepEqual((await log(rb, { limit: 5 })).map((e) => e.message), ['B one']);
  // A symlinked spelling of the same folder is the same project.
  const link = path.join(temp(t, 'km-link-'), 'a');
  fs.symlinkSync(A, link);
  assert.equal((await projectRepo({ dir: path.join(link, 'p') })).gitdir, ra.gitdir);
});

test('I2: a data folder inside a home folder kept in git is fine; inside the user’s .git it is refused', async (t) => {
  const home = temp(t, 'km-home-');
  await git.init({ fs, dir: home, defaultBranch: 'main' });
  const ws = path.join(home, 'KineticMigrate');
  mkdirSync(ws, { recursive: true });
  const saved = process.env.KINETIC_MIGRATOR_DATA_DIR;
  t.after(() => { process.env.KINETIC_MIGRATOR_DATA_DIR = saved; });
  process.env.KINETIC_MIGRATOR_DATA_DIR = path.join(home, 'Library', 'Application Support', 'Kinetic Migrator');
  const ref = await createProject(ws, { name: 'Demo' });
  const repo = await projectRepo(ref);
  assert.equal(repo.mode, 'external');
  assert.equal((await log(repo, { limit: 1 }))[0].message, 'Created project Demo');
  process.env.KINETIC_MIGRATOR_DATA_DIR = path.join(home, '.git', 'km-data');
  await assert.rejects(projectRepo(ref), (e: { code?: string }) => e.code === 'history_inside_repository');
  process.env.KINETIC_MIGRATOR_DATA_DIR = path.join(ref.dir, 'km-data');
  await assert.rejects(projectRepo(ref), (e: { code?: string }) => e.code === 'history_inside_repository');
});

test('I3: GET /repository stays fast with 5,000 files once the count is cached', async (t) => {
  const root = temp(t, 'km-perf-');
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'p/kinetic-sync.config.json', '{}');
  write(root, 'p/environments/dev.json', '{"url":"https://dev.example.com"}');
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({ fs, dir: root, message: 'i', author });
  const project = path.join(root, 'p');
  const { call } = await server(t);
  const opened = await call('POST', '/api/projects/open', { path: project });
  const P = `/api/projects/${opened.json.id}`;
  const body = 'x'.repeat(4000);
  for (let i = 0; i < 5000; i++) write(project, `snapshots/dev/forms/f${i % 50}/item${i}.json`, `{"i":${i},"b":"${body}"}`);
  const started = Date.now();
  const first = (await call('GET', `${P}/repository`)).json as RepositorySettings;
  assert.ok(Date.now() - started < 1000, 'the first answer does not wait for the count');
  assert.equal(first.external!.checking, true);
  await statusSettled(findEnclosingRepository(project)!);
  for (let k = 0; k < 3; k++) {
    const t0 = Date.now();
    const s = (await call('GET', `${P}/repository`)).json as RepositorySettings;
    const ms = Date.now() - t0;
    assert.equal(s.external!.checking, false);
    assert.ok((s.external!.changedFiles ?? 0) >= 5000, String(s.external!.changedFiles));
    assert.ok(ms < 300, `GET /repository took ${ms} ms`);
  }
});
