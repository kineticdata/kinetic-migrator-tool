// Bridge models. PUT is a full replace, so the whole definition is sent.
import { stripMeta, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { spaceExport, enc } from './common.mjs';

export default {
  type: 'models',
  scope: null,
  owns: (key) => /^models\/[^/]+$/.test(key),
  namedCollections: ['attributes', 'qualifications', 'mappings'].map((field) => ({ field, key: 'name' })),

  async list(client, ctx) {
    const space = await spaceExport(client, ctx);
    return sortBy(space.models).map((m) => {
      const data = stripMeta(m);
      for (const f of ['attributes', 'qualifications', 'mappings']) if (data[f]) data[f] = sortBy(data[f]);
      return { key: keyFor('models', m.name), data, meta: {} };
    });
  },

  async apply(client, item) {
    const { name, status } = item.desired;
    if (!item.existing) await client.request('core', 'POST', '/models', { body: { name, status } });
    await client.request('core', 'PUT', `/models/${enc(name)}`, { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/models/${enc(existing.data.name)}`);
  },
};
