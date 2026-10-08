// Entries of an item's sub-collections (the space's attribute and security
// policy definitions; a kapp's attribute definitions, security policy
// definitions, form types, categories and integrations). Apply only creates
// and updates entries, and entries only in the target are kept (they never
// make an item differ). One can be removed on purpose: it is addressed as
// `<item key>#<collection>/<encoded name or slug>` (the name encoded like a
// key segment, see store.mjs), e.g. `kapps/services/kapp#categories/hardware`.
// A Task category's members are entries too, plain definitionIds (a spec
// without `key`): `task-categories/Notifications#handlers/mail_send_v1`.
import { compareText } from './normalize.mjs';
import { encodeSegment, segmentLabel } from './store.mjs';

// Only the space, kapps and Task categories have entries; other keys may
// contain '#' in a name. A category's name may contain '#' too (its key
// segment is the part before the last '#' that starts `<collection>/`).
const ENTRY = /^(space|kapps\/[^/#]+\/kapp|task-categories\/[^/]+)#([^/#]+)\/(.+)$/;
export const isEntryKey = (key) => ENTRY.test(String(key));

export const entryKey = (itemKey, field, name) => `${itemKey}#${field}/${encodeSegment(name)}`;

export function parseEntryKey(key) {
  const m = ENTRY.exec(String(key));
  return m ? { itemKey: m[1], field: m[2], segment: m[3] } : null;
}

// The spec of a module's sub-collection, or undefined.
export const collectionOf = (mod, field) => (mod?.subCollections ?? []).find((c) => c.field === field);

// An entry's name: its `key` field, or the entry itself (a plain id).
export const entryName = (spec, e) => (spec.key ? e?.[spec.key] : e);

// The entry of `data` a parsed key names (matched by encoded name, so names
// cut short in the key still match).
export function findEntry(data, spec, segment) {
  return (data?.[spec.field] ?? []).find((e) => e && encodeSegment(entryName(spec, e)) === segment) ?? null;
}

// Entries in the target's copy of an item that the source's copy does not have.
export function targetOnlyEntries(mod, itemKey, source, target) {
  const out = [];
  for (const spec of mod?.subCollections ?? []) {
    const have = new Set((source?.[spec.field] ?? []).map((e) => entryName(spec, e)));
    for (const e of target?.[spec.field] ?? []) {
      const name = entryName(spec, e);
      if (name === undefined || have.has(name)) continue;
      out.push({ key: entryKey(itemKey, spec.field, name), collection: spec.field, name: String(name) });
    }
  }
  return out.sort((a, b) => compareText(a.key, b.key));
}

// Words for collections, for messages.
const WORDS = {
  spaceAttributeDefinitions: 'space attribute definition',
  teamAttributeDefinitions: 'team attribute definition',
  userAttributeDefinitions: 'user attribute definition',
  userProfileAttributeDefinitions: 'user profile attribute definition',
  kappAttributeDefinitions: 'kapp attribute definition',
  formAttributeDefinitions: 'form attribute definition',
  categoryAttributeDefinitions: 'category attribute definition',
  securityPolicyDefinitions: 'security policy definition',
  formTypes: 'form type',
  categories: 'category',
  integrations: 'integration',
  handlers: 'handler',
  routines: 'routine',
};
export const collectionWord = (field) => WORDS[field] ?? field;

const q = (s) => `"${s}"`;
const hasAttr = (data, name) => (data?.attributes ?? []).some((a) => a?.name === name);
const usesPolicy = (data, name) => (data?.securityPolicies ?? []).some((p) => p?.name === name);
const definesPolicy = (data, name) => (data?.securityPolicyDefinitions ?? []).some((d) => d?.name === name);
const nameOf = (data, key) => data?.name ?? data?.slug ?? segmentLabel(key.split('/').filter((s) => !['kapp', 'form'].includes(s)).pop() ?? key);

// What in `world` (key -> data, the target as the plan leaves it) still uses
// an entry: attribute definitions set on items, categories assigned to forms,
// security policy definitions referenced by policies, form types used by
// forms. Users and user profiles are not exported, so their attribute
// definitions are never reported as in use; kapp integrations are not traced.
export function entryUsers(world, itemKey, field, name) {
  const out = [];
  const add = (key, reason) => out.push({ key, kind: 'uses', reason });
  const kappSlugKey = /^kapps\/([^/]+)\/kapp$/.exec(itemKey)?.[1];
  const inKapp = (k) => kappSlugKey !== undefined && k.startsWith(`kapps/${kappSlugKey}/forms/`) && k.endsWith('/form');
  for (const [key, data] of world) {
    const label = nameOf(data, key);
    if (itemKey === 'space') {
      if (field === 'spaceAttributeDefinitions' && key === 'space' && hasAttr(data, name)) add(key, `The space sets attribute ${q(name)}`);
      if (field === 'teamAttributeDefinitions' && key.startsWith('teams/') && hasAttr(data, name)) add(key, `Team ${q(label)} sets attribute ${q(name)}`);
      if (field === 'securityPolicyDefinitions' && usesPolicy(data, name)) {
        // A kapp's own definition of the same name wins for it and its forms.
        const kapp = /^kapps\/([^/]+)\//.exec(key)?.[1];
        if (kapp === undefined || !definesPolicy(world.get(`kapps/${kapp}/kapp`), name)) add(key, `${label} is secured by policy ${q(name)}`);
      }
      continue;
    }
    if (kappSlugKey === undefined) continue;
    if (field === 'kappAttributeDefinitions' && key === itemKey && hasAttr(data, name)) add(key, `Kapp ${q(label)} sets attribute ${q(name)}`);
    if (field === 'categoryAttributeDefinitions' && key === itemKey) {
      for (const c of data?.categories ?? []) if (hasAttr(c, name)) add(key, `Category ${q(c.name ?? c.slug)} sets attribute ${q(name)}`);
    }
    if (field === 'securityPolicyDefinitions' && (key === itemKey || inKapp(key)) && usesPolicy(data, name)) add(key, `${label} is secured by policy ${q(name)}`);
    if (!inKapp(key)) continue;
    if (field === 'formAttributeDefinitions' && hasAttr(data, name)) add(key, `Form ${q(label)} sets attribute ${q(name)}`);
    if (field === 'categories' && (data?.categorizations ?? []).some((c) => c?.category?.slug === name)) add(key, `Form ${q(label)} is in category ${q(name)}`);
    if (field === 'formTypes' && data?.type === name) add(key, `Form ${q(label)} is of type ${q(name)}`);
  }
  // One entry per user (the reasons of one item are joined).
  const byKey = new Map();
  for (const u of out) byKey.set(u.key, byKey.has(u.key) ? { ...u, reason: `${byKey.get(u.key).reason}; ${u.reason}` } : u);
  return [...byKey.values()].sort((a, b) => compareText(a.key, b.key));
}
