// Reference-data submissions for forms allowlisted in kinetic-sync.config.json,
// matched across environments by their configured key fields.
import { isEqual, compareText } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { enc } from './common.mjs';

const PAGE = 25;

export function rowKey(values, keyFields) {
  return JSON.stringify(keyFields.map((f) => values?.[f] ?? null));
}

// Submissions come newest first. Cursor with `<=` on the last createdAt and
// de-duplicate by id so rows sharing a timestamp across pages are kept.
export async function walkSubmissions(client, kapp, form) {
  const seen = new Map();
  let last = null;
  for (;;) {
    const q = last ? `createdAt <= "${last}"` : undefined;
    const res = await client.get('core', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { include: 'details,values', limit: PAGE, orderBy: 'createdAt', direction: 'DESC', q });
    const page = res?.submissions ?? [];
    let fresh = 0;
    for (const s of page) if (!seen.has(s.id)) { seen.set(s.id, s); fresh++; }
    if (page.length < PAGE) break;
    if (fresh === 0) throw new Error(`${kapp}/${form}: more than ${PAGE} submissions share createdAt ${last}; cannot page reliably`);
    last = page[page.length - 1].createdAt;
  }
  return [...seen.values()];
}

const sortRows = (rows, keyFields) => [...rows].sort((a, b) => compareText(rowKey(a, keyFields), rowKey(b, keyFields)));
const formOf = (key) => { const p = key.split('/'); return { kapp: p[1], form: p[3] }; };

export default {
  type: 'data',
  scope: null,
  owns: (key) => /^kapps\/[^/]+\/forms\/[^/]+\/data$/.test(key),

  async list(client, ctx) {
    const out = [];
    for (const { kapp, form, key } of ctx.config.data) {
      let subs;
      try {
        subs = await walkSubmissions(client, kapp, form);
      } catch (e) {
        if (e.status === 404) continue;
        throw e;
      }
      const rows = new Map();
      const ids = {};
      for (const s of subs) {
        if (key.some((f) => s.values?.[f] === undefined || s.values[f] === null || s.values[f] === '')) {
          throw new Error(`${kapp}/${form}: submission ${s.id} has an empty key field (${key.join(', ')})`);
        }
        const k = rowKey(s.values, key);
        if (rows.has(k)) throw new Error(`${kapp}/${form}: duplicate key ${k} (submissions ${ids[k]} and ${s.id})`);
        rows.set(k, s.values);
        ids[k] = s.id;
      }
      out.push({ key: keyFor('kapps', kapp, 'forms', form, 'data'), data: { key, rows: sortRows([...rows.values()], key) }, meta: { ids } });
    }
    return out;
  },

  mergeTargetOnly(desired, existing) {
    if (!existing) return desired;
    const have = new Set(desired.rows.map((r) => rowKey(r, desired.key)));
    const extra = existing.rows.filter((r) => !have.has(rowKey(r, desired.key)));
    return extra.length ? { ...desired, rows: sortRows([...desired.rows, ...extra], desired.key) } : desired;
  },

  async apply(client, item, ctx) {
    const { kapp, form } = formOf(item.key);
    const keyFields = item.source.key;
    const ids = item.existing?.meta.ids ?? {};
    const current = new Map((item.existing?.data.rows ?? []).map((v) => [rowKey(v, keyFields), v]));
    for (const values of item.source.rows) {
      const k = rowKey(values, keyFields);
      if (!ids[k]) await client.request('core', 'POST', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { body: { values } });
      else if (!isEqual(current.get(k), values)) await client.request('core', 'PUT', `/submissions/${enc(ids[k])}`, { body: { values } });
    }
    if (ctx.prune.has('data')) {
      const wanted = new Set(item.source.rows.map((v) => rowKey(v, keyFields)));
      for (const [k, id] of Object.entries(ids)) {
        if (!wanted.has(k)) await client.request('core', 'DELETE', `/submissions/${enc(id)}`);
      }
    }
  },
};
