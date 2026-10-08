// Snapshots and Explore through the API, against fake Dev/Test spaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ExploreItem, SearchResponse, SnapshotResult, TreeNode } from '../shared/sync-api.ts';
import { log, readTreeAt } from './repo.ts';
import { PLANTED, assertNoSecret, harness } from './sync-fixtures.ts';
import { setEnvSecret } from './environments.ts';
import { SEARCH_LIMIT, search } from './explore.ts';
import { snapshotFrom } from './snapshots.ts';

const P = '/api/projects/sync-test';

test('snapshot → commit, explore tree (lazy), item, search; no secret anywhere', async (t) => {
  const h = await harness(t);
  assert.equal((await h.call('GET', `${P}/explore/dev/tree`)).status, 404, 'no snapshot yet');

  const snap = await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  assert.equal(snap.status, 'succeeded', JSON.stringify(snap.error));
  const r = snap.result as SnapshotResult;
  assert.equal(r.env, 'dev');
  assert.ok(r.commit);
  assert.ok(r.total >= 6);
  assert.match(snap.events, /event: progress/);
  assert.deepEqual(h.writes(), [], 'a snapshot never writes to the environment');
  assert.ok(existsSync(path.join(h.dir, 'snapshots', 'dev', 'space.json')));
  const head = (await log(h.dir, { limit: 1 }))[0];
  assert.equal(head.oid, r.commit);
  assert.match(head.message, /^Snapshot of Dev\n\nEnvironment: dev$/);
  const project = (await h.call('GET', P)).json;
  assert.equal(project.environments.find((e: any) => e.name === 'dev').lastSnapshot.commit, r.commit);

  const roots = (await h.call('GET', `${P}/explore/dev/tree`)).json as TreeNode[];
  assert.deepEqual(roots.map((n) => n.label), ['Dev Space', 'Kapps', 'Connections', 'Handlers', 'Teams']);
  const kapps = roots.find((n) => n.id === 'group:kapps')!;
  assert.equal(kapps.count, 3);
  const [services] = (await h.call('GET', `${P}/explore/dev/tree?parent=${encodeURIComponent(kapps.id)}`)).json as TreeNode[];
  assert.deepEqual([services.key, services.label, services.kind, services.hasChildren], ['kapps/services/kapp', 'Services', 'kapp', true]);
  const groups = (await h.call('GET', `${P}/explore/dev/tree?parent=${encodeURIComponent(services.id)}`)).json as TreeNode[];
  assert.deepEqual(groups.map((g) => [g.label, g.count]), [['Forms', 2]]);
  const forms = (await h.call('GET', `${P}/explore/dev/tree?parent=${encodeURIComponent(groups[0].id)}`)).json as TreeNode[];
  assert.deepEqual(forms.map((f) => f.label), ['IT Request', 'Leave Request']);
  assert.equal((await h.call('GET', `${P}/explore/dev/tree?parent=nope`)).status, 404);
  const conns = (await h.call('GET', `${P}/explore/dev/tree?parent=group%3Aconnections`)).json as TreeNode[];
  assert.deepEqual(conns.map((c) => [c.label, c.count]), [['Ticketing', 1]]);

  // Item: summary with has-flags from the store, relationships, JSON, history.
  await setEnvSecret(h.store, { id: 'sync-test', dir: h.dir }, 'dev', 'secret', 'TICKETING__PASSWORD', PLANTED);
  const conn = (await h.call('GET', `${P}/explore/dev/item?key=${encodeURIComponent('connections/Ticketing/connection')}`)).json as ExploreItem;
  assert.equal(conn.type, 'connections');
  const auth = conn.summary.sections.find((s) => s.heading === 'Authentication')!;
  assert.deepEqual(auth.rows!.find((x) => x.label === 'password')!.value, '•••• set');
  assert.deepEqual(conn.relationships.usedBy.map((e) => e.key).sort(), ['connections/Ticketing/operations/Create Ticket', 'kapps/services/forms/it-request/form']);
  assert.equal(conn.history.length, 1);
  assert.equal(conn.history[0].commit, r.commit);

  const formItem = (await h.call('GET', `${P}/explore/dev/item?key=${encodeURIComponent('kapps/services/forms/it-request/form')}`)).json as ExploreItem;
  assert.equal(formItem.label, 'IT Request');
  assert.ok(JSON.stringify(formItem.summary).includes('Ticketing › Create Ticket'));
  assert.deepEqual(formItem.relationships.uses.map((e) => e.label).sort(), ['Create Ticket', 'Services', 'Ticketing']);
  assert.equal((formItem.json as any).slug, 'it-request');

  const handler = (await h.call('GET', `${P}/explore/dev/item?key=${encodeURIComponent('handlers/mail_send_v1/handler')}`)).json as ExploreItem;
  const settings = handler.summary.sections.find((s) => s.heading === 'Settings')!;
  assert.equal(settings.rows!.find((x) => x.label === 'Password')!.value, 'not set');

  assert.equal((await h.call('GET', `${P}/explore/dev/item?key=nope`)).status, 404);
  assert.equal((await h.call('GET', `${P}/explore/dev/item`)).status, 400);
  assert.equal((await h.call('GET', `${P}/explore/ghost/tree`)).status, 404);

  // Search by name, slug and field name, case-insensitively.
  const s1 = (await h.call('GET', `${P}/search/dev?q=it%20req`)).json as SearchResponse;
  assert.deepEqual(s1.results.map((x) => [x.key, x.match]), [['kapps/services/forms/it-request/form', 'name']]);
  const s2 = (await h.call('GET', `${P}/search/dev?q=ASSET`)).json as SearchResponse;
  assert.deepEqual(s2.results.map((x) => [x.label, x.match, x.field]), [['IT Request', 'field', 'Asset Tag']]);
  const s3 = (await h.call('GET', `${P}/search/dev?q=mail_send`)).json as SearchResponse;
  assert.deepEqual(s3.results.map((x) => x.match), ['slug']);

  // A second, identical snapshot changes nothing and makes no commit.
  const again = await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  assert.equal(again.result.commit, null);
  // Nothing secret in any response or in the repository.
  assertNoSecret(h);
  const tree = await readTreeAt(h.dir, head.oid, '');
  assert.ok(!JSON.stringify([...tree]).includes(PLANTED));
});

test('snapshot of an unknown environment → 404; without credentials → 400', async (t) => {
  const h = await harness(t, { dev: true } as any);
  assert.equal((await h.call('POST', `${P}/snapshots`, { env: 'ghost' })).status, 404);
  await h.call('PUT', `${P}/environments/bare`, { url: 'https://bare.example.com' });
  assert.equal((await h.call('POST', `${P}/snapshots`, { env: 'bare' })).status, 400);
});

test('search is capped at 200 results', () => {
  const artifacts = new Map<string, unknown>();
  for (let i = 0; i < 250; i++) artifacts.set(`teams/Team ${i}`, { name: `Team ${i}` });
  const res = search(snapshotFrom('dev', 'c', '/nowhere', artifacts), 'team');
  assert.equal(res.results.length, SEARCH_LIMIT);
  assert.equal(res.truncated, true);
});
