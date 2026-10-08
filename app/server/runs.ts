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
  ApplyResult, AttentionKind, EnvironmentValue, NeedsAttention, PlanAction, PlanItemOut, PlanResult, Resolution,
  RunItemOutcome, RunRecord, RunStatus, SecretNeeded,
} from '../shared/sync-api.ts';
import { ApiError, badRequest, notFound, toApiError } from './errors.ts';
import { envBoundNamesFor, envKey, loadConfig, loadOverrides, stableStringify, type EngineEnv } from './engine.ts';
import {
  ENV_BOUND_FIELDS, computePlan, isSecretName, isSecretProperty, parsePath, readTree, runApply, stamp, type EnginePlan, type PlanItem,
} from './engine-sync.ts';
import { readChangeset, recordApplied } from './changesets.ts';
import { hasEnvSecret, readEnvironmentFile, readOverrides, resolveEnv, setEnvSecret } from './environments.ts';
import type { Emit } from './jobs.ts';
import { materializeTree, resolveCommit } from './pinned.ts';
import { commitChange, displayName, isPlainObject, secretsId, withProjectLock, type ProjectRef } from './project-meta.ts';
import type { Router } from './router.ts';
import { RUNS_DIR } from './run-records.ts';
import { makeScrubber, scrubError } from './scrub.ts';
import {
  connectionSecretFields, connectionSecretName, handlerSecretName, handlerSecretProperties,
} from './secret-names.ts';
import type { SecretStore } from './secrets.ts';
import { forwardEvents, latestSnapshotCommit, requireEnvironment, takeSnapshot, type SyncContext } from './snapshots.ts';
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
  const eba = loadConfig(projectDir).envBoundAttributes ?? {};
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
    for (const f of ENV_BOUND_FIELDS[scope] ?? []) {
      if (f in own) continue;
      const from = obj(exp)[f];
      const to = obj(i.desired)[f];
      if (!same(from, to)) push({ key: i.key, path: escapeSeg(f), label: f, from: from ?? null, to: to ?? null, origin: 'environment', required: false });
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

async function secretsNeeded(store: SecretStore, ref: ProjectRef, to: string, items: PlanItem[]): Promise<SecretNeeded[]> {
  const out: SecretNeeded[] = [];
  for (const i of items) {
    if (i.action !== 'create') continue;
    const d = obj(i.desired);
    if (i.type === 'connections') {
      const conn = String(d.name ?? i.key.split('/')[1]);
      for (const f of connectionSecretFields(d)) {
        const name = connectionSecretName(conn, f);
        out.push({ id: `secret/${name}`, key: i.key, scope: 'secret', name, label: `${conn} › ${f}`, has: await hasEnvSecret(store, ref, to, 'secret', name) });
      }
    }
    if (i.type === 'handlers') {
      const id = String(d.definitionId ?? i.key.split('/')[1]);
      for (const p of handlerSecretProperties(d)) {
        const name = handlerSecretName(id, p);
        out.push({ id: `handler/${name}`, key: i.key, scope: 'handler', name, label: `${d.name ?? id} › ${p}`, has: await hasEnvSecret(store, ref, to, 'handler', name) });
      }
    }
  }
  return out;
}

const DATA_WORKFLOWS = /^(.+?): creating\/updating rows will run these workflows in the target: (.+)$/;

function needsAttention(to: string, items: PlanItem[], warnings: string[], secrets: SecretNeeded[]): NeedsAttention[] {
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
  }
  for (const w of warnings) {
    const m = DATA_WORKFLOWS.exec(w);
    if (m) add('data-workflows', m[1], `Writing the reference data of ${m[1].split('/')[3]} runs these workflows in ${To}: ${m[2]}.`);
  }
  return out;
}

function buildResult(base: Omit<PlanResult, 'items' | 'counts' | 'needsAttention' | 'environmentValues' | 'secretsNeeded' | 'errors' | 'warnings'>, plan: EnginePlan, extra: {
  environmentValues: EnvironmentValue[]; secretsNeeded: SecretNeeded[];
}): PlanResult {
  const active = plan.items.filter((i) => i.action !== 'excluded');
  const counts: PlanResult['counts'] = { create: 0, update: 0, unchanged: 0, manual: 0, 'skip-drift': 0, delete: 0 };
  const items: PlanItemOut[] = active.map((i) => {
    counts[i.action as PlanAction]++;
    return { key: i.key, type: i.type, label: labelFor(i.key, i.desired), action: i.action as PlanAction, drift: i.drift, diff: i.diff };
  });
  return {
    ...base, items, counts,
    needsAttention: needsAttention(base.to, active, plan.warnings, extra.secretsNeeded),
    environmentValues: extra.environmentValues, secretsNeeded: extra.secretsNeeded,
    errors: plan.errors, warnings: plan.warnings,
  };
}

const keyList = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.length || !v.every((k) => typeof k === 'string')) throw badRequest('"selected" must be a non-empty list of item keys.');
  return [...new Set(v as string[])].sort();
};

function resolutionsOf(v: unknown): Record<string, Resolution> {
  if (v === undefined) return {};
  if (!isPlainObject(v) || !Object.values(v).every((r) => r === 'overwrite' || r === 'keep')) throw badRequest('"resolutions" maps item keys to "overwrite" or "keep".');
  return v as Record<string, Resolution>;
}

async function startPlan(ctx: SyncContext, ref: ProjectRef, body: unknown): Promise<string> {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
  for (const k of Object.keys(body)) {
    if (!['to', 'changesetId', 'from', 'selected', 'sourceCommit', 'restore', 'resolutions'].includes(k)) throw badRequest(`Unknown field "${k}".`);
  }
  const to = requireEnvironment(ref, body.to);
  const resolutions = resolutionsOf(body.resolutions);
  let from: string;
  let keys: string[];
  let commit: string | null;
  let name: string;
  let changesetId: string | null = null;
  const kind = body.restore === true ? 'restore' : 'apply';
  if (body.changesetId !== undefined) {
    if (typeof body.changesetId !== 'string') throw badRequest('"changesetId" must be a changeset id.');
    const cs = readChangeset(ref, body.changesetId);
    ({ from, keys, sourceCommit: commit, name } = cs);
    changesetId = cs.id;
  } else {
    from = requireEnvironment(ref, body.from);
    keys = keyList(body.selected);
    if (body.sourceCommit !== undefined) {
      commit = typeof body.sourceCommit === 'string' ? await resolveCommit(ref.dir, body.sourceCommit) : null;
      if (!commit) throw badRequest('"sourceCommit" is not a commit of this project.');
    } else commit = await latestSnapshotCommit(ref, from);
    if (!commit) throw new ApiError(404, 'no_snapshot', `There is no snapshot of ${displayName(from)} yet: take one first.`);
    name = kind === 'restore' ? `Restore of ${displayName(to)}` : `${keys.length} item${keys.length === 1 ? '' : 's'} from ${displayName(from)}`;
  }
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
    const { plan } = await computePlan({
      projectDir: ref.dir, envName: to, env, sourceDir, select, resolutions, onEvent: forwardEvents(emit, [env.password, ...Object.values(env.vars)]),
      signal, clientFactory: ctx.clientFactory,
    });
    const active = plan.items.filter((i) => i.action !== 'excluded');
    const missing = keys.filter((k) => !plan.items.some((i) => i.key === k));
    if (missing.length) plan.errors.push(...missing.map((k) => `${k}: not in the source snapshot`));
    const secrets = await secretsNeeded(ctx.secrets, ref, to, active);
    const result = buildResult({ planId, name, to, from, changesetId, sourceCommit: pinned }, plan, {
      environmentValues: environmentValues(ref.dir, to, active, readTree(sourceDir)), secretsNeeded: secrets,
    });
    const scrubbed = makeScrubber([env.password, ...Object.values(env.vars)])(result);
    remember(planId, { projectDir: ref.dir, result: scrubbed, kind, select, sourceDir, sourcePath, resolutions });
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
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
  };
  const required = r.needsAttention.filter((n) => {
    if (n.kind === 'drift') return resolutions[n.key] === 'overwrite';
    if (n.kind === 'connection-secrets') return r.secretsNeeded.some((s) => s.key === n.key && !s.has && !(s.id in secrets));
    return true;
  });
  const missingAcks = required.map((n) => n.id).filter((id) => !acks.includes(id));
  if (missingAcks.length) throw new ApiError(400, 'acknowledgement_required', 'Tick every item that needs attention first.', { missing: missingAcks });
  const missingValues = r.environmentValues.filter((v) => v.required && !given(v.key, v.path)).map((v) => v.id);
  if (missingValues.length) throw new ApiError(400, 'values_required', 'Some environment values are required.', { missing: missingValues });
  return { acknowledgements: acks as string[], values: values as ApplyInput['values'], secrets: secrets as Record<string, string>, remember: body.remember === true, resolutions };
}

const HTTP_FAILURE = /failed with (\d{3})/;
const plainFailure = (message: unknown) => {
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
    const out: RunItemOutcome = { key: String(e.key), status: e.status as RunItemOutcome['status'] };
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
  const onPlan = (applyPlan: EnginePlan) => {
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
  };
  step('apply', 'running');
  let status: RunStatus = 'applied';
  let error: string | null = null;
  let done = 0;
  try {
    const res = await runApply({
      projectDir: ref.dir, envName: r.to, env, sourceDir: plan.sourceDir, yes: true, select: plan.select, resolutions: input.resolutions,
      onEvent, onPlan, signal, clientFactory: ctx.clientFactory, log: () => {},
    });
    done = res.done;
    if (res.code !== 0) {
      status = 'failed';
      error = 'The plan has errors against the current target; nothing was applied. Plan again.';
    } else if (skipped.length) {
      status = 'partial';
      error = `${skipped.length === 1 ? '1 item was' : `${skipped.length} items were`} not applied (see the list below). Plan again to review ${skipped.length === 1 ? 'it' : 'them'}.`;
    }
  } catch (err) {
    const failed = [...outcomes.values()].find((o) => o.status === 'failed' || o.status === 'running');
    done = [...outcomes.values()].filter((o) => o.status === 'done').length;
    if ((err as { name?: string } | null)?.name === 'CancelledError' || signal.aborted) {
      status = 'cancelled';
      error = 'The apply was cancelled.';
      for (const o of outcomes.values()) if (o.status === 'running') Object.assign(o, { status: 'skipped', message: 'Cancelled before it finished.' });
    } else {
      status = done ? 'partial' : 'failed';
      error = failed ? `${failed.key}: ${failed.message ?? toApiError(err).message}` : toApiError(err).message;
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
    selection: [...plan.select].sort(), acknowledgements: input.acknowledgements, resolutions: input.resolutions,
    values, secretsUsed: Object.keys(input.secrets).sort(),
    items: [...outcomes.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), done, error,
  };
  const safe = scrub(record);
  mkdirSync(path.join(ref.dir, RUNS_DIR), { recursive: true });
  writeFileSync(path.join(ref.dir, RUNS_DIR, `${runId}.json`), stableStringify(safe));
  if (r.changesetId && (status === 'applied' || status === 'partial') && existsSync(path.join(ref.dir, 'changesets', `${r.changesetId}.json`))) {
    recordApplied(ref, r.changesetId, { env: r.to, runId, at: safe.finishedAt });
  }
  const verb = plan.kind === 'restore'
    ? { applied: 'Restored', partial: 'Partly restored', failed: 'Failed to restore', cancelled: 'Partly restored' }[status]
    : { applied: 'Applied', partial: 'Partly applied', failed: 'Failed to apply', cancelled: 'Cancelled applying' }[status];
  const title = plan.kind === 'restore' ? `${verb} ${To} from a backup` : `${verb} '${r.name}' to ${To}`;
  const commit = await commitChange(ref, commitMessage(title, { Environment: r.to, Run: runId, Changeset: r.changesetId, Plan: r.planId }));

  // 6. A fresh snapshot of the target once anything was written, so Compare,
  // Explore and the Overview see the target as the apply left it (not the
  // pre-apply backup). Not cancellable, and never changes the outcome.
  let snapshotCommit: string | null = null;
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
      emit({ type: 'warning', message: `The apply finished, but kinetic-migrate could not take a new snapshot of ${To}. Take one before comparing.` });
    }
  }
  // A cancelled apply still reports what it did (the job keeps this result).
  return scrub({ runId, status, commit, backupCommit, snapshotCommit, done, error });
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
        throw scrubError(err, [...Object.values(input.secrets)]);
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

