import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelationships, suggest } from './relationships.mjs';

// A small synthetic space: one kapp with a form, workflows, a WebAPI, a
// connection with two operations, a handler and a routine.
const ARTIFACTS = [
  {
    key: 'space',
    data: { name: 'Space', securityPolicyDefinitions: [{ name: 'Space Admins', type: 'Space', rule: 'false' }] },
  },
  {
    key: 'kapps/services/kapp',
    data: {
      slug: 'services', name: 'Services',
      categories: [{ slug: 'hardware', name: 'Hardware' }],
      securityPolicyDefinitions: [{ name: 'Authenticated Users', type: 'Kapp', rule: 'true' }],
      securityPolicies: [{ endpoint: 'Display', name: 'Space Admins' }, { endpoint: 'Submission Access', name: 'Authenticated Users' }],
      integrations: [{ name: 'Lookup', connectionId: 'c-1', operationId: 'o-2' }],
    },
  },
  {
    key: 'kapps/services/forms/it-request/form',
    data: {
      slug: 'it-request', name: 'IT Request',
      integrations: [
        { name: 'Ticket', connectionId: 'c-1', operationId: 'o-1' },
        { name: 'Missing', connectionId: 'c-gone', operationId: 'o-gone' },
      ],
      securityPolicies: [{ endpoint: 'Display', name: 'Authenticated Users' }, { endpoint: 'Modification', name: 'Nobody' }],
      categorizations: [{ category: { slug: 'hardware' } }, { category: { slug: 'nope' } }],
    },
  },
  {
    key: 'kapps/services/forms/it-request/workflows/Submission Submitted/Notify',
    data: {
      name: 'Notify', event: 'Submission Submitted',
      treeJson: {
        nodes: [
          { definitionId: 'system_start_v1' },
          { definitionId: 'system_integration_v1', parameters: [{ id: 'connection', value: 'c-1' }, { id: 'operation', value: 'o-1' }] },
          { definitionId: 'system_integration_v1', parameters: [{ id: 'connection', value: 'c-1' }, { id: 'operation', value: 'o-1' }] },
          { definitionId: 'mail_send_v1' },
          { definitionId: 'routine_escalate_v1' },
          { definitionId: 'utilities_echo_v1' },
          { definitionId: 'not_installed_v1' },
        ],
      },
    },
  },
  {
    key: 'kapps/services/workflows/Submission Created/Audit',
    data: { name: 'Audit', event: 'Submission Created', treeJson: { nodes: [] } },
  },
  {
    key: 'workflows/User Created/Welcome',
    data: { name: 'Welcome', event: 'User Created', treeJson: { nodes: [{ definitionId: 'mail_send_v1' }] } },
  },
  {
    key: 'webapis/token',
    data: { slug: 'token', method: 'POST', treeXml: '<tree><task definition_id="mail_send_v1"/></tree>' },
  },
  { key: 'connections/ServiceNow/connection', data: { id: 'c-1', name: 'ServiceNow', type: 'http' } },
  { key: 'connections/ServiceNow/operations/Create Ticket', data: { id: 'o-1', connectionId: 'c-1', name: 'Create Ticket' } },
  { key: 'connections/ServiceNow/operations/Find User', data: { id: 'o-2', connectionId: 'c-1', name: 'Find User' } },
  { key: 'handlers/mail_send_v1/handler', data: { definitionId: 'mail_send_v1', name: 'Mail Send' } },
  { key: 'routines/Escalate', data: { name: 'Escalate', definitionId: 'routine_escalate_v1' } },
  { key: 'teams/Admins', data: { name: 'Admins' } },
];

const FORM = 'kapps/services/forms/it-request/form';
const KAPP = 'kapps/services/kapp';
const WF = 'kapps/services/forms/it-request/workflows/Submission Submitted/Notify';
const CONN = 'connections/ServiceNow/connection';
const OP1 = 'connections/ServiceNow/operations/Create Ticket';
const OP2 = 'connections/ServiceNow/operations/Find User';
const HANDLER = 'handlers/mail_send_v1/handler';

const rel = buildRelationships(ARTIFACTS);
const uses = (k) => rel.uses.get(k) ?? [];
const usedBy = (k) => rel.usedBy.get(k) ?? [];
const has = (edges, key, kind) => edges.some((e) => e.key === key && e.kind === kind);

test('every artifact has uses and usedBy entries, even when empty', () => {
  for (const { key } of ARTIFACTS) {
    assert.ok(Array.isArray(rel.uses.get(key)), key);
    assert.ok(Array.isArray(rel.usedBy.get(key)), key);
  }
  assert.deepEqual(uses('teams/Admins'), []);
});

test('form -> kapp is a parent edge, mirrored in usedBy', () => {
  assert.ok(has(uses(FORM), KAPP, 'parent'));
  assert.ok(has(usedBy(KAPP), FORM, 'parent'));
});

test('workflow -> form, kapp workflow -> kapp (parent); space workflows have no parent edge', () => {
  assert.ok(has(uses(WF), FORM, 'parent'));
  assert.ok(has(uses('kapps/services/workflows/Submission Created/Audit'), KAPP, 'parent'));
  assert.ok(!uses('workflows/User Created/Welcome').some((e) => e.kind === 'parent'));
});

test('operation -> connection is a parent edge', () => {
  assert.ok(has(uses(OP1), CONN, 'parent'));
  assert.ok(has(uses(OP2), CONN, 'parent'));
});

test('form and kapp integrations call the connection and operation, with a readable reason', () => {
  assert.ok(has(uses(FORM), CONN, 'calls'));
  const e = uses(FORM).find((x) => x.key === OP1 && x.kind === 'calls');
  assert.equal(e.reason, 'IT Request calls operation "Create Ticket" on connection "ServiceNow"');
  assert.ok(has(uses(KAPP), OP2, 'calls'));
  assert.ok(has(uses(KAPP), CONN, 'calls'));
  assert.ok(has(usedBy(OP1), FORM, 'calls'));
});

test('workflow system_integration_v1 nodes call the connection and operation, de-duplicated', () => {
  assert.equal(uses(WF).filter((e) => e.key === OP1 && e.kind === 'calls').length, 1);
  assert.ok(has(uses(WF), CONN, 'calls'));
});

test('workflows and WebAPIs run handlers and routines by definitionId; built-ins and unknown ids are skipped', () => {
  assert.ok(has(uses(WF), HANDLER, 'runs'));
  assert.ok(has(uses(WF), 'routines/Escalate', 'runs'));
  assert.ok(has(uses('workflows/User Created/Welcome'), HANDLER, 'runs'));
  assert.ok(has(uses('webapis/token'), HANDLER, 'runs'));
  assert.ok(!uses(WF).some((e) => /utilities_|system_|not_installed/.test(e.key)));
  assert.match(uses(WF).find((e) => e.key === HANDLER).reason, /Notify runs handler "Mail Send"/);
  assert.equal(usedBy(HANDLER).length, 3);
});

test('security policies point at the kapp or space defining them (secured-by), naming the policy', () => {
  const formPolicy = uses(FORM).find((e) => e.kind === 'secured-by');
  assert.equal(formPolicy.key, KAPP);
  assert.match(formPolicy.reason, /"Authenticated Users"/);
  // The kapp's own definition would be a self edge; the space one is an edge.
  const kappPolicies = uses(KAPP).filter((e) => e.kind === 'secured-by');
  assert.deepEqual(kappPolicies.map((e) => e.key), ['space']);
  assert.match(kappPolicies[0].reason, /"Space Admins"/);
});

test('form categorizations point at the kapp (categorized); unknown categories are skipped', () => {
  const cats = uses(FORM).filter((e) => e.kind === 'categorized');
  assert.equal(cats.length, 1);
  assert.equal(cats[0].key, KAPP);
  assert.match(cats[0].reason, /Hardware/);
});

test('dangling references are skipped and never create edges to missing keys', () => {
  const keys = new Set(ARTIFACTS.map((a) => a.key));
  for (const [k, edges] of rel.uses) {
    for (const e of edges) assert.ok(keys.has(e.key), `${k} -> ${e.key}`);
    for (const e of edges) assert.notEqual(e.key, k);
  }
});

test('edges are sorted stably by key, kind and reason', () => {
  const edges = uses(FORM);
  const sorted = [...edges].sort((a, b) => (a.key + a.kind + a.reason < b.key + b.kind + b.reason ? -1 : 1));
  assert.deepEqual(edges.map((e) => e.key + e.kind), sorted.map((e) => e.key + e.kind));
});

test('suggest lists changed, unselected dependencies recursively, de-duplicated and sorted', () => {
  const changedKeys = new Set([FORM, OP1, CONN, HANDLER, KAPP]);
  const out = suggest({ selected: new Set([WF]), relationships: rel, changedKeys });
  assert.deepEqual(out.map((s) => s.key), [CONN, OP1, HANDLER, KAPP, FORM].sort());
  assert.equal(new Set(out.map((s) => s.key)).size, out.length);
  // KAPP is reached through FORM (recursive), or directly if WF used it.
  const op = out.find((s) => s.key === OP1);
  assert.equal(op.forKey, WF);
  assert.equal(op.kind, 'calls');
  assert.deepEqual(Object.keys(op).sort(), ['forKey', 'key', 'kind', 'reason']);
  assert.match(op.reason, /Create Ticket/);
  const kapp = out.find((s) => s.key === KAPP);
  assert.equal(kapp.forKey, FORM);
});

test('suggest skips selected and unchanged dependencies', () => {
  const out = suggest({ selected: new Set([WF, OP1]), relationships: rel, changedKeys: new Set([OP1, HANDLER]) });
  assert.deepEqual(out.map((s) => s.key), [HANDLER]);
  assert.deepEqual(suggest({ selected: new Set(), relationships: rel, changedKeys: new Set([OP1]) }), []);
});

test('suggest is deterministic regardless of selection order', () => {
  const changedKeys = new Set([CONN, OP1, OP2, HANDLER]);
  const a = suggest({ selected: new Set([WF, KAPP]), relationships: rel, changedKeys });
  const b = suggest({ selected: new Set([KAPP, WF]), relationships: rel, changedKeys });
  assert.deepEqual(a, b);
});

test('a policy defined in both the kapp and the space resolves to the kapp', () => {
  const r = buildRelationships([
    { key: 'space', data: { securityPolicyDefinitions: [{ name: 'Shared' }, { name: 'Only Space' }] } },
    { key: 'kapps/k/kapp', data: { name: 'K', securityPolicyDefinitions: [{ name: 'Shared' }] } },
    { key: 'kapps/k/forms/f/form', data: { name: 'F', securityPolicies: [{ endpoint: 'Display', name: 'Shared' }, { endpoint: 'Modification', name: 'Only Space' }] } },
  ]);
  const edges = r.uses.get('kapps/k/forms/f/form').filter((e) => e.kind === 'secured-by');
  assert.equal(edges.find((e) => /"Shared"/.test(e.reason)).key, 'kapps/k/kapp');
  assert.equal(edges.find((e) => /"Only Space"/.test(e.reason)).key, 'space');
});

test('a kapp workflow runs handlers and routines too', () => {
  const r = buildRelationships([
    { key: 'kapps/k/kapp', data: { name: 'K' } },
    { key: 'kapps/k/workflows/Submission Created/Route', data: { name: 'Route', treeJson: { nodes: [{ definitionId: 'mail_send_v1' }, { definitionId: 'routine_r_v1' }] } } },
    { key: 'handlers/mail_send_v1/handler', data: { definitionId: 'mail_send_v1', name: 'Mail Send' } },
    { key: 'routines/R', data: { name: 'R', definitionId: 'routine_r_v1' } },
  ]);
  const edges = r.uses.get('kapps/k/workflows/Submission Created/Route');
  assert.ok(edges.some((e) => e.key === 'handlers/mail_send_v1/handler' && e.kind === 'runs'));
  assert.ok(edges.some((e) => e.key === 'routines/R' && e.kind === 'runs'));
  assert.ok(edges.some((e) => e.key === 'kapps/k/kapp' && e.kind === 'parent'));
});
