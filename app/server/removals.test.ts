// Removals of items only in the target: saved in changesets (old ones without
// `remove` still load), planned with what they take along and what still uses
// them, applied after everything else (kept when changed since review), recorded
// in the run and History, and recreated by a restore from the backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ApplyResult, Changeset, CompareResult, HistoryEvent, PlanResult, RunRecord } from '../shared/sync-api.ts';
import { log } from './repo.ts';
import { runTitle } from './runs.ts';
import { assertNoSecret, harness, testRoutes, type Harness } from './sync-fixtures.ts';
import { typeOf } from './history.ts';

const P = '/api/projects/sync-test';
const OLD = 'teams/Old';
const LEGACY = 'kapps/legacy/kapp';

// Test also has a team, a kapp with a form, and a routine a space workflow
// runs: none of them in Dev.
function withExtras(h: Harness, extra: { team?: boolean; teamDescription?: string } = {}): void {
  h.spaces.test = () => {
    const r = testRoutes();
    const teams = (r['GET core/teams'] as { teams: unknown[] }).teams;
    return {
      ...r,
      'GET core/teams': { teams: extra.team === false ? teams : [...teams, { name: 'Old', slug: 'old', description: extra.teamDescription ?? 'Retired' }] },
      'GET core/kapps': { kapps: [{ slug: 'services' }, { slug: 'legacy' }] },
      'GET core/kapps/legacy': { kapp: { slug: 'legacy', name: 'Legacy', webApis: [], forms: [{ slug: 'old-form', name: 'Old Form', status: 'Active' }] } },
      'GET core/kapps/legacy/workflows': { workflows: [] },
      'GET core/kapps/legacy/forms/old-form/workflows': { workflows: [] },
      'GET core/workflows': { workflows: [{ id: 'w-1', name: 'Welcome', event: 'User Created', platformItemType: 'Space', treeJson: { nodes: [{ id: 'n', definitionId: 'routine_r_v1' }] } }] },
      'GET task/trees': { trees: [{ name: 'Helper', title: 'Helper', definitionId: 'routine_r_v1', status: 'Active', treeJson: { nodes: [] } }] },
    };
  };
}

async function plan(h: Harness, body: unknown): Promise<PlanResult> {
  const job = await h.job('POST', `${P}/plans`, body);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  return job.result as PlanResult;
}

test('changesets save removals beside the keys; never-removable or source items are refused; old changesets still load and plan', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const created = await h.call('POST', `${P}/changesets`, { name: 'Tidy', from: 'dev', keys: [], remove: [OLD, OLD, LEGACY] });
  assert.equal(created.status, 201, created.body);
  const cs = created.json as Changeset;
  assert.deepEqual([cs.keys, cs.remove], [[], [LEGACY, OLD]]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(h.dir, 'changesets', `${cs.id}.json`), 'utf8')).remove, [LEGACY, OLD]);

  const refused = await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: ['space'] });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error.message, /space itself can never be removed/);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: ['handlers/system_wait_v1/handler'] })).status, 400);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: ['teams/Ops'] })).status, 400, 'in the source');
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [] })).status, 400, 'nothing at all');

  const updated = await h.call('PUT', `${P}/changesets/${cs.id}`, { keys: ['teams/Ops'], remove: [OLD] });
  assert.equal(updated.status, 200, updated.body);
  assert.deepEqual([(updated.json as Changeset).keys, (updated.json as Changeset).remove], [['teams/Ops'], [OLD]]);
  const cleared = (await h.call('PUT', `${P}/changesets/${cs.id}`, { remove: [] })).json as Changeset;
  assert.equal(cleared.remove, undefined);

  // A changeset written before removals existed (no `remove`).
  const legacy = { ...(cleared as Changeset), id: 'legacy-000000', name: 'Legacy' } as Partial<Changeset>;
  delete legacy.remove;
  writeFileSync(path.join(h.dir, 'changesets', 'legacy-000000.json'), JSON.stringify(legacy));
  const loaded = (await h.call('GET', `${P}/changesets/legacy-000000`)).json as Changeset;
  assert.equal(loaded.remove, undefined);
  withExtras(h);
  const p = await plan(h, { to: 'test', changesetId: 'legacy-000000' });
  assert.deepEqual([p.removals, p.remove, p.counts.delete], [[], [], 0]);
  assertNoSecret(h);
});

test('a plan lists removals with what they take along and what uses them (a warning); apply deletes them last; the run and History say so', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  withExtras(h);
  const p = await plan(h, { to: 'test', from: 'dev', remove: [OLD, LEGACY, 'routines/Helper'] });
  assert.deepEqual(p.errors, []);
  assert.equal(p.name, 'Remove 3 items from Test');
  assert.deepEqual([p.selected, p.remove], [[], [LEGACY, 'routines/Helper', OLD]]);
  assert.equal(p.counts.delete, 3);
  const byKey = new Map(p.removals.map((r) => [r.key, r]));
  assert.deepEqual(byKey.get(LEGACY)!.children.map((c) => [c.key, c.label]), [['kapps/legacy/forms/old-form/form', 'Old Form']]);
  assert.match(byKey.get(LEGACY)!.restore!, /not its other submissions/);
  assert.match(byKey.get(OLD)!.notes.join(' '), /memberships/);
  assert.deepEqual(byKey.get('routines/Helper')!.usedBy.map((u) => [u.key, u.onlyTarget, u.reason]), [
    ['workflows/User Created/Welcome', true, 'Welcome runs routine "Helper"'],
  ]);
  assert.deepEqual(p.needsAttention, [], 'in use is a warning, not something to tick');

  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const result = job.result as ApplyResult;
  assert.equal(result.status, 'applied', String(result.error));
  assert.deepEqual(h.writes('test'), ['DELETE /kapps/legacy', 'DELETE /trees/Helper', 'DELETE /teams/old']);
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', `${result.runId}.json`), 'utf8')) as RunRecord;
  assert.deepEqual(run.removals, [LEGACY, 'routines/Helper', OLD]);
  assert.deepEqual(run.items.map((i) => [i.key, i.status, i.message]), [
    ['kapps/legacy/forms/old-form/form', 'done', `Removed with ${LEGACY}`],
    [LEGACY, 'done', 'Removed'],
    ['routines/Helper', 'done', 'Removed'],
    [OLD, 'done', 'Removed'],
  ]);
  const titles = (await log(h.dir, { limit: 3 })).map((e) => e.message.split('\n')[0]);
  assert.ok(titles.includes('Removed 3 items from Test'), titles.join(' | '));
  const events = (await h.call('GET', `${P}/history`)).json as HistoryEvent[];
  const ev = events.find((e) => e.title === 'Removed 3 items from Test')!;
  assert.deepEqual([ev.type, ev.status], ['applied', 'applied']);

  // Restoring from the backup recreates what was removed.
  // (A new kapp is read back once created.)
  h.spaces.test = () => ({ ...testRoutes(), 'GET core/kapps/legacy': { kapp: { slug: 'legacy', name: 'Legacy', forms: [] } } });
  const restore = await h.job('POST', `${P}/restore`, { commit: result.backupCommit });
  assert.equal(restore.status, 'succeeded', JSON.stringify(restore.error));
  const rr = restore.result as CompareResult;
  assert.deepEqual([...rr.preselected].sort(), ['kapps/legacy/forms/old-form/form', LEGACY, 'routines/Helper', OLD].sort());
  const rp = await plan(h, { to: 'test', from: 'test', sourceCommit: rr.sourceCommit, selected: rr.preselected, restore: true });
  assert.deepEqual(rp.errors, []);
  assert.deepEqual(rp.items.map((i) => [i.key, i.action]).sort(), [
    ['kapps/legacy/forms/old-form/form', 'create'], [LEGACY, 'create'], ['routines/Helper', 'create'], [OLD, 'create'],
  ].sort());
  const restored = (await h.job('POST', `${P}/plans/${rp.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(restored.status, 'applied', String(restored.error));
  const recreated = h.writes('test').slice(3);
  for (const w of ['POST /teams', 'POST /kapps', 'POST /kapps/legacy/forms', 'POST /trees']) assert.ok(recreated.includes(w), `${w} in ${recreated.join(', ')}`);
  assertNoSecret(h, [job.events]);
});

test('a removal changed in the target since review is kept and the run is partial; one already gone is fine', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  withExtras(h);
  const p = await plan(h, { to: 'test', from: 'dev', remove: [OLD, LEGACY] });
  // The team is edited in Test, and the kapp is deleted there by hand.
  const before = h.spaces.test;
  h.spaces.test = () => {
    const r = before();
    return { ...r, 'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'Operations' }, { name: 'Old', slug: 'old', description: 'Edited' }] }, 'GET core/kapps': { kapps: [{ slug: 'services' }] } };
  };
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  const result = job.result as ApplyResult;
  assert.equal(result.status, 'partial');
  assert.deepEqual(h.writes('test'), []);
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', `${result.runId}.json`), 'utf8')) as RunRecord;
  assert.deepEqual(run.items, [
    { key: LEGACY, status: 'skipped', message: 'Already gone from Test.' },
    { key: OLD, status: 'skipped', message: 'Changed in Test since you reviewed it — not removed.' },
  ]);
  assert.match((await log(h.dir, { limit: 3 })).map((e) => e.message).join('\n'), /^Partly removed 2 items from Test/m);
});

test('a plan can promote and remove together; a never-removable key is refused', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  withExtras(h);
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops'], remove: [OLD] });
  assert.equal(p.name, '1 item from Dev, 1 to remove');
  assert.deepEqual([p.counts.update, p.counts.delete], [1, 1]);
  const done = (await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(done.status, 'applied');
  assert.deepEqual(h.writes('test'), ['PUT /teams/ops', 'DELETE /teams/old']);
  assert.match((await log(h.dir, { limit: 3 })).map((e) => e.message).join('\n'), /^Applied '1 item from Dev, 1 to remove' to Test and removed 1 item/m);

  const bad = await h.call('POST', `${P}/plans`, { to: 'test', from: 'dev', remove: ['space'] });
  assert.equal(bad.status, 400);
});

test('run titles name removals and History reads them as applies', () => {
  assert.equal(runTitle('apply', 'applied', 'x', 'Prod', 0, 2), 'Removed 2 items from Prod');
  assert.equal(runTitle('apply', 'failed', 'x', 'Prod', 0, 1), 'Failed to remove 1 item from Prod');
  assert.equal(runTitle('apply', 'applied', 'Q4', 'Prod', 3, 0), "Applied 'Q4' to Prod");
  assert.equal(runTitle('restore', 'applied', 'x', 'Prod', 3, 0), 'Restored Prod from a backup');
  for (const t of ['Removed 2 items from Prod', 'Partly removed 2 items from Prod', 'Failed to remove 1 item from Prod', 'Cancelled removing 1 item from Prod']) {
    assert.equal(typeOf(t), 'applied', t);
  }
});

test('a sub-collection entry only in the target: listed on its item in Compare, saved and planned as a removal, deleted alone, restored with its item', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const KAPP = 'kapps/services/kapp';
  const ENTRY = `${KAPP}#categories/old-hardware`;
  h.spaces.test = () => {
    const r = testRoutes();
    const kapp = (r['GET core/kapps/services'] as { kapp: Record<string, unknown> }).kapp;
    return { ...r, 'GET core/kapps/services': { kapp: { ...kapp, categories: [{ slug: 'old-hardware', name: 'Old Hardware' }] } } };
  };
  const cmp = (await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' })).result as CompareResult;
  const item = (await h.call('GET', `${P}/compare/${cmp.compareId}/item?key=${encodeURIComponent(KAPP)}`)).json;
  assert.equal(item.status, 'same', 'a target-only entry never makes the item differ');
  assert.deepEqual(item.targetOnlyEntries, [{ key: ENTRY, collection: 'categories', word: 'category', name: 'old-hardware' }]);
  const kapps = (await h.call('GET', `${P}/compare/${cmp.compareId}/tree?parent=group%3Akapps`)).json;
  assert.equal(kapps.find((n: { key?: string }) => n.key === KAPP).entries, 1);
  const roots = (await h.call('GET', `${P}/compare/${cmp.compareId}/tree`)).json;
  assert.equal(roots.find((n: { id: string }) => n.id === 'group:kapps').entriesBelow, 1);

  const cs = (await h.call('POST', `${P}/changesets`, { name: 'Tidy categories', from: 'dev', keys: [], remove: [ENTRY] })).json as Changeset;
  assert.deepEqual(cs.remove, [ENTRY]);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: [`${KAPP}#attributes/x`] })).status, 400);
  const p = await plan(h, { to: 'test', changesetId: cs.id });
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.removals.map((r) => [r.key, r.label, r.action, r.entry?.collection]), [[ENTRY, 'old-hardware (category of services)', 'delete', 'categories']]);
  const done = (await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(done.status, 'applied', String(done.error));
  assert.deepEqual(h.writes('test'), ['DELETE /kapps/services/categories/old-hardware']);
  assert.match((await log(h.dir, { limit: 3 })).map((e) => e.message).join('\n'), /^Removed 1 item from Test/m);

  h.spaces.test = testRoutes;
  const rr = (await h.job('POST', `${P}/restore`, { commit: done.backupCommit })).result as CompareResult;
  assert.deepEqual(rr.preselected, [KAPP]);
});
