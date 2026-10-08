// ObjectTree: the virtualized object tree (ARIA `tree`). Only the rows in
// view are rendered, so a space with thousands of items stays fast; children
// load lazily as nodes open. Keyboard: Up/Down move, Right opens or goes to
// the first child, Left closes or goes to the parent, Home/End jump, Enter or
// Space selects an item (or toggles a group), and typing jumps to a label.
// Selection mode (Compare): with `checkState`, rows carry tri-state checkboxes
// (aria-checked on the treeitem); Space ticks, Enter selects.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Box, Check, ChevronRight, Database, FileText, Folder, Globe, KeyRound, Layers, Minus, Package, Plug, Puzzle, Repeat, Settings2, Tags, Users, Workflow,
} from 'lucide-react';
import type { NodeKind, TreeNode } from '../../../shared/sync-api';
import { Spinner } from './ui/Spinner';
import { cn } from './ui/cn';

// A node's children: loaded, still loading, or failed to load.
export type ChildrenState = TreeNode[] | 'loading' | 'error';

export interface TreeRow {
  node: TreeNode;
  depth: number;
  parentId: string | null;
  expanded: boolean;
  loading: boolean;
  // Position among its siblings (aria-posinset / aria-setsize).
  pos: number;
  size: number;
  // Optional secondary text (for example where a search result lives).
  detail?: string;
}

// The visible rows: roots, then the children of every expanded node.
export function flattenTree(roots: TreeNode[], children: Map<string, ChildrenState>, expanded: Set<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentId: string | null) => {
    nodes.forEach((node, i) => {
      const open = node.hasChildren && expanded.has(node.id);
      const kids = open ? children.get(node.id) : undefined;
      out.push({ node, depth, parentId, expanded: open, loading: open && (kids === undefined || kids === 'loading'), pos: i + 1, size: nodes.length });
      if (open && Array.isArray(kids)) walk(kids, depth + 1, node.id);
    });
  };
  walk(roots, 0, null);
  return out;
}

const kindIcon: Record<NodeKind, typeof Folder> = {
  group: Folder,
  space: Settings2,
  kapp: Box,
  form: FileText,
  workflow: Workflow,
  webapi: Globe,
  data: Database,
  connection: Plug,
  operation: Repeat,
  handler: Puzzle,
  team: Users,
  model: Layers,
  'file-resource': Package,
  routine: KeyRound,
  'task-category': Tags,
  other: FileText,
};

export function KindIcon({ kind, className }: { kind: NodeKind | string; className?: string }) {
  const Icon = kindIcon[kind as NodeKind] ?? FileText;
  return <Icon size={14} aria-hidden className={cn('shrink-0', className)} />;
}

export const ROW_HEIGHT = 30;
const TYPE_AHEAD_MS = 600;

export interface ObjectTreeProps {
  label: string;
  rows: TreeRow[];
  // The selected item's key (rows match on node.key).
  selectedKey: string | null;
  onSelect: (node: TreeNode) => void;
  onToggle: (id: string, open: boolean) => void;
  // Extra content at the end of a row (status chips in Compare).
  renderAside?: (row: TreeRow) => ReactNode;
  // Selection mode: each row's checkbox state ('none' = no checkbox).
  checkState?: (row: TreeRow) => CheckState;
  onCheck?: (row: TreeRow) => void;
  // Why a row's checkbox is disabled (null when it is enabled).
  checkHint?: (row: TreeRow) => string | null;
  // Item counts on parent rows (Compare shows rolled-up statuses instead).
  showCounts?: boolean;
  className?: string;
}

export type CheckState = 'checked' | 'unchecked' | 'mixed' | 'none';

const ariaChecked = (s: CheckState) => (s === 'none' ? undefined : s === 'mixed' ? 'mixed' : s === 'checked');

// The visual checkbox; the treeitem itself carries aria-checked.
function CheckBox({ state, hint, onClick }: { state: CheckState; hint: string | null; onClick: () => void }) {
  if (state === 'none') return <span aria-hidden className="size-4 shrink-0" />;
  const on = state !== 'unchecked';
  return (
    <span
      aria-hidden
      data-check
      title={hint ?? undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (!hint) onClick();
      }}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
        hint ? 'cursor-not-allowed border-dashed opacity-60' : 'cursor-pointer',
        on ? 'border-accent bg-accent text-accent-fg' : cn('border-border-strong bg-surface', !hint && 'hover:border-accent'),
      )}
    >
      {state === 'checked' && <Check size={11} strokeWidth={3} />}
      {state === 'mixed' && <Minus size={11} strokeWidth={3} />}
    </span>
  );
}

export function ObjectTree({ label, rows, selectedKey, onSelect, onToggle, renderAside, checkState, onCheck, checkHint, showCounts = true, className }: ObjectTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const domId = `tree${useId().replace(/:/g, '')}`;

  const indexById = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i])), [rows]);
  // The active row: the one moved to, else the selected item, else the first.
  const selectedIndex = selectedKey ? rows.findIndex((r) => r.node.key === selectedKey) : -1;
  const activeIndex = activeId !== null && indexById.has(activeId) ? indexById.get(activeId)! : Math.max(0, selectedIndex);
  const activeRow = rows[activeIndex];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const moveTo = (index: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    setActiveId(row.node.id);
    virtualizer.scrollToIndex(indexById.get(row.node.id)!, { align: 'auto' });
  };

  // Bring a newly selected item into view (and make it the active row) once
  // its row exists: it may appear only after its ancestors have loaded.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedKey || selectedIndex < 0 || revealed.current === selectedKey) return;
    revealed.current = selectedKey;
    setActiveId(rows[selectedIndex].node.id);
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedKey, selectedIndex, rows, virtualizer]);

  // Enter/Space: select an item, toggle a group.
  const activate = (row: TreeRow) => {
    setActiveId(row.node.id);
    if (row.node.key) onSelect(row.node);
    else if (row.node.hasChildren) onToggle(row.node.id, !row.expanded);
  };

  // A click also opens a closed item that has children.
  const click = (row: TreeRow) => {
    activate(row);
    if (row.node.key && row.node.hasChildren && !row.expanded) onToggle(row.node.id, true);
  };

  // Jumps to the next row whose label starts with what was typed.
  const typeAhead = (ch: string) => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > TYPE_AHEAD_MS ? ch.toLowerCase() : t.text + ch.toLowerCase();
    t.at = now;
    // Search after the active row for a new word, from it while extending one.
    const start = t.text.length === 1 ? activeIndex + 1 : activeIndex;
    for (let i = 0; i < rows.length; i++) {
      const idx = (start + i) % rows.length;
      if (rows[idx].node.label.toLowerCase().startsWith(t.text)) {
        moveTo(idx);
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!activeRow) return;
    const { node } = activeRow;
    // Once a word is being typed, Space is part of it.
    if (e.key === ' ' && typed.current.text && Date.now() - typed.current.at <= TYPE_AHEAD_MS) {
      typeAhead(' ');
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowDown': moveTo(activeIndex + 1); break;
      case 'ArrowUp': moveTo(activeIndex - 1); break;
      case 'Home': moveTo(0); break;
      case 'End': moveTo(rows.length - 1); break;
      case 'ArrowRight':
        if (node.hasChildren && !activeRow.expanded) onToggle(node.id, true);
        else if (activeRow.expanded && rows[activeIndex + 1]?.parentId === node.id) moveTo(activeIndex + 1);
        break;
      case 'ArrowLeft':
        if (activeRow.expanded) onToggle(node.id, false);
        else if (activeRow.parentId !== null) moveTo(indexById.get(activeRow.parentId) ?? activeIndex);
        break;
      case ' ':
        if (checkState) {
          if (checkState(activeRow) !== 'none' && !checkHint?.(activeRow)) onCheck?.(activeRow);
          break;
        }
        activate(activeRow);
        break;
      case 'Enter':
        activate(activeRow);
        break;
      default:
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        typeAhead(e.key);
        break;
    }
    e.preventDefault();
  };

  const rowDomId = (id: string) => `${domId}-${indexById.get(id)}`;

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={activeRow ? rowDomId(activeRow.node.id) : undefined}
      onKeyDown={onKeyDown}
      className={cn('relative overflow-auto outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset', className)}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          const { node } = row;
          const selected = Boolean(node.key && node.key === selectedKey);
          const isActive = v.index === activeIndex;
          const check = checkState ? checkState(row) : null;
          const hint = check && check !== 'none' ? checkHint?.(row) ?? null : null;
          return (
            <div
              key={node.id}
              id={rowDomId(node.id)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-posinset={row.pos}
              aria-setsize={row.size}
              aria-expanded={node.hasChildren ? row.expanded : undefined}
              aria-selected={selected}
              aria-checked={check ? ariaChecked(check) : undefined}
              aria-description={hint ?? undefined}
              aria-busy={row.loading || undefined}
              onClick={() => click(row)}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)`, paddingLeft: 8 + row.depth * 16 }}
              className={cn(
                'flex cursor-default items-center gap-1.5 pr-3 text-[13px] select-none',
                selected ? 'bg-accent-soft text-fg' : 'text-fg hover:bg-surface-2',
                isActive && 'shadow-[inset_2px_0_0_var(--accent)]',
              )}
            >
              <span
                aria-hidden
                className="flex size-4 shrink-0 items-center justify-center text-subtle"
                onClick={(e) => {
                  if (!node.hasChildren) return;
                  e.stopPropagation();
                  setActiveId(node.id);
                  onToggle(node.id, !row.expanded);
                }}
              >
                {row.loading ? <Spinner size={12} /> : node.hasChildren && <ChevronRight size={14} className={cn('transition-transform', row.expanded && 'rotate-90')} />}
              </span>
              {check && <CheckBox state={check} hint={hint} onClick={() => { setActiveId(node.id); onCheck?.(row); }} />}
              <KindIcon kind={node.kind} className={selected ? 'text-accent' : 'text-subtle'} />
              <span className={cn('min-w-0 truncate', !node.key && 'font-medium')} title={node.label}>{node.label}</span>
              {row.detail && <span className="min-w-0 truncate text-xs text-subtle">{row.detail}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
                {renderAside?.(row)}
                {showCounts && node.hasChildren && node.count > 0 && (
                  <span className="text-xs text-subtle tabular-nums" aria-label={`${node.count.toLocaleString('en')} items`}>{node.count.toLocaleString('en')}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
