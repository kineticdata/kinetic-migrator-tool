// An environment whose Integrator sign-in answers 404 (Kinetic Platform
// 7.0.0-rc3): snapshots succeed without connections and say why; compare and
// plans leave connections out on both sides (no false creates, removals or
// suggestions to add); Test connection says the same in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CompareResult, CompareTreeNode, PlanResult, SnapshotResult, SuggestionOut } from '../shared/sync-api.ts';
import type { ConnectionTestResult } from '../shared/api.ts';
import { log } from './repo.ts';
import { assertNoSecret, devRoutes, harness, type Harness } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const FORM = 'kapps/services/forms/it-request/form';
const OP = 'connections/Ticketing/operations/Create Ticket';
const CONN = 'connections/Ticketing/connection';
const WHY = "test.example.com runs Kinetic Platform 7.0.0-rc3, which doesn't offer the sign-in this tool uses for the Integrator yet.";

async function snapshot(h: Harness, env: string): Promise<SnapshotResult> {
  const job = await h.job('POST', `${P}/snapshots`, { env });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  return job.result as SnapshotResult;
}

async function compare(h: Harness, body: Record<string, unknown>): Promise<CompareResult> {
  const job = await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', ...body });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  return job.result as CompareResult;
}

const connectionNodes = async (h: Harness, r: CompareResult) => {
  const roots = (await h.call('GET', `${P}/compare/${r.compareId}/tree`)).json as CompareTreeNode[];
  return roots.filter((n) => n.id === 'group:connections');
};

test('a snapshot succeeds without connections and operations, with a warning in the result, the commit and the marker', async (t) => {
  const h = await harness(t);
  h.integratorDown.add('test');
  h.spaces.test = devRoutes; // it has connections; they cannot be read
  const r = await snapshot(h, 'test');
  assert.deepEqual(r.warnings, [`Connections and operations were left out: ${WHY}`]);
  assert.equal(Object.keys(r.counts).some((k) => k === 'connections' || k === 'operations'), false);
  assert.ok((r.counts.forms ?? 0) > 0);
  const head = (await log(h.dir, { limit: 1 }))[0];
  assert.match(head.message, /Connections and operations were left out: test\.example\.com runs Kinetic Platform 7\.0\.0-rc3/);
  assert.match(readFileSync(path.join(h.dir, 'snapshots', 'test', '.kinetic-sync-export'), 'utf8'), /^omitted: \{.*"status":404/m);
  // A later snapshot with the Integrator back records no omission.
  h.integratorDown.delete('test');
  const again = await snapshot(h, 'test');
  assert.equal(again.warnings, undefined);
  assert.doesNotMatch(readFileSync(path.join(h.dir, 'snapshots', 'test', '.kinetic-sync-export'), 'utf8'), /omitted/);
  assertNoSecret(h);
});

test('compare into a target without connections: none are new, a note says why, and suggestions name them as not checked', async (t) => {
  const h = await harness(t);
  await snapshot(h, 'dev');
  h.integratorDown.add('test');
  await snapshot(h, 'test');
  for (const body of [{ mode: 'preview' }, { mode: 'preview', useSnapshots: true }, { mode: 'raw' }]) {
    const r = await compare(h, body);
    const label = JSON.stringify(body);
    assert.equal(r.counts.new, 1, `${label}: only the handler is new (${JSON.stringify(r.counts)})`);
    assert.deepEqual(await connectionNodes(h, r), [], label);
    assert.equal(r.notes?.length, 1, label);
    assert.match(r.notes![0], /^Connections and operations are left out of this comparison: Test has none recorded\. test\.example\.com runs Kinetic Platform 7\.0\.0-rc3/);
    const sug = (await h.call('POST', `${P}/compare/${r.compareId}/suggestions`, { selected: [FORM] })).json as SuggestionOut[];
    assert.deepEqual(sug.map((s) => [s.key, s.unchecked]), [[CONN, true], [OP, true]], label);
    assert.match(sug.find((s) => s.key === OP)!.reason, /calls operation "Create Ticket".*; it couldn't be checked, because connections and operations were left out of this comparison$/);
  }
  assertNoSecret(h);
});

test('a source snapshot without connections never shows the target\'s connections as only in the target', async (t) => {
  const h = await harness(t);
  h.spaces.test = devRoutes;
  h.integratorDown.add('dev');
  await snapshot(h, 'dev');
  h.integratorDown.delete('dev');
  await snapshot(h, 'test');
  for (const body of [{ mode: 'preview' }, { mode: 'preview', useSnapshots: true }, { mode: 'raw' }]) {
    const r = await compare(h, body);
    assert.equal(r.counts['only-target'] ?? 0, 0, JSON.stringify(body));
    assert.deepEqual(await connectionNodes(h, r), []);
    assert.match(r.notes?.[0] ?? '', /Dev has none recorded/);
  }
});

test('a plan into a target without connections has no connection items or errors, and says why', async (t) => {
  const h = await harness(t);
  await snapshot(h, 'dev');
  h.integratorDown.add('test');
  const job = await h.job('POST', `${P}/plans`, { to: 'test', from: 'dev', selected: [FORM, CONN, OP] });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const plan = job.result as PlanResult;
  assert.equal(plan.items.some((i) => i.key.startsWith('connections/')), false);
  assert.equal(plan.removals.length, 0);
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => /left out of this comparison: test has none recorded/.test(w)), JSON.stringify(plan.warnings));
  assert.ok(plan.warnings.some((w) => /couldn't be checked, because connections were left out: kapps\/services\/forms\/it-request\/form/.test(w)));
  assert.ok(plan.items.some((i) => i.key === FORM && i.action === 'update'));
});

test('Test connection says in plain words that the Integrator sign-in is not offered', async (t) => {
  const h = await harness(t);
  h.integratorDown.add('test');
  h.spaces.test = () => ({ ...devRoutes(), 'GET core/me': { username: 'admin' } });
  const r = (await h.call('POST', `${P}/environments/test/test`)).json as ConnectionTestResult;
  const step = r.steps.find((s) => s.step === 'integrator')!;
  assert.equal(step.ok, false);
  assert.equal(step.message, `${WHY} Snapshots will leave connections and operations out.`);
  assert.equal(r.steps.find((s) => s.step === 'core')!.ok, true);
});
