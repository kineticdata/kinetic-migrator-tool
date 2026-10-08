// lib/sync/compare.mjs
// Pure: a raw, nothing-hidden comparison of two environments' artifacts
// (compare --raw). No overrides, env-bound fields or drift state applied.
import { compareText } from './normalize.mjs';
import { diffValues } from './plan.mjs';
import { show } from './report.mjs';

export const STATUSES = ['same', 'differs', 'only-left', 'only-right'];
const MAX_DIFF = 20;

export function compareArtifacts({ modules, left, right }) {
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort(compareText);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const items = keys.map((key) => {
    const type = modules.find((m) => m.owns(key))?.type ?? 'unknown';
    const a = left.get(key);
    const b = right.get(key);
    let status;
    let diff = [];
    if (!b) status = 'only-left';
    else if (!a) status = 'only-right';
    else {
      diff = diffValues(a.data, b.data);
      status = diff.length ? 'differs' : 'same';
    }
    counts[status]++;
    return { key, type, status, diff };
  });
  return { items, counts };
}

export function formatCompare(result, fromName, toName) {
  const label = {
    same: 'same', differs: 'differs', 'only-left': `only in ${fromName}`, 'only-right': `only in ${toName}`,
  };
  const symbol = { differs: '~', 'only-left': '<', 'only-right': '>' };
  const width = Math.max(...Object.values(label).map((l) => l.length));
  const lines = [
    `Compare ${fromName} → ${toName} (raw)`,
    `  ${STATUSES.map((s) => `${label[s]} ${result.counts[s]}`).join('   ')}`,
  ];
  const changes = result.items.filter((i) => i.status !== 'same');
  if (changes.length) lines.push('', 'Differences:');
  for (const i of changes) {
    lines.push(`  ${symbol[i.status]} ${label[i.status].padEnd(width)} ${i.type.padEnd(14)} ${i.key}`);
    for (const d of i.diff.slice(0, MAX_DIFF)) lines.push(`      ${d.path}: ${show(d.from)} → ${show(d.to)}`);
    if (i.diff.length > MAX_DIFF) lines.push(`      ... ${i.diff.length - MAX_DIFF} more difference(s)`);
  }
  return lines.join('\n');
}
