// The object tree shared by Explore and Compare: Space (with its workflows and
// WebAPIs) / Kapps → Forms → Workflows, kapp Workflows, WebAPIs / Connections →
// Operations / Handlers / Teams / Models / File resources / Routines. Item
// nodes use the artifact key as id; groups use `group:` ids. A parent that is
// not itself in the key set (for example an unchanged form in a compare)
// appears as a placeholder without a key. Children are served lazily.
import type { NodeKind, TreeNode } from '../shared/sync-api.ts';
import { compareText, segmentLabel } from './engine-sync.ts';

export interface IndexNode {
  id: string;
  label: string;
  kind: NodeKind;
  key?: string;
  parent: string | null;
  children: string[];
  count: number;
  rank: number;
}

export interface TreeIndex {
  nodes: Map<string, IndexNode>;
  roots: string[];
}

const ROOTS: Array<[string, string]> = [
  ['space', 'Space'], ['group:kapps', 'Kapps'], ['group:connections', 'Connections'], ['group:handlers', 'Handlers'],
  ['group:teams', 'Teams'], ['group:models', 'Models'], ['group:file-resources', 'File resources'], ['group:routines', 'Routines'],
  ['group:other', 'Other'],
];
const ROOT_RANK = new Map(ROOTS.map(([id], i) => [id, i]));

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

export function labelFor(key: string, data: unknown): string {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  // Key segments are encoded file names; labels show the names they encode.
  const seg = (i: number) => segmentLabel(key.split('/')[i] ?? '');
  const last = segmentLabel(key.split('/').pop() ?? key);
  if (key === 'space') return str(d.name) ?? 'Space';
  if (/^kapps\/[^/]+\/kapp$/.test(key)) return str(d.name) ?? seg(1);
  if (/\/form$/.test(key)) return str(d.name) ?? seg(3);
  if (/\/data$/.test(key)) return 'Reference data';
  if (/^connections\/[^/]+\/connection$/.test(key)) return str(d.name) ?? seg(1);
  if (/^handlers\/[^/]+\/handler$/.test(key)) return str(d.name) ?? seg(1);
  return str(d.name) ?? str(d.slug) ?? last;
}

interface Placement {
  kind: NodeKind;
  // Ancestors from the root down: [id, label, kind, rank].
  parents: Array<[string, string, NodeKind, number]>;
}

const g = (id: string, label: string, rank = 0): [string, string, NodeKind, number] => [id, label, 'group', rank];

function place(key: string): Placement | null {
  const p = key.split('/');
  if (key === 'task-refs') return null;
  if (key === 'space') return { kind: 'space', parents: [] };
  if (p[0] === 'workflows' && p.length === 3) return { kind: 'workflow', parents: [['space', 'Space', 'space', 0], g('group:space/workflows', 'Workflows', 1)] };
  if (p[0] === 'webapis' && p.length === 2) return { kind: 'webapi', parents: [['space', 'Space', 'space', 0], g('group:space/webapis', 'WebAPIs', 2)] };
  if (p[0] === 'kapps' && p.length >= 3) {
    const kapp: [string, string, NodeKind, number] = [`kapps/${p[1]}/kapp`, segmentLabel(p[1]), 'kapp', 10];
    const base = [g('group:kapps', 'Kapps'), kapp];
    if (p.length === 3 && p[2] === 'kapp') return { kind: 'kapp', parents: [g('group:kapps', 'Kapps')] };
    if (p[2] === 'forms' && p.length >= 5) {
      const form: [string, string, NodeKind, number] = [`kapps/${p[1]}/forms/${p[3]}/form`, segmentLabel(p[3]), 'form', 10];
      const forms = [...base, g(`group:kapps/${p[1]}/forms`, 'Forms', 1)];
      if (p.length === 5 && p[4] === 'form') return { kind: 'form', parents: forms };
      if (p.length === 5 && p[4] === 'data') return { kind: 'data', parents: [...forms, form] };
      if (p[4] === 'workflows' && p.length === 7) return { kind: 'workflow', parents: [...forms, form] };
    }
    if (p[2] === 'workflows' && p.length === 5) return { kind: 'workflow', parents: [...base, g(`group:kapps/${p[1]}/workflows`, 'Workflows', 2)] };
    if (p[2] === 'webapis' && p.length === 4) return { kind: 'webapi', parents: [...base, g(`group:kapps/${p[1]}/webapis`, 'WebAPIs', 3)] };
  }
  if (p[0] === 'connections' && p.length >= 3) {
    if (p.length === 3 && p[2] === 'connection') return { kind: 'connection', parents: [g('group:connections', 'Connections')] };
    if (p[2] === 'operations' && p.length === 4) {
      return { kind: 'operation', parents: [g('group:connections', 'Connections'), [`connections/${p[1]}/connection`, segmentLabel(p[1]), 'connection', 10]] };
    }
  }
  if (p[0] === 'handlers' && p.length === 3) return { kind: 'handler', parents: [g('group:handlers', 'Handlers')] };
  if (p[0] === 'teams' && p.length === 2) return { kind: 'team', parents: [g('group:teams', 'Teams')] };
  if (p[0] === 'models' && p.length === 2) return { kind: 'model', parents: [g('group:models', 'Models')] };
  if (p[0] === 'file-resources' && p.length === 2) return { kind: 'file-resource', parents: [g('group:file-resources', 'File resources')] };
  if (p[0] === 'routines' && p.length === 2) return { kind: 'routine', parents: [g('group:routines', 'Routines')] };
  return { kind: 'other', parents: [g('group:other', 'Other')] };
}

export function buildTreeIndex(keys: Iterable<string>, dataOf: (key: string) => unknown): TreeIndex {
  const nodes = new Map<string, IndexNode>();
  const roots: string[] = [];
  const ensure = (id: string, label: string, kind: NodeKind, rank: number, parent: string | null): IndexNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, label, kind, parent, children: [], count: 0, rank };
      nodes.set(id, n);
      if (parent === null) roots.push(id);
      else nodes.get(parent)!.children.push(id);
    }
    return n;
  };
  for (const key of keys) {
    const at = place(key);
    if (!at) continue;
    let parent: string | null = null;
    for (const [id, label, kind, rank] of at.parents) {
      ensure(id, label, kind, parent === null ? ROOT_RANK.get(id) ?? 99 : rank, parent);
      parent = id;
    }
    const node = ensure(key, labelFor(key, dataOf(key)), at.kind, parent === null ? ROOT_RANK.get(key) ?? 99 : 10, parent);
    node.key = key;
    node.label = labelFor(key, dataOf(key));
  }
  const order = (a: IndexNode, b: IndexNode) => a.rank - b.rank || compareText(a.label, b.label) || compareText(a.id, b.id);
  const finish = (id: string): number => {
    const n = nodes.get(id)!;
    n.children.sort((a, b) => order(nodes.get(a)!, nodes.get(b)!));
    n.count = n.children.reduce((sum, c) => sum + finish(c) + (nodes.get(c)!.key ? 1 : 0), 0);
    return n.count;
  };
  roots.sort((a, b) => order(nodes.get(a)!, nodes.get(b)!));
  for (const r of roots) finish(r);
  return { nodes, roots };
}

export function toTreeNode(n: IndexNode): TreeNode {
  const out: TreeNode = { id: n.id, label: n.label, kind: n.kind, count: n.count, hasChildren: n.children.length > 0 };
  if (n.key) out.key = n.key;
  return out;
}

// Children of `parent` (roots without one); null for an unknown parent.
export function childrenOf(index: TreeIndex, parent: string | null): IndexNode[] | null {
  if (parent === null || parent === '') return index.roots.map((id) => index.nodes.get(id)!);
  const n = index.nodes.get(parent);
  return n ? n.children.map((id) => index.nodes.get(id)!) : null;
}

// Item keys below a node (the node's own key included).
export function itemsUnder(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  const walk = (nid: string) => {
    const n = index.nodes.get(nid);
    if (!n) return;
    if (n.key) out.push(n.key);
    n.children.forEach(walk);
  };
  walk(id);
  return out;
}
