// Per-type summary cards for the detail pane. Pure, and never includes a
// secret value:
// - Secret-named fields (isSecretName) and secret handler properties
//   (isSecretProperty) never show their value. Whether one is set cannot be
//   read from a snapshot (export strips secret values), so it comes from
//   `extra.secrets`: true → "•••• set", false → "not set", no entry →
//   "•••• hidden".
// - Nested values in a connection's auth show as "(object)", never content.
// - URL-like strings have their userinfo and secret-named query parameters
//   redacted.
//
// summarize(key, data, type, extra) — `type` is the artifact module type
// ('forms') or its singular ('form'). `extra` (all optional):
//   secrets:        { [fieldOrPropertyName]: boolean } has-flags for secret
//                   connection auth fields and handler properties, supplied
//                   by the server (keychain / target); never values.
//   formsCount:     number (kapp)
//   operationCount: number (connection)
//   packageSize:    number of bytes (handler)
//   workflows:      { event, name }[] (form), grouped by event
//   integrations:   string[] (form), labels such as "Connection › Operation",
//                   replacing the integration names
import { AUTH_SECRET_FIELDS, isSecretName, isSecretProperty } from './secrets.mjs';
import { referencedDefinitionIds } from './artifacts/task-refs.mjs';
import { compareText } from './normalize.mjs';
import { segmentLabel } from './store.mjs';

export const SET = '•••• set';
export const NOT_SET = 'not set';
export const HIDDEN = '•••• hidden';
export const OBJECT = '(object)';
const REDACTED = '•••';

const present = (v) => v !== undefined && v !== null && v !== '';
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const lastSegment = (k) => segmentLabel(String(k).split('/').pop());

// Userinfo in scheme://user:pass@host, and values of secret-named query
// parameters, in any string.
export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s?#]+@/gi, `$1${REDACTED}@`)
    .replace(/([?&;])([^=&#\s?;]+)=([^&#\s;]*)/g, (m, sep, name) => (isSecretName(decodeURIComponentSafe(name)) ? `${sep}${name}=${REDACTED}` : m));
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Presence from the explicit has-flags only; never from the value.
const secretState = (name, extra) => {
  const flags = extra.secrets ?? {};
  if (!Object.hasOwn(flags, name)) return HIDDEN;
  return flags[name] ? SET : NOT_SET;
};

// A display value: secret-named labels are masked, objects never shown,
// strings redacted.
const shown = (label, value, extra) => {
  if (isSecretName(label)) return secretState(label, extra);
  if (value && typeof value === 'object') return OBJECT;
  return redactText(value);
};

const section = (heading, list, as = 'rows') => (list.length ? [{ heading, [as]: list }] : []);
const names = (arr, key = 'name') => (arr ?? []).map((x) => (isScalar(x) ? x : x?.[key])).filter(present).map(redactText);

function helpers(extra) {
  const row = (label, value) => ({ label, value: shown(label, value, extra) });
  return {
    row,
    rows: (pairs) => pairs.filter(([l, v]) => present(v) || isSecretName(l)).map(([l, v]) => row(l, v)),
    attributeRows: (attrs) => (attrs ?? []).filter((a) => present(a?.name))
      .map((a) => row(a.name, (a.values ?? []).filter(isScalar).join(', '))),
  };
}

const policyRows = (policies) => (policies ?? []).filter((p) => p?.endpoint).map((p) => ({ label: p.endpoint, value: p.name }));

// { event, name }[] grouped into one row per event.
function workflowRows(workflows) {
  const byEvent = new Map();
  for (const w of [...(workflows ?? [])].sort((a, b) => compareText(a.name, b.name))) {
    byEvent.set(w.event, [...(byEvent.get(w.event) ?? []), w.name]);
  }
  return [...byEvent.keys()].sort(compareText).map((e) => ({ label: e, value: byEvent.get(e).join(', ') }));
}

function fieldsOf(elements, out = []) {
  for (const e of elements ?? []) {
    if (e?.type === 'field') out.push(e);
    if (e?.elements) fieldsOf(e.elements, out);
  }
  return out;
}

function form(key, d, extra) {
  const h = helpers(extra);
  const kapp = key.split('/')[1];
  const fields = fieldsOf((d.pages ?? []).flatMap((p) => p?.elements ?? []));
  return {
    title: d.name ?? d.slug ?? lastSegment(key),
    subtitle: `Form in kapp ${kapp}`,
    sections: [
      { heading: 'Overview', rows: h.rows([['Kapp', kapp], ['Slug', d.slug], ['Status', d.status], ['Type', d.type], ['Pages', (d.pages ?? []).length], ['Fields', fields.length]]) },
      ...section('Fields', fields.map((f) => ({ label: f.name, value: [f.renderType ?? f.dataType, f.required ? 'required' : null].filter(Boolean).join(', ') }))),
      ...section('Workflows', workflowRows(extra.workflows)),
      ...section('Integrations', (extra.integrations ?? (d.integrations ?? []).map((i) => i.name ?? `${i.connectionId} › ${i.operationId}`)).map(redactText), 'items'),
      ...section('Index definitions', names(d.indexDefinitions), 'items'),
      ...section('Security policies', policyRows(d.securityPolicies)),
      ...section('Attributes', h.attributeRows(d.attributes)),
    ],
  };
}

const ATTRIBUTE_DEFINITIONS = {
  kappAttributeDefinitions: 'Kapp', formAttributeDefinitions: 'Form', categoryAttributeDefinitions: 'Category',
  spaceAttributeDefinitions: 'Space', teamAttributeDefinitions: 'Team',
  userAttributeDefinitions: 'User', userProfileAttributeDefinitions: 'User profile',
};
const attributeDefinitions = (d) => Object.entries(ATTRIBUTE_DEFINITIONS)
  .flatMap(([field, label]) => names(d[field]).map((n) => `${label}: ${n}`));

function kapp(key, d, extra) {
  const h = helpers(extra);
  return {
    title: d.name ?? d.slug ?? key.split('/')[1],
    subtitle: 'Kapp',
    sections: [
      { heading: 'Overview', rows: h.rows([['Slug', d.slug], ['Forms', extra.formsCount]]) },
      ...section('Categories', names(d.categories), 'items'),
      ...section('Form types', names(d.formTypes), 'items'),
      ...section('Attribute definitions', attributeDefinitions(d), 'items'),
      ...section('Security policy definitions', names(d.securityPolicyDefinitions), 'items'),
      ...section('Security policies', policyRows(d.securityPolicies)),
      ...section('Integrations', names(d.integrations), 'items'),
      ...section('Attributes', h.attributeRows(d.attributes)),
    ],
  };
}

function scopeOf(key) {
  const p = key.split('/');
  if (p[0] === 'workflows') return 'Space';
  if (p[2] === 'workflows') return `Kapp ${p[1]}`;
  return `Form ${p[1]} / ${p[3]}`;
}

function workflow(key, d, extra) {
  const h = helpers(extra);
  const ids = [...referencedDefinitionIds([{ data: d }])].filter((id) => !id.startsWith('system_')).sort(compareText);
  return {
    title: d.name ?? lastSegment(key),
    subtitle: `${scopeOf(key)} workflow`,
    sections: [
      { heading: 'Overview', rows: h.rows([['Scope', scopeOf(key)], ['Event', d.event], ['Status', d.status], ['Filter', d.filter], ['Nodes', (d.treeJson?.nodes ?? []).length]]) },
      ...section('Handlers and routines', ids, 'items'),
    ],
  };
}

function connection(key, d, extra) {
  const h = helpers(extra);
  const auth = d.config?.auth && typeof d.config.auth === 'object' ? d.config.auth : {};
  const authType = typeof auth.authType === 'string' ? auth.authType : undefined;
  const fields = new Set(Object.keys(auth).filter((k) => k !== 'authType'));
  // A secret field the export stripped still gets a row; extra.secrets names are always added.
  for (const k of AUTH_SECRET_FIELDS[authType] ?? []) fields.add(k);
  for (const k of Object.keys(extra.secrets ?? {})) fields.add(k);
  const authRow = (k) => {
    if (isSecretName(k)) return { label: k, value: secretState(k, extra) };
    const v = auth[k];
    return { label: k, value: v && typeof v === 'object' ? OBJECT : redactText(v ?? '') };
  };
  return {
    title: d.name ?? key.split('/')[1],
    subtitle: 'Connection',
    sections: [
      { heading: 'Overview', rows: h.rows([['Type', d.type], ['Base URL', d.config?.baseUrl], ['Auth type', authType], ['Operations', extra.operationCount]]) },
      ...section('Authentication', [...fields].sort(compareText).map(authRow)),
    ],
  };
}

const keysOrNames = (v) => (Array.isArray(v) ? names(v) : v && typeof v === 'object' ? Object.keys(v).sort(compareText) : []);

function operation(key, d, extra) {
  const h = helpers(extra);
  return {
    title: d.name ?? lastSegment(key),
    subtitle: `Operation on connection ${key.split('/')[1]}`,
    sections: [
      { heading: 'Overview', rows: h.rows([['Method', d.config?.method], ['Path', d.config?.path]]) },
      ...section('Inputs', keysOrNames(d.inputs ?? d.parameters), 'items'),
      ...section('Outputs', keysOrNames(d.outputs ?? d.outputMappings), 'items'),
    ],
  };
}

function handler(key, d, extra) {
  const h = helpers(extra);
  return {
    title: d.name ?? d.definitionId ?? key.split('/')[1],
    subtitle: `Handler ${d.definitionId ?? key.split('/')[1]}`,
    sections: [
      { heading: 'Overview', rows: h.rows([['Definition', d.definitionId], ['Version', d.definitionVersion], ['Status', d.status], ['Package size', extra.packageSize], ['Package SHA-256', d.packageSha256]]) },
      ...section('Categories', names(d.categories), 'items'),
      ...section('Settings', (d.properties ?? []).filter((p) => present(p?.name)).map((p) => ({
        label: p.name,
        value: isSecretProperty(p) ? secretState(p.name, extra) : shown(p.name, p.value ?? '', extra),
      }))),
    ],
  };
}

function team(key, d, extra) {
  const h = helpers(extra);
  return {
    title: d.name ?? lastSegment(key),
    subtitle: 'Team',
    sections: [
      { heading: 'Overview', rows: h.rows([['Name', d.name], ['Description', d.description]]) },
      ...section('Attributes', h.attributeRows(d.attributes)),
    ],
  };
}

const SPACE_COLLECTIONS = new Set([...Object.keys(ATTRIBUTE_DEFINITIONS), 'securityPolicyDefinitions', 'securityPolicies', 'attributes']);

function space(key, d, extra) {
  const h = helpers(extra);
  const settings = Object.keys(d).filter((k) => !SPACE_COLLECTIONS.has(k) && (isScalar(d[k]) || isSecretName(k))).sort(compareText);
  return {
    title: d.name ?? 'Space',
    subtitle: 'Space',
    sections: [
      ...section('Settings', settings.map((k) => h.row(k, d[k]))),
      ...section('Attribute definitions', attributeDefinitions(d), 'items'),
      ...section('Security policy definitions', names(d.securityPolicyDefinitions), 'items'),
      ...section('Security policies', policyRows(d.securityPolicies)),
      ...section('Attributes', h.attributeRows(d.attributes)),
    ],
  };
}

function generic(key, d, extra) {
  const h = helpers(extra);
  const out = [];
  for (const k of Object.keys(d).sort(compareText)) {
    const v = d[k];
    if (isSecretName(k)) out.push(h.row(k, v));
    else if (Array.isArray(v)) out.push(h.row(k, `${v.length} items`));
    else if (isScalar(v)) out.push(h.row(k, v));
  }
  return {
    title: String(redactText(d.name ?? d.slug ?? lastSegment(key))),
    subtitle: key,
    sections: section('Overview', out),
  };
}

const BUILDERS = new Map(Object.entries({ form, kapp, workflow, connection, operation, handler, team, space }));

export function summarize(key, data, type, extra = {}) {
  const t = String(type ?? '');
  const build = BUILDERS.get(t) ?? BUILDERS.get(t.replace(/s$/, '')) ?? generic;
  const d = data && typeof data === 'object' ? data : {};
  return build(String(key), d, extra && typeof extra === 'object' ? extra : {});
}
