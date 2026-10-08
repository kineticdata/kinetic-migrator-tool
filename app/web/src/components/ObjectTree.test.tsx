// ObjectTree: a virtualized ARIA tree. A big space stays usable (only the
// visible rows are in the DOM) and every action works from the keyboard.
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TreeNode } from '../../../shared/sync-api';
import { ObjectTree, flattenTree, type ChildrenState } from './ObjectTree';

// jsdom has no layout: give every element a viewport-sized box so the
// virtualizer has something to fill.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 320, width: 320, height: 600, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
});
afterEach(() => vi.restoreAllMocks());

const node = (id: string, label: string, over: Partial<TreeNode> = {}): TreeNode => ({
  id, label, kind: 'form', key: id, count: 0, hasChildren: false, ...over,
});

test('a 2,000-node tree renders fewer than 100 DOM rows', () => {
  const forms = Array.from({ length: 2000 }, (_, i) => node(`kapps/k/forms/f${i}/form`, `Form ${String(i).padStart(4, '0')}`));
  const roots = [node('group:kapps', 'Kapps', { kind: 'group', key: undefined, count: 2000, hasChildren: true })];
  const rows = flattenTree(roots, new Map([['group:kapps', forms]]), new Set(['group:kapps']));
  expect(rows).toHaveLength(2001);
  render(<ObjectTree label="Items" rows={rows} selectedKey={null} onSelect={() => {}} onToggle={() => {}} />);
  const items = screen.getAllByRole('treeitem');
  expect(items.length).toBeGreaterThan(5);
  expect(items.length).toBeLessThan(100);
  expect(screen.getByRole('tree', { name: 'Items' })).toBeInTheDocument();
  // The group shows its count.
  expect(screen.getByRole('treeitem', { name: /Kapps/ })).toHaveTextContent('2,000');
});

const ROOTS: TreeNode[] = [
  node('space', 'Space', { kind: 'space', key: 'space', count: 0, hasChildren: false }),
  node('group:kapps', 'Kapps', { kind: 'group', key: undefined, count: 3, hasChildren: true }),
  node('group:teams', 'Teams', { kind: 'group', key: undefined, count: 1, hasChildren: true }),
];
const CHILDREN = new Map<string, ChildrenState>([
  ['group:kapps', [node('kapps/hr/kapp', 'HR', { kind: 'kapp', count: 2, hasChildren: true })]],
  ['kapps/hr/kapp', [node('kapps/hr/forms/leave/form', 'Leave request'), node('kapps/hr/forms/onboard/form', 'Onboarding')]],
  ['group:teams', [node('teams/ops', 'Operations', { kind: 'team' })]],
]);

function Harness({ onSelect, onToggle }: { onSelect: (n: TreeNode) => void; onToggle?: (id: string, open: boolean) => void }) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const rows = flattenTree(ROOTS, CHILDREN, expanded);
  return (
    <ObjectTree
      label="Items"
      rows={rows}
      selectedKey={null}
      onSelect={onSelect}
      onToggle={(id, open) => {
        onToggle?.(id, open);
        setExpanded((s) => {
          const n = new Set(s);
          if (open) n.add(id);
          else n.delete(id);
          return n;
        });
      }}
    />
  );
}

const active = () => {
  const tree = screen.getByRole('tree');
  const id = tree.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent ?? '' : '';
};

test('keyboard: arrows move and expand, Home/End jump, type-ahead finds, Enter selects', () => {
  const onSelect = vi.fn();
  render(<Harness onSelect={onSelect} />);
  const tree = screen.getByRole('tree');
  tree.focus();
  expect(active()).toContain('Space');

  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  expect(active()).toContain('Kapps');
  expect(screen.getByRole('treeitem', { name: /Kapps/ })).toHaveAttribute('aria-expanded', 'false');

  // Right expands a closed group, then moves into it.
  fireEvent.keyDown(tree, { key: 'ArrowRight' });
  expect(screen.getByRole('treeitem', { name: /Kapps/ })).toHaveAttribute('aria-expanded', 'true');
  expect(active()).toContain('Kapps');
  fireEvent.keyDown(tree, { key: 'ArrowRight' });
  expect(active()).toContain('HR');
  fireEvent.keyDown(tree, { key: 'ArrowRight' });
  fireEvent.keyDown(tree, { key: 'ArrowRight' });
  expect(active()).toContain('Leave request');
  expect(screen.getByRole('treeitem', { name: /Leave request/ })).toHaveAttribute('aria-level', '3');

  // Left goes to the parent, then collapses it.
  fireEvent.keyDown(tree, { key: 'ArrowLeft' });
  expect(active()).toContain('HR');
  fireEvent.keyDown(tree, { key: 'ArrowLeft' });
  expect(screen.queryByRole('treeitem', { name: /Leave request/ })).toBeNull();

  fireEvent.keyDown(tree, { key: 'End' });
  expect(active()).toContain('Teams');
  fireEvent.keyDown(tree, { key: 'Home' });
  expect(active()).toContain('Space');
  fireEvent.keyDown(tree, { key: 'ArrowUp' });
  expect(active()).toContain('Space');

  // Type-ahead: "h" finds HR.
  fireEvent.keyDown(tree, { key: 'h' });
  expect(active()).toContain('HR');

  fireEvent.keyDown(tree, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'kapps/hr/kapp' }));
});

test('Enter on a group toggles it; clicking an item selects it', () => {
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  render(<Harness onSelect={onSelect} onToggle={onToggle} />);
  const tree = screen.getByRole('tree');
  tree.focus();
  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  fireEvent.keyDown(tree, { key: 'Enter' });
  expect(onToggle).toHaveBeenCalledWith('group:kapps', true);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('HR'));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'kapps/hr/kapp' }));
});

test('an expanded node whose children are loading says so', () => {
  const rows = flattenTree(ROOTS, new Map([['group:kapps', 'loading']]), new Set(['group:kapps']));
  render(<ObjectTree label="Items" rows={rows} selectedKey={null} onSelect={() => {}} onToggle={() => {}} />);
  expect(screen.getByRole('treeitem', { name: /Kapps/ })).toHaveAttribute('aria-busy', 'true');
});

test('Space continues a type-ahead word instead of selecting', () => {
  let now = 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const onSelect = vi.fn();
  render(<Harness onSelect={onSelect} />);
  const tree = screen.getByRole('tree');
  tree.focus();
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'Home']) fireEvent.keyDown(tree, { key });
  for (const key of 'leave r') {
    now += 50;
    fireEvent.keyDown(tree, { key });
  }
  expect(active()).toContain('Leave request');
  expect(onSelect).not.toHaveBeenCalled();
  // After a pause, Space selects again.
  now += 2000;
  fireEvent.keyDown(tree, { key: ' ' });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'kapps/hr/forms/leave/form' }));
});

test('selection mode: rows carry aria-checked, Space ticks, Enter still selects, the box ticks without selecting', () => {
  const onSelect = vi.fn();
  const onCheck = vi.fn();
  const rows = flattenTree(ROOTS, CHILDREN, new Set(['group:kapps', 'kapps/hr/kapp']));
  const states: Record<string, 'checked' | 'unchecked' | 'mixed' | 'none'> = {
    space: 'none', 'group:kapps': 'mixed', 'kapps/hr/kapp': 'mixed', 'kapps/hr/forms/leave/form': 'checked', 'kapps/hr/forms/onboard/form': 'unchecked', 'group:teams': 'unchecked',
  };
  render(
    <ObjectTree
      label="Items"
      rows={rows}
      selectedKey={null}
      onSelect={onSelect}
      onToggle={() => {}}
      checkState={(row) => states[row.node.id] ?? 'none'}
      onCheck={onCheck}
    />,
  );
  expect(screen.getByRole('treeitem', { name: /Space/ })).not.toHaveAttribute('aria-checked');
  expect(screen.getByRole('treeitem', { name: /Kapps/ })).toHaveAttribute('aria-checked', 'mixed');
  expect(screen.getByRole('treeitem', { name: /Leave request/ })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('treeitem', { name: /Onboarding/ })).toHaveAttribute('aria-checked', 'false');

  const tree = screen.getByRole('tree');
  tree.focus();
  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  fireEvent.keyDown(tree, { key: ' ' });
  expect(onCheck).toHaveBeenLastCalledWith(expect.objectContaining({ node: expect.objectContaining({ id: 'group:kapps' }) }));
  // Space on a row without a checkbox does nothing.
  fireEvent.keyDown(tree, { key: 'Home' });
  fireEvent.keyDown(tree, { key: ' ' });
  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(tree, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'space' }));

  fireEvent.click(screen.getByRole('treeitem', { name: /Onboarding/ }).querySelector('[data-check]')!);
  expect(onCheck).toHaveBeenLastCalledWith(expect.objectContaining({ node: expect.objectContaining({ id: 'kapps/hr/forms/onboard/form' }) }));
  expect(onSelect).toHaveBeenCalledTimes(1);
});
