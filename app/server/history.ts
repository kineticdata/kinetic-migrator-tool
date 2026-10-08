// History: the repository log as plain events (snapshot, changeset, applied,
// backup, restore, drift, project), read from commit titles and trailers and
// enriched from run records. Restore starts a comparison with a backup (or
// any snapshot commit) as the source and the live target as To, pre-ticking
// the items the apply that took that backup touched.
import fs from 'node:fs';
import git from 'isomorphic-git';
import type { HistoryDetail, HistoryEvent, HistoryType } from '../shared/sync-api.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { startCompare } from './compare.ts';
import { resolveCommit } from './pinned.ts';
import { isPlainObject, type ProjectRef } from './project-meta.ts';
import { log, readTreeAt, type LogEntry } from './repo.ts';
import type { Router } from './router.ts';
import { listRuns, readRun } from './run-records.ts';
import { requireEnvironment, type SyncContext } from './snapshots.ts';
import { parseMessage } from './trailers.ts';

const TYPES: HistoryType[] = ['snapshot', 'changeset', 'applied', 'backup', 'restore', 'drift', 'project'];
// The whole log: backups and runs of any age must stay findable.
const ALL = Number.MAX_SAFE_INTEGER;

export function typeOf(title: string): HistoryType {
  if (/^Snapshot of /.test(title)) return 'snapshot';
  if (/^Backup of /.test(title)) return 'backup';
  if (/^(Saved|Updated|Deleted) changeset /.test(title)) return 'changeset';
  if (/^(Applied|Partly applied|Failed to apply|Cancelled applying) /.test(title)) return 'applied';
  if (/^(Removed|Partly removed|Failed to remove|Cancelled removing) /.test(title)) return 'applied';
  if (/^(Restored|Partly restored|Failed to restore) /.test(title)) return 'restore';
  return 'project';
}

export function eventsFor(ref: ProjectRef, entry: LogEntry): HistoryEvent[] {
  const { title, body, trailers } = parseMessage(entry.message);
  const type = typeOf(title);
  const runId = trailers.Run ?? null;
  const run = runId ? readRun(ref, runId) : null;
  const drifted = /^Drifted: /.test(body) ? body.split('\n').slice(1).filter(Boolean) : [];
  const base: HistoryEvent = {
    id: entry.oid, commit: entry.oid, type, title, at: entry.at, author: entry.author.name,
    env: trailers.Environment ?? null, runId, changesetId: trailers.Changeset ?? null, status: run?.status ?? null, drifted,
  };
  const out = [base];
  if (type === 'snapshot' && drifted.length) {
    out.push({ ...base, id: `${entry.oid}:drift`, type: 'drift', title: `Drift detected in ${title.slice('Snapshot of '.length).replace(/ after .*$/, '')}: ${drifted.length} item(s) changed since the last promotion` });
  }
  return out;
}

export async function history(ref: ProjectRef, filter: { env?: string | null; type?: string | null }): Promise<HistoryEvent[]> {
  if (filter.type && !TYPES.includes(filter.type as HistoryType)) throw badRequest(`"type" is one of ${TYPES.join(', ')}.`);
  const entries = await log(ref.dir, { limit: ALL });
  return entries.flatMap((e) => eventsFor(ref, e))
    .filter((e) => (!filter.env || e.env === filter.env) && (!filter.type || e.type === filter.type));
}

async function findEntry(ref: ProjectRef, commit: string): Promise<LogEntry> {
  const oid = await resolveCommit(ref.dir, commit);
  if (!oid) throw notFound('No such commit in this project.');
  const { commit: c } = await git.readCommit({ fs, dir: ref.dir, oid });
  return {
    oid,
    message: c.message.replace(/\n$/, ''),
    at: new Date(c.author.timestamp * 1000).toISOString(),
    author: { name: c.author.name, email: c.author.email },
  };
}

export function registerHistoryRoutes(router: Router, ctx: SyncContext): void {
  router.get('/api/projects/:p/history', async ({ params, query }) => (
    { json: await history(ctx.find(params.p), { env: query.get('env'), type: query.get('type') }) }
  ));

  router.get('/api/projects/:p/history/:commit', async ({ params }) => {
    const ref = ctx.find(params.p);
    const [event] = eventsFor(ref, await findEntry(ref, params.commit));
    const detail: HistoryDetail = { event, run: event.runId ? readRun(ref, event.runId) : null };
    return { json: detail };
  });

  router.post('/api/projects/:p/restore', async ({ params, body }) => {
    const ref = ctx.find(params.p);
    if (!isPlainObject(body) || typeof body.commit !== 'string') throw badRequest('Give the commit of the backup to restore.');
    const mode = body.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'raw') throw badRequest('"mode" is "preview" or "raw".');
    const entry = await findEntry(ref, body.commit);
    const { trailers } = parseMessage(entry.message);
    const type = typeOf(parseMessage(entry.message).title);
    if ((type !== 'backup' && type !== 'snapshot') || !trailers.Environment) {
      throw new ApiError(400, 'not_a_backup', 'Only a backup or snapshot can be restored.');
    }
    const env = requireEnvironment(ref, trailers.Environment);
    const artifacts = await readTreeAt(ref.dir, entry.oid, `snapshots/${env}`);
    if (!artifacts.size) throw new ApiError(404, 'no_snapshot', 'This commit holds no snapshot to restore.');
    const touched = listRuns(ref).find((r) => r.backupCommit === entry.oid);
    const day = entry.at.slice(0, 16).replace('T', ' ');
    const jobId = await startCompare(ctx, ref, {
      from: env, fromName: `the ${type} of ${day}`, to: env, mode, liveTarget: true,
      source: { artifacts, commit: entry.oid },
      // Run records keep the keys of their day; an older backup is re-keyed.
      preselected: touched ? touched.items.filter((i) => i.status === 'done').map((i) => artifacts.rekeyed?.get(i.key) ?? i.key) : [],
    });
    return { status: 202, json: { jobId } };
  });
}
