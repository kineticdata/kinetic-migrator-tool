// Space settings, attribute definitions and security policy definitions.
import { stripMeta, omit, sortBy, isEqual } from '../normalize.mjs';
import { spaceExport, upsertByName } from './common.mjs';

const DEFINITIONS = [
  'spaceAttributeDefinitions', 'teamAttributeDefinitions',
  'userAttributeDefinitions', 'userProfileAttributeDefinitions',
];
const NAMED = [...DEFINITIONS, 'securityPolicyDefinitions', 'attributes'];
// Exported as their own artifacts, or out of scope.
const NESTED = ['kapps', 'teams', 'models', 'webApis', 'webhooks'];
const NOT_SETTINGS = [...DEFINITIONS, 'securityPolicyDefinitions', 'slug'];

export default {
  type: 'space',
  scope: 'space',
  owns: (key) => key === 'space',
  namedCollections: [
    ...NAMED.map((field) => ({ field, key: 'name' })),
    { field: 'securityPolicies', key: 'endpoint' },
  ],

  async list(client, ctx) {
    const raw = await spaceExport(client, ctx);
    const data = stripMeta(omit(raw, ['oauthSigningKey', ...NESTED]));
    for (const f of NAMED) if (data[f]) data[f] = sortBy(data[f]);
    if (data.securityPolicies) data.securityPolicies = sortBy(data.securityPolicies, 'endpoint');
    return [{ key: 'space', data, meta: {} }];
  },

  async apply(client, item) {
    const d = item.desired;
    const cur = item.existing?.data ?? {};
    for (const f of DEFINITIONS) await upsertByName(client, 'core', `/${f}`, d[f], cur[f]);
    await upsertByName(client, 'core', '/securityPolicyDefinitions', d.securityPolicyDefinitions, cur.securityPolicyDefinitions);
    const settings = omit(d, NOT_SETTINGS);
    if (isEqual(settings, omit(cur, NOT_SETTINGS))) return;
    if (isEqual(settings.platformComponents, cur.platformComponents)) delete settings.platformComponents;
    await client.request('core', 'PUT', '/space', { body: settings });
  },
};
