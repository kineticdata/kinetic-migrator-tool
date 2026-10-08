// ObjectTree: the virtualized object tree (ARIA `tree`). Only the rows in
// view are rendered, so a space with thousands of items stays fast; children
// load lazily as nodes open. Keyboard: Up/Down move, Right opens or goes to
// the first child, Left closes or goes to the parent, Home/End jump, Enter or
// Space selects an item (or toggles a group), and typing jumps to a label.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Box, ChevronRight, Database, FileText, Folder, Globe, KeyRound, Layers, Package, Plug, Puzzle, Repeat, Settings2, Users, Workflow,
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
  className?: string;
}

export function ObjectTree({ label, rows, selectedKey, onSelect, onToggle, renderAside, className }: ObjectTreeProps) {
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

  // Keep the selected item in view when it changes from outside.
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedKey]);

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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!activeRow) return;
    const { node } = activeRow;
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
      case 'Enter':
      case ' ':
        activate(activeRow);
        break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const now = Date.now();
        const t = typed.current;
        t.text = now - t.at > TYPE_AHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
        t.at = now;
        // Search after the active row for a new word, from it while extending one.
        const start = t.text.length === 1 ? activeIndex + 1 : activeIndex;
        for (let i = 0; i < rows.length; i++) {
          const idx = (start + i) % rows.length;
          if (rows[idx].node.label.toLowerCase().startsWith(t.text)) {
            moveTo(idx);
            break;
          }
        }
        break;
      }
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
              <KindIcon kind={node.kind} className={selected ? 'text-accent' : 'text-subtle'} />
              <span className={cn('min-w-0 truncate', !node.key && 'font-medium')} title={node.label}>{node.label}</span>
              {row.detail && <span className="min-w-0 truncate text-xs text-subtle">{row.detail}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
                {renderAside?.(row)}
                {node.hasChildren && node.count > 0 && (
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
