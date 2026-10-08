// Compare: a job that compares a source (an environment's snapshot, or a
// backup for a restore) with a target, kept in memory under an id: a tree
// with per-node status and rolled-up counts, plus per-item diffs. Preview
// shows what promoting would change (engine computePlan against the live
// target, or buildPlan against the target's snapshot); raw shows every
// difference (compareArtifacts). Suggestions use the engine's `suggest`.
import { randomUUID } from 'node:crypto';
import type {
  CompareItem, CompareMode, CompareResult, CompareStatus, CompareTreeNode, DiffEntry, SuggestionOut,
} from '../shared/sync-api.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { resolveCommit } from './pinned.ts';
import { readTreeAt } from './repo.ts';
import { loadConfig, loadOverrides, type ClientFactory, type EngineEnv } from './engine.ts';
import {
  MODULES, buildPlan, buildRelationships, compareArtifacts, computePlan, diffValues, loadState, suggest, type EnginePlan, type Relationships,
} from './engine-sync.ts';
import { readEnvironmentFile, resolveEnv } from './environments.ts';
import type { Emit } from './jobs.ts';
import { displayName, isPlainObject, secretsId, type ProjectRef } from './project-meta.ts';
import type { Router } from './router.ts';
import { lastPromoted } from './run-records.ts';
import { makeScrubber, scrubError, type Scrubber } from './scrub.ts';
import { envSecrets, forwardEvents, loadSnapshot, requireEnvironment, type SyncContext } from './snapshots.ts';
import { buildTreeIndex, childrenOf, toTreeNode, type TreeIndex } from './tree-index.ts';

interface ItemFull {
  key: string;
  type: string;
  status: CompareStatus;
  diff: DiffEntry[];
  incoming: unknown;
  current: unknown;
}

interface CompareRecord {
  projectDir: string;
  result: CompareResult;
  items: Map<string, ItemFull>;
  index: TreeIndex;
  rollup: Map<string, Partial<Record<CompareStatus, number>>>;
  source: Map<string, unknown>;
  relationships?: Relationships;
  scrub: Scrubber;
}

const MAX_COMPARES = 20;
const compares = new Map<string, CompareRecord>();

export interface CompareSource {
  artifacts: Map<string, unknown>;
  commit: string | null;
}

export interface StartCompareOptions {
  from: string;
  fromName: string;
  to: string;
  mode: CompareMode;
  useSnapshots?: boolean;
  // Raw mode compares with the live target instead of its snapshot.
  liveTarget?: boolean;
  source: CompareSource;
  preselected?: string[];
}

const PREVIEW_STATUS: Record<string, CompareStatus> = {
  create: 'new', update: 'changed', unchanged: 'same', manual: 'manual', 'skip-drift': 'drifted',
};
const RAW_STATUS: Record<string, CompareStatus> = {
  'only-left': 'new', differs: 'changed', same: 'same', 'only-right': 'only-target',
};

const progress = (emit: Emit, done: number, total: number, key: string) => emit({ type: 'progress', phase: 'compare', done, total, key });

function previewItems(plan: EnginePlan): ItemFull[] {
  return [
    ...plan.items.map((i) => ({
      key: i.key, type: i.type, status: PREVIEW_STATUS[i.action] ?? 'changed', diff: i.diff,
      incoming: i.desired, current: i.existing?.data ?? null,
    })),
    ...plan.targetOnly.map((t) => ({ key: t.key, type: t.type, status: 'only-target' as const, diff: [], incoming: null, current: t.existing.data })),
  ];
}

function rollupCounts(index: TreeIndex, items: Map<string, ItemFull>): Map<string, Partial<Record<CompareStatus, number>>> {
  const out = new Map<string, Partial<Record<CompareStatus, number>>>();
  const walk = (id: string): Partial<Record<CompareStatus, number>> => {
    const n = index.nodes.get(id)!;
    const counts: Partial<Record<CompareStatus, number>> = {};
    for (const c of n.children) {
      const child = index.nodes.get(c)!;
      const sub = walk(c);
      for (const [s, v] of Object.entries(sub)) counts[s as CompareStatus] = (counts[s as CompareStatus] ?? 0) + (v ?? 0);
      const own = child.key ? items.get(child.key)?.status : undefined;
      if (own) counts[own] = (counts[own] ?? 0) + 1;
    }
    out.set(id, counts);
    return counts;
  };
  index.roots.forEach(walk);
  return out;
}

async function runCompareJob(ref: ProjectRef, opts: StartCompareOptions, deps: {
  env: EngineEnv | null; clientFactory?: ClientFactory; emit: Emit; signal: AbortSignal;
}): Promise<CompareResult> {
  const { emit, signal, env } = deps;
  const onEvent = forwardEvents(emit, env ? envSecrets(env) : []);
  const sourceList = [...opts.source.artifacts].map(([key, data]) => ({ key, data }));
  let items: ItemFull[];
  if (opts.mode === 'preview') {
    if (opts.useSnapshots) {
      progress(emit, 1, 2, 'snapshot');
      const target = await loadSnapshot(ref, opts.to);
      const plan = buildPlan({
        modules: MODULES, exported: opts.source.artifacts, config: loadConfig(ref.dir),
        target: new Map([...target.artifacts].map(([key, data]) => [key, { key, data }])),
        state: loadState(ref.dir, opts.to), overrides: loadOverrides(ref.dir, opts.to),
        vars: { targetUrl: readEnvironmentFile(ref.dir, opts.to).url },
      });
      items = previewItems(plan);
      progress(emit, 2, 2, 'compare');
    } else {
      const { plan } = await computePlan({
        projectDir: ref.dir, envName: opts.to, env: env!, sourceArtifacts: sourceList, onEvent, signal, clientFactory: deps.clientFactory,
      });
      items = previewItems(plan);
    }
  } else {
    progress(emit, 1, 3, 'source');
    let right: Map<string, { data: unknown }>;
    if (opts.liveTarget) {
      const { targetList } = await computePlan({
        projectDir: ref.dir, envName: opts.to, env: env!, sourceArtifacts: sourceList, onEvent, signal, clientFactory: deps.clientFactory,
      });
      right = new Map(targetList.map((a) => [a.key, { data: a.data }]));
    } else {
      right = new Map([...(await loadSnapshot(ref, opts.to)).artifacts].map(([k, data]) => [k, { data }]));
    }
    progress(emit, 2, 3, 'target');
    const left = new Map(sourceList.map((a) => [a.key, { data: a.data }]));
    const result = compareArtifacts({ modules: MODULES, left, right });
    // The engine diffs left (source) against right (target); the API's
    // `from` is the target's value and `to` the incoming one, as in preview.
    items = result.items.filter((i) => i.key !== 'task-refs').map((i) => ({
      key: i.key, type: i.type, status: RAW_STATUS[i.status], diff: i.diff.map((d) => ({ path: d.path, from: d.to, to: d.from })),
      incoming: left.get(i.key)?.data ?? null, current: right.get(i.key)?.data ?? null,
    }));
    progress(emit, 3, 3, 'compare');
  }
  const byKey = new Map(items.map((i) => [i.key, i]));
  const index = buildTreeIndex(byKey.keys(), (k) => byKey.get(k)!.incoming ?? byKey.get(k)!.current);
  const counts: Partial<Record<CompareStatus, number>> = {};
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  const result: CompareResult = {
    compareId: randomUUID(), from: opts.from, fromName: opts.fromName, to: opts.to, mode: opts.mode,
    sourceCommit: opts.source.commit, counts, preselected: (opts.preselected ?? []).filter((k) => byKey.has(k)),
  };
  compares.set(result.compareId, {
    projectDir: ref.dir, result, items: byKey, index, rollup: rollupCounts(index, byKey),
    source: opts.source.artifacts, scrub: makeScrubber(env ? envSecrets(env) : []),
  });
  while (compares.size > MAX_COMPARES) compares.delete(compares.keys().next().value!);
  return result;
}

export async function startCompare(ctx: SyncContext, ref: ProjectRef, opts: StartCompareOptions): Promise<string> {
  const live = opts.mode === 'preview' ? !opts.useSnapshots : Boolean(opts.liveTarget);
  if (!live) await loadSnapshot(ref, opts.to);
  await secretsId(ref);
  const env = live ? await resolveEnv(ref, opts.to, ctx.secrets) : null;
  return ctx.jobs.createJob('compare', (emit, signal) => runCompareJob(ref, opts, { env, clientFactory: ctx.clientFactory, emit, signal })
    .catch((err) => { throw scrubError(err, env ? envSecrets(env) : []); }));
}

function findCompare(ref: ProjectRef, id: string): CompareRecord {
  const c = compares.get(id);
  if (!c || c.projectDir !== ref.dir) throw notFound('This comparison has expired; run it again.');
  return c;
}

const label = (c: CompareRecord, key: string) => c.index.nodes.get(key)?.label ?? key;

export function registerCompareRoutes(router: Router, ctx: SyncContext): void {
  router.post('/api/projects/:p/compare', async ({ params, body }) => {
    const ref = ctx.find(params.p);
    if (!isPlainObject(body)) throw badRequest('Expected a JSON object.');
    const from = requireEnvironment(ref, body.from);
    const to = requireEnvironment(ref, body.to);
    if (from === to) throw badRequest('Compare needs two different environments.');
    const mode = body.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'raw') throw badRequest('"mode" is "preview" or "raw".');
    let source: CompareSource;
    if (body.sourceCommit !== undefined) {
      const commit = typeof body.sourceCommit === 'string' ? await resolveCommit(ref.dir, body.sourceCommit) : null;
      if (!commit) throw badRequest('"sourceCommit" is not a commit of this project.');
      const artifacts = await readTreeAt(ref.dir, commit, `snapshots/${from}`);
      if (!artifacts.size) throw new ApiError(404, 'no_snapshot', `That commit holds no snapshot of ${displayName(from)}.`);
      source = { artifacts, commit };
    } else {
      const snap = await loadSnapshot(ref, from);
      source = { artifacts: snap.artifacts, commit: snap.commit };
    }
    const jobId = await startCompare(ctx, ref, {
      from, fromName: displayName(from), to, mode, useSnapshots: body.useSnapshots === true, source,
    });
    return { status: 202, json: { jobId } };
  });

  router.get('/api/projects/:p/compare/:id/tree', ({ params, query }) => {
    const c = findCompare(ctx.find(params.p), params.id);
    const nodes = childrenOf(c.index, query.get('parent'));
    if (!nodes) throw notFound('No such tree node.');
    return {
      json: nodes.map((n): CompareTreeNode => {
        const out: CompareTreeNode = { ...toTreeNode(n), counts: c.rollup.get(n.id) ?? {} };
        if (n.key) out.status = c.items.get(n.key)?.status;
        return out;
      }),
    };
  });

  router.get('/api/projects/:p/compare/:id/item', async ({ params, query }) => {
    const ref = ctx.find(params.p);
    const c = findCompare(ref, params.id);
    const key = query.get('key') ?? '';
    const i = c.items.get(key);
    if (!i) throw notFound('No such item in this comparison.');
    const item: CompareItem = { key, type: i.type, label: label(c, key), status: i.status, diff: i.diff, incoming: i.incoming, current: i.current };
    if (i.status === 'drifted') {
      const last = await lastPromoted(ref, c.result.to, key);
      item.threeWay = {
        lastPromoted: last?.data ?? null, lastPromotedAt: last?.at ?? null, target: i.current, incoming: i.incoming,
        targetChanges: last ? diffValues(last.data, i.current) : [],
      };
    }
    return { json: c.scrub(item) };
  });

  router.post('/api/projects/:p/compare/:id/suggestions', ({ params, body }) => {
    const c = findCompare(ctx.find(params.p), params.id);
    const selected = isPlainObject(body) ? body.selected : undefined;
    if (!Array.isArray(selected) || !selected.every((k) => typeof k === 'string')) throw badRequest('"selected" is a list of item keys.');
    const changed = new Set([...c.items.values()].filter((i) => ['new', 'changed', 'drifted'].includes(i.status)).map((i) => i.key));
    c.relationships ??= buildRelationships([...c.source].map(([key, data]) => ({ key, data })));
    const list = suggest({ selected: new Set(selected as string[]), relationships: c.relationships, changedKeys: changed });
    const out: SuggestionOut[] = list.map((s) => {
      const status = c.items.get(s.key)!.status;
      const why = status === 'new' ? `which is new in ${c.result.fromName}` : `which changed in ${c.result.fromName}`;
      return { key: s.key, label: label(c, s.key), forKey: s.forKey, kind: s.kind, status, reason: `${s.reason}, ${why}` };
    });
    return { json: c.scrub(out) };
  });
}
