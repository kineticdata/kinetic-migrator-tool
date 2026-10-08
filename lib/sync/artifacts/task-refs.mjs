// Which handlers and routines the exported workflows, WebAPIs and routines
// depend on, so the plan can fail early when a target is missing one.
import { enc, isBuiltInHandler } from './common.mjs';
import { keyFor } from '../store.mjs';
import { listTrees } from './routines.mjs';

export function referencedDefinitionIds(artifacts) {
  const ids = new Set();
  for (const { data } of artifacts) {
    for (const n of data?.treeJson?.nodes ?? []) if (n.definitionId) ids.add(n.definitionId);
    if (typeof data?.treeXml === 'string') {
      for (const m of data.treeXml.matchAll(/definition_id="([^"]+)"/g)) ids.add(m[1]);
    }
  }
  return ids;
}

export function classifyRefs(ids, routineIds) {
  const handlers = [];
  const routines = [];
  for (const id of [...ids].sort()) {
    if (id.startsWith('system_')) continue;
    (routineIds.has(id) ? routines : handlers).push(id);
  }
  return { handlers, routines };
}

export default {
  type: 'task-refs',
  scope: null,
  applyable: false,
  owns: (key) => key === 'task-refs',

  // Must run after every other module: it reads what they collected.
  async list(client, ctx) {
    const collected = ctx.collected ?? [];
    const routineIds = new Set(collected.filter((a) => a.key.startsWith('routines/')).map((a) => a.data.definitionId));
    return [{ key: 'task-refs', data: classifyRefs(referencedDefinitionIds(collected), routineIds), meta: {} }];
  },

  async preflight(client, exported) {
    const refs = exported.get('task-refs');
    const errors = [];
    if (!refs) return { errors, warnings: [] };
    for (const id of refs.handlers) {
      // Built-ins exist everywhere; exported handlers are installed by apply.
      if (isBuiltInHandler(id) || exported.has(keyFor('handlers', id, 'handler'))) continue;
      try {
        await client.get('task', `/handlers/${enc(id)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        errors.push(`Handler ${id} is used by exported workflows but is not installed in the target`);
      }
    }
    // Exported routines are created by apply (and a selection that leaves a
    // needed one out is reported by the plan's own dependency check), so only
    // routines that are not in the export are looked up.
    const exportedRoutines = new Set([...exported].filter(([k]) => k.startsWith('routines/')).map(([, d]) => d?.definitionId));
    const wanted = refs.routines.filter((id) => !exportedRoutines.has(id));
    const present = wanted.length ? new Set((await listTrees(client, 'Global Routine')).map((t) => t.definitionId)) : new Set();
    for (const id of wanted) {
      if (!present.has(id)) errors.push(`Routine ${id} is used by exported workflows but does not exist in the target`);
    }
    return { errors, warnings: [] };
  },
};
