// lib/sync/report.mjs
// Pure: render a plan for people (formatPlan) and for the plans/ record.
import { recordId, isKeyless } from './artifacts/data.mjs';
import { segmentLabel } from './store.mjs';

const ACTIONS = ['create', 'update', 'manual', 'skip-drift', 'unchanged'];
const SYMBOL = { create: '+', update: '~', manual: '!', 'skip-drift': '?' };
const MAX_DIFF = 20;

export function show(value) {
  if (value === undefined) return '(none)';
  const s = JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

export function formatPlan(plan, envName, { prune = [] } = {}) {
  const count = (a) => plan.items.filter((i) => i.action === a).length;
  const lines = [
    `Plan for ${envName}`,
    `  ${ACTIONS.map((a) => `${a} ${count(a)}`).join('   ')}   target-only ${plan.targetOnly.length}`,
  ];
  const removals = plan.removals ?? [];
  if (removals.length) lines.push(`  remove ${removals.filter((r) => r.action === 'delete').length}`);
  // Items outside a selection are only counted, never listed.
  const excluded = count('excluded');
  if (excluded) lines.push(`  excluded ${excluded} (not selected)`);
  const changes = plan.items.filter((i) => i.action !== 'unchanged' && i.action !== 'excluded');
  if (changes.length) lines.push('', 'Changes:');
  for (const i of changes) {
    lines.push(`  ${SYMBOL[i.action]} ${i.action.padEnd(10)} ${i.type.padEnd(14)} ${i.key}`);
    for (const d of i.diff.slice(0, MAX_DIFF)) lines.push(`      ${d.path}: ${show(d.from)} → ${show(d.to)}`);
    if (i.diff.length > MAX_DIFF) lines.push(`      ... ${i.diff.length - MAX_DIFF} more difference(s)`);
  }
  if (plan.targetOnly.length) {
    lines.push('', 'Only in the target (kept unless pruned):');
    // `data` prunes rows within an artifact, never a whole target-only artifact.
    for (const t of plan.targetOnly) lines.push(`  - ${prune.includes(t.type) && t.type !== 'data' && !t.excluded ? 'DELETE ' : ''}${t.type.padEnd(14)} ${t.key}`);
  }
  if (removals.length) {
    lines.push('', 'Removals (deleted from the target after every other change):');
    for (const r of removals) {
      const what = { delete: 'REMOVE', 'skip-drift': 'KEEP (changed since reviewed)', gone: 'GONE (already removed)' }[r.action];
      lines.push(`  - ${what} ${r.type.padEnd(14)} ${r.key}`);
      for (const c of r.children) lines.push(`      with ${c.type.padEnd(14)} ${c.key}`);
      for (const u of r.usedBy) lines.push(`      IN USE: ${u.reason}${u.onlyTarget ? ' (only in the target; --remove it too?)' : ''}`);
      for (const n of r.notes) lines.push(`      NOTE: ${n}`);
    }
  }
  if (prune.includes('data')) {
    const rows = plan.items
      .filter((i) => i.type === 'data' && i.existing && !isKeyless(i.source.key) && !['skip-drift', 'manual', 'excluded'].includes(i.action))
      .flatMap((i) => {
        const wanted = new Set(i.source.rows.map((r) => recordId(r, i.source.key)));
        const [, kapp, , form] = i.key.split('/').map(segmentLabel);
        return Object.keys(i.existing.meta?.ids ?? {}).filter((k) => !wanted.has(k)).map((k) => `  - DELETE row ${kapp}/${form} ${k}`);
      });
    if (rows.length) lines.push('', 'Rows only in the target (will be deleted by --prune data):', ...rows);
  }
  if (plan.warnings.length) lines.push('', 'Warnings:', ...plan.warnings.map((w) => `  WARN  ${w}`));
  if (plan.errors.length) lines.push('', 'Errors:', ...plan.errors.map((e) => `  ERROR ${e}`));
  return lines.join('\n');
}

export function planRecord(plan) {
  return {
    items: plan.items.filter((i) => i.action !== 'unchanged' && i.action !== 'excluded')
      .map(({ key, type, action, diff, drift }) => ({ key, type, action, diff, drift })),
    targetOnly: plan.targetOnly.map((t) => t.key),
    removals: (plan.removals ?? []).map(({ key, type, action, children, usedBy }) => ({
      key, type, action, children: children.map((c) => c.key), usedBy: usedBy.map((u) => u.key),
    })),
    warnings: plan.warnings,
    errors: plan.errors,
  };
}
