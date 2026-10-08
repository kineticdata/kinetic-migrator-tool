// Where an item sits in the object tree shared by Explore and Compare. This
// mirrors the server's tree layout (app/server/tree-index.ts): the section an
// item belongs to and the tree nodes above it, root first.
import type { NodeKind } from '../../../shared/sync-api';
import { segmentLabel } from './key-label';

// Which top-level section an item key belongs to (for the type filter).
export function sectionOf(key: string): string {
  const head = key.split('/')[0];
  if (key === 'space' || head === 'workflows' || head === 'webapis') return 'space';
  const groups: Record<string, string> = {
    kapps: 'group:kapps', connections: 'group:connections', handlers: 'group:handlers', teams: 'group:teams',
    models: 'group:models', 'file-resources': 'group:file-resources', routines: 'group:routines',
  };
  return groups[head] ?? 'group:other';
}

// The tree nodes above an item, root first (mirrors the server's tree
// layout), so an item opened by link can be revealed.
export function ancestorsOf(key: string): string[] {
  const p = key.split('/');
  if (key === 'space') return [];
  if (p[0] === 'workflows') return ['space', 'group:space/workflows'];
  if (p[0] === 'webapis') return ['space', 'group:space/webapis'];
  if (p[0] === 'kapps' && p.length >= 3) {
    const kapp = ['group:kapps'];
    if (p[2] === 'kapp') return kapp;
    kapp.push(`kapps/${p[1]}/kapp`);
    if (p[2] === 'forms' && p.length >= 5) {
      const forms = [...kapp, `group:kapps/${p[1]}/forms`];
      return p[4] === 'form' ? forms : [...forms, `kapps/${p[1]}/forms/${p[3]}/form`];
    }
    if (p[2] === 'workflows' || p[2] === 'webapis') return [...kapp, `group:kapps/${p[1]}/${p[2]}`];
  }
  if (p[0] === 'connections' && p.length >= 3) {
    return p[2] === 'operations' ? ['group:connections', `connections/${p[1]}/connection`] : ['group:connections'];
  }
  return [sectionOf(key)];
}

// The kind of item a key names (as the tree shows it).
export function kindOfKey(key: string): NodeKind {
  // A sub-collection entry (`<item>#<collection>/<name>`) shows as its item.
  key = key.split('#')[0];
  const p = key.split('/');
  if (key === 'space') return 'space';
  if (p[0] === 'workflows' || (p[0] === 'kapps' && (p[2] === 'workflows' || p[4] === 'workflows'))) return 'workflow';
  if (p[0] === 'webapis' || (p[0] === 'kapps' && p[2] === 'webapis')) return 'webapi';
  if (p[0] === 'kapps') return p[2] === 'kapp' ? 'kapp' : p[4] === 'data' ? 'data' : 'form';
  if (p[0] === 'connections') return p[2] === 'operations' ? 'operation' : 'connection';
  const heads: Record<string, NodeKind> = { handlers: 'handler', teams: 'team', models: 'model', 'file-resources': 'file-resource', routines: 'routine' };
  return heads[p[0]] ?? 'other';
}

// A readable name from a key alone, when nothing better is known.
export function nameOfKey(key: string): string {
  const p = key.split('/');
  if (key === 'space') return 'Space';
  const last = p[p.length - 1];
  if (['kapp', 'form', 'connection', 'handler', 'data'].includes(last) && p.length >= 2) {
    const name = last === 'data' ? `${p[p.length - 2]} data` : p[p.length - 2];
    return safe(name);
  }
  return safe(last);
}

// Key segments are engine-encoded file names (see key-label.ts).
const safe = segmentLabel;
