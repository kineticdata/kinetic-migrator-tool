// Task categories (Task API, `task` client). A handler or routine that is in
// no category does not appear in the workflow builder, so a promoted handler
// or routine is only usable there once its categories come along.
//
// Only 'Stored' categories are exported and promoted; 'Integrated' ones are
// built into the platform and never touched. Names are not unique across the
// two types (a built-in and a Stored category may share one), so the listing
// is filtered by type. A category's data is its name, description, the
// definitionIds of its handlers and routines (the listing shows routines
// under `trees`) and, for information only, its policy rule names: Task
// policy rules are not migrated.
//
// Calls (verified live):
// - GET /categories?include=details,handlers,trees
// - POST /categories { name, description, type: 'Stored' } (no member lists)
// - POST /categories/{name}/handlers { definitionId }
// - POST /categories/{name}/routines { definitionId } (/trees does not exist)
// - DELETE /categories/{name}/handlers/{id}, /routines/{id}, /categories/{name}
// - PUT /categories/{name} { name, description }, description changes only.
//   NEVER send `handlers`, `trees`, `routines` or `policyRules` in a PUT: a
//   `trees` list silently clears the category's routines, and objects in a
//   list fail with a 500.
//
// Membership is additive: members only in the target are kept (they are no
// difference), and a member is only added when it is in the target, or is
// created by the same run; otherwise the plan warns and leaves it out.
import { compareText } from '../normalize.mjs';
import { keyFor, keySegment } from '../store.mjs';
import { enc, isBuiltInHandler } from './common.mjs';
import { listTrees } from './routines.mjs';

const INCLUDE = 'details,handlers,trees';
export const MEMBERS = ['handlers', 'routines'];
const KIND = { handlers: 'handler', routines: 'routine' };
const ids = (list) => [...new Set((list ?? []).filter((x) => x !== undefined && x !== null && x !== '').map(String))].sort(compareText);

// Every category, of both types (none on a Task API without the endpoint).
export async function listCategories(client) {
  try {
    return (await client.get('task', '/categories', { include: INCLUDE }))?.categories ?? [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

export const isStored = (c) => c?.type === 'Stored';

// definitionId of a category's `trees` entry: its own when listed, else the
// routine of that title or name (from the routines already collected, or the
// routines list when one is not among them).
async function routineIdOf(client, ctx, categories) {
  const byName = new Map();
  const learn = (t) => {
    if (!t?.definitionId) return;
    if (t.name) byName.set(t.name, t.definitionId);
    if (t.title) byName.set(t.title, t.definitionId);
  };
  for (const a of ctx?.collected ?? []) {
    if (a.key.startsWith('routines/')) learn({ ...a.data, title: a.meta?.title });
  }
  const unknown = categories.flatMap((c) => c.trees ?? []).some((t) => !t?.definitionId && !byName.has(t?.title ?? t?.name));
  if (unknown) for (const t of await listTrees(client, 'Global Routine', 'details')) learn(t);
  return (t) => t?.definitionId ?? byName.get(t?.title) ?? byName.get(t?.name);
}

export function normalizeCategory(raw, routineId = (t) => t?.definitionId) {
  return {
    name: raw.name,
    description: raw.description ?? '',
    handlers: ids((raw.handlers ?? []).map((h) => h?.definitionId ?? h)),
    routines: ids((raw.trees ?? raw.routines ?? []).map((t) => (typeof t === 'string' ? t : routineId(t)))),
    policyRules: ids((raw.policyRules ?? []).map((r) => r?.name ?? r)),
  };
}

// Target-only members are kept; policy rules are never carried, so the
// target's stand (they are never a difference).
export function mergeCategory(desired, existing) {
  if (!existing || !desired) return desired;
  const out = { ...desired };
  for (const f of MEMBERS) out[f] = ids([...(desired[f] ?? []), ...(existing[f] ?? [])]);
  out.policyRules = existing.policyRules ?? [];
  return out;
}

// Members the target lacks (and that this run does not create) are left out
// of the desired category, each with a warning; so are policy rules the
// target lacks (never carried). `has(kind, id)`: whether a handler or routine
// is in the target after this run's creates. `source`: the source's copy
// (before the target's policy rules were merged in).
export function availableOnly(desired, existing, { key, has, targetName = 'the target', source = desired }) {
  const warnings = [];
  if (!desired) return { desired, warnings };
  const out = { ...desired };
  for (const f of MEMBERS) {
    const have = new Set(existing?.[f] ?? []);
    out[f] = (desired[f] ?? []).filter((id) => {
      if (have.has(id) || has(KIND[f], id)) return true;
      warnings.push(`${key}: ${id} is not in ${targetName}; promote it to add it to the category`);
      return false;
    });
  }
  const lacking = (source?.policyRules ?? []).filter((r) => !(existing?.policyRules ?? []).includes(r));
  if (lacking.length) warnings.push(`${key}: its policy rules (${lacking.join(', ')}) are not carried; set them in ${targetName}`);
  return { desired: out, warnings };
}

// Handlers named by exported categories that the target has installed but
// does not list (a handler in no category is missing from GET /handlers).
async function installedHandlers(client, exported, target) {
  const wanted = new Set();
  for (const [k, d] of exported) {
    if (!/^task-categories\/[^/]+$/.test(k)) continue;
    for (const id of d?.handlers ?? []) {
      if (!isBuiltInHandler(id) && !target.has(keyFor('handlers', id, 'handler'))) wanted.add(id);
    }
  }
  const found = [];
  for (const id of [...wanted].sort(compareText)) {
    try {
      await client.get('task', `/handlers/${enc(id)}`);
      found.push(id);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return { installedHandlers: found };
}

const categoryPath = (name) => `/categories/${enc(name)}`;

export default {
  type: 'task-categories',
  scope: null,
  owns: (key) => /^task-categories\/[^/]+$/.test(key),
  mergeTargetOnly: mergeCategory,
  wholeLists: MEMBERS,
  availableOnly,
  planInputs: installedHandlers,
  // Members are entries: `task-categories/<name>#handlers/<definitionId>`.
  subCollections: MEMBERS.map((field) => ({ field, key: null })),
  entryApi: 'task',
  entryPath: (itemKey, field, entry) => `${categoryPath(entry?.itemName ?? keySegment(itemKey, 1))}/${field}`,

  // Lists after routines (to name the routines of each category).
  async list(client, ctx) {
    const stored = (await listCategories(client)).filter(isStored);
    const routineId = await routineIdOf(client, ctx, stored);
    return stored
      .map((c) => ({ key: keyFor('task-categories', c.name), data: normalizeCategory(c, routineId), meta: { name: c.name } }))
      .sort((a, b) => compareText(a.key, b.key));
  },

  async apply(client, item) {
    const d = item.desired;
    const cur = item.existing?.data ?? null;
    const path = categoryPath(d.name);
    let wrote = false;
    if (!cur) {
      // Members are added one by one below, never as lists.
      await client.request('task', 'POST', '/categories', { body: { name: d.name, description: d.description ?? '', type: 'Stored' } });
      wrote = true;
    } else if ((d.description ?? '') !== (cur.description ?? '')) {
      // Only name and description: member lists in a PUT clear or break the
      // category's members (see the top of this file).
      await client.request('task', 'PUT', path, { body: { name: d.name, description: d.description ?? '' } });
      wrote = true;
    }
    for (const f of MEMBERS) {
      const have = new Set(cur?.[f] ?? []);
      for (const id of d[f] ?? []) {
        if (have.has(id)) continue;
        await client.request('task', 'POST', `${path}/${f}`, { body: { definitionId: id } });
        wrote = true;
      }
    }
    return wrote ? undefined : { skipped: true };
  },

  async prune(client, existing) {
    await client.request('task', 'DELETE', categoryPath(existing.meta?.name ?? existing.data.name));
  },
};
