// The snapshot folder swap: the new export replaces snapshots/<env>/ only as a
// whole; when the swap fails, the previous snapshot is put back (a failed
// rename on Windows must never leave the folder missing, or the next commit
// would record the whole snapshot as deleted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { retryingRename, swapInto } from './snapshots.ts';

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

test('a successful swap puts the new snapshot in place and removes the old one', (t) => {
  const { temp, final, aside } = layout(t);
  swapInto(temp, final, aside);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
  assert.equal(fs.existsSync(temp), false);
  assert.equal(fs.existsSync(aside), false);
});

test('a first snapshot needs no old folder', (t) => {
  const { temp, final, aside } = layout(t);
  rmSync(final, { recursive: true });
  swapInto(temp, final, aside);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
});

test('when the new folder cannot be moved in, the previous snapshot is restored', (t) => {
  const { temp, final, aside } = layout(t);
  const rename = (from: string, to: string) => {
    if (from === temp) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.renameSync(from, to);
  };
  assert.throws(() => swapInto(temp, final, aside, { rename }), /EPERM/);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"old"');
  assert.equal(fs.existsSync(aside), false);
  assert.equal(fs.existsSync(temp), false, 'the unused export is removed');
});

test('when the old folder cannot be moved aside, nothing changes', (t) => {
  const { temp, final, aside } = layout(t);
  const rename = (from: string, to: string) => {
    if (from === final) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    fs.renameSync(from, to);
  };
  assert.throws(() => swapInto(temp, final, aside, { rename }), /EBUSY/);
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"old"');
  assert.equal(fs.existsSync(temp), false);
});

test('an old folder that cannot be deleted stays aside in plans/, never in snapshots/', (t) => {
  const { temp, final, aside } = layout(t);
  const rm = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  swapInto(temp, final, aside, { rm });
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
  assert.equal(readFileSync(path.join(aside, 'space.json'), 'utf8'), '"old"');
});

test('on Windows a rename blocked for a moment (antivirus, indexer) is retried', (t) => {
  const { temp, final, aside } = layout(t);
  let failures = 2;
  const slept: number[] = [];
  const rename = (from: string, to: string) => {
    if (from === temp && failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.renameSync(from, to);
  };
  swapInto(temp, final, aside, { rename, platform: 'win32', sleep: (ms) => slept.push(ms) });
  assert.equal(readFileSync(path.join(final, 'space.json'), 'utf8'), '"new"');
  assert.deepEqual(slept, [50, 100]);
});

test('retries give up after a bounded time and only for transient codes', () => {
  let calls = 0;
  const busy = () => { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  assert.throws(() => retryingRename(busy, { platform: 'win32', sleep: () => {} })('a', 'b'), /EBUSY/);
  assert.equal(calls, 8);
  calls = 0;
  const missing = () => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.throws(() => retryingRename(missing, { platform: 'win32', sleep: () => {} })('a', 'b'), /ENOENT/);
  assert.equal(calls, 1);
  calls = 0;
  assert.throws(() => retryingRename(busy, { platform: 'darwin', sleep: () => {} })('a', 'b'), /EBUSY/);
  assert.equal(calls, 1, 'no retries where the error is not transient');
});
