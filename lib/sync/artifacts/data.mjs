// Reference-data submissions for forms allowlisted in kinetic-sync.config.json.
// An entry may narrow the records with a filter (Field = Value conditions,
// all of which must hold) and names the fields that identify a record across
// environments (`key`). Without key fields a target record stands for a
// source record when it has every value the source record has (see
// matchesRecord), each target record stands for at most one source record
// (so identical source records need as many target records), an edited
// record is a new one, and nothing is ever updated or deleted.
import { isEqual, compareText, stableStringify } from '../normalize.mjs';
import { keyFor, keySegment } from '../store.mjs';
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

const isEmptyValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// Keyless matching: every field of the source record has an equal value in
// the target record. Fields only the target has (or that its form defaults)
// are ignored; an empty source value matches an absent or empty target one.
export function matchesRecord(source, target) {
  return Object.entries(source ?? {}).every(([f, v]) => (isEmptyValue(v) ? isEmptyValue(target?.[f]) : isEqual(v, target?.[f])));
}

// Pairs source records with target records, one target record per source
// record at most (exact matches first, so a looser match cannot take the
// target record an identical source record needs). Returns the target index
// for each source record, or -1 when the target lacks it.
export function matchKeyless(sourceRows, targetRows) {
  const taken = new Set();
  const out = sourceRows.map(() => -1);
  const pass = (accept) => sourceRows.forEach((s, i) => {
    if (out[i] !== -1) return;
    const j = targetRows.findIndex((t, k) => !taken.has(k) && accept(s, t));
    if (j !== -1) { taken.add(j); out[i] = j; }
  });
  pass((s, t) => isEqual(s, t));
  pass(matchesRecord);
  return out;
}

// A list value (checkboxes) matches when it contains the filter value.
function matchesValue(actual, wanted) {
  return Array.isArray(actual) ? actual.includes(wanted) : actual === wanted;
}
export function matchesFilter(values, filter) {
  return (filter ?? []).every(({ field, value }) => matchesValue(values?.[field], value));
}

// An entry's key and filter in a comparable form (conditions are ANDed, so
// their order does not matter; key order does, as it shapes rowKey).
const normFilter = (filter) => [...(filter ?? [])]
  .map(({ field, value }) => ({ field, value }))
  .sort((a, b) => compareText(`${a.field}\0${a.value}`, `${b.field}\0${b.value}`));
const settingsOf = (x) => ({ key: x?.key ?? [], filter: normFilter(x?.filter) });

export function dataEntryFor(config, artifactKey) {
  const { kapp, form } = formOf(artifactKey);
  return (config?.data ?? []).find((d) => d.kapp === kapp && d.form === form);
}

// Data read with other settings (key fields or filter) than the config holds
// now cannot be applied safely: its rows and keys would be matched against a
// target read differently (duplicates, or prune deleting kept rows).
export function dataSettingsErrors(artifactKey, { source, target, config, sourceName = 'the source', targetName = 'the target' }) {
  const { kapp, form } = formOf(artifactKey);
  const entry = dataEntryFor(config, artifactKey);
  const errors = [];
  if (!entry) {
    errors.push(`${kapp}/${form}: no longer in the reference-data settings — take a new snapshot of ${sourceName}`);
    return errors;
  }
  const want = settingsOf(entry);
  const changed = `${kapp}/${form}: reference-data settings changed since the snapshot of`;
  if (source && !isEqual(settingsOf(source), want)) errors.push(`${changed} ${sourceName} was taken — take a new snapshot`);
  if (target && !isEqual(settingsOf(target), want)) errors.push(`${changed} ${targetName} was taken — take a new snapshot`);
  return errors;
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
const formOf = (key) => ({ kapp: keySegment(key, 1), form: keySegment(key, 3) });

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
      // Keyless: every record is kept, identical ones too (each needs its own
      // target record).
      const all = [];
      for (const s of subs) {
        if (!matchesFilter(s.values, filter)) continue;
        if (key.some((f) => s.values?.[f] === undefined || s.values[f] === null || s.values[f] === '')) {
          throw new Error(`${kapp}/${form}: submission ${s.id} has an empty key field (${key.join(', ')})`);
        }
        if (isKeyless(key)) { all.push(s.values); continue; }
        const k = recordId(s.values, key);
        if (rows.has(k)) {
          throw new Error(`${kapp}/${form}: duplicate key ${k} (submissions ${ids[k]} and ${s.id})`);
        }
        rows.set(k, s.values);
        ids[k] = s.id;
      }
      out.push({ key: keyFor('kapps', kapp, 'forms', form, 'data'), data: { key, rows: sortRows(isKeyless(key) ? all : [...rows.values()], key), ...(filter?.length ? { filter: normFilter(filter) } : {}) }, meta: { ids } });
    }
    return out;
  },

  // Keyless: a source record the target already has is shown as the target's
  // record, so target-only fields never appear as a change; only records to
  // create differ.
  mergeTargetOnly(desired, existing) {
    if (!existing) return desired;
    if (isKeyless(desired.key)) {
      const pairs = matchKeyless(desired.rows, existing.rows);
      const missing = desired.rows.filter((_, i) => pairs[i] === -1);
      return missing.length ? { ...desired, rows: sortRows([...existing.rows, ...missing], desired.key) } : { ...desired, rows: existing.rows };
    }
    const have = new Set(desired.rows.map((r) => recordId(r, desired.key)));
    const extra = existing.rows.filter((r) => !have.has(recordId(r, desired.key)));
    return extra.length ? { ...desired, rows: sortRows([...desired.rows, ...extra], desired.key) } : desired;
  },

  async apply(client, item, ctx) {
    const { kapp, form } = formOf(item.key);
    const keyFields = item.source.key;
    if (isKeyless(keyFields)) {
      // Create only what the target lacks; never update or delete (not even
      // with --prune data).
      const pairs = matchKeyless(item.source.rows, item.existing?.data.rows ?? []);
      for (const [i, values] of item.source.rows.entries()) {
        if (pairs[i] === -1) await client.request('core', 'POST', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { body: { values } });
      }
      return;
    }
    const ids = item.existing?.meta.ids ?? {};
    const current = new Map((item.existing?.data.rows ?? []).map((v) => [recordId(v, keyFields), v]));
    for (const values of item.source.rows) {
      const k = recordId(values, keyFields);
      if (!ids[k]) await client.request('core', 'POST', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { body: { values } });
      else if (!isEqual(current.get(k), values)) await client.request('core', 'PUT', `/submissions/${enc(ids[k])}`, { body: { values } });
    }
    if (ctx.prune.has('data')) {
      const wanted = new Set(item.source.rows.map((v) => recordId(v, keyFields)));
      for (const [k, id] of Object.entries(ids)) {
        if (!wanted.has(k)) await client.request('core', 'DELETE', `/submissions/${enc(id)}`);
      }
    }
  },
};
