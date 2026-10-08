// Per-type summary cards for the detail pane. Pure. Secret values are never
// included: secret-named fields and secret handler properties render as
// "•••• set" / "not set".
import { isSecretName, isSecretProperty } from './secrets.mjs';
import { referencedDefinitionIds } from './artifacts/task-refs.mjs';
import { compareText } from './normalize.mjs';

export const SET = '•••• set';
export const NOT_SET = 'not set';

const present = (v) => v !== undefined && v !== null && v !== '';
const masked = (v) => (present(v) ? SET : NOT_SET);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const lastSegment = (k) => String(k).split('/').pop();

// A row; the value is masked when the label looks like a secret.
const row = (label, value) => ({ label, value: isSecretName(label) ? masked(value) : value });
const rows = (pairs) => pairs.filter(([, v]) => present(v)).map(([l, v]) => row(l, v));
const section = (heading, list, as = 'rows') => (list.length ? [{ heading, [as]: list }] : []);
const names = (arr, key = 'name') => (arr ?? []).map((x) => (isScalar(x) ? x : x?.[key])).filter(present);

const attributeRows = (attrs) => (attrs ?? []).map((a) => row(a.name, (a.values ?? []).join(', ')));
const policyRows = (policies) => (policies ?? []).map((p) => ({ label: p.endpoint, value: p.name }));

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
  const kapp = key.split('/')[1];
  const fields = fieldsOf((d.pages ?? []).flatMap((p) => p?.elements ?? []));
  return {
    title: d.name ?? d.slug ?? lastSegment(key),
    subtitle: `Form in kapp ${kapp}`,
    sections: [
      { heading: 'Overview', rows: rows([['Kapp', kapp], ['Slug', d.slug], ['Status', d.status], ['Type', d.type], ['Pages', (d.pages ?? []).length], ['Fields', fields.length]]) },
      ...section('Fields', fields.map((f) => ({ label: f.name, value: [f.renderType ?? f.dataType, f.required ? 'required' : null].filter(Boolean).join(', ') }))),
      ...section('Workflows', workflowRows(extra.workflows)),
      ...section('Integrations', extra.integrations ?? (d.integrations ?? []).map((i) => i.name ?? `${i.connectionId} › ${i.operationId}`), 'items'),
      ...section('Index definitions', names(d.indexDefinitions), 'items'),
      ...section('Security policies', policyRows(d.securityPolicies)),
      ...section('Attributes', attributeRows(d.attributes)),
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
  return {
    title: d.name ?? d.slug ?? key.split('/')[1],
    subtitle: 'Kapp',
    sections: [
      { heading: 'Overview', rows: rows([['Slug', d.slug], ['Forms', extra.formsCount]]) },
      ...section('Categories', names(d.categories), 'items'),
      ...section('Form types', names(d.formTypes), 'items'),
      ...section('Attribute definitions', attributeDefinitions(d), 'items'),
      ...section('Security policy definitions', names(d.securityPolicyDefinitions), 'items'),
      ...section('Security policies', policyRows(d.securityPolicies)),
      ...section('Integrations', names(d.integrations), 'items'),
      ...section('Attributes', attributeRows(d.attributes)),
    ],
  };
}

function scopeOf(key) {
  const p = key.split('/');
  if (p[0] === 'workflows') return 'Space';
  if (p[2] === 'workflows') return `Kapp ${p[1]}`;
  return `Form ${p[1]} / ${p[3]}`;
}

function workflow(key, d) {
  const ids = [...referencedDefinitionIds([{ data: d }])].filter((id) => !id.startsWith('system_')).sort(compareText);
  return {
    title: d.name ?? lastSegment(key),
    subtitle: `${scopeOf(key)} workflow`,
    sections: [
      { heading: 'Overview', rows: rows([['Scope', scopeOf(key)], ['Event', d.event], ['Status', d.status], ['Filter', d.filter], ['Nodes', (d.treeJson?.nodes ?? []).length]]) },
      ...section('Handlers and routines', ids, 'items'),
    ],
  };
}

function connection(key, d, extra) {
  const auth = d.config?.auth ?? {};
  return {
    title: d.name ?? key.split('/')[1],
    subtitle: 'Connection',
    sections: [
      { heading: 'Overview', rows: rows([['Type', d.type], ['Base URL', d.config?.baseUrl], ['Auth type', auth.authType], ['Operations', extra.operationCount]]) },
      ...section('Authentication', Object.keys(auth).filter((k) => k !== 'authType').sort(compareText)
        .map((k) => ({ label: k, value: isSecretName(k) ? masked(auth[k]) : auth[k] }))),
    ],
  };
}

const keysOrNames = (v) => (Array.isArray(v) ? names(v) : v && typeof v === 'object' ? Object.keys(v).sort(compareText) : []);

function operation(key, d) {
  return {
    title: d.name ?? lastSegment(key),
    subtitle: `Operation on connection ${key.split('/')[1]}`,
    sections: [
      { heading: 'Overview', rows: rows([['Method', d.config?.method], ['Path', d.config?.path]]) },
      ...section('Inputs', keysOrNames(d.inputs ?? d.parameters), 'items'),
      ...section('Outputs', keysOrNames(d.outputs ?? d.outputMappings), 'items'),
    ],
  };
}

function handler(key, d, extra) {
  return {
    title: d.name ?? d.definitionId ?? key.split('/')[1],
    subtitle: `Handler ${d.definitionId ?? key.split('/')[1]}`,
    sections: [
      { heading: 'Overview', rows: rows([['Definition', d.definitionId], ['Version', d.definitionVersion], ['Status', d.status], ['Package size', extra.packageSize], ['Package SHA-256', d.packageSha256]]) },
      ...section('Categories', names(d.categories), 'items'),
      ...section('Settings', (d.properties ?? []).map((p) => ({
        label: p.name, value: isSecretProperty(p) ? masked(p.value) : (p.value ?? ''),
      }))),
    ],
  };
}

function team(key, d) {
  return {
    title: d.name ?? lastSegment(key),
    subtitle: 'Team',
    sections: [
      { heading: 'Overview', rows: rows([['Name', d.name], ['Description', d.description]]) },
      ...section('Attributes', attributeRows(d.attributes)),
    ],
  };
}

const SPACE_COLLECTIONS = new Set([...Object.keys(ATTRIBUTE_DEFINITIONS), 'securityPolicyDefinitions', 'securityPolicies', 'attributes']);

function space(key, d) {
  const settings = Object.keys(d).filter((k) => !SPACE_COLLECTIONS.has(k) && isScalar(d[k])).sort(compareText);
  return {
    title: d.name ?? 'Space',
    subtitle: 'Space',
    sections: [
      ...section('Settings', settings.map((k) => row(k, d[k]))),
      ...section('Attribute definitions', attributeDefinitions(d), 'items'),
      ...section('Security policy definitions', names(d.securityPolicyDefinitions), 'items'),
      ...section('Security policies', policyRows(d.securityPolicies)),
      ...section('Attributes', attributeRows(d.attributes)),
    ],
  };
}

function generic(key, d) {
  const out = [];
  for (const k of Object.keys(d).sort(compareText)) {
    const v = d[k];
    if (Array.isArray(v)) out.push(row(k, `${v.length} items`));
    else if (isScalar(v) || isSecretName(k)) out.push(row(k, v));
  }
  return {
    title: String(d.name ?? d.slug ?? lastSegment(key)),
    subtitle: key,
    sections: section('Overview', out),
  };
}

const BUILDERS = { form, kapp, workflow, connection, operation, handler, team, space };

// `type` is the artifact module type ('forms') or its singular ('form').
// `extra` carries facts not in the artifact itself: formsCount (kapp),
// operationCount (connection), packageSize (handler); for forms, workflows
// ({ event, name }[]) and integrations (labels such as "Connection › Operation",
// replacing the integration names).
export function summarize(key, data, type, extra = {}) {
  const t = String(type ?? '');
  const build = BUILDERS[t] ?? BUILDERS[t.replace(/s$/, '')] ?? generic;
  return build(String(key), data ?? {}, extra ?? {});
}
