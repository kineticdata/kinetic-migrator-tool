// Pure helpers that turn platform responses into canonical, comparable JSON.
import { createHash } from 'node:crypto';
import { isSecretProperty } from './secrets.mjs';
import { envBoundNames, itemIdentity, nestedIdentity, DEFAULT_ENV_BOUND_SPACE_FIELDS, canonicalSpaceFields } from './env-bound.mjs';

// Server-managed audit fields. Never meaningful when comparing environments.
export const META_KEYS = new Set([
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'insertedAt', 'lockVersion',
]);

// Fields that describe where an environment lives, not what it is configured
// to do. Never copied from the source; the target keeps its own values.
export const ENV_BOUND_FIELDS = {
  space: ['name', 'slug', 'platformComponents', 'bundlePath', 'sharedBundleBase'],
  kapp: ['bundlePath'],
};

// Every environment-bound field of `scope`: the fixed ones plus, for the
// space, the project's chosen settings (config.envBoundSpaceFields).
export function envBoundFields(scope, spaceFields = DEFAULT_ENV_BOUND_SPACE_FIELDS) {
  const fixed = ENV_BOUND_FIELDS[scope] ?? [];
  return scope === 'space' ? [...fixed, ...spaceFields] : fixed;
}

// No value: undefined, null, '' or []. false and 0 are values.
export const isEmptyValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// Collections inside an artifact whose items carry their own attributes.
export const NESTED_ATTRIBUTE_SCOPES = {
  kapp: [{ field: 'categories', key: 'slug', scope: 'category' }],
};

export function stripMeta(value) {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!META_KEYS.has(k)) out[k] = stripMeta(v);
    return out;
  }
  return value;
}

export function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

// Locale-independent ordering so every machine sorts exports identically.
export function compareText(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sortBy(arr, key = 'name') {
  const get = typeof key === 'function' ? key : (x) => x?.[key];
  return [...(arr ?? [])].sort((a, b) => compareText(get(a), get(b)));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function isEqual(a, b) {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

export function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// Scopes whose `properties[].value` is environment-bound (handler settings
// such as SMTP servers differ per environment).
const PROPERTY_VALUE_SCOPES = new Set(['handler']);

function dropAttributes(attrs, names) {
  return Array.isArray(attrs) ? attrs.filter((a) => !names.has(a.name)) : attrs;
}

function carryAttributes(attrs, from, names) {
  if (!names.size || !Array.isArray(from)) return attrs;
  const kept = from.filter((a) => names.has(a.name));
  return kept.length ? sortBy([...(attrs ?? []), ...kept]) : attrs;
}

// `key` is the artifact key: scoped rules (a kapp, a form, a team) match on
// it. envBoundAttributes rules are resolved by env-bound.mjs.
// `spaceFields` are the chosen space settings (config.envBoundSpaceFields).
export function withoutEnvBound(scope, data, envBoundAttributes = {}, key = null, spaceFields = DEFAULT_ENV_BOUND_SPACE_FIELDS) {
  if (!scope || !data) return data;
  const out = omit(data, envBoundFields(scope, spaceFields));
  if (PROPERTY_VALUE_SCOPES.has(scope) && Array.isArray(out.properties)) {
    out.properties = out.properties.map(({ value, ...p }) => p);
  }
  const identity = itemIdentity(scope, key, data);
  const own = envBoundNames(envBoundAttributes, scope, identity);
  if (own.size && out.attributes) out.attributes = dropAttributes(out.attributes, own);
  for (const n of NESTED_ATTRIBUTE_SCOPES[scope] ?? []) {
    if (!Array.isArray(out[n.field])) continue;
    out[n.field] = out[n.field].map((item) => {
      const names = envBoundNames(envBoundAttributes, n.scope, nestedIdentity(n.scope, identity, item));
      return names.size ? { ...item, attributes: dropAttributes(item.attributes, names) } : item;
    });
  }
  return out;
}

// Property values come from the target's same-named property, else from
// `source` (the export before withoutEnvBound): a first install or a property
// the target does not have yet starts from the exported value.
function carryPropertyValues(props, existing, source) {
  const valueOf = (list, name) => list?.find((p) => p.name === name && p.value !== undefined);
  return props.map((p) => {
    const from = valueOf(existing?.properties, p.name) ?? valueOf(source?.properties, p.name);
    return from ? { ...p, value: from.value } : p;
  });
}

// Secret property values never take part in a plan, even if an override
// sets one: they are set on install from environment variables only.
export function withoutSecretValues(scope, data) {
  if (!PROPERTY_VALUE_SCOPES.has(scope) || !Array.isArray(data?.properties)) return data;
  return { ...data, properties: data.properties.map((p) => (isSecretProperty(p) ? (({ value, ...rest }) => rest)(p) : p)) };
}

// `data` must already have had withoutEnvBound applied. `key` and
// `spaceFields` as in withoutEnvBound.
export function carryEnvBound(scope, data, existing, envBoundAttributes = {}, source = null, key = null, spaceFields = DEFAULT_ENV_BOUND_SPACE_FIELDS) {
  if (scope && PROPERTY_VALUE_SCOPES.has(scope) && Array.isArray(data?.properties)) {
    data = { ...data, properties: carryPropertyValues(data.properties, existing, source) };
  }
  if (!scope || !existing) return data;
  const out = { ...data };
  // The chosen space settings like the fixed fields: the target's value,
  // even an empty one, is never replaced by the source's.
  for (const f of envBoundFields(scope, spaceFields)) if (f in existing) out[f] = existing[f];
  const identity = itemIdentity(scope, key, existing);
  const attrs = carryAttributes(out.attributes, existing.attributes, envBoundNames(envBoundAttributes, scope, identity));
  if (attrs === undefined) delete out.attributes;
  else out.attributes = attrs;
  for (const n of NESTED_ATTRIBUTE_SCOPES[scope] ?? []) {
    if (!Array.isArray(out[n.field])) continue;
    out[n.field] = out[n.field].map((item) => {
      const names = envBoundNames(envBoundAttributes, n.scope, nestedIdentity(n.scope, identity, item));
      if (!names.size) return item;
      const match = existing[n.field]?.find((e) => e[n.key] === item[n.key]);
      return match ? { ...item, attributes: carryAttributes(item.attributes, match.attributes, names) } : item;
    });
  }
  return out;
}

// ---- Recorded state (drift detection) --------------------------------------
//
// state/<env>.json maps each promoted key to the hash of the target's content
// without its environment-bound parts. Which space fields are environment-
// bound is configurable, so the space's entry also names the field set it was
// hashed with: "<hash>;space-fields=a,b". An entry without one was recorded
// before the list existed, when only the fixed fields were left out. When the
// recorded set differs from the current one the hash cannot tell a change in
// a newly kept (or newly promoted) setting from other changes, so the check
// is skipped ('unknown') until the next apply records the current set.
const SPACE_FIELDS_MARK = ';space-fields=';

export function parseRecorded(recorded) {
  const s = String(recorded ?? '');
  const at = s.indexOf(SPACE_FIELDS_MARK);
  if (at < 0) return { hash: s, spaceFields: null };
  const list = s.slice(at + SPACE_FIELDS_MARK.length);
  return { hash: s.slice(0, at), spaceFields: canonicalSpaceFields(list ? list.split(',') : []) };
}

// The state entry for `data` (the target's content after an apply).
export function stateEntry(scope, data, config = {}, key = null) {
  const spaceFields = config.envBoundSpaceFields ?? DEFAULT_ENV_BOUND_SPACE_FIELDS;
  const hash = hashOf(withoutEnvBound(scope, data, config.envBoundAttributes ?? {}, key, spaceFields));
  return scope === 'space' ? `${hash}${SPACE_FIELDS_MARK}${spaceFields.join(',')}` : hash;
}

// 'drifted' | 'clean' | 'unknown': whether `data` (the target's current
// content) differs from the recorded entry.
export function driftStatus(scope, data, recorded, config = {}, key = null) {
  const { hash, spaceFields } = parseRecorded(recorded);
  let fields = [];
  if (scope === 'space') {
    fields = spaceFields ?? [];
    const current = canonicalSpaceFields(config.envBoundSpaceFields ?? DEFAULT_ENV_BOUND_SPACE_FIELDS);
    if (fields.join(',') !== current.join(',')) return 'unknown';
  }
  return hash === hashOf(withoutEnvBound(scope, data, config.envBoundAttributes ?? {}, key, fields)) ? 'clean' : 'drifted';
}

// Only a known difference is drift.
export const driftedFrom = (...args) => driftStatus(...args) === 'drifted';

export const SPACE_DRIFT_SKIPPED = 'Drift check for the space skipped: kept settings changed since the last promotion';
