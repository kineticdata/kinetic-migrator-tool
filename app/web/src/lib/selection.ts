// The changeset being built in Compare: the selected item keys (with the
// status each had when ticked) and per-item drift decisions. Pure functions,
// so the tri-state rules are testable on their own.
//
// Rules:
// - New and changed items can be ticked, singly or through a parent.
// - A drifted item is ticked only on purpose (its own checkbox, or Overwrite
//   in the detail pane), which records an "overwrite" decision. A parent never
//   ticks drifted items, unless drifted items are all there is below it.
// - A parent is checked when everything a tick would select is selected,
//   mixed when only some of it is, and has no checkbox when nothing below it
//   can be promoted.
// - After a compare refresh, keys that no longer differ (or that became
//   drifted with no decision) are pruned.
import type { CompareStatus, CompareTreeNode, Resolution } from '../../../shared/sync-api';
import type { CheckState } from '../components/ObjectTree';
import { ancestorsOf } from './tree-layout';

export type { CheckState };

export const SELECTABLE: ReadonlySet<CompareStatus> = new Set(['new', 'changed', 'drifted']);
const BULK: ReadonlySet<CompareStatus> = new Set(['new', 'changed']);

export interface Selection {
  // Selected key → its status when it was ticked (insertion order kept).
  items: Record<string, CompareStatus>;
  resolutions: Record<string, Resolution>;
}

export interface KeyStatus {
  key: string;
  status: CompareStatus;
}

export const emptySelection = (): Selection => ({ items: {}, resolutions: {} });

export const selectedKeys = (sel: Selection): string[] => Object.keys(sel.items);

export const isSelectable = (status: CompareStatus | undefined): boolean => Boolean(status && SELECTABLE.has(status));

// Whether a selected item may stay selected with this status.
const keepable = (status: CompareStatus, resolution: Resolution | undefined) => BULK.has(status) || (status === 'drifted' && resolution === 'overwrite');

export interface Under {
  all: number;
  bulk: number;
}

// Selected items below each tree node.
export function underCounts(sel: Selection): Map<string, Under> {
  const out = new Map<string, Under>();
  for (const [key, status] of Object.entries(sel.items)) {
    for (const id of ancestorsOf(key)) {
      const u = out.get(id) ?? { all: 0, bulk: 0 };
      u.all++;
      if (BULK.has(status)) u.bulk++;
      out.set(id, u);
    }
  }
  return out;
}

const sum = (counts: CompareTreeNode['counts'], set: ReadonlySet<CompareStatus>) => [...set].reduce((n, s) => n + (counts[s] ?? 0), 0);

export function checkStateOf(node: CompareTreeNode, sel: Selection, under: Map<string, Under>): CheckState {
  const own = node.key && isSelectable(node.status) ? node.status! : null;
  const ownSelected = Boolean(node.key && sel.items[node.key]);
  const u = under.get(node.id) ?? { all: 0, bulk: 0 };
  const totalAll = sum(node.counts, SELECTABLE) + (own ? 1 : 0);
  const totalBulk = sum(node.counts, BULK) + (own && BULK.has(own) ? 1 : 0);
  if (totalAll === 0) return ownSelected ? 'checked' : 'none';
  const selAll = u.all + (ownSelected ? 1 : 0);
  const selBulk = u.bulk + (ownSelected && BULK.has(sel.items[node.key!]) ? 1 : 0);
  if (selAll === 0) return 'unchecked';
  const full = (totalBulk > 0 ? selBulk >= totalBulk : selAll >= totalAll) && (!own || ownSelected);
  return full ? 'checked' : 'mixed';
}

function add(sel: Selection, list: KeyStatus[]): Selection {
  const items = { ...sel.items };
  const resolutions = { ...sel.resolutions };
  for (const { key, status } of list) {
    if (!isSelectable(status)) continue;
    items[key] = status;
    if (status === 'drifted') resolutions[key] = 'overwrite';
  }
  return { items, resolutions };
}

export function removeKeys(sel: Selection, keys: Iterable<string>): Selection {
  const items = { ...sel.items };
  const resolutions = { ...sel.resolutions };
  for (const k of keys) {
    delete items[k];
    if (resolutions[k] === 'overwrite') delete resolutions[k];
  }
  return { items, resolutions };
}

// Adds items on purpose (a suggestion, Add all): drifted ones as overwrites.
export const addItems = (sel: Selection, list: KeyStatus[]): Selection => add(sel, list);

// An item's own checkbox.
export function toggleItem(sel: Selection, key: string, status: CompareStatus): Selection {
  return sel.items[key] ? removeKeys(sel, [key]) : add(sel, [{ key, status }]);
}

// A parent's checkbox (or an item with children). `below` lists the
// selectable items under it; `current` is its state before the click.
export function toggleNode(sel: Selection, node: CompareTreeNode, below: KeyStatus[], current: CheckState): Selection {
  const own: KeyStatus[] = node.key && isSelectable(node.status) ? [{ key: node.key, status: node.status! }] : [];
  if (current === 'checked') return removeKeys(sel, [...own, ...below].map((i) => i.key));
  const all = [...own, ...below].filter((i) => isSelectable(i.status));
  const bulk = all.filter((i) => BULK.has(i.status));
  // An item's own drifted status was clicked on purpose; drifted children were not.
  const ownDrifted = own.filter((i) => i.status === 'drifted');
  return add(sel, bulk.length ? [...bulk, ...ownDrifted] : all);
}

// Overwrite ticks a drifted item; Keep target unticks it and records that.
export function setResolution(sel: Selection, key: string, status: CompareStatus, resolution: Resolution): Selection {
  if (resolution === 'overwrite') return add(sel, [{ key, status }]);
  const next = removeKeys(sel, [key]);
  return { ...next, resolutions: { ...next.resolutions, [key]: 'keep' } };
}

// `found` maps keys looked up in the new comparison to their status, or null
// when the comparison no longer has them. Keys not in `found` are kept.
export function pruneSelection(sel: Selection, found: Map<string, CompareStatus | null | undefined>): { selection: Selection; removed: string[] } {
  const removed: string[] = [];
  let changed = false;
  const items = { ...sel.items };
  for (const [key, was] of Object.entries(sel.items)) {
    if (!found.has(key)) continue;
    const now = found.get(key);
    if (!now || !keepable(now, sel.resolutions[key])) removed.push(key);
    else if (now !== was) {
      items[key] = now;
      changed = true;
    }
  }
  if (!removed.length && !changed) return { selection: sel, removed };
  return { selection: removeKeys({ ...sel, items }, removed), removed };
}

// Decisions to send with a plan: overwrite for every selected drifted item.
export function planResolutions(sel: Selection): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const [key, status] of Object.entries(sel.items)) if (status === 'drifted') out[key] = 'overwrite';
  return out;
}
