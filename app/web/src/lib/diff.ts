// Field-level differences for Compare. diffValues follows the engine's rules
// (lib/sync/plan.mjs): named lists match by name, a reorder is one entry, and
// `from` is the first argument. Compare passes the target first and the
// incoming item second, whatever the comparison mode.
import type { DiffEntry } from '../../../shared/sync-api';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const join = (path: string, seg: string | number) => (path ? `${path}.${seg}` : String(seg));

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])]));
}

const isEqual = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
const named = (x: unknown): x is { name: unknown } => isObj(x) && 'name' in x;

export function diffValues(from: unknown, to: unknown, path = ''): DiffEntry[] {
  if (isEqual(from, to)) return [];
  const here = [{ path: path || '(root)', from, to }];
  if (!isObj(from) || !isObj(to) || Array.isArray(from) !== Array.isArray(to)) return here;
  if (Array.isArray(from) && Array.isArray(to)) {
    if ([...from, ...to].every(named)) {
      const fromNames = from.map((x) => (x as { name: unknown }).name);
      const toNames = to.map((x) => (x as { name: unknown }).name);
      if (new Set(fromNames).size !== fromNames.length || new Set(toNames).size !== toNames.length) return here;
      const names = [...new Set([...fromNames, ...toNames])].map(String).sort();
      const reordered: DiffEntry[] = fromNames.length === toNames.length && fromNames.every((n) => toNames.includes(n)) && !fromNames.every((n, i) => n === toNames[i])
        ? [{ path: path || '(root)', from: fromNames as unknown, to: toNames as unknown }] : [];
      const find = (list: unknown[], n: string) => list.find((x) => String((x as { name: unknown }).name) === n);
      return reordered.concat(names.flatMap((n) => diffValues(find(from, n), find(to, n), `${path}[${n}]`)));
    }
    if (from.length !== to.length) return here;
    return from.flatMap((v, i) => diffValues(v, to[i], join(path, i)));
  }
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  return keys.flatMap((k) => diffValues((from as Record<string, unknown>)[k], (to as Record<string, unknown>)[k], join(path, k)));
}

// Singular names for lists whose entries are matched by name.
const SINGULAR: Record<string, string> = {
  pages: 'Page', elements: 'Element', fields: 'Field', attributes: 'Attribute', attributeDefinitions: 'Attribute definition',
  indexDefinitions: 'Index definition', securityPolicies: 'Security policy', securityPolicyDefinitions: 'Security policy definition',
  categories: 'Category', bridgedResources: 'Bridged resource', operations: 'Operation', properties: 'Property', events: 'Event',
  memberships: 'Membership', values: 'Value', parameters: 'Parameter', inputs: 'Input', outputs: 'Output', nodes: 'Node',
};

// "indexDefinitions" → "Index definitions".
export function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

// "pages[Details].elements[Priority].required" →
// "Page “Details” › Element “Priority” › Required".
export function pathLabel(path: string): string {
  if (path === '(root)' || path === '') return 'Whole item';
  const parts: string[] = [];
  const re = /\[([^\]]*)\]|([^.[]+)/g;
  let m: RegExpExecArray | null;
  let pendingKey: string | null = null;
  const flush = () => {
    if (pendingKey !== null) parts.push(/^\d+$/.test(pendingKey) ? `#${Number(pendingKey) + 1}` : humanize(pendingKey));
    pendingKey = null;
  };
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) {
      const list = pendingKey;
      pendingKey = null;
      parts.push(`${list ? SINGULAR[list] ?? humanize(list) : 'Entry'} “${m[1]}”`);
    } else {
      flush();
      pendingKey = m[2];
    }
  }
  flush();
  return parts.join(' › ');
}

const MAX = 160;

// A value as one short line of text.
export function displayValue(v: unknown): string {
  if (v === undefined) return 'Not set';
  if (v === null || v === '') return 'Empty';
  let text: string;
  if (typeof v === 'string') text = v;
  else if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) text = v.length ? v.map(String).join(', ') : 'None';
  else if (typeof v === 'object') text = JSON.stringify(v);
  else text = String(v);
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}

export interface ThreeWayRow {
  path: string;
  last: unknown;
  target: unknown;
  incoming: unknown;
  // Changed in the target since it was last promoted (an overwrite loses it).
  drifted: boolean;
}

// Rows for a drifted item: everything that changed in the target since the
// last promotion, and everything the incoming item would change.
export function threeWayRows(last: unknown, target: unknown, incoming: unknown): ThreeWayRow[] {
  const rows = new Map<string, ThreeWayRow>();
  for (const d of diffValues(last, target)) rows.set(d.path, { path: d.path, last: d.from, target: d.to, incoming: d.to, drifted: true });
  for (const d of diffValues(target, incoming)) {
    const row = rows.get(d.path);
    if (row) row.incoming = d.to;
    else rows.set(d.path, { path: d.path, last: d.from, target: d.from, incoming: d.to, drifted: false });
  }
  return [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
