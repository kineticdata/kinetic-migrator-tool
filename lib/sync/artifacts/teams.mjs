// Teams (without memberships: users are not promoted).
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { listAll, enc } from './common.mjs';

export default {
  type: 'teams',
  scope: 'team',
  owns: (key) => /^teams\/[^/]+$/.test(key),
  namedCollections: [{ field: 'attributes', key: 'name' }],

  async list(client) {
    const teams = await listAll(client, 'core', '/teams', 'teams', { include: 'attributes' });
    return sortBy(teams).map((t) => {
      const data = stripMeta(omit(t, ['slug', 'memberships']));
      if (data.attributes) data.attributes = sortBy(data.attributes);
      return { key: keyFor('teams', t.name), data, meta: { slug: t.slug } };
    });
  },

  async apply(client, item) {
    if (item.existing) await client.request('core', 'PUT', `/teams/${enc(item.existing.meta.slug)}`, { body: item.desired });
    else await client.request('core', 'POST', '/teams', { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/teams/${enc(existing.meta.slug)}`);
  },
};
