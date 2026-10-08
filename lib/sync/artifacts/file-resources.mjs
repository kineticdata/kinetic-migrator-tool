// File resources (external file read paths).
import { stripMeta, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { enc, listAll } from './common.mjs';

export default {
  type: 'file-resources',
  scope: null,
  owns: (key) => /^file-resources\/[^/]+$/.test(key),

  async list(client) {
    const all = await listAll(client, 'core', '/fileResources', 'fileResources');
    return sortBy(all, 'slug').map((f) => ({ key: keyFor('file-resources', f.slug), data: stripMeta(f), meta: {} }));
  },

  async apply(client, item) {
    if (item.existing) await client.request('core', 'PUT', `/fileResources/${enc(item.desired.slug)}`, { body: item.desired });
    else await client.request('core', 'POST', '/fileResources', { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/fileResources/${enc(existing.data.slug)}`);
  },
};
