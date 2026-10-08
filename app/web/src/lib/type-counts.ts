// "2 kapps · 5 forms · 3 connections · 3 teams": an environment's items by
// type, from its snapshot tree (the root groups, plus the kapps, kapp and
// connections levels where one group holds several types). The space itself
// and "Other" are not counted as types.
import type { TreeNode } from '../../../shared/sync-api';

export interface TypeCount {
  one: string;
  many: string;
  count: number;
}

// "group:kapps" → "kapps".
export const groupOf = (n: Pick<TreeNode, 'id'>): string => n.id.replace(/^group:/, '');

const SIMPLE: Array<[string, string, string]> = [
  ['handlers', 'handler', 'handlers'], ['teams', 'team', 'teams'], ['models', 'model', 'models'],
  ['routines', 'routine', 'routines'], ['file-resources', 'file resource', 'file resources'],
  ['task-categories', 'Workflow category', 'Workflow categories'],
];

// `children` maps a node id to its loaded children.
export function typeCounts(root: TreeNode[], children: ReadonlyMap<string, TreeNode[]>): TypeCount[] {
  const out: TypeCount[] = [];
  const find = (g: string) => root.find((n) => groupOf(n) === g);
  const kappsGroup = find('kapps');
  const kapps = kappsGroup ? (children.get(kappsGroup.id) ?? []).filter((n) => n.kind === 'kapp') : [];
  const forms = kapps.flatMap((k) => (children.get(k.id) ?? []).filter((n) => n.kind === 'group' && /\/forms$/.test(n.id)))
    .reduce((s, g) => s + (children.get(g.id) ?? []).filter((n) => n.kind === 'form').length, 0);
  const connGroup = find('connections');
  const connections = connGroup ? (children.get(connGroup.id) ?? []).filter((n) => n.kind === 'connection').length : 0;
  out.push({ one: 'kapp', many: 'kapps', count: kapps.filter((k) => k.key).length });
  out.push({ one: 'form', many: 'forms', count: forms });
  out.push({ one: 'connection', many: 'connections', count: connections });
  for (const [g, one, many] of SIMPLE) out.push({ one, many, count: find(g)?.count ?? 0 });
  return out.filter((t) => t.count > 0);
}
