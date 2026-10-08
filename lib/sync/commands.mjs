// lib/sync/commands.mjs
// Orchestration for the CLI commands. Each run* returns a process exit code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClient, ReadOnlyError } from './http.mjs';
import { loadEnvironment, loadConfig, loadOverrides, listOverrideEnvs, connectionSecrets, handlerSecrets } from './env.mjs';
import { writeTree, readTree } from './store.mjs';
import { stableStringify, hashOf, withoutEnvBound } from './normalize.mjs';
import { MODULES, APPLY_ORDER, moduleFor, PRUNABLE } from './artifacts/index.mjs';
import { findSourceHostStrings, uncoveredFor } from './leftovers.mjs';
import { loadState, saveState } from './state.mjs';
import { buildPlan, preflightChecks } from './plan.mjs';
import { formatPlan, planRecord } from './report.mjs';
import { compareArtifacts, formatCompare } from './compare.mjs';
import { renderHtml } from './html-report.mjs';

export const exportDir = (projectDir) => join(projectDir, 'export');
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// Keeps binary attachments, so exports and backups carry handler packages.
export const strip = (artifacts) => artifacts.map(({ key, data, files }) => (files ? { key, data, files } : { key, data }));

export async function exportArtifacts(client, config) {
  const ctx = { config, collected: [] };
  for (const mod of MODULES) ctx.collected.push(...(await mod.list(client, ctx)));
  return ctx.collected;
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

export async function runExport({ projectDir, envName, log, clientFactory = createClient }) {
  const env = loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const client = clientFactory({ env, mode: 'read' });
  const artifacts = await exportArtifacts(client, config);
  writeTree(exportDir(projectDir), strip(artifacts));
  log(`Exported ${artifacts.length} artifacts from ${env.name} to ${exportDir(projectDir)}`);
  const counts = new Map();
  for (const a of artifacts) counts.set(moduleFor(a.key).type, (counts.get(moduleFor(a.key).type) ?? 0) + 1);
  for (const [type, n] of counts) log(`  ${type.padEnd(16)} ${n}`);

  const hits = findSourceHostStrings(artifacts, env.url, (k) => moduleFor(k)?.scope);
  const host = new URL(env.url).host;
  const targets = listOverrideEnvs(projectDir).filter((t) => t !== envName);
  if (hits.length && !targets.length) {
    log(`\n${hits.length} value(s) contain ${host}. Add overrides/<env>.json for each target before promoting.`);
  }
  for (const target of targets) {
    const left = uncoveredFor(hits, loadOverrides(projectDir, target), env.url);
    if (!left.length) continue;
    log(`\n${left.length} value(s) still contain ${host} with no override for "${target}":`);
    for (const h of left.slice(0, 50)) log(`  ${h.key}  ${h.path}`);
    if (left.length > 50) log(`  ... and ${left.length - 50} more`);
  }
  return 0;
}

// sourceArtifacts (live artifacts from another environment) stands in for the
// project export when given; compare uses it to preview a promotion.
export async function computePlan({ projectDir, envName, overwriteDrift = false, clientFactory = createClient, sourceArtifacts }) {
  const env = loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const exported = sourceArtifacts
    ? new Map(sourceArtifacts.map((a) => [a.key, a.data]))
    : readTree(exportDir(projectDir));
  const reader = clientFactory({ env, mode: 'read' });
  const targetList = await exportArtifacts(reader, config);
  const target = new Map(targetList.map((a) => [a.key, a]));
  const plan = buildPlan({
    modules: MODULES, exported, target, config, overwriteDrift,
    state: loadState(projectDir, envName),
    overrides: loadOverrides(projectDir, envName),
    vars: { targetUrl: env.url },
  });
  const checks = preflightChecks({
    plan, exported, target, config,
    hasSecrets: (name) => Object.keys(connectionSecrets(env, name)).length > 0,
  });
  for (const mod of MODULES) {
    if (!mod.preflight) continue;
    const r = await mod.preflight(reader, exported);
    checks.errors.push(...r.errors);
    checks.warnings.push(...r.warnings);
  }
  plan.errors.push(...checks.errors);
  plan.warnings.push(...checks.warnings);
  return { env, config, plan, targetList };
}

export async function runPlan({ projectDir, envName, overwriteDrift, log, clientFactory = createClient }) {
  const { env, plan } = await computePlan({ projectDir, envName, overwriteDrift, clientFactory });
  log(formatPlan(plan, env.name));
  const dir = join(projectDir, 'plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${env.name}-${stamp()}.json`), stableStringify(planRecord(plan)));
  return plan.errors.length ? 1 : 0;
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
// when someone changed it outside promotion. Drift-skipped and manual items
// keep their previous hash.
export function recordState(projectDir, envName, config, plan, artifacts, deleted = []) {
  const state = loadState(projectDir, envName);
  const keep = new Set(plan.items.filter((i) => i.action === 'skip-drift' || i.action === 'manual').map((i) => i.key));
  const promoted = new Set(plan.items.map((i) => i.key));
  for (const a of artifacts) {
    if (!promoted.has(a.key) || keep.has(a.key)) continue;
    state[a.key] = hashOf(withoutEnvBound(moduleFor(a.key).scope, a.data, config.envBoundAttributes));
  }
  for (const key of deleted) delete state[key];
  saveState(projectDir, envName, state);
}

export async function runApply({
  projectDir, envName, yes = false, prune = [], overwriteDrift = false, log,
  clientFactory = createClient, confirm = promptConfirm,
}) {
  const env = loadEnvironment(projectDir, envName);
  if (env.readOnly) throw new ReadOnlyError(`Environment "${env.name}" is readOnly; apply never writes to it`);
  for (const t of prune) {
    if (!PRUNABLE.includes(t)) throw new Error(`--prune ${t}: not a prunable type (one of ${PRUNABLE.join(', ')})`);
  }
  const { config, plan, targetList } = await computePlan({ projectDir, envName, overwriteDrift, clientFactory });
  // Whole-artifact deletions come from modules with prune(); `data` deletes rows.
  log(formatPlan(plan, env.name, { prune: prune.filter((t) => t === 'data' || MODULES.some((m) => m.type === t && m.prune)) }));
  if (plan.errors.length) { log('\nRefusing to apply: fix the errors above first.'); return 1; }

  const pruneSet = new Set(prune);
  const work = plan.items.filter((i) => i.action === 'create' || i.action === 'update'
    || (i.type === 'data' && pruneSet.has('data') && i.existing
      && i.action !== 'skip-drift' && i.action !== 'manual'));
  const deletions = plan.targetOnly.filter((t) => pruneSet.has(t.type) && moduleFor(t.key)?.prune);
  if (!work.length && !deletions.length) {
    log('Nothing to apply.');
    recordState(projectDir, env.name, config, plan, targetList);
    return 0;
  }
  if (!yes && !(await confirm(env.name))) { log('Aborted; nothing was changed.'); return 1; }

  const backupDir = join(projectDir, 'backups', `${env.name}-${stamp()}`);
  writeTree(backupDir, strip(targetList));
  log(`\nBacked up ${env.name} to ${backupDir}`);

  const writer = clientFactory({ env, mode: 'write' });
  const ctx = {
    config, prune: pruneSet,
    connectionSecrets: (name) => connectionSecrets(env, name),
    handlerSecrets: (definitionId) => handlerSecrets(env, definitionId),
    exportDir: exportDir(projectDir),
    warn: (m) => log(`  WARN  ${m}`),
  };
  let done = 0;
  try {
    for (const mod of APPLY_ORDER) {
      for (const item of work.filter((i) => i.type === mod.type)) {
        const result = await mod.apply(writer, item, ctx);
        if (result?.skipped) { log(`  skipped  ${item.key}`); continue; }
        done++;
        log(`  ${item.action.padEnd(8)} ${item.key}`);
      }
    }
    for (const mod of [...APPLY_ORDER].reverse()) {
      for (const t of deletions.filter((d) => d.type === mod.type)) {
        await mod.prune(writer, t.existing, ctx);
        done++;
        log(`  delete   ${t.key}`);
      }
    }
  } catch (e) {
    log(`\nStopped after ${done} change(s). Nothing was rolled back; fix the cause and re-run apply (items left half-applied may need --overwrite-drift). Backup: ${backupDir}`);
    throw e;
  }

  const after = await exportArtifacts(clientFactory({ env, mode: 'read' }), config);
  recordState(projectDir, env.name, config, plan, after, deletions.map((d) => d.key));
  log(`\nApplied ${done} change(s) to ${env.name}.`);
  return 0;
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
}

// Read two environments (read-only clients only) and report how they differ:
// by default as a preview of promoting `from` into `to`; with raw, every
// difference with nothing hidden. Never writes to either environment or to
// the project export.
export async function runCompare({ projectDir, from, to, raw = false, log, clientFactory = createClient }) {
  if (from === to) throw new Error('compare needs two different environments');
  const envA = loadEnvironment(projectDir, from);
  const envB = loadEnvironment(projectDir, to);
  const config = loadConfig(projectDir);

  if (raw) {
    const [left, right] = await Promise.all([envA, envB].map(async (env) => {
      const list = await exportArtifacts(clientFactory({ env, mode: 'read' }), config);
      return new Map(list.map((a) => [a.key, a]));
    }));
    const result = compareArtifacts({ modules: MODULES, left, right });
    log(formatCompare(result, envA.name, envB.name));
    const label = { same: 'same', differs: 'differs', 'only-left': `only in ${envA.name}`, 'only-right': `only in ${envB.name}` };
    writeCompareReports({
      projectDir, from: envA.name, to: envB.name, mode: 'raw',
      title: `Compare ${envA.name} → ${envB.name}`, subtitle: 'Raw comparison: every difference, nothing hidden',
      summary: Object.entries(result.counts).map(([s, count]) => ({ label: label[s], count })),
      items: result.items.map(({ key, type, status, diff }) => ({
        key, type, status: label[status], diff, tone: { 'only-left': 'added', 'only-right': 'neutral' }[status],
      })),
      warnings: [], errors: [], log,
    });
    return 0;
  }

  const source = await exportArtifacts(clientFactory({ env: envA, mode: 'read' }), config);
  const { plan } = await computePlan({ projectDir, envName: envB.name, clientFactory, sourceArtifacts: source });
  log(formatPlan(plan, `${envB.name} (preview of promoting ${envA.name})`));
  const onlyTo = `only in ${envB.name}`;
  const items = [
    ...plan.items.map(({ key, type, action, diff }) => ({ key, type, status: action, diff })),
    ...plan.targetOnly.map(({ key, type }) => ({ key, type, status: onlyTo, diff: [] })),
  ];
  const summary = ['create', 'update', 'manual', 'skip-drift', 'unchanged', onlyTo]
    .map((label) => ({ label, count: items.filter((i) => i.status === label).length }));
  writeCompareReports({
    projectDir, from: envA.name, to: envB.name, mode: 'preview',
    title: `Promote ${envA.name} → ${envB.name}`, subtitle: `Preview: what promoting ${envA.name} into ${envB.name} would change`,
    summary, items, warnings: plan.warnings, errors: plan.errors, log,
  });
  return plan.errors.length ? 1 : 0;
}
