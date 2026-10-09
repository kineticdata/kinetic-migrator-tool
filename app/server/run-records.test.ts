// lastPromoted reads a source item straight from a commit (not through a tree
// read), so it must strip credentials an older snapshot still holds: it feeds
// Compare's three-way view of a drifted item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitAll, ensureRepo } from './repo.ts';
import { lastPromoted, RUNS_DIR } from './run-records.ts';
import type { ProjectRef } from './project-meta.ts';

const PLANTED = 'Planted-Old-Db-Pa55';

test('lastPromoted strips a database password an older source snapshot holds', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'km-lastpromoted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await ensureRepo(dir);
  const key = 'connections/Warehouse DB/connection';
  const file = path.join(dir, 'snapshots', 'dev', 'connections', 'Warehouse DB', 'connection.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ id: 'c', name: 'Warehouse DB', type: 'postgres', config: { configType: 'postgres', host: 'db.example.com', password: PLANTED } }));
  const commit = await commitAll(dir, 'Snapshot of Dev', { name: 'Tester', email: 'tester@example.com' });
  assert.ok(commit);
  mkdirSync(path.join(dir, RUNS_DIR), { recursive: true });
  writeFileSync(path.join(dir, RUNS_DIR, 'r1.json'), JSON.stringify({
    id: 'r1', to: 'test', startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:01:00Z',
    source: { commit, path: 'snapshots/dev' }, items: [{ key, status: 'done' }],
  }));
  const last = await lastPromoted({ id: 'p', dir } as ProjectRef, 'test', key);
  assert.ok(last);
  assert.ok(!JSON.stringify(last).includes(PLANTED), JSON.stringify(last));
  assert.equal((last.data as any).config.host, 'db.example.com');
});
