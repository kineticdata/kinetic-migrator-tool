// WebAPIs (definition + tree) at space and kapp scope, via export/import.
import { stripMeta, sortBy } from '../normalize.mjs';
import { keyFor, keySegment } from '../store.mjs';
import { spaceExport, kappExports, enc } from './common.mjs';

const kappOf = (key) => (key.startsWith('kapps/') ? keySegment(key, 1) : null);
const unwrap = (r) => stripMeta(r?.webApi ?? r);

export default {
  type: 'webapis',
  scope: null,
  owns: (key) => /^(kapps\/[^/]+\/)?webapis\/[^/]+$/.test(key),

  async list(client, ctx) {
    const out = [];
    for (const w of sortBy((await spaceExport(client, ctx)).webApis, 'slug')) {
      out.push({ key: keyFor('webapis', w.slug), data: unwrap(await client.get('core', `/webApis/${enc(w.slug)}/export`)), meta: {} });
    }
    for (const kapp of await kappExports(client, ctx)) {
      for (const w of sortBy(kapp.webApis, 'slug')) {
        const r = await client.get('core', `/kapps/${enc(kapp.slug)}/webApis/${enc(w.slug)}/export`);
        out.push({ key: keyFor('kapps', kapp.slug, 'webapis', w.slug), data: unwrap(r), meta: {} });
      }
    }
    return out;
  },

  async apply(client, item, ctx) {
    const kapp = kappOf(item.key);
    const path = kapp ? `/kapps/${enc(kapp)}/webApiImport` : '/webApiImport';
    try {
      await client.request('core', 'POST', path, { query: { force: 'true' }, body: item.desired });
    } catch (e) {
      if (kapp || e.status !== 404) throw e;
      ctx.warn(`${item.key}: this server has no space WebAPI import endpoint; recreate it by hand from its snapshot file`);
      return { skipped: true };
    }
  },

  async prune(client, existing) {
    const kapp = kappOf(existing.key);
    const path = kapp ? `/kapps/${enc(kapp)}/webApis/${enc(existing.data.slug)}` : `/webApis/${enc(existing.data.slug)}`;
    await client.request('core', 'DELETE', path);
  },
};
