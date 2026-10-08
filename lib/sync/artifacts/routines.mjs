// Global routines from the Task API. Exported for reference and checked for
// presence in the target; not created by apply.
import { stripMeta, pick, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';

const PAGE = 100;

export async function listTrees(client, type) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await client.get('task', '/trees', { type, include: 'treeJson,details', limit: PAGE, offset });
    const trees = res?.trees ?? [];
    out.push(...trees);
    if (trees.length < PAGE) return out;
  }
}

export default {
  type: 'routines',
  scope: null,
  applyable: false,
  owns: (key) => /^routines\/[^/]+$/.test(key),

  async list(client) {
    return sortBy(await listTrees(client, 'Global Routine')).map((t) => ({
      key: keyFor('routines', t.name),
      data: stripMeta(pick(t, ['name', 'definitionId', 'notes', 'status', 'inputs', 'outputs', 'treeJson'])),
      meta: {},
    }));
  },
};
