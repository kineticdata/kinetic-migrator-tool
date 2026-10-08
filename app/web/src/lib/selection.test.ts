// Changeset selection: tri-state parents, drifted items needing an explicit
// decision, and pruning to what still differs after a compare refresh.
import { expect, test } from 'vitest';
import type { CompareTreeNode } from '../../../shared/sync-api';
import {
  checkStateOf, emptySelection, pruneSelection, selectedKeys, setResolution, tickKind, toggleItem, toggleNode, underCounts, type Selection,
} from './selection';

const node = (id: string, over: Partial<CompareTreeNode> = {}): CompareTreeNode => ({
  id, label: id, kind: 'form', key: id, count: 0, hasChildren: false, counts: {}, ...over,
});

const FORMS = node('group:kapps/hr/forms', { key: undefined, kind: 'group', hasChildren: true, count: 3, counts: { new: 1, changed: 1, drifted: 1 } });
const KAPP = node('kapps/hr/kapp', { kind: 'kapp', status: 'same', hasChildren: true, count: 4, counts: { new: 1, changed: 1, drifted: 1 } });
const LEAVE = node('kapps/hr/forms/leave/form', { status: 'new' });
const TRAVEL = node('kapps/hr/forms/travel/form', { status: 'changed' });
const APPROVAL = node('kapps/hr/forms/approval/form', { status: 'drifted' });
const SAME = node('kapps/hr/forms/same/form', { status: 'same' });
const KIDS = [LEAVE, TRAVEL, APPROVAL, SAME].map((n) => ({ key: n.key!, status: n.status! }));

const state = (n: CompareTreeNode, sel: Selection) => checkStateOf(n, sel, underCounts(sel));

test('items start unchecked; drifted items are never ticked by a parent', () => {
  let sel = emptySelection();
  for (const n of [FORMS, KAPP, LEAVE, TRAVEL, APPROVAL]) expect(state(n, sel)).toBe('unchecked');
  expect(state(SAME, sel)).toBe('none');

  sel = toggleNode(sel, FORMS, KIDS, state(FORMS, sel));
  expect(selectedKeys(sel)).toEqual([LEAVE.key, TRAVEL.key]);
  expect(state(FORMS, sel)).toBe('checked');
  expect(state(KAPP, sel)).toBe('checked');
  expect(state(LEAVE, sel)).toBe('checked');
  expect(state(APPROVAL, sel)).toBe('unchecked');
});

test('a partly selected parent is mixed; ticking it completes it, unticking a full one clears it', () => {
  let sel = toggleItem(emptySelection(), LEAVE.key!, 'new');
  expect(state(FORMS, sel)).toBe('mixed');
  expect(state(KAPP, sel)).toBe('mixed');

  sel = toggleNode(sel, FORMS, KIDS, state(FORMS, sel));
  expect(state(FORMS, sel)).toBe('checked');

  // An explicitly ticked drifted item goes with the parent when it is cleared.
  sel = toggleItem(sel, APPROVAL.key!, 'drifted');
  expect(sel.resolutions[APPROVAL.key!]).toBe('overwrite');
  expect(state(FORMS, sel)).toBe('checked');
  sel = toggleNode(sel, FORMS, KIDS, state(FORMS, sel));
  expect(selectedKeys(sel)).toEqual([]);
  expect(state(FORMS, sel)).toBe('unchecked');

  // Unticking one child of a full parent makes it mixed again.
  sel = toggleNode(sel, FORMS, KIDS, 'unchecked');
  sel = toggleItem(sel, TRAVEL.key!, 'changed');
  expect(state(FORMS, sel)).toBe('mixed');
});

test('a parent with only drifted items below cannot tick them: each needs its own decision', () => {
  const grp = node('group:teams', { key: undefined, kind: 'group', hasChildren: true, count: 1, counts: { drifted: 1 } });
  expect(tickKind(grp)).toBe('disabled');
  let sel = toggleNode(emptySelection(), grp, [{ key: 'teams/ops', status: 'drifted' }], 'unchecked');
  expect(selectedKeys(sel)).toEqual([]);
  expect(state(grp, sel)).toBe('unchecked');
  // Ticked one by one, the parent reflects them.
  sel = toggleItem(sel, 'teams/ops', 'drifted');
  expect(state(grp, sel)).toBe('checked');
  // A drifted item with children ticks only itself.
  const form = node(APPROVAL.key!, { status: 'drifted', hasChildren: true, counts: { same: 2 } });
  expect(tickKind(form)).toBe('self');
  expect(selectedKeys(toggleNode(emptySelection(), form, [], 'unchecked'))).toEqual([APPROVAL.key]);
});

test('Keep target unticks a drifted item; Overwrite ticks it', () => {
  let sel = setResolution(emptySelection(), APPROVAL.key!, 'drifted', 'overwrite');
  expect(selectedKeys(sel)).toEqual([APPROVAL.key]);
  sel = setResolution(sel, APPROVAL.key!, 'drifted', 'keep');
  expect(selectedKeys(sel)).toEqual([]);
  expect(sel.resolutions[APPROVAL.key!]).toBe('keep');
});

test('pruning drops keys that no longer differ, and drifted ones nobody chose to overwrite', () => {
  let sel = toggleNode(emptySelection(), FORMS, KIDS, 'unchecked');
  sel = toggleItem(sel, APPROVAL.key!, 'drifted');
  sel = toggleItem(sel, 'teams/ops', 'changed');
  const found = new Map<string, CompareTreeNode['status'] | null>([
    [LEAVE.key!, 'same'],
    [TRAVEL.key!, 'drifted'],
    [APPROVAL.key!, 'drifted'],
    ['teams/ops', null],
  ]);
  const { selection, removed } = pruneSelection(sel, found);
  expect(removed.sort()).toEqual([LEAVE.key, TRAVEL.key, 'teams/ops'].sort());
  expect(selectedKeys(selection)).toEqual([APPROVAL.key]);
  // Keys not looked up yet are left alone.
  expect(pruneSelection(sel, new Map()).removed).toEqual([]);
});
