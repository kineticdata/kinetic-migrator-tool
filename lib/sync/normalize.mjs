// Pure helpers that turn platform responses into canonical, comparable JSON.
import { createHash } from 'node:crypto';
import { isSecretProperty } from './secrets.mjs';

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

// Collections inside an artifact whose items carry their own attributes.
const NESTED_ATTRIBUTE_SCOPES = {
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

export function withoutEnvBound(scope, data, envBoundAttributes = {}) {
  if (!scope || !data) return data;
  const out = omit(data, ENV_BOUND_FIELDS[scope] ?? []);
  if (PROPERTY_VALUE_SCOPES.has(scope) && Array.isArray(out.properties)) {
    out.properties = out.properties.map(({ value, ...p }) => p);
  }
  const own = new Set(envBoundAttributes[scope] ?? []);
  if (own.size && out.attributes) out.attributes = dropAttributes(out.attributes, own);
  for (const n of NESTED_ATTRIBUTE_SCOPES[scope] ?? []) {
    const names = new Set(envBoundAttributes[n.scope] ?? []);
    if (!names.size || !Array.isArray(out[n.field])) continue;
    out[n.field] = out[n.field].map((item) => ({ ...item, attributes: dropAttributes(item.attributes, names) }));
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

// `data` must already have had withoutEnvBound applied.
export function carryEnvBound(scope, data, existing, envBoundAttributes = {}, source = null) {
  if (scope && PROPERTY_VALUE_SCOPES.has(scope) && Array.isArray(data?.properties)) {
    data = { ...data, properties: carryPropertyValues(data.properties, existing, source) };
  }
  if (!scope || !existing) return data;
  const out = { ...data };
  for (const f of ENV_BOUND_FIELDS[scope] ?? []) if (f in existing) out[f] = existing[f];
  const attrs = carryAttributes(out.attributes, existing.attributes, new Set(envBoundAttributes[scope] ?? []));
  if (attrs === undefined) delete out.attributes;
  else out.attributes = attrs;
  for (const n of NESTED_ATTRIBUTE_SCOPES[scope] ?? []) {
    const names = new Set(envBoundAttributes[n.scope] ?? []);
    if (!names.size || !Array.isArray(out[n.field])) continue;
    out[n.field] = out[n.field].map((item) => {
      const match = existing[n.field]?.find((e) => e[n.key] === item[n.key]);
      return match ? { ...item, attributes: carryAttributes(item.attributes, match.attributes, names) } : item;
    });
  }
  return out;
}
