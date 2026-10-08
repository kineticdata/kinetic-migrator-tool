// lib/sync/plan.mjs
// Pure: compare the export (after overrides) with the target and decide what
// apply would do. No I/O.
import { isEqual, sortBy, compareText, driftStatus, driftedFrom, isEmptyValue, SPACE_DRIFT_SKIPPED } from './normalize.mjs';
import { prepareDesired } from './overrides.mjs';
import { envBoundNamesFor, DEFAULT_ENV_BOUND_SPACE_FIELDS } from './env-bound.mjs';
import { isKeyless, dataSettingsErrors } from './artifacts/data.mjs';
import { keyFor, segmentLabel } from './store.mjs';
import { isBuiltInHandler } from './artifacts/common.mjs';
import { referencedDefinitionIds } from './artifacts/task-refs.mjs';
import { planRemovals } from './removals.mjs';

const isObj = (v) => v !== null && typeof v === 'object';
const join = (path, seg) => (path ? `${path}.${seg}` : String(seg));

export function diffValues(from, to, path = '') {
  if (isEqual(from, to)) return [];
  if (isObj(from) && isObj(to) && Array.isArray(from) === Array.isArray(to)) {
    if (Array.isArray(from)) {
      const named = [...from, ...to].every((x) => isObj(x) && 'name' in x);
      if (named) {
        const fromNames = from.map((x) => x.name);
        const toNames = to.map((x) => x.name);
        if (new Set(fromNames).size !== fromNames.length || new Set(toNames).size !== toNames.length) {
          return [{ path: path || '(root)', from, to }];
        }
        const names = [...new Set([...fromNames, ...toNames])].sort();
        const reordered = fromNames.length === toNames.length && fromNames.every((n) => toNames.includes(n)) && !fromNames.every((n, i) => n === toNames[i])
          ? [{ path: path || '(root)', from: fromNames, to: toNames }] : [];
        return reordered.concat(names.flatMap((n) => diffValues(from.find((x) => x.name === n), to.find((x) => x.name === n), `${path}[${n}]`)));
      }
      if (from.length !== to.length) return [{ path: path || '(root)', from, to }];
      return from.flatMap((v, i) => diffValues(v, to[i], join(path, i)));
    }
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
    return keys.flatMap((k) => diffValues(from[k], to[k], join(path, k)));
  }
  return [{ path: path || '(root)', from, to }];
}

// diffValues for one item of a module: fields the module lists in
// `wholeLists` (a workflow category's members) differ as whole lists.
export function diffItem(mod, from, to) {
  const diff = diffValues(from, to);
  const fields = (mod?.wholeLists ?? []).filter((f) => !isEqual(from?.[f], to?.[f]));
  if (!fields.length) return diff;
  const inField = (p) => fields.find((f) => p === f || p.startsWith(`${f}.`) || p.startsWith(`${f}[`));
  return [
    ...diff.filter((d) => !inField(d.path)),
    ...fields.map((f) => ({ path: f, from: from?.[f], to: to?.[f] })),
  ].sort((a, b) => compareText(a.path, b.path));
}

export function mergeTargetOnly(desired, existing, specs = []) {
  if (!existing) return desired;
  const out = { ...desired };
  for (const { field, key } of specs) {
    if (!Array.isArray(existing[field])) continue;
    const have = new Set((out[field] ?? []).map((x) => x[key]));
    const extra = existing[field].filter((x) => !have.has(x[key]));
    if (extra.length) out[field] = sortBy([...(out[field] ?? []), ...extra], key);
  }
  return out;
}

const moduleFor = (modules, key) => modules.find((m) => m.owns(key));

// Whether a target item changed since its state was recorded after the last
// apply (no record: never). The one place that reads a state entry for drift.
export function driftedSince(recorded, mod, data, config, key) {
  return Boolean(recorded) && driftedFrom(mod.scope, data, recorded, config ?? {}, key);
}

// select (a Set of keys), when given, limits the plan to those keys: every
// other exported item is reported as `excluded` (with `wouldBe`, the action it
// would otherwise have) and target-only items not selected are flagged
// `excluded`, so they are never pruned. resolutions[key] ('overwrite' | 'keep')
// decides a drifted item; overwriteDrift overwrites every drifted item.
// sourceName / targetName name the environments in messages. remove lists
// target-only keys to delete (see removals.mjs), removeExpected their hashes
// as reviewed. inputs: per module type, what its planInputs read from the
// target (workflow categories: handlers installed but in no category).
export function buildPlan({ modules, exported, target, state = {}, overrides = {}, vars = {}, config, overwriteDrift = false, select, resolutions = {}, sourceName, targetName, remove = [], removeExpected, inputs = {} }) {
  const eba = config.envBoundAttributes ?? {};
  const spaceFields = config.envBoundSpaceFields ?? DEFAULT_ENV_BOUND_SPACE_FIELDS;
  const items = [];
  const errors = [];
  const warnings = [];
  const has = taskMemberCheck({ exported, target, select, inputs });
  for (const key of [...exported.keys()].sort()) {
    const mod = moduleFor(modules, key);
    if (!mod) { errors.push(`Unrecognized file in export: ${key}`); continue; }
    if (mod.applyable === false) continue;
    const existing = target.get(key) ?? null;
    const source = prepareDesired({ key, scope: mod.scope, exported: exported.get(key), existing: existing?.data, overrides, vars, envBoundAttributes: eba, envBoundSpaceFields: spaceFields });
    const merged = mod.mergeTargetOnly
      ? mod.mergeTargetOnly(source, existing?.data)
      : mergeTargetOnly(source, existing?.data, mod.namedCollections);
    // A module may leave out what the target cannot take (workflow category
    // members not in the target), with a warning for each.
    const limited = mod.availableOnly
      ? mod.availableOnly(merged, existing?.data, { key, has, targetName: targetName ?? 'the target', source, inputs: inputs[mod.type] ?? {} })
      : { desired: merged, warnings: [] };
    const desired = limited.desired;
    const diff = existing ? diffItem(mod, existing.data, desired) : [];
    // A module may name writes still needed that the data cannot show (a
    // handler's required settings empty in the target).
    const pending = existing && mod.pendingDiff ? mod.pendingDiff(desired, existing).filter((d) => !diff.some((x) => x.path === d.path)) : [];
    if (pending.length) {
      diff.push(...pending);
      diff.sort((a, b) => compareText(a.path, b.path));
    }
    let action = !existing ? 'create' : diff.length ? 'update' : 'unchanged';
    const recorded = state[key];
    // Keyless reference data only ever creates records, so there is nothing
    // for drift protection to protect.
    const keylessData = mod.type === 'data' && isKeyless(source?.key);
    const status = action === 'update' && !keylessData && recorded ? driftStatus(mod.scope, existing.data, recorded, config, key) : 'clean';
    const drift = status === 'drifted';
    const included = !select || select.has(key);
    const overwrite = resolutions[key] === 'overwrite' || (overwriteDrift && resolutions[key] !== 'keep');
    const notes = [...limited.warnings];
    if (status === 'unknown') notes.push(SPACE_DRIFT_SKIPPED);
    if (limited.manual && (action === 'create' || action === 'update')) {
      action = 'manual';
      notes.push(limited.manual);
    } else if (action === 'update' && mod.updatable === false) {
      action = 'manual';
      notes.push(`${key}: differs from the target, but ${mod.type} are never updated automatically; apply the diff by hand`);
    } else if (drift) {
      if (!overwrite) action = 'skip-drift';
      notes.push(`${key}: changed in the target since the last promotion${overwrite ? ' (will be overwritten)' : ' (skipped; use --overwrite-drift to replace it)'}`);
    }
    if (!included) {
      items.push({ key, type: mod.type, scope: mod.scope, action: 'excluded', wouldBe: action, source, desired, existing, diff, drift });
      continue;
    }
    warnings.push(...notes);
    if (mod.type === 'data') {
      errors.push(...dataSettingsErrors(key, { source: exported.get(key), target: existing?.data, config, sourceName, targetName }));
    }
    items.push({ key, type: mod.type, scope: mod.scope, action, source, desired, existing, diff, drift });
  }
  const targetOnly = [...target.keys()]
    .filter((k) => !exported.has(k))
    .map((k) => ({ key: k, mod: moduleFor(modules, k) }))
    .filter(({ mod }) => mod && mod.applyable !== false)
    .sort((a, b) => compareText(a.key, b.key))
    .map(({ key, mod }) => ({ key, type: mod.type, existing: target.get(key), ...(select && !select.has(key) ? { excluded: true } : {}) }));
  for (const k of Object.keys(overrides.artifacts ?? {})) {
    if (!exported.has(k)) warnings.push(`Override for "${k}" matches nothing in the export (check the key against the export/ file paths)`);
  }
  const removed = planRemovals({ modules, exported, target, remove, expected: removeExpected, state, config, items, overwriteDrift, resolutions, sourceName, inputs });
  errors.push(...removed.errors);
  warnings.push(...removed.warnings);
  return { items, targetOnly, removals: removed.removals, errors, warnings };
}

const HANDLER = /^handlers\/[^/]+\/handler$/;
const ROUTINE_KEY = /^routines\/[^/]+$/;

// Whether a handler or routine (by definitionId) is in the target once this
// plan's creates are done: built in, in the target (listed, or installed but
// in no category: inputs['task-categories'].installedHandlers), or exported
// and selected (created by this run).
function taskMemberCheck({ exported, target, select, inputs }) {
  const chosen = (k) => !select || select.has(k);
  const handlers = new Set(inputs['task-categories']?.installedHandlers ?? []);
  const routines = new Set();
  for (const [k, a] of target) {
    if (HANDLER.test(k)) handlers.add(a.data?.definitionId);
    if (ROUTINE_KEY.test(k)) routines.add(a.data?.definitionId);
  }
  for (const [k, d] of exported) {
    if (HANDLER.test(k) && chosen(k)) handlers.add(d?.definitionId);
    if (ROUTINE_KEY.test(k) && chosen(k)) routines.add(d?.definitionId);
  }
  return (kind, id) => (kind === 'handler' ? isBuiltInHandler(id) || handlers.has(id) : routines.has(id));
}

export function integrationRefs(data) {
  const refs = [];
  for (const i of data?.integrations ?? []) refs.push({ connectionId: i.connectionId, operationId: i.operationId });
  for (const n of data?.treeJson?.nodes ?? []) {
    if (!String(n.definitionId).startsWith('system_integration_v1')) continue;
    const param = (id) => (n.parameters ?? []).find((p) => String(p.id ?? p.name).toLowerCase() === id)?.value;
    refs.push({ connectionId: param('connection'), operationId: param('operation') });
  }
  return refs;
}

const CONNECTION = /^connections\/[^/]+\/connection$/;
const OPERATION = /^connections\/[^/]+\/operations\/[^/]+$/;
const ROUTINE = /^routines\/[^/]+$/;
const FORM = /^kapps\/[^/]+\/forms\/[^/]+\/form$/;
const FORM_WORKFLOW = /^kapps\/[^/]+\/forms\/[^/]+\/workflows\//;
const KAPP_WORKFLOW = /^kapps\/[^/]+\/workflows\//;
const SUBMISSION_EVENT = /^Submission (Created|Submitted|Updated)$/;
const isDynamic = (v) => typeof v === 'string' && v.includes('<%');

// With a selection, only selected items are checked, and each dependency must
// be selected or in the target: connections and operations by id (an
// operation's own connection too), handlers and routines by definitionId, a
// form's kapp and a workflow's form or kapp by key.
export function preflightChecks({ plan, exported, target, config, hasSecrets, select, targetName = 'the target' }) {
  const chosen = (k) => !select || select.has(k);
  const errors = [];
  const warnings = [];
  const ids = { connection: new Set(), operation: new Set() };
  const collect = (k, d) => {
    if (CONNECTION.test(k)) ids.connection.add(d?.id);
    if (OPERATION.test(k)) ids.operation.add(d?.id);
  };
  // Target key per connection/operation id, to catch renames.
  const targetKeyById = { connection: new Map(), operation: new Map() };
  for (const [k, d] of exported) collect(k, d);
  const targetIds = { connection: new Set(), operation: new Set() };
  for (const [k, a] of target) {
    collect(k, a.data);
    if (CONNECTION.test(k)) { targetKeyById.connection.set(a.data?.id, k); targetIds.connection.add(a.data?.id); }
    if (OPERATION.test(k)) { targetKeyById.operation.set(a.data?.id, k); targetIds.operation.add(a.data?.id); }
  }
  const exportedKeyById = { connection: new Map(), operation: new Map() };
  const routineKeyById = new Map();
  const targetRoutineIds = new Set([...target].filter(([k]) => ROUTINE.test(k)).map(([, a]) => a.data?.definitionId));
  for (const [k, d] of exported) {
    if (CONNECTION.test(k)) exportedKeyById.connection.set(d?.id, k);
    if (OPERATION.test(k)) exportedKeyById.operation.set(d?.id, k);
    if (ROUTINE.test(k)) routineKeyById.set(d?.definitionId, k);
  }
  // Dependencies a selection leaves behind. Ids (connections, operations) are
  // satisfied by the target only when it holds that id; keys (handlers,
  // routines, kapps, forms) when the target holds that key.
  const needs = [];
  const depKeys = new Set();
  const needId = (k, kind, id, depKey, reason) => {
    if (!select || targetIds[kind].has(id) || !depKey) return;
    depKeys.add(depKey);
    if (!select.has(depKey)) needs.push(`${k} needs ${depKey} (${reason}), which is not selected and not in the target`);
  };
  const needKey = (k, depKey, reason) => {
    if (!select || select.has(depKey) || target.has(depKey)) return;
    needs.push(`${k} needs ${depKey} (${reason}), which is not selected and not in the target`);
  };

  const refErrors = [];
  for (const [k, d] of exported) {
    if (!chosen(k)) continue;
    for (const ref of integrationRefs(d)) {
      for (const kind of ['connection', 'operation']) {
        const id = ref[`${kind}Id`];
        if (!id || isDynamic(id)) continue;
        if (!ids[kind].has(id)) {
          refErrors.push(`${k}: references ${kind} ${id}, which is neither exported nor in the target`);
        } else {
          needId(k, kind, id, exportedKeyById[kind].get(id), `references ${kind} ${id}`);
        }
      }
    }
    if (!select) continue;
    if (OPERATION.test(k)) {
      const cid = d?.connectionId;
      const sibling = k.replace(/\/operations\/[^/]+$/, '/connection');
      if (cid) needId(k, 'connection', cid, exportedKeyById.connection.get(cid) ?? sibling, `operation of connection ${cid}`);
      else needKey(k, sibling, 'operation of this connection');
    }
    const parts = k.split('/');
    const shown = (i) => segmentLabel(parts[i]);
    if (FORM.test(k)) needKey(k, `kapps/${parts[1]}/kapp`, `form in kapp ${shown(1)}`);
    if (FORM_WORKFLOW.test(k)) needKey(k, `kapps/${parts[1]}/forms/${parts[3]}/form`, `workflow on form ${shown(3)}`);
    else if (KAPP_WORKFLOW.test(k)) needKey(k, `kapps/${parts[1]}/kapp`, `workflow on kapp ${shown(1)}`);
    for (const id of [...referencedDefinitionIds([{ data: d }])].sort()) {
      if (isBuiltInHandler(id)) continue;
      const routineKey = routineKeyById.get(id);
      // A routine is there when the target has its definitionId (under any name).
      if (routineKey && targetRoutineIds.has(id)) continue;
      const depKey = routineKey ?? keyFor('handlers', id, 'handler');
      if (exported.has(depKey)) needKey(k, depKey, routineKey ? `calls routine ${id}` : `runs handler ${id}`);
    }
  }

  // Name and rename checks for every selected key and every exported key a
  // selected item depends on by id.
  for (const [k, d] of exported) {
    if (!chosen(k) && !depKeys.has(k)) continue;
    if ((CONNECTION.test(k) || OPERATION.test(k)) && target.has(k) && target.get(k).data.id !== d.id) {
      errors.push(`${k}: the target has one with the same name but id ${target.get(k).data.id} (export has ${d.id}); reconcile by hand before promoting`);
    }
    const kind = CONNECTION.test(k) ? 'connection' : OPERATION.test(k) ? 'operation' : null;
    const otherKey = kind && d?.id !== undefined ? targetKeyById[kind].get(d.id) : undefined;
    if (otherKey && otherKey !== k) {
      errors.push(`${k}: id ${d.id} already exists in the target as ${otherKey}; it was probably renamed — reconcile by hand before promoting`);
    }
  }
  errors.push(...refErrors, ...needs);

  for (const i of plan.items) {
    if (i.action === 'excluded') continue;
    if (i.type === 'routines' && i.action === 'create' && targetRoutineIds.has(i.desired?.definitionId)) {
      const other = [...target].find(([k, a]) => ROUTINE.test(k) && a.data?.definitionId === i.desired.definitionId)?.[0];
      warnings.push(`${i.key}: ${targetName} already has routine ${other} with the same definitionId (${i.desired.definitionId}); creating it may fail — rename or remove one first`);
    }
    if (i.type === 'connections' && i.action === 'create' && !hasSecrets(i.desired.name)) {
      warnings.push(`${i.key}: will be created without credentials (set KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD> to supply them)`);
    }
    if (i.type === 'data' && isKeyless(i.source?.key) && (i.action === 'create' || i.action === 'update')) {
      const [, kapp, , form] = i.key.split('/').map(segmentLabel);
      warnings.push(`${kapp}/${form}: no match fields — a record edited in the source is created as a new record in ${targetName}`);
    }
    if (i.type === 'data' && (i.action === 'create' || i.action === 'update')) {
      // Form, kapp and space workflows on submission events, from the export
      // (applied before data) and from the target; the export wins per key.
      const kapp = i.key.split('/')[1];
      const prefixes = [i.key.replace(/data$/, 'workflows/'), `kapps/${kapp}/workflows/`, 'workflows/'];
      const candidates = new Map();
      for (const [k, d] of exported) candidates.set(k, d);
      for (const [k, a] of target) if (!candidates.has(k)) candidates.set(k, a.data);
      const fired = [...candidates]
        .filter(([k, d]) => prefixes.some((p) => k.startsWith(p)) && SUBMISSION_EVENT.test(d?.event) && d.status !== 'Inactive')
        .map(([, d]) => `${d.name} (${d.event})`);
      if (fired.length) warnings.push(`${i.key}: creating/updating rows will run these workflows in the target: ${fired.join(', ')}`);
    }
    if (i.scope === 'space' && i.existing && i.action !== 'skip-drift') {
      const exp = exported.get(i.key) ?? {};
      for (const f of config.envBoundSpaceFields ?? DEFAULT_ENV_BOUND_SPACE_FIELDS) {
        // Kept empty, though the source has a value (no override sets one).
        if (isEmptyValue(i.desired?.[f]) && !isEmptyValue(exp[f])) {
          warnings.push(`${i.key}: "${f}" is kept per environment and empty in the target; the source has a value, which is not copied (set an override to use it)`);
        }
      }
    }
    for (const name of envBoundNamesFor(config.envBoundAttributes, i.scope, i.key, i.desired)) {
      const attr = i.desired?.attributes?.find((a) => a.name === name);
      if (!attr?.values?.length) {
        warnings.push(`${i.key}: environment-bound attribute "${name}" is empty in the target and no override sets it`);
      }
    }
  }
  warnings.push(...uncategorizedWarnings(plan, target, targetName));
  return { errors, warnings };
}

// A handler or routine this plan creates that will be in no workflow category in
// the target does not appear in the workflow builder. Categories after the
// plan: what the plan writes (its desired copy), otherwise the target's own.
// Only Stored categories are read: a handler or routine that is not in the
// target yet cannot already be in a built-in (Integrated) one.
function uncategorizedWarnings(plan, target, targetName) {
  const members = new Set();
  const add = (d) => { for (const f of ['handlers', 'routines']) for (const id of d?.[f] ?? []) members.add(id); };
  const planned = new Set();
  for (const i of plan.items) {
    if (i.type !== 'task-categories') continue;
    planned.add(i.key);
    add(['create', 'update', 'unchanged'].includes(i.action) ? i.desired : i.existing?.data);
  }
  for (const [k, a] of target) if (k.startsWith('task-categories/') && !planned.has(k)) add(a.data);
  return plan.items
    .filter((i) => (i.type === 'handlers' || i.type === 'routines') && i.action === 'create' && !members.has(i.desired?.definitionId))
    .map((i) => `${i.key}: will be in no workflow category in ${targetName}, so it will not appear in the workflow builder; promote a workflow category that holds it`);
}
