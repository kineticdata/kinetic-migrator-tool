// Compare (preview, raw, against snapshots) and dependency suggestions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompareItem, CompareResult, CompareTreeNode, SuggestionOut } from '../shared/sync-api.ts';
import { assertNoSecret, harness, type Harness } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const FORM = 'kapps/services/forms/it-request/form';
const OP = 'connections/Ticketing/operations/Create Ticket';
const CONN = 'connections/Ticketing/connection';

async function snapshots(h: Harness) {
  for (const env of ['dev', 'test']) assert.equal((await h.job('POST', `${P}/snapshots`, { env })).status, 'succeeded');
}

test('preview compare: tree with statuses and rolled-up counts, item diff, suggestions with reasons', async (t) => {
  const h = await harness(t);
  await snapshots(h);
  const job = await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.match(job.events, /event: progress/);
  const r = job.result as CompareResult;
  assert.equal(r.fromName, 'Dev');
  assert.ok(r.sourceCommit);
  assert.equal(r.counts.new, 3, JSON.stringify(r.counts)); // connection, operation, handler
  assert.ok((r.counts.changed ?? 0) >= 2); // form, team (space name is env-bound)
  assert.deepEqual(h.writes(), [], 'compare never writes');

  const roots = (await h.call('GET', `${P}/compare/${r.compareId}/tree`)).json as CompareTreeNode[];
  const kapps = roots.find((n) => n.id === 'group:kapps')!;
  assert.deepEqual(kapps.counts, { changed: 1, same: 2 });
  const conns = (await h.call('GET', `${P}/compare/${r.compareId}/tree?parent=group%3Aconnections`)).json as CompareTreeNode[];
  assert.deepEqual([conns[0].status, conns[0].counts], ['new', { new: 1 }]);

  const item = (await h.call('GET', `${P}/compare/${r.compareId}/item?key=${encodeURIComponent(FORM)}`)).json as CompareItem;
  assert.equal(item.status, 'changed');
  assert.ok(item.diff.some((d) => d.path.startsWith('integrations')));
  assert.equal((item.current as any).slug, 'it-request');
  assert.equal((await h.call('GET', `${P}/compare/${r.compareId}/item?key=nope`)).status, 404);

  const sug = (await h.call('POST', `${P}/compare/${r.compareId}/suggestions`, { selected: [FORM] })).json as SuggestionOut[];
  assert.deepEqual(sug.map((s) => s.key), [CONN, OP]);
  const op = sug.find((s) => s.key === OP)!;
  assert.equal(op.reason, 'IT Request calls operation "Create Ticket" on connection "Ticketing", which is new in Dev');
  assert.equal(op.forKey, FORM);
  assert.deepEqual((await h.call('POST', `${P}/compare/${r.compareId}/suggestions`, { selected: [FORM, OP, CONN] })).json, []);
  assert.equal((await h.call('POST', `${P}/compare/${r.compareId}/suggestions`, { selected: 'x' })).status, 400);
  assert.equal((await h.call('GET', `${P}/compare/nope/tree`)).status, 404);
  assertNoSecret(h);
});

test('raw compare over both snapshots and preview against the target snapshot', async (t) => {
  const h = await harness(t);
  await snapshots(h);
  const raw = await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'raw' });
  assert.equal(raw.status, 'succeeded', JSON.stringify(raw.error));
  assert.match(raw.events, /"phase":"compare"/);
  const rr = raw.result as CompareResult;
  // Raw shows the env-bound space name difference that preview hides.
  const space = (await h.call('GET', `${P}/compare/${rr.compareId}/item?key=space`)).json as CompareItem;
  assert.equal(space.status, 'changed');
  // `from` is the target's value and `to` the incoming one, as in preview.
  assert.deepEqual(space.diff.find((d) => d.path === 'name'), { path: 'name', from: 'Test Space', to: 'Dev Space' });

  const fast = await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview', useSnapshots: true });
  const fr = fast.result as CompareResult;
  assert.equal(fr.counts.new, 3);
  const spaceP = (await h.call('GET', `${P}/compare/${fr.compareId}/item?key=space`)).json as CompareItem;
  assert.equal(spaceP.status, 'same');

  // A pinned source: the snapshot of From at a given commit.
  const pinned = await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview', useSnapshots: true, sourceCommit: fr.sourceCommit });
  assert.equal(pinned.status, 'succeeded', JSON.stringify(pinned.error));
  assert.equal((pinned.result as CompareResult).sourceCommit, fr.sourceCommit);
  assert.deepEqual((pinned.result as CompareResult).counts, fr.counts);
  assert.equal((await h.call('POST', `${P}/compare`, { from: 'dev', to: 'test', sourceCommit: 'zz' })).status, 400);

  assert.equal((await h.call('POST', `${P}/compare`, { from: 'dev', to: 'dev' })).status, 400);
  assert.equal((await h.call('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'x' })).status, 400);
  assert.equal((await h.call('POST', `${P}/compare`, { from: 'prod', to: 'test' })).status, 404, 'no snapshot of prod');
  assertNoSecret(h);
});
