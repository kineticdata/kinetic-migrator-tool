// The snapshot folder swap: the new export replaces snapshots/<env>/ only as a
// whole; when the swap fails, the previous snapshot is put back (a failed
// rename on Windows must never leave the folder missing, or the next commit
// would record the whole snapshot as deleted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableStringify } from './engine.ts';
import { driftedKeys, retryingRename, swapInto } from './snapshots.ts';

function layout(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'km-swap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const temp = path.join(dir, 'plans', 'snap-new');
  const final = path.join(dir, 'snapshots', 'test');
  const aside = path.join(dir, 'plans', 'old-1');
  mkdirSync(temp, { recursive: true });
  writeFileSync(path.join(temp, 'space.json'), '"new"');
  mkdirSync(final, { recursive: true });
  writeFileSync(path.join(final, 'space.json'), '"old"');
  return { dir, temp, final, aside };
}

test('a successful swap puts the new snapshot in place and removes the old one', async (t) => {
  const { temp, final, aside } = layout(t);
  await swapInto(temp, final, aside);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
  assert.equal(fs.existsSync(temp), false);
  assert.equal(fs.existsSync(aside), false);
});

test('a first snapshot needs no old folder', async (t) => {
  const { temp, final, aside } = layout(t);
  rmSync(final, { recursive: true });
  await swapInto(temp, final, aside);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
});

test('when the new folder cannot be moved in, the previous snapshot is restored', async (t) => {
  const { temp, final, aside } = layout(t);
  const rename = (from: string, to: string) => {
    if (from === temp) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.renameSync(from, to);
  };
  await assert.rejects(swapInto(temp, final, aside, { rename }), /EPERM/);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"old"');
  assert.equal(fs.existsSync(aside), false);
  assert.equal(fs.existsSync(temp), false, 'the unused export is removed');
});

test('when the old folder cannot be moved aside, nothing changes', async (t) => {
  const { temp, final, aside } = layout(t);
  const rename = (from: string, to: string) => {
    if (from === final) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    fs.renameSync(from, to);
  };
  await assert.rejects(swapInto(temp, final, aside, { rename }), /EBUSY/);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"old"');
  assert.equal(fs.existsSync(temp), false);
});

test('an old folder that cannot be deleted stays aside in plans/, never in snapshots/', async (t) => {
  const { temp, final, aside } = layout(t);
  const rm = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  await swapInto(temp, final, aside, { rm });
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
  assert.equal(readFileSync(path.join(aside, 'space.json'), 'utf8'), '"old"');
});

test('on Windows a rename blocked for a moment (antivirus, indexer) is retried', async (t) => {
  const { temp, final, aside } = layout(t);
  let failures = 2;
  const slept: number[] = [];
  const rename = (from: string, to: string) => {
    if (from === temp && failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.renameSync(from, to);
  };
  await swapInto(temp, final, aside, { rename, platform: 'win32', sleep: (ms) => { slept.push(ms); } });
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
  assert.deepEqual(slept, [50, 100]);
});

test('retries give up after a bounded time and only for transient codes', async () => {
  let calls = 0;
  const busy = () => { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  await assert.rejects(retryingRename(busy, { platform: 'win32', sleep: () => {} })('a', 'b'), /EBUSY/);
  assert.equal(calls, 8);
  calls = 0;
  const missing = () => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(retryingRename(missing, { platform: 'win32', sleep: () => {} })('a', 'b'), /ENOENT/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryingRename(busy, { platform: 'darwin', sleep: () => {} })('a', 'b'), /EBUSY/);
  assert.equal(calls, 1, 'no retries where the error is not transient');
});

test('drift after a snapshot uses the field set each entry was recorded with, so upgrading or changing the kept space settings is not drift', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'km-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const space = { name: 'Test', slug: 'test', displayValue: 'https://test.example.com/app', defaultLocale: 'en' };
  // What a build without envBoundSpaceFields recorded: only the fixed fields left out.
  const { name, slug, ...rest } = space;
  const legacy = createHash('sha256').update(stableStringify(rest)).digest('hex');
  mkdirSync(path.join(dir, 'state'));
  const writeState = (entry: string) => writeFileSync(path.join(dir, 'state', 'test.json'), JSON.stringify({ space: entry }));
  writeState(legacy);
  const config = (fields?: string[]) => writeFileSync(path.join(dir, 'kinetic-sync.config.json'), JSON.stringify(fields ? { envBoundSpaceFields: fields } : {}));
  config();
  const tree = (data: unknown) => new Map([['space', data]]);
  assert.deepEqual(driftedKeys(dir, 'test', tree(space)), []);
  config(['displayValue', 'defaultLocale']);
  assert.deepEqual(driftedKeys(dir, 'test', tree(space)), []);
  // A real change since the promotion still is.
  assert.deepEqual(driftedKeys(dir, 'test', tree({ ...space, defaultLocale: 'de' })), ['space']);
  // An entry recorded with defaultLocale kept: a change to it is not drift, even after unticking it.
  const { defaultLocale, displayValue, ...portable } = rest;
  writeState(`${createHash('sha256').update(stableStringify(portable)).digest('hex')};space-fields=displayValue,defaultLocale`);
  config([]);
  assert.deepEqual(driftedKeys(dir, 'test', tree({ ...space, defaultLocale: 'de' })), []);
});
