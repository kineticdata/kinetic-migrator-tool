// Kapp settings plus the kapp-scoped collections the Core API manages
// through their own endpoints.
import { stripMeta, omit, sortBy, isEqual } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { kappExports, upsertByName, buildChangedIndexes, enc } from './common.mjs';

// Sub-collections with their own endpoints, in creation order, and their keys.
const SUB = [
  ['kappAttributeDefinitions', 'name'],
  ['formAttributeDefinitions', 'name'],
  ['categoryAttributeDefinitions', 'name'],
  ['securityPolicyDefinitions', 'name'],
  ['formTypes', 'name'],
  ['categories', 'slug'],
  ['integrations', 'name'],
];
const SUB_FIELDS = SUB.map(([f]) => f);
const NESTED = ['forms', 'webApis', 'webhooks'];

export function normalizeKapp(raw) {
  const k = stripMeta(omit(raw, NESTED));
  for (const [f, key] of SUB) if (k[f]) k[f] = sortBy(k[f], key);
  for (const f of ['attributes', 'fields']) if (k[f]) k[f] = sortBy(k[f]);
  if (k.indexDefinitions) k.indexDefinitions = sortBy(k.indexDefinitions.map((d) => omit(d, ['status'])));
  if (k.securityPolicies) k.securityPolicies = sortBy(k.securityPolicies, 'endpoint');
  return k;
}

export default {
  type: 'kapps',
  scope: 'kapp',
  owns: (key) => /^kapps\/[^/]+\/kapp$/.test(key),
  namedCollections: [
    ...SUB.map(([field, key]) => ({ field, key })),
    { field: 'attributes', key: 'name' },
    { field: 'fields', key: 'name' },
    { field: 'indexDefinitions', key: 'name' },
    { field: 'securityPolicies', key: 'endpoint' },
  ],

  async list(client, ctx) {
    return (await kappExports(client, ctx)).map((k) => ({
      key: keyFor('kapps', k.slug, 'kapp'), data: normalizeKapp(k), meta: {},
    }));
  },

  async apply(client, item) {
    const d = item.desired;
    const cur = item.existing?.data ?? {};
    const base = `/kapps/${enc(d.slug)}`;
    let subCur = cur;
    if (!item.existing) {
      await client.request('core', 'POST', '/kapps', { body: { slug: d.slug, name: d.name } });
      // A new kapp comes with platform defaults (e.g. an "Admins" security
      // policy definition); update those instead of POSTing duplicates.
      subCur = normalizeKapp((await client.get('core', base, { export: 'true' }))?.kapp ?? {});
    }
    for (const [f, key] of SUB) await upsertByName(client, 'core', `${base}/${f}`, d[f], subCur[f], key);
    const settings = omit(d, SUB_FIELDS);
    if (!item.existing || !isEqual(settings, omit(cur, SUB_FIELDS))) {
      await client.request('core', 'PUT', base, { body: settings });
    }
    await buildChangedIndexes(client, base, d.indexDefinitions, cur.indexDefinitions);
  },

  // Deleting a kapp deletes its forms and submissions. Only via --prune kapps.
  async prune(client, existing) {
    await client.request('core', 'DELETE', `/kapps/${enc(existing.data.slug)}`);
  },
};
