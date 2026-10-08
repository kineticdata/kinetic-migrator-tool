// Saved changesets: create (pinned to the snapshot commit), list, update, delete; one commit each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Changeset } from '../shared/sync-api.ts';
import { log } from './repo.ts';
import { assertNoSecret, harness } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const FORM = 'kapps/services/forms/it-request/form';

test('changesets CRUD, pinned to the source snapshot commit, committed per change', async (t) => {
  const h = await harness(t);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'Q4', from: 'dev', keys: [FORM] })).status, 404, 'no snapshot yet');
  const snap = (await h.job('POST', `${P}/snapshots`, { env: 'dev' })).result;
  const count = async () => (await log(h.dir, { limit: 1000 })).length;
  let n = await count();

  const created = await h.call('POST', `${P}/changesets`, { name: 'Q4 forms', description: 'IT request changes', from: 'dev', keys: [FORM, FORM] });
  assert.equal(created.status, 201, created.body);
  const cs = created.json as Changeset;
  assert.match(cs.id, /^q4-forms-[0-9a-f]{6}$/);
  assert.equal(cs.sourceCommit, snap.commit);
  assert.deepEqual(cs.keys, [FORM]);
  assert.deepEqual(cs.appliedTo, []);
  assert.ok(existsSync(path.join(h.dir, 'changesets', `${cs.id}.json`)));
  assert.equal(await count(), ++n);
  assert.match((await log(h.dir, { limit: 1 }))[0].message, /^Saved changeset 'Q4 forms'/);

  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: ['teams/Nobody'] })).status, 400);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [] })).status, 400);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: '', from: 'dev', keys: [FORM] })).status, 400);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [FORM], sourceCommit: 'deadbeef' })).status, 400);
  assert.equal((await h.call('POST', `${P}/changesets`, { name: 'x', from: 'dev', keys: [FORM], extra: 1 })).status, 400);

  const list = (await h.call('GET', `${P}/changesets`)).json as Changeset[];
  assert.deepEqual(list.map((c) => c.id), [cs.id]);
  const updated = await h.call('PUT', `${P}/changesets/${cs.id}`, { name: 'Q4 forms v2', keys: [FORM, 'teams/Ops'] });
  assert.equal(updated.status, 200, updated.body);
  assert.deepEqual((updated.json as Changeset).keys, [FORM, 'teams/Ops']);
  assert.equal((updated.json as Changeset).sourceCommit, snap.commit);
  assert.equal(await count(), ++n);
  assert.equal(JSON.parse(readFileSync(path.join(h.dir, 'changesets', `${cs.id}.json`), 'utf8')).name, 'Q4 forms v2');
  assert.equal((await h.call('PUT', `${P}/changesets/${cs.id}`, { from: 'test' })).status, 400);

  assert.equal((await h.call('DELETE', `${P}/changesets/${cs.id}`)).status, 200);
  assert.equal(await count(), ++n);
  assert.equal((await h.call('GET', `${P}/changesets/${cs.id}`)).status, 404);
  assert.equal((await h.call('GET', `${P}/changesets/..`)).status, 404);
  assertNoSecret(h);
});
