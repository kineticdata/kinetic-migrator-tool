// Explore: the object tree of an environment's newest snapshot (lazy by
// parent), one item's summary / relationships / JSON / history, and search.
// Secrets never appear: snapshots hold none, and summaries get only has-flags.
import type { ExploreItem, RelatedItem, SearchResponse, SearchResult } from '../shared/sync-api.ts';
import { badRequest, notFound } from './errors.ts';
import { moduleFor, summarize, type Edge } from './engine-sync.ts';
import { hasEnvSecret } from './environments.ts';
import type { ProjectRef } from './project-meta.ts';
import { log } from './repo.ts';
import type { Router } from './router.ts';
import type { SecretStore } from './secrets.ts';
import {
  connectionSecretFields, connectionSecretName, handlerSecretName, handlerSecretProperties,
} from './secret-names.ts';
import { fileSize, loadSnapshot, packagePath, requireEnvironment, type Snapshot, type SyncContext } from './snapshots.ts';
import { childrenOf, labelFor, toTreeNode } from './tree-index.ts';

export const SEARCH_LIMIT = 200;

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

export function itemLabel(snap: Snapshot, key: string): string {
  return snap.index.nodes.get(key)?.label ?? labelFor(key, snap.artifacts.get(key));
}

function relatedList(snap: Snapshot, edges: Edge[] | undefined): RelatedItem[] {
  return (edges ?? []).map((e) => ({ key: e.key, label: itemLabel(snap, e.key), kind: e.kind, reason: e.reason }));
}

function fieldNames(form: Obj): string[] {
  const out: string[] = [];
  const walk = (els: unknown) => {
    for (const e of Array.isArray(els) ? els : []) {
      if (e?.type === 'field' && typeof e.name === 'string') out.push(e.name);
      if (e?.elements) walk(e.elements);
    }
  };
  for (const p of Array.isArray(form.pages) ? form.pages : []) walk(p?.elements);
  return out;
}

// The has-flags and counts a summary card needs, from the snapshot and store.
async function summaryExtra(ref: ProjectRef, snap: Snapshot, key: string, store: SecretStore): Promise<Record<string, unknown>> {
  const d = obj(snap.artifacts.get(key));
  const keys = [...snap.artifacts.keys()];
  const extra: Record<string, unknown> = {};
  let m: RegExpExecArray | null;
  if ((m = /^kapps\/([^/]+)\/kapp$/.exec(key))) {
    extra.formsCount = keys.filter((k) => k.startsWith(`kapps/${m![1]}/forms/`) && k.endsWith('/form')).length;
  } else if ((m = /^connections\/([^/]+)\/connection$/.exec(key))) {
    extra.operationCount = keys.filter((k) => k.startsWith(`connections/${m![1]}/operations/`)).length;
    const secrets: Record<string, boolean> = {};
    const name = String(d.name ?? m[1]);
    for (const f of connectionSecretFields(d)) secrets[f] = await hasEnvSecret(store, ref, snap.env, 'secret', connectionSecretName(name, f));
    extra.secrets = secrets;
  } else if (/^handlers\/[^/]+\/handler$/.test(key)) {
    const secrets: Record<string, boolean> = {};
    const id = String(d.definitionId ?? key.split('/')[1]);
    for (const p of handlerSecretProperties(d)) secrets[p] = await hasEnvSecret(store, ref, snap.env, 'handler', handlerSecretName(id, p));
    extra.secrets = secrets;
    extra.packageSize = fileSize(packagePath(snap, key));
  } else if ((m = /^(kapps\/[^/]+\/forms\/[^/]+)\/form$/.exec(key))) {
    const prefix = `${m[1]}/workflows/`;
    extra.workflows = keys.filter((k) => k.startsWith(prefix)).map((k) => {
      const w = obj(snap.artifacts.get(k));
      return { event: String(w.event ?? k.split('/')[5]), name: String(w.name ?? k.split('/')[6]) };
    });
    const byId = new Map<string, string>();
    for (const k of keys) {
      if (/^connections\/[^/]+\/(connection|operations\/[^/]+)$/.test(k)) {
        const x = obj(snap.artifacts.get(k));
        if (typeof x.id === 'string') byId.set(x.id, String(x.name ?? k.split('/').pop()));
      }
    }
    if (Array.isArray(d.integrations)) {
      extra.integrations = d.integrations.map((i: Obj) => {
        const conn = byId.get(i?.connectionId);
        const op = byId.get(i?.operationId);
        return conn && op ? `${conn} › ${op}` : String(i?.name ?? `${i?.connectionId} › ${i?.operationId}`);
      });
    }
  }
  return extra;
}

export async function exploreItem(ref: ProjectRef, snap: Snapshot, key: string, store: SecretStore): Promise<ExploreItem> {
  if (!snap.artifacts.has(key) || key === 'task-refs') throw notFound('No such item in this snapshot.');
  const data = snap.artifacts.get(key);
  const type = moduleFor(key)?.type ?? 'unknown';
  const rel = snap.relationships();
  const history = (await log(ref.dir, { path: `snapshots/${snap.env}/${key}.json`, limit: 50 }))
    .map((e) => ({ commit: e.oid, at: e.at, message: e.message.split('\n')[0] }));
  return {
    key,
    type,
    label: itemLabel(snap, key),
    summary: summarize(key, data, type, await summaryExtra(ref, snap, key, store)),
    relationships: { uses: relatedList(snap, rel.uses.get(key)), usedBy: relatedList(snap, rel.usedBy.get(key)) },
    json: data,
    history,
  };
}

export function search(snap: Snapshot, q: string): SearchResponse {
  const needle = q.trim().toLowerCase();
  if (!needle) return { results: [], truncated: false };
  const results: SearchResult[] = [];
  let truncated = false;
  const hit = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(needle);
  for (const n of snap.index.nodes.values()) {
    if (!n.key) continue;
    const d = obj(snap.artifacts.get(n.key));
    let r: SearchResult | null = null;
    if (hit(n.label) || hit(d.name)) r = { key: n.key, label: n.label, kind: n.kind, match: 'name' };
    else if (hit(d.slug) || hit(n.key.split('/').filter((s) => !['form', 'kapp', 'connection', 'handler'].includes(s)).pop())) {
      r = { key: n.key, label: n.label, kind: n.kind, match: 'slug' };
    } else if (n.kind === 'form') {
      const field = fieldNames(d).find(hit);
      if (field) r = { key: n.key, label: n.label, kind: n.kind, match: 'field', field };
    }
    if (!r) continue;
    if (results.length >= SEARCH_LIMIT) {
      truncated = true;
      break;
    }
    results.push(r);
  }
  return { results, truncated };
}

export function registerExploreRoutes(router: Router, ctx: SyncContext): void {
  const snapshotOf = async (p: string, env: string) => {
    const ref = ctx.find(p);
    return { ref, snap: await loadSnapshot(ref, requireEnvironment(ref, env)) };
  };
  router.get('/api/projects/:p/explore/:env/tree', async ({ params, query }) => {
    const { snap } = await snapshotOf(params.p, params.env);
    const nodes = childrenOf(snap.index, query.get('parent'));
    if (!nodes) throw notFound('No such tree node.');
    return { json: nodes.map(toTreeNode) };
  });
  router.get('/api/projects/:p/explore/:env/item', async ({ params, query }) => {
    const { ref, snap } = await snapshotOf(params.p, params.env);
    const key = query.get('key');
    if (!key) throw badRequest('Give the item key.');
    return { json: await exploreItem(ref, snap, key, ctx.secrets) };
  });
  router.get('/api/projects/:p/search/:env', async ({ params, query }) => {
    const { snap } = await snapshotOf(params.p, params.env);
    return { json: search(snap, query.get('q') ?? '') };
  });
}
