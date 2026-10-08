// The relationships index: which artifacts each artifact uses, and which use
// it, each edge with a plain-language reason. Pure; drives the Relationships
// tab and changeset dependency suggestions. Dangling references are skipped.
import { compareText } from './normalize.mjs';
import { integrationRefs } from './plan.mjs';
import { keyFor, segmentLabel } from './store.mjs';
import { referencedDefinitionIds } from './artifacts/task-refs.mjs';
import { isBuiltInHandler } from './artifacts/common.mjs';

const CONNECTION = /^connections\/[^/]+\/connection$/;
const OPERATION = /^connections\/([^/]+)\/operations\/[^/]+$/;
const FORM = /^kapps\/([^/]+)\/forms\/([^/]+)\/form$/;
const KAPP = /^kapps\/([^/]+)\/kapp$/;
const ROUTINE = /^routines\/[^/]+$/;
const WEBAPI = /^(kapps\/[^/]+\/)?webapis\/[^/]+$/;
const FORM_WORKFLOW = /^kapps\/([^/]+)\/forms\/([^/]+)\/workflows\/[^/]+\/[^/]+$/;
const KAPP_WORKFLOW = /^kapps\/([^/]+)\/workflows\/[^/]+\/[^/]+$/;
const SPACE_WORKFLOW = /^workflows\/[^/]+\/[^/]+$/;

const isWorkflow = (k) => FORM_WORKFLOW.test(k) || KAPP_WORKFLOW.test(k) || SPACE_WORKFLOW.test(k);
const lastSegment = (k) => segmentLabel(k.split('/').pop());
const nameOf = (key, data) => data?.name ?? data?.slug ?? data?.definitionId ?? lastSegment(key);
const q = (s) => `"${s}"`;

const compareEdges = (a, b) => compareText(a.key, b.key) || compareText(a.kind, b.kind) || compareText(a.reason, b.reason);

export function buildRelationships(artifacts) {
  const byKey = new Map(artifacts.map((a) => [a.key, a.data]));
  const uses = new Map(artifacts.map((a) => [a.key, []]));
  const usedBy = new Map(artifacts.map((a) => [a.key, []]));

  const ids = { connection: new Map(), operation: new Map(), routine: new Map() };
  for (const { key, data } of artifacts) {
    if (CONNECTION.test(key) && data?.id) ids.connection.set(data.id, key);
    if (OPERATION.test(key) && data?.id) ids.operation.set(data.id, key);
    if (ROUTINE.test(key) && data?.definitionId) ids.routine.set(data.definitionId, key);
  }

  const seen = new Set();
  const add = (from, to, kind, reason) => {
    if (!to || to === from || !byKey.has(to)) return;
    const id = `${from}\u0000${to}\u0000${kind}\u0000${reason}`;
    if (seen.has(id)) return;
    seen.add(id);
    uses.get(from).push({ key: to, kind, reason });
    usedBy.get(to).push({ key: from, kind, reason });
  };

  for (const { key, data } of artifacts) {
    const name = nameOf(key, data);
    let m;

    // Parents.
    // Segments taken from a key are already encoded: join them, never keyFor.
    if ((m = FORM.exec(key))) add(key, `kapps/${m[1]}/kapp`, 'parent', `${name} belongs to kapp ${q(nameOf(`kapps/${m[1]}/kapp`, byKey.get(`kapps/${m[1]}/kapp`)))}`);
    if ((m = FORM_WORKFLOW.exec(key))) {
      const form = `kapps/${m[1]}/forms/${m[2]}/form`;
      add(key, form, 'parent', `${name} is a workflow on form ${q(nameOf(form, byKey.get(form)))}`);
    } else if ((m = KAPP_WORKFLOW.exec(key))) {
      const kapp = `kapps/${m[1]}/kapp`;
      add(key, kapp, 'parent', `${name} is a workflow on kapp ${q(nameOf(kapp, byKey.get(kapp)))}`);
    }
    if (OPERATION.test(key)) {
      const conn = ids.connection.get(data?.connectionId) ?? `connections/${OPERATION.exec(key)[1]}/connection`;
      add(key, conn, 'parent', `Operation ${q(name)} belongs to connection ${q(nameOf(conn, byKey.get(conn)))}`);
    }

    // Integrations (form/kapp integrations and system_integration_v1 nodes).
    if (FORM.test(key) || KAPP.test(key) || isWorkflow(key) || WEBAPI.test(key)) {
      for (const ref of integrationRefs(data)) {
        const conn = ids.connection.get(ref.connectionId);
        const op = ids.operation.get(ref.operationId);
        const connName = conn ? nameOf(conn, byKey.get(conn)) : null;
        if (op) {
          const opName = nameOf(op, byKey.get(op));
          const opConn = ids.connection.get(byKey.get(op)?.connectionId) ?? conn;
          const onConn = opConn ? ` on connection ${q(nameOf(opConn, byKey.get(opConn)))}` : '';
          add(key, op, 'calls', `${name} calls operation ${q(opName)}${onConn}`);
        }
        if (conn) add(key, conn, 'calls', `${name} calls connection ${q(connName)}`);
      }
    }

    // Handlers and routines.
    if (isWorkflow(key) || WEBAPI.test(key)) {
      for (const id of [...referencedDefinitionIds([{ data }])].sort()) {
        if (isBuiltInHandler(id)) continue;
        const routine = ids.routine.get(id);
        if (routine) {
          add(key, routine, 'runs', `${name} runs routine ${q(nameOf(routine, byKey.get(routine)))}`);
        } else {
          const handler = keyFor('handlers', id, 'handler');
          add(key, handler, 'runs', `${name} runs handler ${q(nameOf(handler, byKey.get(handler)))} (${id})`);
        }
      }
    }

    // Security policies: the kapp's definitions first, then the space's.
    const kappSlug = (FORM.exec(key) ?? KAPP.exec(key))?.[1];
    if (kappSlug !== undefined) {
      const kappKey = `kapps/${kappSlug}/kapp`;
      const definedIn = (k, policy) => (byKey.get(k)?.securityPolicyDefinitions ?? []).some((d) => d?.name === policy);
      for (const p of data?.securityPolicies ?? []) {
        if (!p?.name) continue;
        const target = definedIn(kappKey, p.name) ? kappKey : definedIn('space', p.name) ? 'space' : null;
        if (!target) continue;
        const where = target === 'space' ? 'the space' : `kapp ${q(nameOf(kappKey, byKey.get(kappKey)))}`;
        add(key, target, 'secured-by', `${name} is secured by policy ${q(p.name)} (${p.endpoint ?? 'policy'}) defined in ${where}`);
      }

      // Categorizations.
      if (FORM.test(key)) {
        const categories = byKey.get(kappKey)?.categories ?? [];
        for (const c of data?.categorizations ?? []) {
          const slug = c?.category?.slug;
          const cat = categories.find((x) => x?.slug === slug);
          if (!cat) continue;
          add(key, kappKey, 'categorized', `${name} is in category ${q(cat.name ?? slug)} of kapp ${q(nameOf(kappKey, byKey.get(kappKey)))}`);
        }
      }
    }
  }

  for (const list of [...uses.values(), ...usedBy.values()]) list.sort(compareEdges);
  return { uses, usedBy };
}

// Dependencies of the selection that differ and are not selected, followed
// through suggested items too. One suggestion per key (the first reached in a
// sorted breadth-first walk), sorted by key.
export function suggest({ selected, relationships, changedKeys }) {
  const out = new Map();
  const queue = [...selected].sort(compareText);
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const e of relationships.uses.get(from) ?? []) {
      if (!changedKeys.has(e.key) || selected.has(e.key) || out.has(e.key)) continue;
      out.set(e.key, { key: e.key, forKey: from, kind: e.kind, reason: e.reason });
      queue.push(e.key);
    }
  }
  return [...out.values()].sort((a, b) => compareText(a.key, b.key) || compareText(a.forKey, b.forKey));
}
