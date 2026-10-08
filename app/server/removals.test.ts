// Removals of items only in the target: saved in changesets (old ones without
// `remove` still load), planned with what they take along and what still uses
// them, applied after everything else (kept when changed since review), recorded
// in the run and History, and recreated by a restore from the backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ApplyResult, Changeset, CompareResult, HistoryEvent, PlanResult, RunRecord } from '../shared/sync-api.ts';
import { log } from './repo.ts';
import { runTitle } from './runs.ts';
import { assertNoSecret, devRoutes, harness, testRoutes, type Harness } from './sync-fixtures.ts';
// @ts-expect-error -- untyped engine module
import { fakeTaskCategories } from '../../lib/sync/fake-client.mjs';
import { typeOf } from './history.ts';

const P = '/api/projects/sync-test';
const OLD = 'teams/Old';
const LEGACY = 'kapps/legacy/kapp';

// Test also has a team, a kapp with a form, and a routine a space workflow
// runs: none of them in Dev.
// The legacy kapp's delete takes its form with it (the platform cascades).
function withExtras(h: Harness, extra: { team?: boolean; teamDescription?: string } = {}): void {
  let legacyGone = false;
  h.spaces.test = () => {
    const r = testRoutes();
    const teams = (r['GET core/teams'] as { teams: unknown[] }).teams;
    return {
      ...r,
      'GET core/teams': { teams: extra.team === false ? teams : [...teams, { name: 'Old', slug: 'old', description: extra.teamDescription ?? 'Retired' }] },
      'GET core/kapps': () => ({ kapps: legacyGone ? [{ slug: 'services' }] : [{ slug: 'services' }, { slug: 'legacy' }] }),
      'DELETE core/kapps/legacy': () => { legacyGone = true; return {}; },
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
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'Tidy', from: 'dev', keys: [], remove: [OLD] })).status, 400, 'removals need the target they were chosen for');
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'Tidy', from: 'dev', keys: [], remove: [OLD], removeFrom: 'dev' })).status, 400, 'not the source');
  const created = await h.call('POST', `${P}/changesets`, { name: 'Tidy', from: 'dev', keys: [], remove: [OLD, OLD, LEGACY], removeFrom: 'test' });
  assert.equal(created.status, 201, created.body);
  const cs = created.json as Changeset;
  assert.deepEqual([cs.keys, cs.remove, cs.removeFrom], [[], [LEGACY, OLD], 'test']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(h.dir, 'changesets', `${cs.id}.json`), 'utf8')).remove, [LEGACY, OLD]);

  const refused = await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: ['space'], removeFrom: 'test' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error.message, /space itself can never be removed/);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: ['handlers/system_wait_v1/handler'], removeFrom: 'test' })).status, 400);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: ['teams/Ops'], removeFrom: 'test' })).status, 400, 'in the source');
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [] })).status, 400, 'nothing at all');

  const updated = await h.call('PUT', `${P}/changesets/${cs.id}`, { keys: ['teams/Ops'], remove: [OLD] });
  assert.equal(updated.status, 200, updated.body);
  assert.deepEqual([(updated.json as Changeset).keys, (updated.json as Changeset).remove], [['teams/Ops'], [OLD]]);
  const cleared = (await h.call('PUT', `${P}/changesets/${cs.id}`, { remove: [] })).json as Changeset;
  assert.equal(cleared.remove, undefined);

  // Bound to Test: planned against Test, refused (with a warning) against Prod.
  withExtras(h);
  assert.equal((await h.call('PUT', `${P}/changesets/${cs.id}`, { remove: [OLD] })).status, 400, 'cleared removals lost their target');
  const bound = (await h.call('PUT', `${P}/changesets/${cs.id}`, { remove: [OLD], removeFrom: 'test' })).json as Changeset;
  assert.equal(bound.removeFrom, 'test');
  assert.deepEqual((await plan(h, { to: 'test', changesetId: cs.id })).remove, [OLD]);
  h.spaces.prod = h.spaces.test;
  const elsewhere = await plan(h, { to: 'prod', changesetId: cs.id });
  assert.deepEqual([elsewhere.remove, elsewhere.removals], [[], []]);
  assert.ok(elsewhere.warnings.includes("This changeset's 1 removal were chosen for Test and are not planned against Prod"), elsewhere.warnings.join('|'));
  // Saved before removals were bound: not planned until confirmed for a target.
  const raw = JSON.parse(readFileSync(path.join(h.dir, 'changesets', `${cs.id}.json`), 'utf8'));
  delete raw.removeFrom;
  writeFileSync(path.join(h.dir, 'changesets', `${cs.id}.json`), JSON.stringify(raw));
  const unbound = await plan(h, { to: 'test', changesetId: cs.id });
  assert.deepEqual(unbound.remove, []);
  assert.ok(unbound.warnings.some((w) => /saved without a target environment and are not planned: confirm them for Test/.test(w)));
  assert.equal((await h.call('PUT', `${P}/changesets/${cs.id}`, { removeFrom: 'test' })).status, 200);
  assert.deepEqual((await plan(h, { to: 'test', changesetId: cs.id })).remove, [OLD]);

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
  assert.match((await log(h.dir, { limit: 3 })).map((e) => e.message).join('\n'), /^Removed nothing from Test \(2 items skipped\)/m);
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
  assert.equal(runTitle('apply', 'partial', 'x', 'Prod', 0, 0, 2), 'Removed nothing from Prod (2 items skipped)');
  assert.equal(runTitle('apply', 'partial', 'x', 'Prod', 0, 1, 2), 'Partly removed 1 item from Prod');
  for (const t of ['Removed nothing from Prod (2 items skipped)', 'Removed 2 items from Prod', 'Partly removed 2 items from Prod', 'Failed to remove 1 item from Prod', 'Cancelled removing 1 item from Prod']) {
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

  const cs = (await h.call('POST', `${P}/changesets`, { name: 'Tidy categories', from: 'dev', keys: [], remove: [ENTRY], removeFrom: 'test' })).json as Changeset;
  assert.deepEqual(cs.remove, [ENTRY]);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [], remove: [`${KAPP}#attributes/x`], removeFrom: 'test' })).status, 400);
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

test('C1: a removal the plan kept (changed since last promoted) or found gone is never deleted at apply, even when it changes back or reappears', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  // Kept: the team was promoted, then edited in Test.
  const { stateEntry } = await import('../../lib/sync/normalize.mjs' as string);
  mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  writeFileSync(path.join(h.dir, 'state', 'test.json'), JSON.stringify({ [OLD]: stateEntry('team', { name: 'Old', description: 'as promoted' }, {}, OLD) }));
  withExtras(h, { teamDescription: 'edited in Test' });
  const kept = await plan(h, { to: 'test', from: 'dev', remove: [OLD] });
  assert.deepEqual(kept.removals.map((r) => [r.key, r.action]), [[OLD, 'skip-drift']]);
  assert.equal(kept.counts.delete, 0);
  const a1 = (await h.job('POST', `${P}/plans/${kept.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(a1.status, 'applied', String(a1.error));
  assert.deepEqual(h.writes('test'), [], 'kept means kept');

  // Gone at plan time, then created in Test before Apply.
  withExtras(h, { team: false });
  const gone = await plan(h, { to: 'test', from: 'dev', remove: [OLD] });
  assert.deepEqual(gone.removals.map((r) => [r.key, r.action]), [[OLD, 'gone']]);
  withExtras(h);
  await h.job('POST', `${P}/plans/${gone.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.deepEqual(h.writes('test'), [], 'an item the user never saw is never deleted');
});

test('I1: an item that is back in the newest snapshot of the source is not removed, even by a changeset pinned before it came back', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  withExtras(h);
  const cs = (await h.call('POST', `${P}/changesets`, { name: 'Cleanup', from: 'dev', keys: [], remove: [OLD], removeFrom: 'test' })).json as Changeset;
  // The team is then created in Dev, and Dev is snapshotted again.
  const dev = h.spaces.dev;
  h.spaces.dev = () => ({ ...dev(), 'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'Operations (dev)' }, { name: 'Old', slug: 'old' }] } });
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', changesetId: cs.id });
  assert.deepEqual([p.removals, p.counts.delete], [[], 0]);
  assert.ok(p.warnings.includes(`${OLD}: still exists in Dev (newest snapshot) — not removed`), p.warnings.join('|'));
  // A plan from the newest snapshot drops it the same way.
  const live = await plan(h, { to: 'test', from: 'dev', remove: [OLD] });
  assert.deepEqual(live.removals, []);
  assert.ok(live.warnings.includes(`${OLD}: still exists in dev — not removed`), live.warnings.join('|'));
  await h.job('POST', `${P}/plans/${live.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.deepEqual(h.writes('test').filter((w) => w.startsWith('DELETE')), []);
});

test('I4: a child still in the target after its kapp was removed, and that cannot be deleted, makes the run partial and is reported failed', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  withExtras(h);
  const cascading = h.spaces.test;
  // No cascade, and the form's own delete fails.
  h.spaces.test = () => ({
    ...cascading(), 'GET core/kapps': { kapps: [{ slug: 'services' }, { slug: 'legacy' }] },
    'DELETE core/kapps/legacy/forms/old-form': () => { throw Object.assign(new Error('DELETE x failed with 500'), { status: 500 }); },
  });
  const p = await plan(h, { to: 'test', from: 'dev', remove: [LEGACY] });
  const result = (await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(result.status, 'partial');
  assert.match(String(result.error), /still in Test/);
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', `${result.runId}.json`), 'utf8')) as RunRecord;
  assert.deepEqual(run.items.map((i) => [i.key, i.status]), [['kapps/legacy/forms/old-form/form', 'failed'], [LEGACY, 'done']]);
});

test('a restore planned from a changeset never plans its removals', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  withExtras(h);
  const cs = (await h.call('POST', `${P}/changesets`, { name: 'Tidy', from: 'dev', keys: ['teams/Ops'], remove: [OLD], removeFrom: 'test' })).json as Changeset;
  const p = await plan(h, { to: 'test', changesetId: cs.id, restore: true });
  assert.deepEqual([p.remove, p.removals, p.counts.delete], [[], [], 0]);
  assert.equal((await h.call('POST', `${P}/plans`, { to: 'test', from: 'test', selected: ['teams/Ops'], restore: true, remove: [OLD] })).status, 400);
});

test('after removing an entry, the next snapshot reports no drift for its item; nor after restoring it from the backup', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const KAPP = 'kapps/services/kapp';
  const ENTRY = `${KAPP}#categories/old-hardware`;
  // Test's kapp keeps what is written to its categories.
  let cats: Array<Record<string, unknown>> = [{ slug: 'old-hardware', name: 'Old Hardware' }];
  h.spaces.test = () => {
    const r = testRoutes();
    const kapp = (r['GET core/kapps/services'] as { kapp: Record<string, unknown> }).kapp;
    return {
      ...r,
      'GET core/kapps/services': () => ({ kapp: { ...kapp, categories: structuredClone(cats) } }),
      'DELETE core/kapps/services/categories/old-hardware': () => { cats = cats.filter((c) => c.slug !== 'old-hardware'); return {}; },
      'POST core/kapps/services/categories': ({ body }: { body: Record<string, unknown> }) => { cats = [...cats, body]; return {}; },
    };
  };
  // The kapp was promoted before, so its state is recorded.
  const first = await plan(h, { to: 'test', from: 'dev', selected: [KAPP] });
  assert.equal((await h.job('POST', `${P}/plans/${first.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result.status, 'applied');
  assert.deepEqual((await h.job('POST', `${P}/snapshots`, { env: 'test' })).result.drifted, []);

  const p = await plan(h, { to: 'test', from: 'dev', remove: [ENTRY] });
  const done = (await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(done.status, 'applied', String(done.error));
  assert.deepEqual(cats, []);
  assert.deepEqual((await h.job('POST', `${P}/snapshots`, { env: 'test' })).result.drifted, [], 'removing an entry is not drift');

  const rr = (await h.job('POST', `${P}/restore`, { commit: done.backupCommit })).result as CompareResult;
  assert.deepEqual(rr.preselected, [KAPP]);
  const rp = await plan(h, { to: 'test', from: 'test', sourceCommit: rr.sourceCommit, selected: rr.preselected, restore: true });
  const restored = (await h.job('POST', `${P}/plans/${rp.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(restored.status, 'applied', String(restored.error));
  assert.deepEqual((cats as Array<Record<string, unknown>>).map((c) => c.slug), ['old-hardware']);
  assert.deepEqual((await h.job('POST', `${P}/snapshots`, { env: 'test' })).result.drifted, [], 'a restore is not drift');
});

test('a Task category and a category member only in the target are removed, with no drift after; a restore puts both back', async (t) => {
  const h = await harness(t);
  const seed = (name: string, handlers: string[]) => ({ name, type: 'Stored', description: name, handlers: handlers.map((definitionId) => ({ definitionId })), trees: [] });
  const devCats = fakeTaskCategories([seed('Notifications', ['utilities_echo_v1'])]);
  const testCats = fakeTaskCategories([
    seed('Notifications', ['utilities_echo_v1', 'utilities_old_v1']), seed('Legacy', ['utilities_echo_v1']),
    { ...seed('Built In', ['system_join_v1']), type: 'Integrated' },
  ]);
  type Store = { handle: (api: string, method: string, path: string, opts?: { body?: unknown }) => unknown };
  // Routes for every Task categories call, answered by the stateful fake.
  const categoryRoutes = (store: Store) => {
    const r: Record<string, unknown> = {};
    const at = (method: string, p: string) => { r[`${method} task${p}`] = ({ body }: { body?: unknown }) => store.handle('task', method, p, { body }); };
    at('GET', '/categories');
    at('POST', '/categories');
    for (const name of ['Notifications', 'Legacy']) {
      for (const m of ['PUT', 'DELETE']) at(m, `/categories/${name}`);
      for (const f of ['handlers', 'routines']) {
        at('POST', `/categories/${name}/${f}`);
        for (const id of ['utilities_echo_v1', 'utilities_old_v1']) at('DELETE', `/categories/${name}/${f}/${id}`);
      }
    }
    return r;
  };
  h.spaces.dev = () => ({ ...devRoutes(), ...categoryRoutes(devCats) });
  h.spaces.test = () => ({ ...testRoutes(), ...categoryRoutes(testCats) });
  const NOTIFY = 'task-categories/Notifications';
  const ENTRY = `${NOTIFY}#handlers/utilities_old_v1`;
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  // Promoted before, so its state is recorded.
  const first = await plan(h, { to: 'test', from: 'dev', selected: [NOTIFY] });
  assert.equal(first.items.find((i) => i.key === NOTIFY)?.action, 'unchanged', 'a member only in Test is no difference');
  assert.equal((await h.job('POST', `${P}/plans/${first.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result.status, 'applied');

  const p = await plan(h, { to: 'test', from: 'dev', remove: ['task-categories/Legacy', ENTRY] });
  assert.deepEqual(p.removals.map((r) => [r.key, r.action]), [['task-categories/Legacy', 'delete'], [ENTRY, 'delete']]);
  const done = (await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(done.status, 'applied', String(done.error));
  assert.deepEqual(h.writes('test').slice(-2), ['DELETE /categories/Legacy', 'DELETE /categories/Notifications/handlers/utilities_old_v1']);
  const names = () => (testCats as { categories: Array<{ name: string; type: string; handlers: Array<{ definitionId: string }> }> }).categories
    .map((c) => [c.name, c.type, c.handlers.map((x) => x.definitionId)]);
  assert.deepEqual(names(), [['Notifications', 'Stored', ['utilities_echo_v1']], ['Built In', 'Integrated', ['system_join_v1']]], 'the built-in category stays');
  assert.deepEqual((await h.job('POST', `${P}/snapshots`, { env: 'test' })).result.drifted, [], 'removing a member is not drift');

  const rr = (await h.job('POST', `${P}/restore`, { commit: done.backupCommit })).result as CompareResult;
  assert.deepEqual([...rr.preselected].sort(), ['task-categories/Legacy', NOTIFY]);
  const rp = await plan(h, { to: 'test', from: 'test', sourceCommit: rr.sourceCommit, selected: rr.preselected, restore: true });
  const restored = (await h.job('POST', `${P}/plans/${rp.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result as ApplyResult;
  assert.equal(restored.status, 'applied', String(restored.error));
  assert.deepEqual(names(), [
    ['Notifications', 'Stored', ['utilities_echo_v1', 'utilities_old_v1']], ['Built In', 'Integrated', ['system_join_v1']], ['Legacy', 'Stored', ['utilities_echo_v1']],
  ]);
  assert.deepEqual((await h.job('POST', `${P}/snapshots`, { env: 'test' })).result.drifted, [], 'a restore is not drift');
});
