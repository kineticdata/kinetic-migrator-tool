// lib/sync/report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPlan, planRecord, show } from './report.mjs';

const PLAN = {
  items: [
    { key: 'teams/New', type: 'teams', action: 'create', diff: [] },
    { key: 'teams/Ops', type: 'teams', action: 'update', diff: [{ path: 'description', from: 'a', to: 'b' }] },
    { key: 'space', type: 'space', action: 'unchanged', diff: [] },
  ],
  targetOnly: [{ key: 'teams/Old', type: 'teams' }],
  warnings: ['careful'],
  errors: [],
};

test('show truncates long values and marks absent ones', () => {
  assert.equal(show(undefined), '(none)');
  assert.equal(show('x'.repeat(200)).length, 80);
});

test('formatPlan summarises counts, changes, target-only items, warnings', () => {
  const text = formatPlan(PLAN, 'prod', { prune: ['teams'] });
  assert.match(text, /^Plan for prod/);
  assert.match(text, /create 1 {3}update 1 .*unchanged 1 {3}target-only 1/);
  assert.match(text, /\+ create\s+teams\s+teams\/New/);
  assert.match(text, /description: "a" → "b"/);
  assert.match(text, /- DELETE teams\s+teams\/Old/);
  assert.match(text, /WARN {2}careful/);
  assert.doesNotMatch(text, /space/);
});

test('planRecord keeps only changes and is serialisable', () => {
  const rec = planRecord(PLAN);
  assert.deepEqual(rec.items.map((i) => i.key), ['teams/New', 'teams/Ops']);
  assert.deepEqual(rec.targetOnly, ['teams/Old']);
  assert.doesNotThrow(() => JSON.stringify(rec));
});

test('formatPlan lists target-only data rows only when data is pruned, and never labels a whole data artifact DELETE', () => {
  const dataItem = (key, action) => ({
    key, type: 'data', action, diff: [],
    source: { key: ['Code'], rows: [{ Code: 'A' }] },
    existing: { key, data: { key: ['Code'], rows: [{ Code: 'A' }, { Code: 'Z' }] }, meta: { ids: { '["A"]': 'id-a', '["Z"]': 'id-z' } } },
  });
  const plan = {
    items: [dataItem('kapps/ref/forms/codes/data', 'unchanged'), dataItem('kapps/ref/forms/drifted/data', 'skip-drift')],
    targetOnly: [{ key: 'kapps/ref/forms/other/data', type: 'data' }],
    warnings: [], errors: [],
  };
  const pruned = formatPlan(plan, 'prod', { prune: ['data'] });
  assert.match(pruned, /Rows only in the target \(will be deleted by --prune data\):\n {2}- DELETE row ref\/codes \["Z"\]/);
  assert.doesNotMatch(pruned, /DELETE row ref\/drifted/);
  assert.doesNotMatch(pruned, /DELETE data/);
  assert.doesNotMatch(formatPlan(plan, 'prod'), /DELETE/);
});
