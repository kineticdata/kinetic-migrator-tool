// Global routines from the Task API (the component path, `task` client:
// /app/components/task/app/api/v2; the /kinetic-task path silently drops a
// routine's inputs and outputs). A routine's tree title is its name.
// Created with POST /trees, updated with PUT /trees/{title} (the changed
// fields and the current versionId), deleted with DELETE /trees/{title}.
// Routines that call other routines are applied callees first (see order).
import { stripMeta, pick, sortBy, isEqual, compareText } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { enc } from './common.mjs';
import { referencedDefinitionIds } from './task-refs.mjs';

const PAGE = 100;
export const ROUTINE_FIELDS = ['name', 'definitionId', 'notes', 'status', 'inputs', 'outputs', 'treeJson'];
// What an update may send (the title, `name`, never changes).
const UPDATABLE = ['definitionId', 'notes', 'status', 'inputs', 'outputs', 'treeJson'];

export async function listTrees(client, type) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await client.get('task', '/trees', { type, include: 'treeJson,details', limit: PAGE, offset });
    const trees = (res?.trees ?? []).filter((t) => !type || t.type === undefined || t.type === type);
    out.push(...trees);
    if ((res?.trees ?? []).length < PAGE) return out;
  }
}

const unwrap = (r) => r?.tree ?? r;

// The current versionId of a routine (PUT needs it, as a string), read fresh
// so a concurrent edit does not make the update fail as a stale record.
async function currentVersion(client, title, fallback) {
  try {
    const v = unwrap(await client.get('task', `/trees/${enc(title)}`))?.versionId;
    if (v !== undefined && v !== null) return String(v);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return String(fallback ?? '0');
}

// Items (plan items or target-only entries) in dependency order: a routine
// comes after every routine it calls. Calls are read from treeJson by
// definitionId; cycles and calls to routines outside the list are ignored
// (ties and cycles fall back to key order). `reverse` gives callers first,
// for deletes.
export function orderRoutines(items, { reverse = false } = {}) {
  const dataOf = (i) => i.desired ?? i.existing?.data ?? i.data ?? {};
  const sorted = [...items].sort((a, b) => compareText(a.key, b.key));
  const byId = new Map(sorted.map((i) => [dataOf(i).definitionId, i]));
  const out = [];
  const state = new Map(); // key -> 'visiting' | 'done'
  const visit = (i) => {
    if (state.has(i.key)) return;
    state.set(i.key, 'visiting');
    for (const id of [...referencedDefinitionIds([{ data: dataOf(i) }])].sort()) {
      const dep = byId.get(id);
      if (dep && dep !== i && state.get(dep.key) !== 'visiting') visit(dep);
    }
    state.set(i.key, 'done');
    out.push(i);
  };
  for (const i of sorted) visit(i);
  return reverse ? out.reverse() : out;
}

export default {
  type: 'routines',
  scope: null,
  owns: (key) => /^routines\/[^/]+$/.test(key),
  order: orderRoutines,

  async list(client) {
    return sortBy(await listTrees(client, 'Global Routine')).map((t) => ({
      key: keyFor('routines', t.name),
      data: stripMeta(pick(t, ROUTINE_FIELDS)),
      meta: { title: t.title ?? t.name, ...(t.versionId !== undefined ? { versionId: String(t.versionId) } : {}) },
    }));
  },

  async apply(client, item) {
    const d = item.desired;
    if (!item.existing) {
      await client.request('task', 'POST', '/trees', {
        body: { sourceName: '-', sourceGroup: '-', type: 'Global Routine', ...pick(d, ROUTINE_FIELDS) },
      });
      return;
    }
    const cur = item.existing.data;
    const changed = UPDATABLE.filter((f) => f in d && !isEqual(d[f], cur[f]));
    if (!changed.length) return { skipped: true };
    const title = item.existing.meta?.title ?? cur.name;
    const versionId = await currentVersion(client, title, item.existing.meta?.versionId);
    await client.request('task', 'PUT', `/trees/${enc(title)}`, { body: { ...pick(d, changed), versionId } });
  },

  async prune(client, existing) {
    await client.request('task', 'DELETE', `/trees/${enc(existing.meta?.title ?? existing.data.name)}`);
  },
};
