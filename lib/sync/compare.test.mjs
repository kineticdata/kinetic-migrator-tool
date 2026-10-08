// lib/sync/compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareArtifacts, formatCompare } from './compare.mjs';

const MODULES = [
  { type: 'space', owns: (k) => k === 'space' },
  { type: 'teams', owns: (k) => k.startsWith('teams/') },
  { type: 'routines', owns: (k) => k.startsWith('routines/') },
];
const art = (key, data) => [key, { key, data }];

function sample() {
  const left = new Map([
    art('teams/Ops', { name: 'Ops', description: 'a' }),
    art('space', { name: 'Dev' }),
    art('teams/Same', { name: 'Same' }),
    art('routines/Notify', { name: 'Notify' }),
    art('mystery/x', { v: 1 }),
  ]);
  const right = new Map([
    art('teams/Ops', { name: 'Ops', description: 'b' }),
    art('space', { name: 'Prod' }),
    art('teams/Same', { name: 'Same' }),
    art('teams/Extra', { name: 'Extra' }),
  ]);
  return compareArtifacts({ modules: MODULES, left, right });
}

test('compareArtifacts classifies every key, sorted, with A→B diffs and counts', () => {
  const r = sample();
  assert.deepEqual(r.items.map((i) => [i.key, i.status, i.type]), [
    ['mystery/x', 'only-left', 'unknown'],
    ['routines/Notify', 'only-left', 'routines'],
    ['space', 'differs', 'space'],
    ['teams/Extra', 'only-right', 'teams'],
    ['teams/Ops', 'differs', 'teams'],
    ['teams/Same', 'same', 'teams'],
  ]);
  assert.deepEqual(r.items.find((i) => i.key === 'teams/Ops').diff, [{ path: 'description', from: 'a', to: 'b' }]);
  assert.deepEqual(r.items.find((i) => i.key === 'space').diff, [{ path: 'name', from: 'Dev', to: 'Prod' }]);
  assert.deepEqual(r.items.find((i) => i.key === 'teams/Same').diff, []);
  assert.deepEqual(r.items.find((i) => i.key === 'teams/Extra').diff, []);
  assert.deepEqual(r.counts, { same: 1, differs: 2, 'only-left': 2, 'only-right': 1 });
});

test('formatCompare lists only the non-same items with their field diffs', () => {
  const text = formatCompare(sample(), 'dev', 'prod');
  assert.match(text, /^Compare dev → prod \(raw\)/);
  assert.match(text, /same 1 {3}differs 2 {3}only in dev 2 {3}only in prod 1/);
  assert.match(text, /~ differs\s+teams\s+teams\/Ops\n\s+description: "a" → "b"/);
  assert.match(text, /< only in dev\s+routines\s+routines\/Notify/);
  assert.match(text, /> only in prod\s+teams\s+teams\/Extra/);
  assert.doesNotMatch(text, /teams\/Same/);
});

test('formatCompare caps field diffs per item', () => {
  const big = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${String(i).padStart(2, '0')}`, i]));
  const r = compareArtifacts({
    modules: MODULES,
    left: new Map([art('space', big)]),
    right: new Map([art('space', {})]),
  });
  const text = formatCompare(r, 'dev', 'prod');
  assert.match(text, /\.\.\. 5 more difference\(s\)/);
  assert.doesNotMatch(text, /f24/);
});
