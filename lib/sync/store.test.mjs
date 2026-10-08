import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeName, keyFor, writeTree, readTree, assertUniqueKeys, MARKER } from './store.mjs';
import { loadState, saveState } from './state.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ksync-store-'));

test('safeName replaces path and reserved characters', () => {
  assert.equal(safeName('Departments::IT'), 'Departments__IT');
  assert.equal(safeName('a/b\\c*?"<>|'), 'a_b_c______');
  assert.equal(safeName('..hidden'), '_.hidden');
  assert.equal(safeName('  '), '_');
  assert.equal(keyFor('kapps', 'k', 'forms', 'a/b'), 'kapps/k/forms/a_b');
});

test('assertUniqueKeys rejects exact and case-only collisions', () => {
  assert.throws(() => assertUniqueKeys([{ key: 'teams/A_B' }, { key: 'teams/A_B' }]), /teams\/A_B/);
  assert.throws(() => assertUniqueKeys([{ key: 'teams/Ops' }, { key: 'teams/ops' }]), /case/);
  assert.doesNotThrow(() => assertUniqueKeys([{ key: 'teams/a' }, { key: 'teams/b' }]));
});

test('writeTree writes stable JSON plus a marker, and readTree reads it back', () => {
  const dir = join(tmp(), 'export');
  writeTree(dir, [{ key: 'space', data: { b: 1, a: 2 } }, { key: 'kapps/k/forms/f/form', data: { slug: 'f' } }]);
  assert.ok(existsSync(join(dir, MARKER)));
  assert.equal(readFileSync(join(dir, 'space.json'), 'utf8'), '{\n  "a": 2,\n  "b": 1\n}\n');
  const tree = readTree(dir);
  assert.deepEqual([...tree.keys()].sort(), ['kapps/k/forms/f/form', 'space']);
  assert.deepEqual(tree.get('kapps/k/forms/f/form'), { slug: 'f' });
});

test('writeTree replaces a previous export so deleted artifacts disappear', () => {
  const dir = join(tmp(), 'export');
  writeTree(dir, [{ key: 'teams/Old', data: {} }]);
  writeTree(dir, [{ key: 'teams/New', data: {} }]);
  assert.deepEqual([...readTree(dir).keys()], ['teams/New']);
});

test('writeTree refuses to clear a non-empty directory that is not an export', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'important.txt'), 'keep me');
  assert.throws(() => writeTree(dir, []), /not a kinetic-sync export/);
  assert.equal(readFileSync(join(dir, 'important.txt'), 'utf8'), 'keep me');
});

test('readTree on a missing directory explains how to create it', () => {
  assert.throws(() => readTree(join(tmp(), 'nope')), /run export first/);
});

test('state round-trips and defaults to empty', () => {
  const dir = tmp();
  assert.deepEqual(loadState(dir, 'prod'), {});
  saveState(dir, 'prod', { b: 'h2', a: 'h1' });
  assert.deepEqual(loadState(dir, 'prod'), { a: 'h1', b: 'h2' });
  assert.equal(readFileSync(join(dir, 'state', 'prod.json'), 'utf8').split('\n')[1], '  "a": "h1",');
});

test('writeTree writes binary attachments beside the artifact; readTree ignores them', () => {
  const dir = join(tmp(), 'export');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  writeTree(dir, [{ key: 'handlers/h_v1/handler', data: { definitionId: 'h_v1' }, files: { 'package.zip': zip } }]);
  assert.deepEqual(readFileSync(join(dir, 'handlers', 'h_v1', 'package.zip')), zip);
  assert.ok(existsSync(join(dir, 'handlers', 'h_v1', 'handler.json')));
  assert.deepEqual([...readTree(dir).keys()], ['handlers/h_v1/handler']);
});

test('writeTree refuses attachment names that would escape the artifact folder', () => {
  const dir = join(tmp(), 'export');
  assert.throws(() => writeTree(dir, [{ key: 'handlers/h/handler', data: {}, files: { '../x.zip': Buffer.from('') } }]), /attachment/);
});
