// lib/sync/commands.mjs
// Orchestration for the CLI commands. Each run* returns an object carrying the
// process exit code as `code`. Optional `env`/`envs` (resolved environments),
// `onEvent` (structured events) and `signal` (AbortSignal) let a server drive them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClient, ReadOnlyError } from './http.mjs';
import { loadEnvironment, validateEnvName, loadConfig, loadOverrides, listOverrideEnvs, connectionSecrets, handlerSecrets } from './env.mjs';
import { writeTree, readTree } from './store.mjs';
import { stableStringify, hashOf, withoutEnvBound } from './normalize.mjs';
import { MODULES, APPLY_ORDER, moduleFor, PRUNABLE } from './artifacts/index.mjs';
import { classifyRefs, referencedDefinitionIds } from './artifacts/task-refs.mjs';
import { findSourceHostStrings, uncoveredFor } from './leftovers.mjs';
import { loadState, saveState } from './state.mjs';
import { buildPlan, preflightChecks } from './plan.mjs';
import { formatPlan, planRecord } from './report.mjs';
import { compareArtifacts, formatCompare } from './compare.mjs';
import { renderHtml } from './html-report.mjs';
import { createEmitter, cancelled } from './events.mjs';

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

export async function exportArtifacts(client, config, { emit, signal } = {}) {
  const ctx = { config, collected: [] };
  let i = 0;
  for (const mod of MODULES) {
    cancelled(signal);
    ctx.collected.push(...(await mod.list(client, ctx)));
    emit?.progress('export', ++i, MODULES.length, mod.type);
  }
  return ctx.collected;
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

const INIT_FILES = {
  'kinetic-sync.config.json': stableStringify({
    data: [],
    exclude: { kapps: [], forms: [] },
    envBoundAttributes: { space: [], kapp: [], form: [], team: [], category: [] },
  }),
  'environments/dev.json': stableStringify({ url: 'https://your-space.kinops.io', readOnly: true }),
  '.gitignore': '# Credentials, pre-apply backups, plan records and comparison reports stay on this machine.\n.env.*\nbackups/\nplans/\ncompares/\n',
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

export async function runExport({ projectDir, envName, env: given, log: rawLog, onEvent, signal, clientFactory = createClient }) {
  const { emit, log } = channels(rawLog, onEvent);
  const env = given ?? loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const client = clientFactory({ env, mode: 'read' });
  const artifacts = await exportArtifacts(client, config, { emit, signal });
  const dest = snapshotDir(projectDir, env.name);
  writeTree(dest, strip(artifacts));
  log(`Exported ${artifacts.length} artifacts from ${env.name} to ${dest}`);
  const counts = new Map();
  for (const a of artifacts) counts.set(moduleFor(a.key).type, (counts.get(moduleFor(a.key).type) ?? 0) + 1);
  for (const [type, n] of counts) log(`  ${type.padEnd(16)} ${n}`);

  const hits = findSourceHostStrings(artifacts, env.url, (k) => moduleFor(k)?.scope);
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
  return { code: 0, artifacts: artifacts.length, counts: Object.fromEntries(counts), leftovers };
}

// sourceArtifacts (live artifacts from another environment) stands in for the
// source snapshot when given; compare uses it to preview a promotion. `from`
// names the source environment's snapshot (see sourceDirFor); sourceDir, when
// given, is read instead (a snapshot pinned at an earlier commit). select (Set
// of keys) and resolutions ({ key: 'overwrite' | 'keep' }) are as in buildPlan.
export async function computePlan({ projectDir, envName, from, sourceDir, env: given, overwriteDrift = false, select, resolutions, clientFactory = createClient, sourceArtifacts, onEvent, signal, emit: givenEmit }) {
  const emit = givenEmit ?? createEmitter(onEvent);
  const env = given ?? loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const exported = sourceArtifacts
    ? new Map(sourceArtifacts.map((a) => [a.key, a.data]))
    : readTree(sourceDir ?? sourceDirFor(projectDir, from));
  const reader = clientFactory({ env, mode: 'read' });
  const targetList = await exportArtifacts(reader, config, { emit, signal });
  const target = new Map(targetList.map((a) => [a.key, a]));
  const plan = buildPlan({
    modules: MODULES, exported, target, config, overwriteDrift, select, resolutions,
    state: loadState(projectDir, envName),
    overrides: loadOverrides(projectDir, envName),
    vars: { targetUrl: env.url },
  });
  const checks = preflightChecks({
    plan, exported, target, config, select,
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
  plan.errors.push(...checks.errors);
  plan.warnings.push(...checks.warnings);
  return { env, config, plan, targetList };
}

function scopedToSelection(exported, select) {
  const out = new Map(exported);
  if (!exported.has('task-refs')) return out;
  // Routines are never applied, so a reference is a routine whether or not it is
  // selected: classify against every exported routine.
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
export function recordState(projectDir, envName, config, plan, artifacts, deleted = []) {
  const state = loadState(projectDir, envName);
  const keep = new Set(plan.items.filter((i) => ['skip-drift', 'manual', 'excluded'].includes(i.action)).map((i) => i.key));
  const promoted = new Set(plan.items.map((i) => i.key));
  for (const a of artifacts) {
    if (!promoted.has(a.key) || keep.has(a.key)) continue;
    state[a.key] = hashOf(withoutEnvBound(moduleFor(a.key).scope, a.data, config.envBoundAttributes));
  }
  for (const key of deleted) delete state[key];
  saveState(projectDir, envName, state);
}

export async function runApply({
  projectDir, envName, from, sourceDir, env: given, yes = false, prune = [], overwriteDrift = false, select, resolutions, log: rawLog, onEvent, signal,
  clientFactory = createClient, confirm = promptConfirm,
}) {
  const { emit, log, warn } = channels(rawLog, onEvent);
  const env = given ?? loadEnvironment(projectDir, envName);
  if (env.readOnly) throw new ReadOnlyError(`Environment "${env.name}" is readOnly; apply never writes to it`);
  for (const t of prune) {
    if (!PRUNABLE.includes(t)) throw new Error(`--prune ${t}: not a prunable type (one of ${PRUNABLE.join(', ')})`);
  }
  const { config, plan, targetList } = await computePlan({ projectDir, envName, from, sourceDir, env, overwriteDrift, select, resolutions, clientFactory, emit, signal });
  // Whole-artifact deletions come from modules with prune(); `data` deletes rows.
  log(formatPlan(plan, env.name, { prune: prune.filter((t) => t === 'data' || MODULES.some((m) => m.type === t && m.prune)) }));
  if (plan.errors.length) { log('\nRefusing to apply: fix the errors above first.'); return { code: 1, done: 0 }; }

  const pruneSet = new Set(prune);
  const work = plan.items.filter((i) => i.action === 'create' || i.action === 'update'
    || (i.type === 'data' && pruneSet.has('data') && i.existing
      && !['skip-drift', 'manual', 'excluded'].includes(i.action)));
  // Target-only items outside a selection are never pruned.
  const deletions = plan.targetOnly.filter((t) => !t.excluded && pruneSet.has(t.type) && moduleFor(t.key)?.prune);
  if (!work.length && !deletions.length) {
    log('Nothing to apply.');
    recordState(projectDir, env.name, config, plan, targetList);
    return { code: 0, done: 0 };
  }
  if (!yes && !(await confirm(env.name))) { log('Aborted; nothing was changed.'); return { code: 1, done: 0 }; }

  const backupDir = join(projectDir, 'backups', `${env.name}-${stamp()}`);
  writeTree(backupDir, strip(targetList));
  log(`\nBacked up ${env.name} to ${backupDir}`);

  const writer = clientFactory({ env, mode: 'write' });
  const ctx = {
    config, prune: pruneSet,
    connectionSecrets: (name) => connectionSecrets(env, name),
    handlerSecrets: (definitionId) => handlerSecrets(env, definitionId),
    exportDir: sourceDir ?? sourceDirFor(projectDir, from),
    warn,
  };
  const total = work.length + deletions.length;
  let done = 0;
  let processed = 0; // done plus skipped, for progress
  let current = null;
  try {
    for (const mod of APPLY_ORDER) {
      for (const item of work.filter((i) => i.type === mod.type)) {
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
    for (const mod of [...APPLY_ORDER].reverse()) {
      for (const t of deletions.filter((d) => d.type === mod.type)) {
        cancelled(signal);
        current = t.key;
        emit.item(t.key, 'running');
        await mod.prune(writer, t.existing, ctx);
        done++;
        log(`  delete   ${t.key}`);
        emit.item(t.key, 'done');
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
  const after = await exportArtifacts(clientFactory({ env, mode: 'read' }), config);
  recordState(projectDir, env.name, config, plan, after, deletions.map((d) => d.key));
  log(`\nApplied ${done} change(s) to ${env.name}.`);
  return { code: 0, done, backupDir };
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
    const [left, right] = await Promise.all([envA, envB].map(async (env) => {
      const list = await exportArtifacts(clientFactory({ env, mode: 'read' }), config, { signal });
      return new Map(list.map((a) => [a.key, a]));
    }));
    const result = compareArtifacts({ modules: MODULES, left, right });
    log(formatCompare(result, envA.name, envB.name));
    const label = { same: 'same', differs: 'differs', 'only-left': `only in ${envA.name}`, 'only-right': `only in ${envB.name}` };
    const reports = writeCompareReports({
      projectDir, from: envA.name, to: envB.name, mode: 'raw',
      title: `Compare ${envA.name} → ${envB.name}`, subtitle: 'Raw comparison: every difference, nothing hidden',
      summary: Object.entries(result.counts).map(([s, count]) => ({ label: label[s], count })),
      items: result.items.map(({ key, type, status, diff }) => ({
        key, type, status: label[status], diff, tone: { 'only-left': 'added', 'only-right': 'neutral' }[status],
      })),
      warnings: [], errors: [], log,
    });
    return { code: 0, mode: 'raw', result, reports };
  }

  const source = await exportArtifacts(clientFactory({ env: envA, mode: 'read' }), config, { emit, signal });
  const { plan } = await computePlan({ projectDir, envName: envB.name, env: envB, clientFactory, sourceArtifacts: source, emit, signal });
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
