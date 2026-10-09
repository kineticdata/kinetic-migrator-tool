// Run records: runs/<stamp>-<target>.json, one per apply, committed. Read by
// History, by drift's three-way view (what was last promoted) and by restore.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '../shared/sync-api.ts';
import { readJsonAt } from './pinned.ts';
import { projectRepo } from './project-repo.ts';
import type { ProjectRef } from './project-meta.ts';

export const RUNS_DIR = 'runs';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function readRun(ref: ProjectRef, id: string): RunRecord | null {
  if (!RUN_ID.test(id)) return null;
  const file = path.join(ref.dir, RUNS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

// Newest first.
export function listRuns(ref: ProjectRef): RunRecord[] {
  const dir = path.join(ref.dir, RUNS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readRun(ref, f.slice(0, -'.json'.length)))
    .filter((r): r is RunRecord => r !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

// The item as last promoted into `env`: the source content of the newest run
// that wrote it, read at that run's pinned source commit.
export async function lastPromoted(ref: ProjectRef, env: string, key: string): Promise<{ data: unknown; at: string } | null> {
  for (const run of listRuns(ref)) {
    if (run.to !== env || !run.source.commit) continue;
    if (!run.items.some((i) => i.key === key && i.status === 'done')) continue;
    const data = await readJsonAt(await projectRepo(ref), run.source.commit, `${run.source.path}/${key}.json`);
    if (data !== undefined) return { data, at: run.finishedAt };
  }
  return null;
}
