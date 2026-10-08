// lib/sync/commands.mjs
// Orchestration for the CLI commands. Each run* returns an object carrying the
// process exit code as `code`. Optional `env`/`envs` (resolved environments),
// `onEvent` (structured events) and `signal` (AbortSignal) let a server drive them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClient, ReadOnlyError } from './http.mjs';
import { loadEnvironment, validateEnvName, loadConfig, loadOverrides, listOverrideEnvs, connectionSecrets, handlerSecrets } from './env.mjs';
import { writeTree, LAYOUT_VERSION } from './store.mjs';
import { loadTree, unresolvedErrors } from './layout.mjs';
import { stableStringify, stateEntry, driftedFrom } from './normalize.mjs';
import { MODULES, APPLY_ORDER, moduleFor, PRUNABLE } from './artifacts/index.mjs';
import { classifyRefs, referencedDefinitionIds } from './artifacts/task-refs.mjs';
import { isKeyless } from './artifacts/data.mjs';
import { removeEntry } from './artifacts/common.mjs';
import workflowsModule from './artifacts/workflows.mjs';
import { listTrees } from './artifacts/routines.mjs';
import { findSourceHostStrings, uncoveredFor } from './leftovers.mjs';
import { loadState, saveState } from './state.mjs';
import { DEFAULT_ENV_BOUND_SPACE_FIELDS } from './env-bound.mjs';
import { buildPlan, preflightChecks } from './plan.mjs';
import { formatPlan, planRecord } from './report.mjs';
import { compareArtifacts, formatCompare } from './compare.mjs';
import { renderHtml } from './html-report.mjs';
import { createEmitter, cancelled } from './events.mjs';
import { isOmittable, isOmittedKey, omissionFrom, omissionWarning, omittedBetween, withoutOmitted } from './omitted.mjs';

// Legacy single export folder; still read when --from is omitted.
export const exportDir = (projectDir) => join(projectDir, 'export');
export const snapshotDir = (projectDir, env) => join(projectDir, 'snapshots', env);
// Where a plan/apply reads its source from: the named environment's snapshot;
// without one, the legacy export/ folder when the project has no snapshots/;
// otherwise an error.
export function sourceDirFor(projectDir, from) {
  if (from) {
    validateEnvName(from);
    const dir = snapshotDir(projectDir, from);
    if (!existsSync(dir)) throw new Error(`No snapshot for "${from}"; run export --env ${from}`);
    return dir;
  }
  if (existsSync(exportDir(projectDir)) && !existsSync(join(projectDir, 'snapshots'))) return exportDir(projectDir);
  throw new Error("Specify --from <env> (snapshots/<env> holds each environment's export)");
}
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// Keeps binary attachments, so exports and backups carry handler packages.
export const strip = (artifacts) => artifacts.map(({ key, data, files }) => (files ? { key, data, files } : { key, data }));

// The list carries `omitted` (non-enumerable): what the export had to leave
// out, and why (see omitted.mjs). Only the Integrator types can be left out,
// when its sign-in is unavailable; any other failure fails the export.
export async function exportArtifacts(client, config, { emit, signal } = {}) {
  const ctx = { config, collected: [] };
  const omitted = [];
  let i = 0;
  for (const mod of MODULES) {
    cancelled(signal);
    if (!omitted.some((o) => o.types.includes(mod.type))) {
      try {
        ctx.collected.push(...(await mod.list(client, ctx)));
      } catch (err) {
        if (!isOmittable(err, mod.type)) throw err;
        omitted.push(omissionFrom(err));
      }
    }
    emit?.progress('export', ++i, MODULES.length, mod.type);
  }
  return Object.defineProperty(ctx.collected, 'omitted', { value: omitted });
}

// Leaves out of a plan's or comparison's two sides every type either side
// left out (sides: [{ name, omitted }]), with a note for each.
function excludeOmitted(sides, maps) {
  const { types, notes } = omittedBetween(sides);
  const typeOf = (k) => moduleFor(k)?.type;
  return { types, notes, maps: maps.map((m) => withoutOmitted(m, types, typeOf)) };
}

// Every log line is also an event; warnings get their own event type.
function channels(log = () => {}, onEvent) {
  const emit = createEmitter(onEvent);
  return {
    emit,
    log: (m) => { log(m); emit.log(m); },
    warn: (m) => { log(`  WARN  ${m}`); emit.log(`  WARN  ${m}`); emit.warning(m); },
  };
}

// For git on other machines (isomorphic-git ignores it): text files are kept
// with LF line ends in every checkout (Git for Windows would otherwise check
// them out with CRLF), and handler packages are never converted or diffed.
export const GITATTRIBUTES = '# Written by kinetic-migrate: LF line ends everywhere; handler packages are binary.\n* text=auto eol=lf\n*.zip binary\n';

const INIT_FILES = {
  'kinetic-sync.config.json': stableStringify({
    layoutVersion: LAYOUT_VERSION,
    data: [],
    exclude: { kapps: [], forms: [] },
    envBoundAttributes: { space: [], kapp: [], form: [], team: [], category: [] },
    envBoundSpaceFields: DEFAULT_ENV_BOUND_SPACE_FIELDS,
  }),
  'environments/dev.json': stableStringify({ url: 'https://your-space.kinops.io', readOnly: true }),
  '.gitignore': '# Credentials, pre-apply backups, plan records and comparison reports stay on this machine.\n.env.*\nbackups/\nplans/\ncompares/\n',
  '.gitattributes': GITATTRIBUTES,
};

export async function runInit({ projectDir, log }) {
  for (const [rel, content] of Object.entries(INIT_FILES)) {
    const file = join(projectDir, rel);
    if (existsSync(file)) {
      log(`  exists   ${rel}`);
      const text = rel === '.gitignore' ? readFileSync(file, 'utf8') : '';
      if (rel === '.gitignore' && !text.includes('.env.*')) {
        log('  WARN     .gitignore does not ignore .env.* — add it so credentials are never committed');
      }
      if (rel === '.gitignore' && !text.includes('compares/')) {
        log('  WARN     .gitignore does not ignore compares/ — add it so comparison reports are not committed');
      }
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    log(`  created  ${rel}`);
  }
  log(`\nNext: edit environments/dev.json, put credentials in .env.dev, then run export --env dev.`);
  return 0;
}

// dest, when given, receives the tree instead of snapshots/<env> (a server
// exports into a temporary folder and swaps it in on success).
export async function runExport({ projectDir, envName, env: given, dest: givenDest, log: rawLog, onEvent, signal, clientFactory = createClient }) {
  const { emit, log, warn } = channels(rawLog, onEvent);
  const env = given ?? loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const client = clientFactory({ env, mode: 'read' });
  const artifacts = await exportArtifacts(client, config, { emit, signal });
  const dest = givenDest ?? snapshotDir(projectDir, env.name);
  const { omitted } = artifacts;
  writeTree(dest, strip(artifacts), { omitted });
  log(`Exported ${artifacts.length} artifacts from ${env.name} to ${dest}`);
  const warnings = omitted.map(omissionWarning);
  for (const w of warnings) warn(w);
  const counts = new Map();
  for (const a of artifacts) counts.set(moduleFor(a.key).type, (counts.get(moduleFor(a.key).type) ?? 0) + 1);
  for (const [type, n] of counts) log(`  ${type.padEnd(16)} ${n}`);

  const hits = findSourceHostStrings(artifacts, env.url, (k) => moduleFor(k)?.scope, config.envBoundSpaceFields);
  const host = new URL(env.url).host;
  const targets = listOverrideEnvs(projectDir).filter((t) => t !== env.name);
  const leftovers = [];
  if (hits.length && !targets.length) {
    leftovers.push(...hits.map((h) => ({ target: null, key: h.key, path: h.path })));
    log(`\n${hits.length} value(s) contain ${host}. Add overrides/<env>.json for each target before promoting.`);
  }
  for (const target of targets) {
    const left = uncoveredFor(hits, loadOverrides(projectDir, target), env.url);
    if (!left.length) continue;
    leftovers.push(...left.map((h) => ({ target, key: h.key, path: h.path })));
    log(`\n${left.length} value(s) still contain ${host} with no override for "${target}":`);
    for (const h of left.slice(0, 50)) log(`  ${h.key}  ${h.path}`);
    if (left.length > 50) log(`  ... and ${left.length - 50} more`);
  }
  return { code: 0, artifacts: artifacts.length, counts: Object.fromEntries(counts), leftovers, omitted, warnings };
}

// sourceArtifacts (live artifacts from another environment) stands in for the
// source snapshot when given; compare uses it to preview a promotion. `from`
// names the source environment's snapshot (see sourceDirFor) and, unless
// sourceName is given, the source in messages; sourceDir, when
// given, is read instead (a snapshot pinned at an earlier commit). select (Set
// of keys) and resolutions ({ key: 'overwrite' | 'keep' }) are as in buildPlan.
// sourceUnresolved: with sourceArtifacts from an older tree, the items that
// could not be re-keyed (see layout.mjs); each one is a plan error.
// remove / removeExpected: explicit removals of target-only keys (buildPlan).
// sourceOmitted: with sourceArtifacts, what the source's export left out (a
// source tree records its own). A type either side left out is left out of
// the whole plan (see omitted.mjs), with a warning.
export async function computePlan({ projectDir, envName, from, sourceName, sourceDir, env: given, overwriteDrift = false, select: givenSelect, resolutions, remove: givenRemove, removeExpected, clientFactory = createClient, sourceArtifacts, sourceUnresolved, sourceOmitted, onEvent, signal, emit: givenEmit }) {
  const emit = givenEmit ?? createEmitter(onEvent);
  const env = given ?? loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const loaded = sourceArtifacts
    ? new Map(sourceArtifacts.map((a) => [a.key, a.data]))
    : loadTree(sourceDir ?? sourceDirFor(projectDir, from));
  const reader = clientFactory({ env, mode: 'read' });
  const targetList = await exportArtifacts(reader, config, { emit, signal });
  const left = excludeOmitted([
    { name: sourceName ?? from ?? 'the source', omitted: sourceOmitted ?? loaded.omitted },
    { name: env.name, omitted: targetList.omitted },
  ], [loaded, new Map(targetList.map((a) => [a.key, a]))]);
  const [exported, target] = left.maps;
  const kept = (k) => !isOmittedKey(k.split('#')[0], left.types, (x) => moduleFor(x)?.type);
  const select = givenSelect && left.types.size ? new Set([...givenSelect].filter(kept)) : givenSelect;
  const remove = givenRemove && left.types.size ? givenRemove.filter(kept) : givenRemove;
  // What modules read from the target for the plan beyond its export.
  const inputs = {};
  for (const mod of MODULES) {
    if (!mod.planInputs) continue;
    cancelled(signal);
    inputs[mod.type] = await mod.planInputs(reader, exported, target);
  }
  const plan = buildPlan({
    modules: MODULES, exported, target, config, overwriteDrift, select, resolutions, remove, removeExpected, inputs,
    sourceName: sourceName ?? from, targetName: env.name,
    state: loadState(projectDir, envName),
    overrides: loadOverrides(projectDir, envName),
    vars: { targetUrl: env.url },
  });
  const checks = preflightChecks({
    plan, exported, target, config, select, targetName: env.name, unchecked: left.types,
    hasSecrets: (name) => Object.keys(connectionSecrets(env, name)).length > 0,
  });
  // With a selection, module checks (handlers and routines in use) see only
  // what the selected items reference.
  const checked = select ? scopedToSelection(exported, select) : exported;
  for (const mod of MODULES) {
    if (!mod.preflight) continue;
    cancelled(signal);
    const r = await mod.preflight(reader, checked);
    checks.errors.push(...r.errors);
    checks.warnings.push(...r.warnings);
  }
  plan.errors.push(...unresolvedErrors({ unresolved: sourceUnresolved ?? exported.unresolved }, sourceName ?? from));
  plan.errors.push(...checks.errors);
  plan.warnings.push(...left.notes, ...(config.warnings ?? []), ...checks.warnings);
  plan.omitted = [...left.types];
  return { env, config, plan, targetList };
}

function scopedToSelection(exported, select) {
  const out = new Map(exported);
  if (!exported.has('task-refs')) return out;
  // A reference is a routine whether or not that routine is selected:
  // classify against every exported routine.
  const routineIds = new Set([...exported].filter(([k]) => k.startsWith('routines/')).map(([, d]) => d?.definitionId));
  const chosen = [...exported].filter(([k]) => select.has(k)).map(([, data]) => ({ data }));
  out.set('task-refs', classifyRefs(referencedDefinitionIds(chosen), routineIds));
  return out;
}

export async function runPlan({ projectDir, envName, from, env: given, overwriteDrift, log: rawLog, onEvent, signal, clientFactory = createClient }) {
  const { emit, log } = channels(rawLog, onEvent);
  const { env, plan } = await computePlan({ projectDir, envName, from, env: given, overwriteDrift, clientFactory, emit, signal });
  log(formatPlan(plan, env.name));
  const dir = join(projectDir, 'plans');
  mkdirSync(dir, { recursive: true });
  const planFile = join(dir, `${env.name}-${stamp()}.json`);
  writeFileSync(planFile, stableStringify(planRecord(plan)));
  return { code: plan.errors.length ? 1 : 0, plan, planFile };
}

export async function promptConfirm(envName) {
  if (!process.stdin.isTTY) throw new Error('No terminal to confirm on; re-run with --yes to apply without a prompt');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`\nType "${envName}" to apply these changes: `)).trim() === envName;
  } finally {
    rl.close();
  }
}

// Remember each promoted artifact's target state so the next plan can tell
// when someone changed it outside promotion. Drift-skipped, manual and
// excluded (unselected) items keep their previous hash.
// `changed` lists items the run changed some other way (a removed entry of
// the space or a kapp): re-recorded as they are now, so the change is not
// reported as drift, when they were part of the run, or were recorded before
// and had not drifted (in `before`, the target as read before the writes).
export function recordState(projectDir, envName, config, plan, artifacts, deleted = [], changed = [], before = []) {
  const state = loadState(projectDir, envName);
  const keep = new Set(plan.items.filter((i) => ['skip-drift', 'manual', 'excluded'].includes(i.action)).map((i) => i.key));
  const promoted = new Set(plan.items.map((i) => i.key));
  const inRun = new Set(plan.items.filter((i) => !['excluded', 'skip-drift', 'manual'].includes(i.action)).map((i) => i.key));
  const was = new Map(before.map((a) => [a.key, a.data]));
  const cleanBefore = (k) => k in state && was.has(k) && !driftedFrom(moduleFor(k).scope, was.get(k), state[k], config, k);
  const refresh = new Set(changed.filter((k) => inRun.has(k) || cleanBefore(k)));
  for (const a of artifacts) {
    if (refresh.has(a.key)) {
      state[a.key] = stateEntry(moduleFor(a.key).scope, a.data, config, a.key);
      continue;
    }
    if (!promoted.has(a.key) || keep.has(a.key)) continue;
    state[a.key] = stateEntry(moduleFor(a.key).scope, a.data, config, a.key);
  }
  for (const key of deleted) delete state[key];
  saveState(projectDir, envName, state);
}

// remove: target-only keys to delete (each with what its delete takes with
// it); removeExpected: { key: hash } as reviewed, so an item changed since
// is not deleted. Removals run after every create and update, in reverse
// dependency order.
export async function runApply({
  projectDir, envName, from, sourceName, sourceDir, env: given, yes = false, prune = [], overwriteDrift = false, select, resolutions, remove = [], removeExpected,
  log: rawLog, onEvent, signal, clientFactory = createClient, confirm = promptConfirm, onPlan,
}) {
  const { emit, log, warn } = channels(rawLog, onEvent);
  const env = given ?? loadEnvironment(projectDir, envName);
  if (env.readOnly) throw new ReadOnlyError(`Environment "${env.name}" is readOnly; apply never writes to it`);
  for (const t of prune) {
    if (!PRUNABLE.includes(t)) throw new Error(`--prune ${t}: not a prunable type (one of ${PRUNABLE.join(', ')})`);
  }
  const { config, plan, targetList } = await computePlan({ projectDir, envName, from, sourceName, sourceDir, env, overwriteDrift, select, resolutions, remove, removeExpected, clientFactory, emit, signal });
  const pruneSet = new Set(prune);
  // Keyless reference data never deletes rows, so --prune data skips it.
  if (pruneSet.has('data')) {
    for (const i of plan.items) {
      if (i.type === 'data' && i.action !== 'excluded' && isKeyless(i.source?.key)) {
        plan.warnings.push(`${i.key}: no match fields, so --prune data deletes nothing here`);
      }
    }
  }
  // The plan actually applied (a server reports what it will skip, and why).
  onPlan?.(plan);
  // Whole-artifact deletions come from modules with prune(); `data` deletes rows.
  log(formatPlan(plan, env.name, { prune: prune.filter((t) => t === 'data' || MODULES.some((m) => m.type === t && m.prune)) }));
  if (plan.errors.length) { log('\nRefusing to apply: fix the errors above first.'); return { code: 1, done: 0 }; }

  const work = plan.items.filter((i) => i.action === 'create' || i.action === 'update'
    || (i.type === 'data' && pruneSet.has('data') && i.existing && !isKeyless(i.source?.key)
      && !['skip-drift', 'manual', 'excluded'].includes(i.action)));
  const removals = plan.removals.filter((r) => r.action === 'delete');
  const removed = new Set(removals.flatMap((r) => [r.key, ...r.children.map((c) => c.key)]));
  // Target-only items outside a selection are never pruned.
  const deletions = plan.targetOnly.filter((t) => !t.excluded && pruneSet.has(t.type) && moduleFor(t.key)?.prune && !removed.has(t.key));
  if (!work.length && !deletions.length && !removals.length) {
    log('Nothing to apply.');
    recordState(projectDir, env.name, config, plan, targetList);
    return { code: 0, done: 0 };
  }
  if (!yes && !(await confirm(env.name))) { log('Aborted; nothing was changed.'); return { code: 1, done: 0 }; }

  const backupDir = join(projectDir, 'backups', `${env.name}-${stamp()}`);
  writeTree(backupDir, strip(targetList), { omitted: targetList.omitted });
  log(`\nBacked up ${env.name} to ${backupDir}`);

  const writer = clientFactory({ env, mode: 'write' });
  const ctx = {
    config, prune: pruneSet,
    connectionSecrets: (name) => connectionSecrets(env, name),
    handlerSecrets: (definitionId) => handlerSecrets(env, definitionId),
    exportDir: sourceDir ?? sourceDirFor(projectDir, from),
    warn,
  };
  const total = work.length + deletions.length + removals.length;
  // Workflows deleted ahead of their kapp or form.
  const removedFirst = new Set();
  let done = 0;
  let processed = 0; // done plus skipped, for progress
  let current = null;
  try {
    for (const mod of APPLY_ORDER) {
      const own = work.filter((i) => i.type === mod.type);
      for (const item of mod.order ? mod.order(own) : own) {
        cancelled(signal);
        current = item.key;
        emit.item(item.key, 'running');
        const result = await mod.apply(writer, item, ctx);
        if (result?.skipped) {
          log(`  skipped  ${item.key}`);
          emit.item(item.key, 'skipped');
        } else {
          done++;
          log(`  ${item.action.padEnd(8)} ${item.key}`);
          emit.item(item.key, 'done');
        }
        current = null;
        emit.progress('apply', ++processed, total, item.key);
      }
    }
    // Pruned types and explicit removals, callers before what they call. A
    // removal's delete takes its children with it (no delete of their own);
    // that they went is confirmed against the target afterwards.
    for (const mod of [...APPLY_ORDER].reverse()) {
      const own = [...deletions, ...removals].filter((d) => d.type === mod.type);
      for (const t of mod.order ? mod.order(own, { reverse: true }) : own) {
        cancelled(signal);
        current = t.key;
        emit.item(t.key, 'running');
        // A kapp's or form's delete leaves its workflows' Task trees behind
        // (verified live); deleting each workflow through Core removes its
        // tree, so they go first.
        for (const c of workflowChildren(t)) {
          current = c.key;
          emit.item(c.key, 'running');
          await workflowsModule.prune(writer, c.existing, ctx);
          removedFirst.add(c.key);
          done++;
          log(`  delete   ${c.key} (before ${t.key})`);
          emit.item(c.key, 'done', `Removed with ${t.key}`);
        }
        current = t.key;
        if (t.entry) await removeEntry(writer, mod, t);
        else await mod.prune(writer, t.existing, ctx);
        done++;
        log(`  delete   ${t.key}`);
        emit.item(t.key, 'done', t.children ? 'Removed' : undefined);
        current = null;
        emit.progress('apply', ++processed, total, t.key);
      }
    }
  } catch (e) {
    if (current !== null && e?.name !== 'CancelledError') emit.item(current, 'failed', e.message);
    log(`\nStopped after ${done} change(s). Nothing was rolled back; fix the cause and re-run apply (items left half-applied may need --overwrite-drift). Backup: ${backupDir}`);
    throw e;
  }

  // Not cancellable: once the writes are done, their state must be recorded.
  const reader = clientFactory({ env, mode: 'read' });
  let after = await exportArtifacts(reader, config);
  // Children a removal's delete should have taken with it: gone, or deleted
  // now on their own (callers first), or reported failed and kept in state.
  const { confirmed, failed, deleted } = await confirmChildren({ removals, after, writer, ctx, log, emit, removedFirst });
  // No Task tree may outlive a removed workflow: any left is deleted, or
  // reported failed.
  const flows = removals.flatMap(workflowChildren).filter((c) => removedFirst.has(c.key));
  if (flows.length) failed.push(...(await removeLeftoverTrees({ flows, reader, writer, log, emit })));
  done += confirmed.length;
  if (deleted) after = await exportArtifacts(reader, config);
  recordState(projectDir, env.name, config, plan, after, [
    ...deletions.map((d) => d.key), ...removals.map((r) => r.key), ...confirmed,
  ], removals.filter((r) => r.entry).map((r) => r.entry.itemKey), targetList);
  if (failed.length) log(`\n${failed.length} item(s) a removal should have taken with it are still in ${env.name}: ${failed.join(', ')}`);
  log(`\nApplied ${done} change(s) to ${env.name}.`);
  return { code: 0, done, backupDir, failed };
}

// After the deletes: each child of a removal that is gone from `after` is
// reported done; one still there is deleted on its own (reverse dependency
// order) or, when that fails or its type cannot be deleted, reported failed.
const workflowChildren = (removal) => (removal.children ?? []).filter((c) => moduleFor(c.key)?.type === 'workflows');

// Task trees of removed workflows still in the engine (matched by the
// workflow's id as the tree's source group, and its name), deleted by title.
async function removeLeftoverTrees({ flows, reader, writer, log, emit }) {
  const trees = await listTrees(reader, 'Tree', 'details');
  const failed = [];
  for (const c of flows) {
    const id = c.existing?.meta?.id;
    const name = c.existing?.data?.name;
    if (!id) continue;
    const left = trees.filter((t) => (t.sourceGroup === id || String(t.title ?? '').includes(` :: ${id} :: `))
      && (t.name === name || String(t.title ?? '').endsWith(` :: ${name}`)));
    for (const t of left) {
      const title = t.title ?? `${t.sourceName} :: ${t.sourceGroup} :: ${t.name}`;
      try {
        await writer.request('task', 'DELETE', `/trees/${encodeURIComponent(title)}`);
        log(`  delete   Task tree "${title}" (left behind by ${c.key})`);
      } catch (e) {
        failed.push(c.key);
        emit.item(c.key, 'failed', `Its Task tree "${title}" is still in the target: ${e.message}`);
      }
    }
  }
  return [...new Set(failed)];
}

async function confirmChildren({ removals, after, writer, ctx, log, emit, removedFirst = new Set() }) {
  const present = new Map(after.map((a) => [a.key, a]));
  const confirmed = [];
  const failed = [];
  const left = [];
  for (const r of removals) {
    for (const c of r.children ?? []) {
      if (removedFirst.has(c.key) && !present.has(c.key)) {
        confirmed.push(c.key);
        continue;
      }
      if (!present.has(c.key)) {
        confirmed.push(c.key);
        log(`  delete   ${c.key} (with ${r.key})`);
        emit.item(c.key, 'done', `Removed with ${r.key}`);
      } else left.push({ ...c, existing: present.get(c.key), parent: r.key });
    }
  }
  for (const mod of [...APPLY_ORDER].reverse()) {
    for (const c of left.filter((x) => moduleFor(x.key)?.type === mod.type)) {
      if (!mod.prune) {
        failed.push(c.key);
        emit.item(c.key, 'failed', `Still in the target after ${c.parent} was removed; remove it by hand.`);
        continue;
      }
      try {
        await mod.prune(writer, c.existing, ctx);
        confirmed.push(c.key);
        log(`  delete   ${c.key} (left behind by ${c.parent})`);
        emit.item(c.key, 'done', `Removed (it did not go with ${c.parent})`);
      } catch (e) {
        failed.push(c.key);
        emit.item(c.key, 'failed', `Still in the target after ${c.parent} was removed: ${e.message}`);
      }
    }
  }
  return { confirmed, failed, deleted: left.length > failed.length };
}

// Group report items by artifact type, in apply (dependency) order.
function groupByType(items) {
  const order = (t) => { const i = APPLY_ORDER.findIndex((m) => m.type === t); return i < 0 ? APPLY_ORDER.length : i; };
  const groups = new Map();
  for (const i of items) {
    if (!groups.has(i.type)) groups.set(i.type, []);
    groups.get(i.type).push({ key: i.key, status: i.status, tone: i.tone, diff: i.diff });
  }
  return [...groups].sort(([a], [b]) => order(a) - order(b)).map(([type, list]) => ({ type, items: list }));
}

function writeCompareReports({ projectDir, from, to, mode, title, subtitle, summary, items, warnings, errors, log }) {
  const dir = join(projectDir, 'compares');
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, `${from}-vs-${to}-${stamp()}`);
  const generatedAt = new Date().toISOString();
  writeFileSync(`${stem}.json`, stableStringify({ mode, from, to, generatedAt, items: items.map(({ tone, ...rest }) => rest), warnings, errors }));
  writeFileSync(`${stem}.html`, renderHtml({ title, subtitle, generatedAt, summary, groups: groupByType(items), warnings, errors }));
  log(`\nReports:\n  ${stem}.json\n  ${stem}.html`);
  return { json: `${stem}.json`, html: `${stem}.html` };
}

// Read two environments (read-only clients only) and report how they differ:
// by default as a preview of promoting `from` into `to`; with raw, every
// difference with nothing hidden. Never writes to either environment or to
// the project export.
export async function runCompare({ projectDir, from, to, envs, raw = false, log: rawLog, onEvent, signal, clientFactory = createClient }) {
  const { emit, log } = channels(rawLog, onEvent);
  from ??= envs?.from?.name;
  to ??= envs?.to?.name;
  if (from === to) throw new Error('compare needs two different environments');
  const envA = envs?.from ?? loadEnvironment(projectDir, from);
  const envB = envs?.to ?? loadEnvironment(projectDir, to);
  const config = loadConfig(projectDir);

  if (raw) {
    const lists = await Promise.all([envA, envB].map((env) => exportArtifacts(clientFactory({ env, mode: 'read' }), config, { signal })));
    const { notes, maps: [left, right] } = excludeOmitted(
      lists.map((list, i) => ({ name: [envA, envB][i].name, omitted: list.omitted })),
      lists.map((list) => new Map(list.map((a) => [a.key, a]))),
    );
    const result = compareArtifacts({ modules: MODULES, left, right });
    for (const n of notes) log(`  WARN  ${n}`);
    log(formatCompare(result, envA.name, envB.name));
    const label = { same: 'same', differs: 'differs', 'only-left': `only in ${envA.name}`, 'only-right': `only in ${envB.name}` };
    const reports = writeCompareReports({
      projectDir, from: envA.name, to: envB.name, mode: 'raw',
      title: `Compare ${envA.name} → ${envB.name}`, subtitle: 'Raw comparison: every difference, nothing hidden',
      summary: Object.entries(result.counts).map(([s, count]) => ({ label: label[s], count })),
      items: result.items.map(({ key, type, status, diff }) => ({
        key, type, status: label[status], diff, tone: { 'only-left': 'added', 'only-right': 'neutral' }[status],
      })),
      warnings: notes, errors: [], log,
    });
    return { code: 0, mode: 'raw', result, reports };
  }

  const source = await exportArtifacts(clientFactory({ env: envA, mode: 'read' }), config, { emit, signal });
  const { plan } = await computePlan({ projectDir, envName: envB.name, env: envB, clientFactory, sourceArtifacts: source, sourceOmitted: source.omitted, sourceName: envA.name, emit, signal });
  log(formatPlan(plan, `${envB.name} (preview of promoting ${envA.name})`));
  const onlyTo = `only in ${envB.name}`;
  const items = [
    ...plan.items.map(({ key, type, action, diff }) => ({ key, type, status: action, diff })),
    ...plan.targetOnly.map(({ key, type }) => ({ key, type, status: onlyTo, diff: [] })),
  ];
  const summary = ['create', 'update', 'manual', 'skip-drift', 'unchanged', onlyTo]
    .map((label) => ({ label, count: items.filter((i) => i.status === label).length }));
  const reports = writeCompareReports({
    projectDir, from: envA.name, to: envB.name, mode: 'preview',
    title: `Promote ${envA.name} → ${envB.name}`, subtitle: `Preview: what promoting ${envA.name} into ${envB.name} would change`,
    summary, items, warnings: plan.warnings, errors: plan.errors, log,
  });
  return { code: plan.errors.length ? 1 : 0, mode: 'preview', plan, items, reports };
}
