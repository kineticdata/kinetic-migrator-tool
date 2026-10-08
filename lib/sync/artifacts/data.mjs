// Reference-data submissions for forms allowlisted in kinetic-sync.config.json.
// An entry may narrow the records with a filter (Field = Value conditions,
// all of which must hold) and names the fields that identify a record across
// environments (`key`). Without key fields a record is identified by all of
// its values: identical records count as one, an edited record is a new one,
// and nothing is ever updated or deleted.
import { isEqual, compareText, stableStringify } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { enc } from './common.mjs';

const PAGE = 25;

export function rowKey(values, keyFields) {
  return JSON.stringify(keyFields.map((f) => values?.[f] ?? null));
}

// What identifies a record: its key fields, or (no key fields) every value.
export const isKeyless = (keyFields) => !Array.isArray(keyFields) || keyFields.length === 0;
export function recordId(values, keyFields) {
  return isKeyless(keyFields) ? JSON.stringify(JSON.parse(stableStringify(values ?? {}))) : rowKey(values, keyFields);
}

// A list value (checkboxes) matches when it contains the filter value.
function matchesValue(actual, wanted) {
  return Array.isArray(actual) ? actual.includes(wanted) : actual === wanted;
}
export function matchesFilter(values, filter) {
  return (filter ?? []).every(({ field, value }) => matchesValue(values?.[field], value));
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A description of what is wrong with the config's `data` list, or null.
export function dataConfigError(entries) {
  if (!Array.isArray(entries)) return '"data" must be a list of reference-data entries.';
  for (const [i, d] of entries.entries()) {
    const at = `Reference-data entry ${i + 1}`;
    if (!isPlain(d)) return `${at} must be an object.`;
    const extra = Object.keys(d).find((k) => !['kapp', 'form', 'key', 'filter'].includes(k));
    if (extra) return `${at}: unknown field "${extra}" (allowed: kapp, form, key, filter).`;
    if (!isText(d.kapp) || !isText(d.form)) return `${at} needs a kapp and a form.`;
    if (d.key !== undefined && (!Array.isArray(d.key) || !d.key.every(isText))) {
      return `${at}: "key" must be a list of field names (leave it out to match records by all their values).`;
    }
    if (d.filter !== undefined) {
      if (!Array.isArray(d.filter)) return `${at}: "filter" must be a list of { field, value } conditions.`;
      for (const [j, c] of d.filter.entries()) {
        const ok = isPlain(c) && Object.keys(c).every((k) => k === 'field' || k === 'value') && isText(c.field) && isText(c.value);
        if (!ok) return `${at}: filter condition ${j + 1} needs a field and a value.`;
      }
    }
  }
  return null;
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

const sortRows = (rows, keyFields) => [...rows].sort((a, b) => compareText(recordId(a, keyFields), recordId(b, keyFields)));
const formOf = (key) => { const p = key.split('/'); return { kapp: p[1], form: p[3] }; };

export default {
  type: 'data',
  scope: null,
  owns: (key) => /^kapps\/[^/]+\/forms\/[^/]+\/data$/.test(key),

  // Submissions outside the entry's filter are left out on both sides, so the
  // target's other records are never compared, updated or deleted.
  async list(client, ctx) {
    const out = [];
    for (const { kapp, form, key: given, filter } of ctx.config.data) {
      const key = given ?? [];
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
        if (!matchesFilter(s.values, filter)) continue;
        if (key.some((f) => s.values?.[f] === undefined || s.values[f] === null || s.values[f] === '')) {
          throw new Error(`${kapp}/${form}: submission ${s.id} has an empty key field (${key.join(', ')})`);
        }
        const k = recordId(s.values, key);
        if (rows.has(k)) {
          // Identical records (no key fields) count as one.
          if (isKeyless(key)) continue;
          throw new Error(`${kapp}/${form}: duplicate key ${k} (submissions ${ids[k]} and ${s.id})`);
        }
        rows.set(k, s.values);
        ids[k] = s.id;
      }
      out.push({ key: keyFor('kapps', kapp, 'forms', form, 'data'), data: { key, rows: sortRows([...rows.values()], key) }, meta: { ids } });
    }
    return out;
  },

  mergeTargetOnly(desired, existing) {
    if (!existing) return desired;
    const have = new Set(desired.rows.map((r) => recordId(r, desired.key)));
    const extra = existing.rows.filter((r) => !have.has(recordId(r, desired.key)));
    return extra.length ? { ...desired, rows: sortRows([...desired.rows, ...extra], desired.key) } : desired;
  },

  async apply(client, item, ctx) {
    const { kapp, form } = formOf(item.key);
    const keyFields = item.source.key;
    const ids = item.existing?.meta.ids ?? {};
    const current = new Map((item.existing?.data.rows ?? []).map((v) => [recordId(v, keyFields), v]));
    for (const values of item.source.rows) {
      const k = recordId(values, keyFields);
      if (!ids[k]) await client.request('core', 'POST', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { body: { values } });
      else if (!isKeyless(keyFields) && !isEqual(current.get(k), values)) await client.request('core', 'PUT', `/submissions/${enc(ids[k])}`, { body: { values } });
    }
    // Without key fields a record cannot be told apart from an edited one, so
    // nothing is deleted even with --prune data.
    if (ctx.prune.has('data') && !isKeyless(keyFields)) {
      const wanted = new Set(item.source.rows.map((v) => recordId(v, keyFields)));
      for (const [k, id] of Object.entries(ids)) {
        if (!wanted.has(k)) await client.request('core', 'DELETE', `/submissions/${enc(id)}`);
      }
    }
  },
};
