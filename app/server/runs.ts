// Plans and guided apply.
// - POST plans: a job that pins the source (a changeset's commit, or the
//   newest snapshot of `from`, or an explicit commit for a restore) into
//   plans/src-<planId>/, runs the engine's computePlan with the selection and
//   returns items, counts, what needs attention, environment values and the
//   secrets needed (has-flags only).
// - POST plans/:id/apply: validates acknowledgements, required values and the
//   typed confirmation, refuses read-only targets, then (as a write job) saves
//   values to overrides/<to>.json, takes secrets for this run (or keeps them
//   in the store when `remember`), takes and commits a backup snapshot of the
//   target, runs the engine's runApply with the selection and resolutions,
//   writes runs/<stamp>-<to>.json, updates the changeset and commits.
//   Resume is another apply of the same plan: the engine re-plans and skips
//   what is already in place.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ApplyResult, AttentionKind, EnvironmentValue, NeedsAttention, PlanAction, PlanItemOut, PlanRemovalOut, PlanResult, Resolution,
  RunItemOutcome, RunRecord, RunStatus, SecretNeeded,
} from '../shared/sync-api.ts';
import { ApiError, badRequest, notFound, toApiError } from './errors.ts';
import { envBoundNamesFor, envKey, loadConfig, spaceFieldPair, loadOverrides, stableStringify, type EngineEnv } from './engine.ts';
import {
  MODULES, collectionWord, computePlan, describeFailureMessage, removalInSource, envBoundFields, isEmptyValue, isSecretName, isSecretProperty, missingRequired, parseEntryKey, parsePath, readTree, runApply, segmentLabel, stamp,
  type EngineHints, type EngineRemoval, type EnginePlan, type PlanItem, type SettingsHintParts,
} from './engine-sync.ts';
import { isOmittedKey, moduleFor } from './engine-sync.ts';
import { currentKeys, readChangeset, recordApplied, removeList } from './changesets.ts';
import { hasEnvSecret, readEnvironmentFile, readOverrides, resolveEnv, setEnvSecret } from './environments.ts';
import type { Emit } from './jobs.ts';
import { materializeTree, resolveCommit } from './pinned.ts';
import { capturingFactory, crossVersionFor, rememberPlatform } from './platforms.ts';
import { commitChange, displayName, isPlainObject, secretsId, withProjectLock, type ProjectRef } from './project-meta.ts';
import type { Router } from './router.ts';
import { RUNS_DIR } from './run-records.ts';
import { makeScrubber, scrubError } from './scrub.ts';
import {
  connectionSecretFields, connectionSecretName, handlerSecretName, handlerSecretProperties,
} from './secret-names.ts';
import type { SecretStore } from './secrets.ts';
import {
  availableHandlerSecrets, engineHints, readHandlerMemory, recordHandlerOutcomes, writeHandlerMemory, type HandlerMemory, type HandlerSettingsOutcome,
} from './handler-memory.ts';
import { forwardEvents, latestSnapshotCommit, loadSnapshot, requireEnvironment, takeSnapshot, type SyncContext } from './snapshots.ts';
import { labelFor } from './tree-index.ts';
import { commitMessage } from './trailers.ts';

interface StoredPlan {
  projectDir: string;
  result: PlanResult;
  kind: 'apply' | 'restore';
  select: Set<string>;
  sourceDir: string;
  sourcePath: string;
  resolutions: Record<string, Resolution>;
  // Removals reviewed as deletes (the only ones apply is given), and each
  // one's fingerprint as reviewed (an item changed since is not deleted).
  remove: string[];
  removeExpected: Record<string, string>;
  // Selected keys left out of the plan (connections the Integrator could not
  // be read for), with why: reported skipped at apply, never written unreviewed.
  leftOut: Record<string, string>;
}

const MAX_PLANS = 50;
const plans = new Map<string, StoredPlan>();

// Plans whose apply is running are never evicted (their source folder is in use).
const applying = new Set<string>();

function remember(id: string, plan: StoredPlan): void {
  plans.set(id, plan);
  for (const [oldId, old] of plans) {
    if (plans.size <= MAX_PLANS) break;
    if (applying.has(oldId) || oldId === id) continue;
    plans.delete(oldId);
    rmSync(old.sourceDir, { recursive: true, force: true });
  }
}

// At server start: source folders (plans/src-*) of plans that no longer
// exist, unfinished snapshot exports (plans/snap-*) and replaced snapshots
// that could not be deleted (plans/old-*), for example from before a restart
// or a crash.
export function removeStaleWorkFolders(projectDir: string): void {
  const dir = path.join(projectDir, 'plans');
  if (!existsSync(dir)) return;
  const live = new Set([...plans.values()].map((p) => p.sourceDir));
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (/^(src|snap|old)-/.test(name) && !live.has(full)) rmSync(full, { recursive: true, force: true });
  }
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const same = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);
const escapeSeg = (s: string) => s.replace(/\./g, '\\.');

// Reads an override path the way the engine sets it: arrays by element name,
// a named attribute's `values`.
function getPath(data: unknown, p: string): unknown {
  let cur: unknown = data;
  const segs = parsePath(p);
  for (let i = 0; i < segs.length; i++) {
    if (Array.isArray(cur)) {
      const el = cur.find((e) => obj(e).name === segs[i]);
      if (el === undefined) return undefined;
      cur = i === segs.length - 1 && 'values' in obj(el) ? obj(el).values : el;
    } else if (cur && typeof cur === 'object') cur = (cur as Obj)[segs[i]];
    else return undefined;
  }
  return cur;
}

const attributeValues = (data: unknown, name: string) => obj(data).attributes?.find?.((a: Obj) => a?.name === name)?.values;

function environmentValues(projectDir: string, to: string, items: PlanItem[], exported: Map<string, unknown>): EnvironmentValue[] {
  const overrides = loadOverrides(projectDir, to);
  const config = loadConfig(projectDir);
  const eba = config.envBoundAttributes ?? {};
  const out: EnvironmentValue[] = [];
  const push = (v: Omit<EnvironmentValue, 'id'>) => {
    if (parsePath(v.path).some(isSecretName)) return;
    out.push({ id: `${v.key}#${v.path}`, ...v });
  };
  for (const i of items) {
    const exp = exported.get(i.key);
    const own = (overrides.artifacts?.[i.key] ?? {}) as Record<string, unknown>;
    for (const [p, v] of Object.entries(own)) push({ key: i.key, path: p, label: p, from: getPath(exp, p) ?? null, to: v, origin: 'override', required: false });
    const scope = i.scope ?? '';
    const chosen = scope === 'space' ? new Set(config.envBoundSpaceFields ?? []) : new Set<string>();
    for (const f of envBoundFields(scope, config.envBoundSpaceFields)) {
      if (f in own) continue;
      const from = obj(exp)[f];
      const to = obj(i.desired)[f];
      if (same(from, to)) continue;
      // A kept space setting is never copied. When the target has no value
      // (for a pair: either half) and the source has one, the source value is
      // offered for the user to take on purpose; a pair is offered whole.
      const pair = chosen.has(f) ? spaceFieldPair(f) : null;
      const members = pair ?? [f];
      const unset = chosen.has(f) && members.some((m) => isEmptyValue(obj(i.desired)[m])) && members.some((m) => !isEmptyValue(obj(exp)[m]));
      push({
        key: i.key, path: escapeSeg(f), label: f, from: from ?? null, to: to ?? null, origin: 'environment', required: false,
        ...(unset ? { suggested: from ?? null } : {}), ...(unset && pair ? { pair: pair.join('+') } : {}),
      });
    }
    for (const name of envBoundNamesFor(eba, i.scope, i.key, i.desired)) {
      const p = `attributes.${escapeSeg(name)}`;
      if (p in own) continue;
      const to = attributeValues(i.desired, name);
      push({ key: i.key, path: p, label: name, from: attributeValues(exp, name) ?? null, to: to ?? null, origin: 'attribute', required: !(Array.isArray(to) && to.length) });
    }
    if (scope === 'handler') {
      for (const prop of obj(i.desired).properties ?? []) {
        if (!prop?.name || isSecretProperty(prop)) continue;
        const p = `properties.${escapeSeg(prop.name)}.value`;
        if (p in own) continue;
        const from = obj(exp).properties?.find?.((x: Obj) => x?.name === prop.name)?.value;
        push({ key: i.key, path: p, label: prop.name, from: from ?? null, to: prop.value ?? null, origin: 'setting', required: false });
      }
    }
  }
  return out;
}

// Required handler properties that are (or may be) empty in the target: read
// empty from it, named empty by the platform last time, or not in its copy.
function knownEmpty(i: PlanItem, memory: HandlerMemory): Set<string> {
  const d = obj(i.desired);
  const out = new Set<string>(obj(i.existing?.meta).unsetRequired ?? []);
  for (const n of memory.empty[String(d.definitionId)] ?? []) out.add(n);
  const there = new Set((obj(i.existing?.data).properties ?? []).map((p: Obj) => p?.name));
  for (const p of d.properties ?? []) if (p?.required && !there.has(p.name)) out.add(p.name);
  return out;
}

// Secret properties of a handler the plan offers (write-only), each with a
// hint: every one for an install or a package re-install; for an update,
// every required one (the target never shows its value, so it can always be
// entered or replaced), plus any entered and not yet accepted.
function handlerSecretsOffered(i: PlanItem, memory: HandlerMemory, To: string): Array<{ prop: string; hint?: string }> {
  const d = obj(i.desired);
  const all = handlerSecretProperties(d);
  if (i.action === 'create') return all.map((prop) => ({ prop }));
  if (i.action !== 'update' || !i.existing) return [];
  const id = String(d.definitionId);
  const repackaged = d.packageSha256 !== obj(i.existing.data).packageSha256;
  const required = new Set((d.properties ?? []).filter((p: Obj) => p?.required).map((p: Obj) => p.name));
  const pending = new Set(memory.pending);
  const empty = knownEmpty(i, memory);
  return all
    .filter((prop) => repackaged || required.has(prop) || empty.has(prop) || pending.has(handlerSecretName(id, prop)))
    .map((prop) => ({
      prop,
      hint: empty.has(prop) && required.has(prop)
        ? `Empty in ${To}; needed before the handler's settings can be saved.`
        : `Not readable in ${To} — leave blank to keep ${To}'s value.`,
    }));
}

async function secretsNeeded(store: SecretStore, ref: ProjectRef, to: string, items: PlanItem[], memory: HandlerMemory): Promise<SecretNeeded[]> {
  const out: SecretNeeded[] = [];
  for (const i of items) {
    const d = obj(i.desired);
    if (i.type === 'connections' && i.action === 'create') {
      const conn = String(d.name ?? segmentLabel(i.key.split('/')[1]));
      for (const f of connectionSecretFields(d)) {
        const name = connectionSecretName(conn, f);
        out.push({ id: `secret/${name}`, key: i.key, scope: 'secret', name, label: `${conn} › ${f}`, has: await hasEnvSecret(store, ref, to, 'secret', name) });
      }
    }
    if (i.type === 'handlers') {
      const id = String(d.definitionId ?? segmentLabel(i.key.split('/')[1]));
      for (const { prop, hint } of handlerSecretsOffered(i, memory, displayName(to))) {
        const name = handlerSecretName(id, prop);
        out.push({
          id: `handler/${name}`, key: i.key, scope: 'handler', name, label: `${d.name ?? id} › ${prop}`, has: await hasEnvSecret(store, ref, to, 'handler', name),
          ...(hint ? { hint } : {}),
        });
      }
    }
  }
  return out;
}

// Required handler settings that would still be empty after the apply (see
// missingRequired), each with what fills it: a secret (by its id) or an
// environment value (by its id).
function handlerSettingsNeeded(i: PlanItem, secrets: SecretNeeded[], hints: EngineHints): Array<{ name: string; valueId: string }> {
  if (i.type !== 'handlers' || (i.action !== 'create' && i.action !== 'update')) return [];
  const d = obj(i.desired);
  const id = String(d.definitionId ?? segmentLabel(i.key.split('/')[1]));
  const secretId = (p: string) => `handler/${handlerSecretName(id, p)}`;
  const props: Obj[] = d.properties ?? [];
  const has = (p: string) => secrets.some((s) => s.id === secretId(p) && s.has);
  return missingRequired(d, i.existing, has, hints.handlers).map((name) => ({
    name,
    valueId: isSecretProperty(props.find((p) => p?.name === name)) ? secretId(name) : `${i.key}#properties.${escapeSeg(name)}.value`,
  }));
}

const DATA_WORKFLOWS = /^(.+?): creating\/updating rows will run these workflows in the target: (.+)$/;

function needsAttention(to: string, items: PlanItem[], warnings: string[], secrets: SecretNeeded[], hints: EngineHints): NeedsAttention[] {
  const out: NeedsAttention[] = [];
  const add = (kind: AttentionKind, key: string, message: string) => out.push({ id: `${kind}:${key}`, kind, key, message });
  const To = displayName(to);
  for (const i of items) {
    const name = labelFor(i.key, i.desired);
    const writes = i.action === 'create' || i.action === 'update';
    if (i.type === 'handlers' && writes) add('handler', i.key, i.action === 'create' ? `Installs handler ${name} in ${To}.` : `Upgrades handler ${name} in ${To}.`);
    if ((i.type === 'forms' || i.type === 'kapps') && writes) {
      const changed = i.action === 'create' ? (obj(i.desired).indexDefinitions ?? []).length > 0 : i.diff.some((d) => d.path.startsWith('indexDefinitions'));
      if (changed) add('index', i.key, `Rebuilds search indexes of ${name}; searches on it may be incomplete until the rebuild finishes.`);
    }
    if (i.drift) add('drift', i.key, `${name} was changed in ${To} since it was last promoted; overwriting replaces those changes.`);
    if (i.type === 'connections' && i.action === 'create' && secrets.some((s) => s.key === i.key && !s.has)) {
      add('connection-secrets', i.key, `Connection ${name} will be created without credentials unless you enter them.`);
    }
    // The Task API saves none of a handler's settings while a required one is
    // empty: each is filled in under Environment values (a secret or a
    // setting), or ticked to install without it.
    for (const n of handlerSettingsNeeded(i, secrets, hints)) {
      out.push({
        id: `handler-settings:${i.key}#${n.name}`, kind: 'handler-settings', key: i.key, valueId: n.valueId,
        message: `${name} needs ${n.name} before its settings can be saved in ${To}.`,
      });
    }
  }
  for (const w of warnings) {
    const m = DATA_WORKFLOWS.exec(w);
    if (m) add('data-workflows', m[1], `Writing the reference data of ${segmentLabel(m[1].split('/')[3] ?? '')} runs these workflows in ${To}: ${m[2]}.`);
  }
  return out;
}

// An entry's removal reads "Hardware (category of Services)".
function removalLabel(r: EngineRemoval): Pick<PlanRemovalOut, 'label' | 'entry'> {
  if (!r.entry) return { label: labelFor(r.key, r.existing?.data) };
  const p = parseEntryKey(r.key)!;
  const name = r.entry.name ?? segmentLabel(p.segment);
  const itemLabel = labelFor(r.entry.itemKey, undefined);
  return { label: `${name} (${collectionWord(r.entry.field)} of ${itemLabel})`, entry: { item: r.entry.itemKey, itemLabel, collection: r.entry.field, name } };
}

function removalsOut(plan: EnginePlan): PlanRemovalOut[] {
  return (plan.removals ?? []).map((r) => ({
    key: r.key, type: r.type, action: r.action, ...removalLabel(r),
    children: r.children.map((c) => ({ key: c.key, type: c.type, label: labelFor(c.key, c.existing?.data) })),
    usedBy: r.usedBy.map((u) => ({ key: u.key, label: labelFor(u.key, undefined), reason: u.reason, onlyTarget: u.onlyTarget })),
    notes: r.notes, restore: r.restore,
  }));
}

function buildResult(base: Omit<PlanResult, 'items' | 'removals' | 'counts' | 'needsAttention' | 'environmentValues' | 'secretsNeeded' | 'errors' | 'warnings'>, plan: EnginePlan, extra: {
  environmentValues: EnvironmentValue[]; secretsNeeded: SecretNeeded[]; hints: EngineHints;
}): PlanResult {
  const active = plan.items.filter((i) => i.action !== 'excluded');
  const counts: PlanResult['counts'] = { create: 0, update: 0, unchanged: 0, manual: 0, 'skip-drift': 0, delete: 0 };
  const items: PlanItemOut[] = active.map((i) => {
    counts[i.action as PlanAction]++;
    return { key: i.key, type: i.type, label: labelFor(i.key, i.desired), action: i.action as PlanAction, drift: i.drift, diff: i.diff };
  });
  const removals = removalsOut(plan);
  counts.delete = removals.filter((r) => r.action === 'delete').length;
  return {
    ...base, items, removals, counts,
    needsAttention: needsAttention(base.to, active, plan.warnings, extra.secretsNeeded, extra.hints),
    environmentValues: extra.environmentValues, secretsNeeded: extra.secretsNeeded,
    errors: plan.errors, warnings: plan.warnings,
  };
}

const keyList = (v: unknown, allowEmpty = false): string[] => {
  if (v === undefined && allowEmpty) return [];
  if (!Array.isArray(v) || (!v.length && !allowEmpty) || !v.every((k) => typeof k === 'string')) throw badRequest('"selected" must be a non-empty list of item keys.');
  return [...new Set(v as string[])].sort();
};

const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

function resolutionsOf(v: unknown): Record<string, Resolution> {
  if (v === undefined) return {};
  if (!isPlainObject(v) || !Object.values(v).every((r) => r === 'overwrite' || r === 'keep')) throw badRequest('"resolutions" maps item keys to "overwrite" or "keep".');
  return v as Record<string, Resolution>;
}

async function startPlan(ctx: SyncContext, ref: ProjectRef, body: unknown): Promise<string> {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) {
    if (!['to', 'changesetId', 'from', 'selected', 'remove', 'sourceCommit', 'restore', 'resolutions'].includes(k)) throw badRequest(`Unknown field "${k}".`);
  }
  const to = requireEnvironment(ref, body.to);
  const resolutions = resolutionsOf(body.resolutions);
  let remove = removeList(body.remove);
  if (remove.length && body.restore === true) throw badRequest('A restore cannot remove items.');
  // Removals not planned, and why (warnings in the plan).
  const unplanned: string[] = [];
  let from: string;
  let keys: string[];
  let commit: string | null;
  let name: string;
  let changesetId: string | null = null;
  const kind = body.restore === true ? 'restore' : 'apply';
  if (body.changesetId !== undefined) {
    if (typeof body.changesetId !== 'string') throw badRequest('"changesetId" must be a changeset id.');
    const cs = readChangeset(ref, body.changesetId);
    ({ from, sourceCommit: commit, name } = cs);
    // Keys of a changeset from before the file-name change follow its pinned tree.
    keys = await currentKeys(ref, cs);
    // A changeset's removals were chosen against one environment: only
    // planned against that one (legacy unbound ones need confirming first).
    const saved = cs.remove ?? [];
    if (saved.length && cs.removeFrom === to) remove = [...new Set([...saved, ...remove])].sort();
    else if (saved.length && !cs.removeFrom) {
      unplanned.push(`This changeset's ${items(saved.length).replace(/item/, 'removal')} were saved without a target environment and are not planned: confirm them for ${displayName(to)} on the changeset's page, then plan again`);
    } else if (saved.length) {
      unplanned.push(`This changeset's ${items(saved.length).replace(/item/, 'removal')} were chosen for ${displayName(cs.removeFrom!)} and are not planned against ${displayName(to)}`);
    }
    changesetId = cs.id;
  } else {
    from = requireEnvironment(ref, body.from);
    keys = keyList(body.selected, remove.length > 0);
    if (body.sourceCommit !== undefined) {
      commit = typeof body.sourceCommit === 'string' ? await resolveCommit(ref.dir, body.sourceCommit) : null;
      if (!commit) throw badRequest('"sourceCommit" is not a commit of this project.');
    } else commit = await latestSnapshotCommit(ref, from);
    if (!commit) throw new ApiError(404, 'no_snapshot', `There is no snapshot of ${displayName(from)} yet: take one first.`);
    name = kind === 'restore' ? `Restore of ${displayName(to)}`
      : !keys.length ? `Remove ${items(remove.length)} from ${displayName(to)}`
        : `${items(keys.length)} from ${displayName(from)}${remove.length ? `, ${remove.length} to remove` : ''}`;
  }
  // A restore only brings back what a backup holds: it never removes.
  if (kind === 'restore') remove = [];
  if (from === to && kind !== 'restore') throw badRequest('The source and target are the same environment.');
  await secretsId(ref);
  const env = await resolveEnv(ref, to, ctx.secrets);
  const planId = randomUUID();
  const sourcePath = `snapshots/${from}`;
  const sourceDir = path.join(ref.dir, 'plans', `src-${planId}`);
  const pinned = commit;
  const known = [env.password, ...Object.values(env.vars)];
  return ctx.jobs.createJob('plan', (emit, signal) => runPlanJob(emit, signal).catch((err) => {
    rmSync(sourceDir, { recursive: true, force: true });
    throw scrubError(err, known);
  }));
  async function runPlanJob(emit: Emit, signal: AbortSignal): Promise<PlanResult> {
    if (!(await materializeTree(ref.dir, pinned, sourcePath, sourceDir))) {
      throw new ApiError(404, 'no_snapshot', `The pinned snapshot of ${displayName(from)} is missing from the project history.`);
    }
    const select = new Set(keys);
    // An item that is in the newest snapshot of the source again (not only the
    // pinned one) is not removed.
    const newest = remove.length ? await latestSnapshotCommit(ref, from) : null;
    // Removals the newest snapshot could not check (it left their type out)
    // are dropped with a warning saying why: never sent, never blocking.
    const refused: string[] = [];
    if (newest && newest !== pinned) {
      const latest = (await loadSnapshot(ref, from)).artifacts;
      for (const o of latest.omitted ?? []) {
        const types = new Set(o.types);
        const unknown = remove.filter((k) => isOmittedKey(k.split('#')[0], types, (x) => moduleFor(x)?.type));
        for (const k of unknown) refused.push(`${k}: not removed — couldn't check ${displayName(from)}'s connections: ${o.message}`);
        remove = remove.filter((k) => !unknown.includes(k));
      }
      const back = remove.filter((k) => removalInSource(k, latest, MODULES));
      for (const k of back) unplanned.push(`${k}: still exists in ${displayName(from)} (newest snapshot) — not removed`);
      remove = remove.filter((k) => !back.includes(k));
    }
    const memory = readHandlerMemory(ref.dir, to);
    const hints = engineHints(memory, availableHandlerSecrets(to, env.vars));
    const capture = capturingFactory(ctx.clientFactory);
    const { plan } = await computePlan({
      projectDir: ref.dir, envName: to, env, sourceDir, sourceName: from, select, resolutions, remove, onEvent: forwardEvents(emit, [env.password, ...Object.values(env.vars)]),
      signal, clientFactory: capture.factory, hints,
    });
    rememberPlatform(ref.dir, to, await capture.platform());
    plan.warnings.push(...unplanned);
    plan.warnings.push(...refused);
    // Only what the plan shows as a delete is ever sent to apply.
    const deletes = (plan.removals ?? []).filter((x) => x.action === 'delete' && x.hash);
    const removeExpected = Object.fromEntries(deletes.map((x) => [x.key, x.hash!]));
    const active = plan.items.filter((i) => i.action !== 'excluded');
    // Keys of a type left out of the plan (connections when either side has
    // none recorded) are skipped with the plan's note, not refused.
    const leftOutTypes = new Set(plan.omitted ?? []);
    const isLeftOut = (k: string) => !plan.items.some((i) => i.key === k) && isOmittedKey(k, leftOutTypes, (x) => moduleFor(x)?.type);
    const why = plan.omissions?.[0];
    const leftOut = Object.fromEntries(keys.filter(isLeftOut).map((k) => [k, why
      ? `Not applied: ${why.live ? `${displayName(why.name)}'s connections couldn't be read` : `${displayName(why.name)}'s snapshot has none recorded`} — ${why.message}`
      : 'Not applied: connections and operations were left out of this plan.']));
    for (const k of Object.keys(leftOut)) select.delete(k);
    const missing = keys.filter((k) => !plan.items.some((i) => i.key === k) && !isLeftOut(k));
    if (missing.length) plan.errors.push(...missing.map((k) => `${k}: not in the source snapshot`));
    const secrets = await secretsNeeded(ctx.secrets, ref, to, active, memory);
    const result = buildResult({ planId, name, to, from, changesetId, sourceCommit: pinned, selected: keys, remove }, plan, {
      environmentValues: environmentValues(ref.dir, to, active, readTree(sourceDir)), secretsNeeded: secrets, hints,
    });
    // Cross-major promotions are allowed, with a warning in the header.
    const crossVersion = from === to ? null : crossVersionFor(ref.dir, from, to);
    if (crossVersion) result.crossVersion = crossVersion;
    const scrubbed = makeScrubber([env.password, ...Object.values(env.vars)])(result);
    remember(planId, { projectDir: ref.dir, result: scrubbed, kind, select, sourceDir, sourcePath, resolutions, remove: deletes.map((x) => x.key), removeExpected, leftOut });
    return scrubbed;
  }
}

// ---- Apply -----------------------------------------------------------------

interface ApplyInput {
  acknowledgements: string[];
  values: Record<string, Record<string, unknown>>;
  secrets: Record<string, string>;
  remember: boolean;
  resolutions: Record<string, Resolution>;
}

function validateApply(plan: StoredPlan, body: unknown, readOnly: boolean): ApplyInput {
  const r = plan.result;
  if (readOnly) throw new ApiError(403, 'read_only', `${displayName(r.to)} is protected (read-only); nothing can be applied to it.`);
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) {
    if (!['acknowledgements', 'values', 'secrets', 'remember', 'resolutions', 'confirm'].includes(k)) throw badRequest(`Unknown field "${k}".`);
  }
  if (body.confirm !== r.to) throw new ApiError(400, 'confirmation_required', `Type "${r.to}" to confirm.`);
  if (r.errors.length) throw new ApiError(409, 'plan_has_errors', 'The plan has errors; fix them and plan again.', { errors: r.errors });
  const acks = body.acknowledgements ?? [];
  if (!Array.isArray(acks) || !acks.every((a) => typeof a === 'string')) throw badRequest('"acknowledgements" is a list of ids.');
  const values = body.values ?? {};
  if (!isPlainObject(values) || !Object.values(values).every(isPlainObject)) throw badRequest('"values" maps item keys to { path: value }.');
  // Only the environment values the plan listed (which never include secrets).
  const planned = new Set(r.environmentValues.map((v) => v.id));
  for (const [key, paths] of Object.entries(values)) {
    for (const p of Object.keys(paths as Obj)) {
      let segs: string[];
      try { segs = parsePath(p); } catch { throw badRequest(`Invalid value path "${p}".`); }
      if (segs.some(isSecretName)) throw new ApiError(400, 'secret_value', 'Secrets cannot be saved as environment values; enter them as secrets.');
      if (!planned.has(`${key}#${p}`)) throw badRequest(`"values" names a value that is not in the plan: ${key} ${p}`);
    }
  }
  const secrets = body.secrets ?? {};
  const known = new Set(r.secretsNeeded.map((s) => s.id));
  if (!isPlainObject(secrets) || !Object.entries(secrets).every(([id, v]) => known.has(id) && typeof v === 'string' && v !== '')) {
    throw badRequest('"secrets" maps the ids of the secrets needed to non-empty values.');
  }
  if (body.remember !== undefined && typeof body.remember !== 'boolean') throw badRequest('"remember" is true or false.');
  const resolutions = { ...plan.resolutions, ...resolutionsOf(body.resolutions) };

  const given = (key: string, p: string) => {
    const v = (values as Obj)[key]?.[p];
    return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && !v.length);
  };
  const required = r.needsAttention.filter((n) => {
    if (n.kind === 'drift') return resolutions[n.key] === 'overwrite';
    if (n.kind === 'connection-secrets') return r.secretsNeeded.some((s) => s.key === n.key && !s.has && !(s.id in secrets));
    // Taken care of by entering what it needs: the secret, or the value.
    if (n.kind === 'handler-settings' && n.valueId) {
      if (n.valueId in secrets) return false;
      const [key, ...rest] = n.valueId.split('#');
      return !given(key, rest.join('#'));
    }
    return true;
  });
  const missingAcks = required.map((n) => n.id).filter((id) => !acks.includes(id));
  if (missingAcks.length) throw new ApiError(400, 'acknowledgement_required', 'Tick every item that needs attention first.', { missing: missingAcks });
  const missingValues = r.environmentValues.filter((v) => v.required && !given(v.key, v.path)).map((v) => v.id);
  if (missingValues.length) throw new ApiError(400, 'values_required', 'Some environment values are required.', { missing: missingValues });
  return { acknowledgements: acks as string[], values: values as ApplyInput['values'], secrets: secrets as Record<string, string>, remember: body.remember === true, resolutions };
}

// A platform failure as the platform's own message and error list (names,
// redacted and capped), or its status alone; any other failure as it is.
const HTTP_FAILURE = /failed with (\d{3})/;
const plainFailure = (message: unknown) => {
  const described = describeFailureMessage(message);
  if (described) return described;
  const m = HTTP_FAILURE.exec(String(message ?? ''));
  return m ? `The Kinetic Platform returned an error (${m[1]}).` : String(message ?? 'This item failed.');
};

function skipReason(action: string | undefined, To: string): string | null {
  if (action === 'skip-drift') return `Changed in ${To} since you reviewed it — not applied.`;
  if (action === 'manual') return `Now needs a change by hand in ${To} — not applied.`;
  if (action === undefined || action === 'excluded') return `No longer part of the plan against ${To} — not applied.`;
  return null;
}

async function runApplyJob(ctx: SyncContext, ref: ProjectRef, plan: StoredPlan, input: ApplyInput, emit: Emit, signal: AbortSignal): Promise<ApplyResult> {
  const r = plan.result;
  const To = displayName(r.to);
  const started = new Date().toISOString();
  const secretValues = Object.values(input.secrets);
  const step = (name: string, status: string) => emit({ type: 'step', step: name, status });

  // 1. Environment values.
  if (Object.keys(input.values).length) {
    const current = readOverrides(ref, r.to);
    for (const [key, paths] of Object.entries(input.values)) current.artifacts[key] = { ...(current.artifacts[key] ?? {}), ...paths };
    mkdirSync(path.join(ref.dir, 'overrides'), { recursive: true });
    writeFileSync(path.join(ref.dir, 'overrides', `${r.to}.json`), stableStringify(current));
    await commitChange(ref, commitMessage(`Updated environment values for ${To}`, { Environment: r.to }));
  }

  // 2. Secrets: kept in the store, or for this run only.
  const extraVars: Record<string, string> = {};
  for (const s of r.secretsNeeded) {
    const value = input.secrets[s.id];
    if (value === undefined) continue;
    if (input.remember) await setEnvSecret(ctx.secrets, ref, r.to, s.scope, s.name, value);
    else extraVars[`KINETIC_${envKey(r.to)}_${s.scope === 'secret' ? 'SECRET' : 'HANDLER'}_${s.name}`] = value;
  }
  const env: EngineEnv = await resolveEnv(ref, r.to, ctx.secrets, extraVars);
  // Handler secrets entered now are sent with the next settings write; kept
  // ones stay pending (names only) until the target accepts one.
  const supplied = r.secretsNeeded.filter((s) => s.scope === 'handler' && input.secrets[s.id] !== undefined).map((s) => s.name);
  const memory = readHandlerMemory(ref.dir, r.to);
  if (input.remember && supplied.length) writeHandlerMemory(ref.dir, r.to, { ...memory, pending: [...memory.pending, ...supplied] });
  const hints = engineHints(readHandlerMemory(ref.dir, r.to), availableHandlerSecrets(r.to, env.vars), supplied);
  // What an unsaved handler's message offers: entering them here only when
  // the plan has an input for each.
  const settingsHint = (parts: SettingsHintParts): string | null => {
    if (parts.unknown.length) return null;
    const offered = parts.secrets.every((p) => r.secretsNeeded.some((s) => s.key === parts.key && s.name === handlerSecretName(parts.definitionId, p)));
    if (!offered) return null;
    return parts.settings.length ? 'or enter them under Environment values and apply again' : 'or enter them here and apply again';
  };
  const known = [env.password, ...Object.values(env.vars), ...secretValues];
  const scrub = makeScrubber(known);

  // 3. Backup snapshot of the target.
  step('backup', 'running');
  const backup = await takeSnapshot({
    ref, env, title: `Backup of ${To} before applying '${r.name}'`, trailers: { Plan: r.planId }, always: true,
    onEvent: forwardEvents(emit, known, (e) => (e.type === 'progress' ? { ...e, phase: 'backup' } : e)), signal, clientFactory: ctx.clientFactory,
  });
  const backupCommit = backup.commit ?? await latestSnapshotCommit(ref, r.to);
  step('backup', 'done');

  // 4. Apply the selection.
  const outcomes = new Map<string, RunItemOutcome>();
  // Whether the apply started writing to the target (a row went running).
  let wrote = false;
  const onEvent = forwardEvents(emit, known, (e) => {
    if (e.type !== 'item') return e;
    if (e.status === 'running') wrote = true;
    const out: RunItemOutcome = { key: String(e.key), status: e.status as RunItemOutcome['status'], ...(e.attention === true ? { attention: true } : {}) };
    if (e.status === 'failed') out.message = plainFailure(e.message);
    else if (typeof e.message === 'string' && e.message) out.message = e.message;
    outcomes.set(out.key, out);
    return { ...e, ...(out.message ? { message: out.message } : {}) };
  });
  // Items reviewed as writes that the apply-time re-plan will not write are
  // reported as skipped, with the reason: already up to date (fine), or
  // changed in the target since review, now manual, or gone (the run is then
  // partial), unless the user chose to keep the target's version.
  const skipped: string[] = [];
  // Selected items the plan had to leave out: skipped, and the run partial.
  const leftOut = Object.entries(plan.leftOut ?? {});
  const onPlan = (applyPlan: EnginePlan) => {
    for (const [key, message] of leftOut) {
      skipped.push(key);
      onEvent({ type: 'item', key, status: 'skipped', message });
    }
    if (applyPlan.errors.length) return;
    for (const reviewed of r.items) {
      if (reviewed.action !== 'create' && reviewed.action !== 'update') continue;
      if (input.resolutions[reviewed.key] === 'keep') continue;
      const now = applyPlan.items.find((i) => i.key === reviewed.key)?.action;
      if (now === 'unchanged') {
        // Already as wanted (for example written by an earlier, stopped run).
        onEvent({ type: 'item', key: reviewed.key, status: 'skipped', message: `Already up to date in ${To}.` });
        continue;
      }
      const message = skipReason(now, To);
      if (!message) continue;
      skipped.push(reviewed.key);
      onEvent({ type: 'item', key: reviewed.key, status: 'skipped', message });
    }
    // Removals reviewed as deletes: one changed since review is kept (the
    // run is then partial); one already gone is fine.
    for (const reviewed of r.removals ?? []) {
      if (reviewed.action !== 'delete') continue;
      const now = (applyPlan.removals ?? []).find((x) => x.key === reviewed.key)?.action;
      if (now === 'gone') {
        onEvent({ type: 'item', key: reviewed.key, status: 'skipped', message: `Already gone from ${To}.` });
      } else if (now !== 'delete') {
        skipped.push(reviewed.key);
        // Left out of the apply's plan (connections couldn't be read) is not "changed".
        const unchecked = now === undefined && isOmittedKey(reviewed.key.split('#')[0], new Set(applyPlan.omitted ?? []), (x) => moduleFor(x)?.type);
        onEvent({ type: 'item', key: reviewed.key, status: 'skipped', message: unchecked
          ? `Not removed: ${To}'s connections couldn't be checked.`
          : `Changed in ${To} since you reviewed it — not removed.` });
      }
    }
  };
  step('apply', 'running');
  let status: RunStatus = 'applied';
  let error: string | null = null;
  let done = 0;
  try {
    const res = await runApply({
      projectDir: ref.dir, envName: r.to, env, sourceDir: plan.sourceDir, sourceName: r.from ?? undefined, yes: true, select: plan.select, resolutions: input.resolutions,
      remove: plan.remove, removeExpected: plan.removeExpected,
      onEvent, onPlan, signal, clientFactory: ctx.clientFactory, log: () => {},
      targetLabel: To, settingsHint, hints,
      heldHint: input.remember ? 'kept for the next apply' : 'not kept: enter it again to use it',
    });
    recordHandlerOutcomes(ref.dir, r.to, res.settings);
    done = res.done;
    const leftOver = res.failed ?? [];
    const attention = res.attention ?? [];
    if (res.code !== 0) {
      status = 'failed';
      error = 'The plan has errors against the current target; nothing was applied. Plan again.';
    } else if (leftOver.length) {
      status = 'partial';
      error = `${leftOver.length === 1 ? '1 item' : `${leftOver.length} items`} a removal should have taken with it ${leftOver.length === 1 ? 'is' : 'are'} still in ${To} (see the list below).`;
    } else if (skipped.length) {
      status = 'partial';
      error = `${skipped.length === 1 ? '1 item was' : `${skipped.length} items were`} not applied or removed (see the list below). Plan again to review ${skipped.length === 1 ? 'it' : 'them'}.`;
    } else if (attention.length) {
      status = 'partial';
      error = `${attention.length === 1 ? '1 handler is' : `${attention.length} handlers are`} installed without required settings (see the list below). Enter them and apply again, or set them in ${To}'s Task console.`;
    }
  } catch (err) {
    recordHandlerOutcomes(ref.dir, r.to, (err as { settings?: HandlerSettingsOutcome[] } | null)?.settings);
    const failed = [...outcomes.values()].find((o) => o.status === 'failed' || o.status === 'running');
    done = [...outcomes.values()].filter((o) => o.status === 'done').length;
    if ((err as { name?: string } | null)?.name === 'CancelledError' || signal.aborted) {
      status = 'cancelled';
      error = 'The apply was cancelled.';
      for (const o of outcomes.values()) if (o.status === 'running') Object.assign(o, { status: 'skipped', message: 'Cancelled before it finished.' });
    } else {
      status = done ? 'partial' : 'failed';
      error = failed ? `${failed.key}: ${failed.message ?? toApiError(err).message}` : toApiError(err).message;
      // The job itself succeeds (its result records the failure): log it here.
      ctx.logger?.error(`apply ${r.planId} to ${r.to} failed${failed ? ` at ${failed.key}` : ''}`, scrubError(err, known));
    }
  }
  step('apply', status === 'applied' ? 'done' : 'failed');

  // 5. Run record, changeset and commit.
  const runId = `${stamp()}-${r.to}`;
  const values: Record<string, Record<string, unknown>> = {};
  for (const v of r.environmentValues) (values[v.key] ??= {})[v.path] = input.values[v.key]?.[v.path] ?? v.to;
  for (const [key, paths] of Object.entries(input.values)) values[key] = { ...(values[key] ?? {}), ...paths };
  const record: RunRecord = {
    id: runId, kind: plan.kind, name: r.name, planId: r.planId, changesetId: r.changesetId, from: r.from, to: r.to,
    source: { commit: r.sourceCommit, path: plan.sourcePath }, backupCommit,
    startedAt: started, finishedAt: new Date().toISOString(), status,
    selection: [...plan.select].sort(), ...(plan.remove.length ? { removals: plan.remove } : {}), acknowledgements: input.acknowledgements, resolutions: input.resolutions,
    values, secretsUsed: Object.keys(input.secrets).sort(),
    items: [...outcomes.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), done, error,
  };
  const safe = scrub(record);
  mkdirSync(path.join(ref.dir, RUNS_DIR), { recursive: true });
  writeFileSync(path.join(ref.dir, RUNS_DIR, `${runId}.json`), stableStringify(safe));
  // A changeset with items left out was not promoted to this target.
  if (r.changesetId && (status === 'applied' || status === 'partial') && !leftOut.length && existsSync(path.join(ref.dir, 'changesets', `${r.changesetId}.json`))) {
    recordApplied(ref, r.changesetId, { env: r.to, runId, at: safe.finishedAt });
  }
  // Removals actually made (as planned when none was).
  // Removals actually made; a failed run names what it tried.
  const made = plan.remove.filter((k) => outcomes.get(k)?.status === 'done').length;
  const title = runTitle(plan.kind, status, r.name, To, r.selected.length, status === 'failed' ? plan.remove.length : made, plan.remove.length);
  const commit = await commitChange(ref, commitMessage(title, { Environment: r.to, Run: runId, Changeset: r.changesetId, Plan: r.planId }));

  // 6. A fresh snapshot of the target once anything was written, so Compare,
  // Explore and the Overview see the target as the apply left it (not the
  // pre-apply backup). Not cancellable, and never changes the outcome.
  let snapshotCommit: string | null = null;
  const warnings: string[] = [];
  if (wrote) {
    step('snapshot', 'running');
    try {
      const after = plan.kind === 'restore' ? 'restoring from a backup' : `applying '${r.name}'`;
      const snap = await takeSnapshot({
        ref, env, title: `Snapshot of ${To} after ${after}`, trailers: { Plan: r.planId },
        onEvent: forwardEvents(emit, known, (e) => (e.type === 'progress' ? { ...e, phase: 'snapshot' } : e)), clientFactory: ctx.clientFactory,
      });
      snapshotCommit = snap.commit ?? await latestSnapshotCommit(ref, r.to);
      step('snapshot', 'done');
    } catch (err) {
      ctx.logger?.error('snapshot after apply', scrubError(err, known));
      step('snapshot', 'failed');
      // Kept with the run, so the Plan page and History say so instead of a plain "Applied".
      const failure = toApiError(err);
      const reason = failure.code === 'internal_error'
        ? 'an unexpected error (the details are in the server log)'
        : scrub(failure.message).replace(/[.\s]+$/, '');
      warnings.push(`The changes were applied, but the snapshot of ${To} afterwards failed: ${reason}. Take a snapshot before comparing again.`);
      emit({ type: 'warning', message: warnings[warnings.length - 1] });
      // Recording it must not turn an applied run into a failed job.
      try {
        writeFileSync(path.join(ref.dir, RUNS_DIR, `${runId}.json`), stableStringify(scrub({ ...safe, warnings })));
        await commitChange(ref, commitMessage(`Recorded that the snapshot of ${To} after the apply failed`, { Environment: r.to }));
      } catch (recordErr) {
        ctx.logger?.error('recording the failed snapshot after apply', scrubError(recordErr, known));
      }
    }
  }
  // A cancelled apply still reports what it did (the job keeps this result).
  return scrub({ runId, status, commit, backupCommit, snapshotCommit, done, error, ...(warnings.length ? { warnings } : {}) });
}

// The commit title of a run (History reads it back, see history.ts typeOf).
export function runTitle(kind: 'apply' | 'restore', status: RunStatus, name: string, To: string, promoted: number, removed: number, asked = removed): string {
  if (kind === 'restore') {
    return `${{ applied: 'Restored', partial: 'Partly restored', failed: 'Failed to restore', cancelled: 'Partly restored' }[status]} ${To} from a backup`;
  }
  // Every removal skipped (changed since review, already gone).
  if (!promoted && asked && !removed) return `Removed nothing from ${To} (${items(asked)} skipped)`;
  if (!promoted && removed) {
    return `${{ applied: 'Removed', partial: 'Partly removed', failed: 'Failed to remove', cancelled: 'Cancelled removing' }[status]} ${items(removed)} from ${To}`;
  }
  const verb = { applied: 'Applied', partial: 'Partly applied', failed: 'Failed to apply', cancelled: 'Cancelled applying' }[status];
  return `${verb} '${name}' to ${To}${removed ? ` and removed ${items(removed)}` : ''}`;
}

function findPlan(ref: ProjectRef, id: string): StoredPlan {
  const p = plans.get(id);
  if (!p || p.projectDir !== ref.dir) throw notFound('This plan has expired; plan again.');
  return p;
}

export function registerRunRoutes(router: Router, ctx: SyncContext): void {
  router.post('/api/projects/:p/plans', async ({ params, body }) => ({ status: 202, json: { jobId: await startPlan(ctx, ctx.find(params.p), body) } }));
  router.get('/api/projects/:p/plans/:id', ({ params }) => ({ json: findPlan(ctx.find(params.p), params.id).result }));
  router.post('/api/projects/:p/plans/:id/apply', async ({ params, body }) => {
    const ref = ctx.find(params.p);
    const plan = findPlan(ref, params.id);
    const input = validateApply(plan, body, readEnvironmentFile(ref.dir, plan.result.to).readOnly);
    await secretsId(ref);
    const id = plan.result.planId;
    const jobId = ctx.jobs.createJob('apply', async (emit, signal) => {
      applying.add(id);
      try {
        return await withProjectLock(ref, () => runApplyJob(ctx, ref, plan, input, emit, signal));
      } catch (err) {
        // Every secret the run could have seen: typed ones and the target's.
        const env = await resolveEnv(ref, plan.result.to, ctx.secrets).catch(() => null);
        throw scrubError(err, [...Object.values(input.secrets), ...(env ? [env.password, ...Object.values(env.vars)] : [])]);
      } finally {
        applying.delete(id);
      }
    }, {
      lockKey: `${ref.id}/${plan.result.to}`,
      resultOnCancel: true,
    });
    return { status: 202, json: { jobId } };
  });
}

