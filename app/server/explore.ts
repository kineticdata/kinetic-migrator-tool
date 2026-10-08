// Explore: the object tree of an environment's newest snapshot (lazy by
// parent), one item's summary / relationships / JSON / history, and search.
// Secrets never appear: snapshots hold none, and summaries get only has-flags.
import type { CatalogKapp, ProjectCatalog } from '../shared/api.ts';
import type { ExploreItem, RelatedItem, SearchResponse, SearchResult } from '../shared/sync-api.ts';
import { badRequest, notFound } from './errors.ts';
import { compareText, moduleFor, segmentLabel, summarize, type Edge } from './engine-sync.ts';
import { hasEnvSecret, pipelineOrder } from './environments.ts';
import type { ProjectRef } from './project-meta.ts';
import { log } from './repo.ts';
import type { Router } from './router.ts';
import type { SecretStore } from './secrets.ts';
import {
  connectionSecretFields, connectionSecretName, handlerSecretName, handlerSecretProperties,
} from './secret-names.ts';
import {
  fileSize, latestSnapshotCommit, loadSnapshot, packagePath, requireEnvironment, type Snapshot, type SyncContext,
} from './snapshots.ts';
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
    const id = String(d.definitionId ?? segmentLabel(key.split('/')[1]));
    for (const p of handlerSecretProperties(d)) secrets[p] = await hasEnvSecret(store, ref, snap.env, 'handler', handlerSecretName(id, p));
    extra.secrets = secrets;
    extra.packageSize = fileSize(packagePath(snap, key));
  } else if ((m = /^(kapps\/[^/]+\/forms\/[^/]+)\/form$/.exec(key))) {
    const prefix = `${m[1]}/workflows/`;
    extra.workflows = keys.filter((k) => k.startsWith(prefix)).map((k) => {
      const w = obj(snap.artifacts.get(k));
      return { event: String(w.event ?? segmentLabel(k.split('/')[5])), name: String(w.name ?? segmentLabel(k.split('/')[6])) };
    });
    const byId = new Map<string, string>();
    for (const k of keys) {
      if (/^connections\/[^/]+\/(connection|operations\/[^/]+)$/.test(k)) {
        const x = obj(snap.artifacts.get(k));
        if (typeof x.id === 'string') byId.set(x.id, String(x.name ?? segmentLabel(k.split('/').pop() ?? '')));
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

// ---- Catalog: names for the settings pickers --------------------------------

const names = (list: unknown): string[] => (Array.isArray(list) ? list.map((x) => obj(x).name).filter((n): n is string => typeof n === 'string' && n !== '') : []);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(compareText);

// Kapps (with forms, fields and categories), teams and attribute names per
// level, read from one snapshot. Attribute names are the definitions plus any
// attribute in use, so a name set without a definition can still be picked.
export function buildCatalog(snap: Snapshot | null): ProjectCatalog {
  const empty: ProjectCatalog = { env: null, kapps: [], teams: [], attributes: { space: [], kapp: [], form: [], team: [], category: [] } };
  if (!snap) return empty;
  const space = obj(snap.artifacts.get('space'));
  const at = { space: [...names(space.spaceAttributeDefinitions), ...names(space.attributes)], kapp: [] as string[], form: [] as string[], team: [...names(space.teamAttributeDefinitions)], category: [] as string[] };
  const kapps = new Map<string, CatalogKapp>();
  const kappOf = (slug: string): CatalogKapp => {
    let k = kapps.get(slug);
    if (!k) kapps.set(slug, (k = { slug, name: slug, forms: [], categories: [], attributes: { kapp: [], form: [], category: [] } }));
    return k;
  };
  const teams: string[] = [];
  for (const [key, raw] of snap.artifacts) {
    const d = obj(raw);
    let m: RegExpExecArray | null;
    // Key segments are encoded file names; slugs come from the data, else decoded.
    const slug = (seg: string, v: unknown) => (typeof v === 'string' && v ? v : segmentLabel(seg));
    if ((m = /^kapps\/([^/]+)\/kapp$/.exec(key))) {
      const k = kappOf(slug(m[1], d.slug));
      k.name = typeof d.name === 'string' && d.name ? d.name : k.slug;
      const cats = Array.isArray(d.categories) ? d.categories.map(obj) : [];
      k.categories = cats.filter((c) => typeof c.slug === 'string').map((c) => ({ slug: c.slug, name: typeof c.name === 'string' ? c.name : c.slug }))
        .sort((a, b) => compareText(a.name, b.name));
      k.attributes.kapp.push(...names(d.kappAttributeDefinitions), ...names(d.attributes));
      k.attributes.form.push(...names(d.formAttributeDefinitions));
      k.attributes.category.push(...names(d.categoryAttributeDefinitions), ...cats.flatMap((c) => names(c.attributes)));
    } else if ((m = /^kapps\/([^/]+)\/forms\/([^/]+)\/form$/.exec(key))) {
      const k = kappOf(segmentLabel(m[1]));
      const formSlug = slug(m[2], d.slug);
      k.forms.push({ slug: formSlug, name: typeof d.name === 'string' && d.name ? d.name : formSlug, fields: sorted(fieldNames(d)) });
      k.attributes.form.push(...names(d.attributes));
    } else if (/^teams\//.test(key) && typeof d.name === 'string') {
      teams.push(d.name);
      at.team.push(...names(d.attributes));
    }
  }
  const list = [...kapps.values()].sort((a, b) => compareText(a.name, b.name));
  for (const k of list) {
    k.forms.sort((a, b) => compareText(a.name, b.name));
    k.attributes = { kapp: sorted(k.attributes.kapp), form: sorted(k.attributes.form), category: sorted(k.attributes.category) };
    at.kapp.push(...k.attributes.kapp);
    at.form.push(...k.attributes.form);
    at.category.push(...k.attributes.category);
  }
  return {
    env: snap.env,
    kapps: list,
    teams: sorted(teams),
    attributes: { space: sorted(at.space), kapp: sorted(at.kapp), form: sorted(at.form), team: sorted(at.team), category: sorted(at.category) },
  };
}

// The named environment, or else the first in pipeline order with a snapshot.
async function catalogSnapshot(ref: ProjectRef, env: string | null): Promise<Snapshot | null> {
  const candidates = env ? [requireEnvironment(ref, env)] : pipelineOrder(ref.dir);
  for (const name of candidates) {
    if (await latestSnapshotCommit(ref, name)) return loadSnapshot(ref, name);
  }
  return null;
}

export function registerExploreRoutes(router: Router, ctx: SyncContext): void {
  const snapshotOf = async (p: string, env: string) => {
    const ref = ctx.find(p);
    return { ref, snap: await loadSnapshot(ref, requireEnvironment(ref, env)) };
  };
  // Read-only, from the latest snapshot only: never the live environment.
  router.get('/api/projects/:p/catalog', async ({ params, query }) => {
    const ref = ctx.find(params.p);
    return { json: buildCatalog(await catalogSnapshot(ref, query.get('env'))) };
  });
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
