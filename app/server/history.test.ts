// History events, drift (snapshot drift + three-way view) and restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompareItem, CompareResult, HistoryDetail, HistoryEvent } from '../shared/sync-api.ts';
import { PLANTED, assertNoSecret, harness, testRoutes } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const TEAM = 'teams/Ops';

test('history events, drift with a three-way view, and restore from a backup', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const cs = (await h.call('POST', `${P}/changesets`, { name: 'Team text', from: 'dev', keys: [TEAM] })).json;
  const plan = (await h.job('POST', `${P}/plans`, { to: 'test', changesetId: cs.id })).result;
  const applied = (await h.job('POST', `${P}/plans/${plan.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result;
  assert.equal(applied.status, 'applied');

  // Someone edits the team in Test after the promotion.
  h.spaces.test = () => ({ ...testRoutes(), 'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'Edited in test' }] } });
  const snap = (await h.job('POST', `${P}/snapshots`, { env: 'test' })).result;
  assert.deepEqual(snap.drifted, [TEAM]);

  const all = (await h.call('GET', `${P}/history`)).json as HistoryEvent[];
  assert.deepEqual(all.slice(0, 6).map((e) => [e.type, e.env]), [
    ['snapshot', 'test'], ['drift', 'test'], ['applied', 'test'], ['backup', 'test'], ['changeset', 'dev'], ['snapshot', 'dev'],
  ]);
  const appliedEvent = all.find((e) => e.type === 'applied')!;
  assert.deepEqual([appliedEvent.runId, appliedEvent.status, appliedEvent.changesetId], [applied.runId, 'applied', cs.id]);
  assert.deepEqual(all.find((e) => e.type === 'drift')!.drifted, [TEAM]);
  assert.equal(all[all.length - 1].type, 'project');
  const onlyDev = (await h.call('GET', `${P}/history?env=dev`)).json as HistoryEvent[];
  assert.ok(onlyDev.length >= 2 && onlyDev.every((e) => e.env === 'dev'));
  const backups = (await h.call('GET', `${P}/history?type=backup`)).json as HistoryEvent[];
  assert.deepEqual(backups.map((e) => e.commit), [applied.backupCommit]);
  assert.equal((await h.call('GET', `${P}/history?type=nope`)).status, 400);
  const detail = (await h.call('GET', `${P}/history/${appliedEvent.commit}`)).json as HistoryDetail;
  assert.equal(detail.run?.id, applied.runId, JSON.stringify(detail));
  assert.equal((await h.call('GET', `${P}/history/0000000`)).status, 404);

  // Compare shows the drift, with what was last promoted.
  const cmp = (await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' })).result as CompareResult;
  const item = (await h.call('GET', `${P}/compare/${cmp.compareId}/item?key=${encodeURIComponent(TEAM)}`)).json as CompareItem;
  assert.equal(item.status, 'drifted');
  assert.equal((item.threeWay!.lastPromoted as any).description, 'Operations (dev)');
  assert.equal((item.threeWay!.target as any).description, 'Edited in test');
  assert.equal((item.threeWay!.incoming as any).description, 'Operations (dev)');
  assert.ok(item.threeWay!.lastPromotedAt);
  assert.deepEqual(item.threeWay!.targetChanges, [{ path: 'description', from: 'Operations (dev)', to: 'Edited in test' }]);

  // Restore: compare the backup (From) with live Test, pre-ticking what the apply touched.
  const restore = await h.job('POST', `${P}/restore`, { commit: applied.backupCommit });
  assert.equal(restore.status, 'succeeded', JSON.stringify(restore.error));
  const rr = restore.result as CompareResult;
  assert.deepEqual(rr.preselected, [TEAM]);
  assert.equal(rr.sourceCommit, applied.backupCommit);
  assert.match(rr.fromName, /^the backup of /);
  const back = (await h.call('GET', `${P}/compare/${rr.compareId}/item?key=${encodeURIComponent(TEAM)}`)).json as CompareItem;
  assert.equal((back.incoming as any).description, 'Operations');
  assert.equal((await h.call('POST', `${P}/restore`, { commit: appliedEvent.commit })).status, 400);

  const rp = (await h.job('POST', `${P}/plans`, { to: 'test', from: 'test', sourceCommit: rr.sourceCommit, selected: rr.preselected, restore: true, resolutions: { [TEAM]: 'overwrite' } })).result;
  assert.deepEqual(rp.needsAttention.map((n: any) => n.id), [`drift:${TEAM}`]);
  const noAck = await h.call('POST', `${P}/plans/${rp.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(noAck.json.error.code, 'acknowledgement_required');
  const done = (await h.job('POST', `${P}/plans/${rp.planId}/apply`, { acknowledgements: [`drift:${TEAM}`], confirm: 'test' })).result;
  assert.equal(done.status, 'applied', done.error);
  const last = h.calls.filter((c) => c.method === 'PUT' && c.path === '/teams/ops').pop()!;
  assert.equal((last.body as any).description, 'Operations');
  const latest = ((await h.call('GET', `${P}/history`)).json as HistoryEvent[])[0];
  assert.deepEqual([latest.type, latest.title], ['restore', 'Restored Test from a backup']);
  assertNoSecret(h);
  assert.ok(!h.bodies.join('').includes(PLANTED));
});
