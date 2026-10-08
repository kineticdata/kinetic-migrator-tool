// Field-level differences for Compare: readable labels for the server's diff
// paths (`a.b`, `list[name]`, `list.0`) and the three-way rows of a drifted
// item. Diff entries come from the server with `from` = the target's value and
// `to` = the incoming one.
import type { DiffEntry } from '../../../shared/sync-api';

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

// Splits a diff path into keys and bracketed names. A name runs to the "]"
// that ends the path or is followed by "." or "[", so names containing "."
// or "]" stay whole.
export function pathSegments(path: string): Array<{ key: string } | { name: string }> {
  const out: Array<{ key: string } | { name: string }> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      i++;
      continue;
    }
    if (path[i] === '[') {
      let j = i + 1;
      while (j < path.length && !(path[j] === ']' && (j + 1 === path.length || path[j + 1] === '.' || path[j + 1] === '['))) j++;
      out.push({ name: path.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    out.push({ key: path.slice(i, j) });
    i = j;
  }
  return out;
}

// "pages[Details].elements[Priority].required" →
// "Page “Details” › Element “Priority” › Required".
export function pathLabel(path: string): string {
  if (path === '(root)' || path === '') return 'Whole item';
  const segs = pathSegments(path);
  const parts: string[] = [];
  segs.forEach((seg, i) => {
    const next = segs[i + 1];
    if ('name' in seg) {
      const prev = segs[i - 1];
      const list = prev && 'key' in prev ? prev.key : null;
      parts.push(`${list ? SINGULAR[list] ?? humanize(list) : 'Entry'} “${seg.name}”`);
    } else if (!(next && 'name' in next)) {
      parts.push(/^\d+$/.test(seg.key) ? `#${Number(seg.key) + 1}` : humanize(seg.key));
    }
  });
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

// Rows for a drifted item: what changed in the target since the last
// promotion (`targetChanges`: last promoted → target now) and what the
// incoming item would change (`incoming`: target now → incoming).
export function threeWayRows(targetChanges: DiffEntry[], incoming: DiffEntry[]): ThreeWayRow[] {
  const rows = new Map<string, ThreeWayRow>();
  for (const d of targetChanges) rows.set(d.path, { path: d.path, last: d.from, target: d.to, incoming: d.to, drifted: true });
  for (const d of incoming) {
    const row = rows.get(d.path);
    if (row) row.incoming = d.to;
    else rows.set(d.path, { path: d.path, last: d.from, target: d.from, incoming: d.to, drifted: false });
  }
  return [...rows.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
