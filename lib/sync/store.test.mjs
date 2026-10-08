import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  safeName, encodeSegment, decodeSegment, isCutSegment, segmentLabel, keySegment, keyFor, writeTree, readTree, assertUniqueKeys, MARKER, MAX_SEGMENT_BYTES,
} from './store.mjs';
import { loadState, saveState } from './state.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ksync-store-'));

test('names that are already safe keep their file name (existing projects do not churn)', () => {
  for (const n of ['IT Request', 'kinetic_core_api_v1', 'Submission Created', '100% done', 'José Núñez', 'a.b', 'smtp-server', '日本語', 'Notify (v2) #1 & co', '~tilde']) {
    assert.equal(encodeSegment(n), n, n);
  }
  assert.equal(safeName, encodeSegment, 'old name kept as an alias');
});

test('characters Windows forbids are percent-escaped, reversibly', () => {
  assert.equal(encodeSegment('Departments::IT'), 'Departments%3A%3AIT');
  assert.equal(encodeSegment('a/b\\c*?"<>|'), 'a%2Fb%5Cc%2A%3F%22%3C%3E%7C');
  assert.equal(encodeSegment('tab\there\x7f'), 'tab%09here%7F');
  assert.equal(keyFor('kapps', 'k', 'forms', 'a/b'), 'kapps/k/forms/a%2Fb');
  for (const n of ['Departments::IT', 'a/b\\c*?"<>|', 'tab\there\x7f']) assert.equal(decodeSegment(encodeSegment(n)), n);
});

test('leading dots and spaces, trailing dots and spaces are escaped (Windows drops trailing ones)', () => {
  assert.equal(encodeSegment('..hidden'), '%2E.hidden');
  assert.equal(encodeSegment('.'), '%2E');
  assert.equal(encodeSegment('..'), '%2E%2E');
  assert.equal(encodeSegment('  '), '%20%20');
  assert.equal(encodeSegment('name.'), 'name%2E');
  assert.equal(encodeSegment(' padded '), '%20padded%20');
  for (const n of ['..hidden', '.', '..', '  ', 'name.', ' padded ']) assert.equal(decodeSegment(encodeSegment(n)), n);
});

test('Windows device names are escaped in any case and with any extension', () => {
  const reserved = ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'COM0', 'LPT1', 'lpt9', 'COM¹', 'LPT³', 'CONIN$', 'conout$', 'con.txt', 'NUL.tar.gz', 'aux .json'];
  for (const n of reserved) {
    const e = encodeSegment(n);
    assert.match(e, /^%[0-9A-F]{2}/, `${n} -> ${e}`);
    assert.equal(decodeSegment(e), n);
  }
  for (const n of ['CONSOLE', 'COM10', 'LPT', 'auxiliary', 'nul-handler', 'icon']) assert.equal(encodeSegment(n), n, n);
});

test('% stays literal unless it would read as an escape; the encoding is injective', () => {
  assert.equal(encodeSegment('50%AB'), '50%25AB');
  assert.equal(encodeSegment('%~x'), '%25~x');
  assert.equal(encodeSegment('%:'), '%%3A');
  assert.equal(encodeSegment('%3:'), '%3%3A');
  const names = ['a:b', 'a%3Ab', 'a%253Ab', 'a_b', 'a%b', '%', '%%', '%3A', '%%3A', '%~', 'x%~12345678', ':', '_', 'con', '%63on', '.x', '%2Ex'];
  const encoded = names.map(encodeSegment);
  assert.equal(new Set(encoded).size, names.length, encoded.join(' '));
  for (const n of names) assert.equal(decodeSegment(encodeSegment(n)), n, n);
});

test('every encoded segment is a valid Windows file name', () => {
  const names = ['CON', 'a:b', 'x.', ' y', '..', 'Pipe|Line', '?', '*', 'emoji 😀', 'x'.repeat(300), 'Ünïcödé'.repeat(20), 'com1.json'];
  for (const n of names) {
    const e = encodeSegment(n);
    assert.doesNotMatch(e, /[<>:"/\\|?*\x00-\x1f]/, e);
    assert.doesNotMatch(e, /[. ]$/, e);
    assert.doesNotMatch(e.split('.')[0].trimEnd(), /^(con|prn|aux|nul|com\d|lpt\d)$/i, e);
    assert.ok(Buffer.byteLength(e) <= MAX_SEGMENT_BYTES, e);
  }
});

test('long names are cut deterministically with a hash of the full name', () => {
  const long = `Notify approver ${'and update the parent record '.repeat(5)}`;
  const e = encodeSegment(long);
  assert.ok(Buffer.byteLength(e) <= MAX_SEGMENT_BYTES);
  assert.match(e, /^Notify approver and update.*%~[0-9a-f]{8}$/);
  assert.equal(encodeSegment(long), e, 'deterministic');
  assert.notEqual(encodeSegment(`${long}!`), e, 'a different long name gets a different hash');
  assert.ok(isCutSegment(e));
  assert.throws(() => decodeSegment(e), /shortened/);
  assert.equal(segmentLabel(e).endsWith('…'), true);
  // A cut never splits an escape or a multi-byte character.
  assert.match(encodeSegment(`${'a'.repeat(60)}:${'é'.repeat(40)}`), /^a{60}%3Aééé%~[0-9a-f]{8}$/);
  assert.match(encodeSegment(`${'a'.repeat(68)}:${'é'.repeat(40)}`), /^a{68}%~[0-9a-f]{8}$/, 'an escape that does not fit is left out whole');
  // Exactly at the limit is kept whole.
  assert.equal(encodeSegment('b'.repeat(MAX_SEGMENT_BYTES)), 'b'.repeat(MAX_SEGMENT_BYTES));
});

test('names are NFC-normalised, so a decomposed name from macOS maps to the same key', () => {
  const nfd = 'José';
  assert.equal(encodeSegment(nfd), 'José');
  assert.equal(keyFor('teams', nfd), keyFor('teams', 'José'));
});

test('keySegment decodes the slug or name a key segment holds', () => {
  const key = keyFor('kapps', 'con', 'forms', 'a:b', 'form');
  assert.equal(key, 'kapps/%63on/forms/a%3Ab/form');
  assert.equal(keySegment(key, 1), 'con');
  assert.equal(keySegment(key, 3), 'a:b');
});

test('assertUniqueKeys rejects exact, case-only and normalisation-only collisions, naming both items', () => {
  assert.throws(() => assertUniqueKeys([{ key: 'teams/A_B' }, { key: 'teams/A_B' }]), /teams \/ A_B/);
  assert.throws(() => assertUniqueKeys([{ key: 'teams/Ops' }, { key: 'teams/ops' }]), /"teams \/ Ops" and "teams \/ ops" differ only by case/);
  assert.throws(() => assertUniqueKeys([{ key: keyFor('teams', 'Ops::A') }, { key: keyFor('teams', 'OPS::a') }]), /Ops::A.*OPS::a/);
  assert.throws(() => assertUniqueKeys([{ key: 'teams/José' }, { key: 'teams/José' }]));
  assert.doesNotThrow(() => assertUniqueKeys([{ key: 'teams/a' }, { key: 'teams/b' }]));
});

test('assertUniqueKeys catches folders that differ only by case', () => {
  assert.throws(
    () => assertUniqueKeys([{ key: 'connections/Mail/connection' }, { key: 'connections/mail/operations/Send' }]),
    /Folders "connections \/ Mail" and "connections \/ mail"/,
  );
  assert.doesNotThrow(() => assertUniqueKeys([{ key: 'connections/Mail/connection' }, { key: 'connections/Mail/operations/Send' }]));
});

test('artifacts with awkward names write, read back under the same keys, and never escape the tree', () => {
  const dir = join(tmp(), 'export');
  const names = ['con', 'a:b', 'x.', '..', 'Pipe|Line', 'x'.repeat(200), 'José'];
  const artifacts = names.map((n, i) => ({ key: keyFor('teams', n), data: { i } }));
  writeTree(dir, artifacts);
  const tree = readTree(dir);
  assert.deepEqual([...tree.keys()].sort(), artifacts.map((a) => a.key).sort());
  for (const a of artifacts) assert.deepEqual(tree.get(a.key), a.data);
  assert.deepEqual(readdirSync(dir).sort(), ['.kinetic-sync-export', 'teams']);
});

test('readTree tolerates a byte-order mark and CRLF line ends (a file edited on Windows)', () => {
  const dir = join(tmp(), 'export');
  writeTree(dir, [{ key: 'teams/T', data: { name: 'T', notes: 'a\nb' } }]);
  writeFileSync(join(dir, 'teams', 'T.json'), '﻿{\r\n  "name": "T",\r\n  "notes": "a\\nb"\r\n}\r\n');
  assert.deepEqual(readTree(dir).get('teams/T'), { name: 'T', notes: 'a\nb' });
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
