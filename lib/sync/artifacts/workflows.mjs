// Core workflows at space, kapp and form scope. Matched across environments by
// scope + event + name; never by UUID (platformItemId differs per environment).
import { stripMeta, pick, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { kappExports, isFormExcluded, enc } from './common.mjs';

const PORTABLE = ['name', 'event', 'filter', 'status', 'notes', 'ownerEmail', 'treeJson'];

export function normalizeWorkflow(raw) {
  const w = raw?.workflow ?? raw;
  if (!w.treeJson) throw new Error(`Workflow "${w.name}" (${w.event}) came back without treeJson`);
  return stripMeta(pick(w, PORTABLE));
}

export function workflowBase(key) {
  const p = key.split('/');
  if (p[0] === 'workflows') return '/workflows';
  if (p[2] === 'workflows') return `/kapps/${enc(p[1])}/workflows`;
  return `/kapps/${enc(p[1])}/forms/${enc(p[3])}/workflows`;
}

const ofType = (type) => (w) => w.platformItemType === undefined || w.platformItemType === type;
const sorted = (list) => sortBy(list, (w) => `${w.event}\u0000${w.name}`);

export default {
  type: 'workflows',
  scope: null,
  owns: (key) => /^(workflows|kapps\/[^/]+\/workflows|kapps\/[^/]+\/forms\/[^/]+\/workflows)\/[^/]+\/[^/]+$/.test(key),

  async list(client, ctx) {
    const out = [];
    const add = (prefix, w, id) => out.push({ key: keyFor(...prefix, w.event, w.name), data: normalizeWorkflow(w), meta: { id } });
    // List endpoints may ignore include=treeJson; fetch the single workflow when it is missing.
    const full = async (base, w) => (w.treeJson ? w : (await client.get('core', `${base}/${enc(w.id)}`)));
    const space = await client.get('core', '/workflows', { include: 'treeJson' });
    for (const w of sorted(space?.workflows).filter(ofType('Space'))) add(['workflows'], await full('/workflows', w), w.id);
    for (const kapp of await kappExports(client, ctx)) {
      const k = enc(kapp.slug);
      const kw = await client.get('core', `/kapps/${k}/workflows`, { include: 'treeJson' });
      for (const w of sorted(kw?.workflows).filter(ofType('Kapp'))) add(['kapps', kapp.slug, 'workflows'], await full(`/kapps/${k}/workflows`, w), w.id);
      for (const form of sortBy(kapp.forms, 'slug')) {
        if (isFormExcluded(ctx, kapp.slug, form.slug)) continue;
        const base = `/kapps/${k}/forms/${enc(form.slug)}/workflows`;
        // The form-level list ignores include=treeJson; fetch each one.
        for (const summary of sorted((await client.get('core', base))?.workflows)) {
          const full = await client.get('core', `${base}/${enc(summary.id)}`);
          add(['kapps', kapp.slug, 'forms', form.slug, 'workflows'], full.workflow ?? full, summary.id);
        }
      }
    }
    return out;
  },

  async apply(client, item) {
    const base = workflowBase(item.key);
    let id = item.existing?.meta.id;
    if (!id) {
      const { treeJson, ...props } = item.desired;
      const created = await client.request('core', 'POST', base, { body: props });
      id = (created?.workflow ?? created).id;
    }
    // Always the scoped path: the flat /workflows/{id} PUT ignores `filter`.
    await client.request('core', 'PUT', `${base}/${enc(id)}`, { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `${workflowBase(existing.key)}/${enc(existing.meta.id)}`);
  },
};
