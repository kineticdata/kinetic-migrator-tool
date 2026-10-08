// Form definitions (pages, fields, integrations, index definitions, policies).
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { kappExports, isFormExcluded, buildChangedIndexes, enc } from './common.mjs';

export function normalizeForm(raw) {
  const f = stripMeta(raw);
  for (const k of ['attributes', 'bridgedResources', 'integrations']) if (f[k]) f[k] = sortBy(f[k]);
  if (f.indexDefinitions) f.indexDefinitions = sortBy(f.indexDefinitions.map((d) => omit(d, ['status'])));
  if (f.securityPolicies) f.securityPolicies = sortBy(f.securityPolicies, 'endpoint');
  if (f.categorizations) f.categorizations = sortBy(f.categorizations, (c) => c.category?.slug);
  return f;
}

const kappSlugOf = (key) => key.split('/')[1];

export default {
  type: 'forms',
  scope: 'form',
  owns: (key) => /^kapps\/[^/]+\/forms\/[^/]+\/form$/.test(key),
  namedCollections: [
    { field: 'attributes', key: 'name' },
    { field: 'bridgedResources', key: 'name' },
    { field: 'integrations', key: 'name' },
    { field: 'indexDefinitions', key: 'name' },
    { field: 'securityPolicies', key: 'endpoint' },
  ],

  async list(client, ctx) {
    const out = [];
    for (const kapp of await kappExports(client, ctx)) {
      for (const form of sortBy(kapp.forms, 'slug')) {
        if (isFormExcluded(ctx, kapp.slug, form.slug)) continue;
        out.push({ key: keyFor('kapps', kapp.slug, 'forms', form.slug, 'form'), data: normalizeForm(form), meta: { kappSlug: kapp.slug } });
      }
    }
    return out;
  },

  async apply(client, item) {
    const base = `/kapps/${enc(kappSlugOf(item.key))}/forms`;
    const path = `${base}/${enc(item.desired.slug)}`;
    if (item.existing) await client.request('core', 'PUT', path, { body: item.desired });
    else await client.request('core', 'POST', base, { body: item.desired });
    await buildChangedIndexes(client, path, item.desired.indexDefinitions, item.existing?.data.indexDefinitions);
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/kapps/${enc(kappSlugOf(existing.key))}/forms/${enc(existing.data.slug)}`);
  },
};
