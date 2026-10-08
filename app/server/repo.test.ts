// Repo manager over isomorphic-git: init, commit adds and deletes, no-op when
// clean, log by path, reading a JSON tree at a commit, ignored files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import git from 'isomorphic-git';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitAll, ensureRepo, getRemote, isSafeRemoteUrl, log, push, readTreeAt, setRemote } from './repo.ts';
import { MemoryStore } from './secrets.ts';

const author = { name: 'Test User', email: 'test@example.com' };

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'km-repo-'));
}

function write(dir: string, rel: string, text: string): void {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test('commitAll stages adds and deletes, and no-ops when clean', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  await ensureRepo(dir); // idempotent
  write(dir, 'state/a.json', '{"a":1}');
  write(dir, 'snapshots/dev/x.json', '{"x":1}');
  const first = await commitAll(dir, 'First', author);
  assert.ok(first);
  assert.equal(await commitAll(dir, 'Nothing', author), null);
  rmSync(path.join(dir, 'state/a.json'));
  write(dir, 'snapshots/dev/y.json', '{"y":2}');
  const second = await commitAll(dir, 'Second', author);
  assert.ok(second);
  const entries = await log(dir, { limit: 10 });
  assert.deepEqual(entries.map((e) => e.message), ['Second', 'First']);
  assert.equal(entries[0].author.name, 'Test User');
  const tree = await readTreeAt(dir, second!, '');
  assert.deepEqual([...tree.keys()].sort(), ['snapshots/dev/x', 'snapshots/dev/y']);
});

test('log filters by path and limit; readTreeAt reads a subdir at an older commit', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  write(dir, 'snapshots/dev/forms/a.json', '{"v":1}');
  const c1 = await commitAll(dir, 'Snapshot of Dev', author);
  write(dir, 'snapshots/test/forms/a.json', '{"v":9}');
  await commitAll(dir, 'Snapshot of Test', author);
  write(dir, 'snapshots/dev/forms/a.json', '{"v":2}');
  await commitAll(dir, 'Snapshot of Dev again', author);
  const devLog = await log(dir, { path: 'snapshots/dev', limit: 10 });
  assert.deepEqual(devLog.map((e) => e.message), ['Snapshot of Dev again', 'Snapshot of Dev']);
  assert.equal((await log(dir, { path: 'snapshots/dev', limit: 1 })).length, 1);
  assert.deepEqual(await log(dir, { path: 'snapshots/prod', limit: 5 }), []);
  const old = await readTreeAt(dir, c1!, 'snapshots/dev');
  assert.deepEqual(old, new Map([['forms/a', { v: 1 }]]));
});

test('ignored and .env files are never committed', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  write(dir, '.gitignore', 'backups/\n');
  write(dir, '.env.dev', 'KINETIC_DEV_PASSWORD=nope');
  write(dir, 'backups/b.json', '{}');
  write(dir, 'environments/.env.dev', 'nope');
  write(dir, 'runs/keep.json', '{}');
  const c = await commitAll(dir, 'First', author);
  const tree = await readTreeAt(dir, c!, '');
  assert.deepEqual([...tree.keys()], ['runs/keep']);
});

test('log on a repo with no commits is empty; remote round-trips; push without a remote fails cleanly', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  assert.deepEqual(await log(dir, { limit: 5 }), []);
  assert.equal(await getRemote(dir), null);
  await setRemote(dir, 'https://git.example.com/team/project.git');
  assert.equal(await getRemote(dir), 'https://git.example.com/team/project.git');
  await setRemote(dir, null);
  await assert.rejects(push(dir, { store: new MemoryStore(), account: 'p/_project/git/token' }), /remote/i);
});

test('commitAll stages only the project layout, never stray files beside it', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  for (const rel of ['kinetic-sync.config.json', 'kinetic-migrate.json', '.gitignore', 'environments/dev.json', 'overrides/dev.json', 'snapshots/dev/space.json',
    'export/space.json', 'state/dev.json', 'changesets/c.json', 'runs/r.json']) write(dir, rel, '{}');
  for (const rel of ['credentials.json', 'notes.txt', 'terraform/main.tf', 'environments.json']) write(dir, rel, 'stray');
  const c = await commitAll(dir, 'First', author);
  const files = (await git.listFiles({ fs, dir, ref: c! })).sort();
  assert.deepEqual(files, ['.gitignore', 'changesets/c.json', 'environments/dev.json', 'export/space.json', 'kinetic-migrate.json', 'kinetic-sync.config.json',
    'overrides/dev.json', 'runs/r.json', 'snapshots/dev/space.json', 'state/dev.json']);
  // A stray file alone is no change to commit.
  write(dir, 'other.txt', 'x');
  assert.equal(await commitAll(dir, 'Nothing', author), null);
});

test('push refuses a plain-http remote to another computer before reading the token', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  write(dir, 'state/a.json', '{}');
  await commitAll(dir, 'First', author);
  // Set outside the app (for example by the CLI or by hand).
  await setRemote(dir, 'http://git.example.com/team/project.git');
  const store = new MemoryStore();
  await store.set('p/_project/git/token', 'tok-Planted-55');
  let reads = 0;
  const counting = { ...store, get: async (a: string) => { reads++; return store.get(a); }, has: (a: string) => store.has(a), set: (a: string, v: string) => store.set(a, v), delete: (a: string) => store.delete(a) };
  await assert.rejects(push(dir, { store: counting, account: 'p/_project/git/token' }), (e: Error) => /https:\/\//.test(e.message) && !e.message.includes('git.example.com') && !e.message.includes('tok-'));
  assert.equal(reads, 0, 'the token is never read for an unsafe remote');
  assert.equal(isSafeRemoteUrl('https://git.example.com/x.git'), true);
  assert.equal(isSafeRemoteUrl('http://localhost:8080/x.git'), true);
  assert.equal(isSafeRemoteUrl('http://127.0.0.1/x.git'), true);
  assert.equal(isSafeRemoteUrl('http://git.example.com/x.git'), false);
  assert.equal(isSafeRemoteUrl('git@github.com:team/x.git'), false);
  assert.equal(isSafeRemoteUrl('not a url'), false);
});
