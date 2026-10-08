// Typed bridge to the engine pieces used by snapshots, explore, compare,
// plans and apply (engine.ts holds the project/environment ones). Each untyped
// engine import is typed here once.
// @ts-expect-error -- untyped engine module
import * as commandsModule from '../../lib/sync/commands.mjs';
// @ts-expect-error -- untyped engine module
import * as compareModule from '../../lib/sync/compare.mjs';
// @ts-expect-error -- untyped engine module
import * as planModule from '../../lib/sync/plan.mjs';
// @ts-expect-error -- untyped engine module
import * as storeModule from '../../lib/sync/store.mjs';
// @ts-expect-error -- untyped engine module
import * as indexModule from '../../lib/sync/artifacts/index.mjs';
// @ts-expect-error -- untyped engine module
import * as relationshipsModule from '../../lib/sync/relationships.mjs';
// @ts-expect-error -- untyped engine module
import * as summariesModule from '../../lib/sync/summaries.mjs';
// @ts-expect-error -- untyped engine module
import * as normalizeModule from '../../lib/sync/normalize.mjs';
// @ts-expect-error -- untyped engine module
import * as secretsModule from '../../lib/sync/secrets.mjs';
// @ts-expect-error -- untyped engine module
import * as envModule from '../../lib/sync/env.mjs';
// @ts-expect-error -- untyped engine module
import * as overridesModule from '../../lib/sync/overrides.mjs';
// @ts-expect-error -- untyped engine module
import * as stateModule from '../../lib/sync/state.mjs';
// @ts-expect-error -- untyped engine module
import * as layoutModule from '../../lib/sync/layout.mjs';
// @ts-expect-error -- untyped engine module
import * as removalsModule from '../../lib/sync/removals.mjs';
// @ts-expect-error -- untyped engine module
import * as entriesModule from '../../lib/sync/entries.mjs';
import type { ClientFactory, EngineConfig, EngineEnv, EngineOverrides, EnvBoundAttributes } from './engine.ts';

export interface Artifact { key: string; data: unknown; files?: Record<string, Uint8Array> }
export interface TargetArtifact { key: string; data: any; meta?: unknown }
export interface DiffEntry { path: string; from: unknown; to: unknown }
export type EngineEvent = { type: string; [k: string]: unknown };
export type OnEvent = (event: EngineEvent) => void;

export interface PlanItem {
  key: string;
  type: string;
  scope: string | null;
  action: 'create' | 'update' | 'unchanged' | 'manual' | 'skip-drift' | 'excluded';
  wouldBe?: string;
  source: any;
  desired: any;
  existing: TargetArtifact | null;
  diff: DiffEntry[];
  drift: boolean;
}

export interface EngineRemoval {
  key: string;
  type: string;
  action: 'delete' | 'skip-drift' | 'gone';
  existing: TargetArtifact | null;
  children: Array<{ key: string; type: string; existing: TargetArtifact }>;
  usedBy: Array<{ key: string; kind: string; reason: string; onlyTarget: boolean }>;
  notes: string[];
  restore: string | null;
  hash: string | null;
  // A sub-collection entry's removal.
  entry?: { itemKey: string; field: string; name: string | null };
}

export interface EnginePlan {
  items: PlanItem[];
  targetOnly: Array<{ key: string; type: string; existing: TargetArtifact; excluded?: boolean }>;
  removals: EngineRemoval[];
  errors: string[];
  warnings: string[];
}

export interface EngineModule {
  type: string;
  scope: string | null;
  applyable?: boolean;
  owns(key: string): boolean;
}

export interface Edge { key: string; kind: string; reason: string }
export interface Relationships { uses: Map<string, Edge[]>; usedBy: Map<string, Edge[]> }
export interface Suggestion { key: string; forKey: string; kind: string; reason: string }

export interface SummarySection { heading: string; rows?: Array<{ label: string; value: unknown }>; items?: unknown[] }
export interface Summary { title: string; subtitle: string; sections: SummarySection[] }

interface RunCommon { projectDir: string; env: EngineEnv; onEvent?: OnEvent; signal?: AbortSignal; clientFactory?: ClientFactory; log?: (line: string) => void }

export const runExport: (opts: RunCommon & { dest?: string }) => Promise<{ code: number; artifacts: number; counts: Record<string, number> }> = commandsModule.runExport;
export const computePlan: (opts: RunCommon & {
  envName: string; from?: string; sourceName?: string; sourceDir?: string; sourceArtifacts?: Artifact[]; sourceUnresolved?: Map<string, string>; select?: Set<string>; resolutions?: Record<string, 'overwrite' | 'keep'>;
  remove?: string[]; removeExpected?: Record<string, string>;
}) => Promise<{ env: EngineEnv; config: EngineConfig; plan: EnginePlan; targetList: TargetArtifact[] }> = commandsModule.computePlan;
export const runApply: (opts: RunCommon & {
  envName: string; from?: string; sourceName?: string; sourceDir?: string; yes: boolean; select?: Set<string>; resolutions?: Record<string, 'overwrite' | 'keep'>;
  remove?: string[]; removeExpected?: Record<string, string>;
  onPlan?: (plan: EnginePlan) => void;
}) => Promise<{ code: number; done: number; backupDir?: string; failed?: string[] }> = commandsModule.runApply;
export const stamp: () => string = commandsModule.stamp;
export const compareArtifacts: (opts: { modules: EngineModule[]; left: Map<string, { data: unknown }>; right: Map<string, { data: unknown }> }) => {
  items: Array<{ key: string; type: string; status: 'same' | 'differs' | 'only-left' | 'only-right'; diff: DiffEntry[] }>;
  counts: Record<string, number>;
} = compareModule.compareArtifacts;
export const buildPlan: (opts: {
  modules: EngineModule[]; exported: Map<string, unknown>; target: Map<string, TargetArtifact>; state?: Record<string, string>;
  overrides?: EngineOverrides; vars?: Record<string, string>; config: EngineConfig; sourceName?: string; targetName?: string;
}) => EnginePlan = planModule.buildPlan;
export const diffValues: (from: unknown, to: unknown) => DiffEntry[] = planModule.diffValues;
// A tree read in any layout (older ones re-keyed from content, see layout.mjs).
export type LoadedTree = Map<string, unknown> & { layout?: number; rekeyed?: Map<string, string>; unresolved?: Map<string, string> };
export const readTree: (dir: string) => LoadedTree = layoutModule.loadTree;
export const rekeyTree: (raw: Map<string, unknown>, layout: number) => LoadedTree = layoutModule.rekeyTree;
export const markerLayout: (text: string | undefined) => number = storeModule.markerLayout;
export const MARKER: string = storeModule.MARKER;
export const LAYOUT_VERSION: number = storeModule.LAYOUT_VERSION;
export const upgradeTree: (dir: string) => { upgraded: boolean; rekeyed: Map<string, string>; unresolved: Map<string, string> } = layoutModule.upgradeTree;
export const upgradeProjectLayout: (dir: string) => { changed: boolean; fromLayout: number; rekeyed: Map<string, string>; notes: string[] } = layoutModule.upgradeProjectLayout;
export const unresolvedErrors: (tree: { unresolved?: Map<string, string> }, sourceName?: string) => string[] = layoutModule.unresolvedErrors;
export const writeTree: (dir: string, artifacts: Artifact[]) => void = storeModule.writeTree;
export const segmentLabel: (segment: string) => string = storeModule.segmentLabel;
export const isReservedDeviceName: (name: string) => boolean = storeModule.isReservedDeviceName;
export const removeTree: (dir: string) => void = storeModule.removeTree;
export const MODULES: EngineModule[] = indexModule.MODULES;
export const moduleFor: (key: string) => EngineModule | undefined = indexModule.moduleFor;
export const buildRelationships: (artifacts: Array<{ key: string; data: unknown }>) => Relationships = relationshipsModule.buildRelationships;
export const suggest: (opts: { selected: Set<string>; relationships: Relationships; changedKeys: Set<string> }) => Suggestion[] = relationshipsModule.suggest;
export const summarize: (key: string, data: unknown, type: string, extra?: Record<string, unknown>) => Summary = summariesModule.summarize;
export const compareText: (a: string, b: string) => number = normalizeModule.compareText;
// No hashOf/withoutEnvBound here on purpose: compare a target with its
// state/<env>.json entry through driftedFrom (the space's entry records the
// field set it was hashed with), never by hashing directly.
export const ENV_BOUND_FIELDS: Record<string, string[]> = normalizeModule.ENV_BOUND_FIELDS;
// The fixed environment-bound fields of a scope plus, for the space, the chosen settings.
export const envBoundFields: (scope: string | null, spaceFields?: string[]) => string[] = normalizeModule.envBoundFields;
export const isEmptyValue: (value: unknown) => boolean = normalizeModule.isEmptyValue;
// Whether an item's current content differs from its state/<env>.json entry.
export const driftedFrom: (scope: string | null, data: unknown, recorded: string, config: Partial<EngineConfig>, key?: string) => boolean = normalizeModule.driftedFrom;
export const isSecretName: (name: string) => boolean = secretsModule.isSecretName;
export const AUTH_SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = secretsModule.AUTH_SECRET_FIELDS;
export const isSecretProperty: (p: unknown) => boolean = secretsModule.isSecretProperty;
export const secretFieldKey: (field: string) => string = envModule.secretFieldKey;
export const parsePath: (path: string) => string[] = overridesModule.parsePath;
export const loadState: (projectDir: string, env: string) => Record<string, string> = stateModule.loadState;
// Why a key can never be removed, or null (see lib/sync/removals.mjs).
export const notRemovable: (key: string, mod: EngineModule | undefined) => string | null = removalsModule.notRemovable;
// The same for any removal key, an item's or a sub-collection entry's.
// Whether a removal key (item or entry) is in a source tree.
export const removalInSource: (key: string, tree: Map<string, unknown>, modules: EngineModule[]) => boolean = removalsModule.removalInSource;
export const removalRefusal: (key: string, modules: EngineModule[]) => string | null = removalsModule.removalRefusal;
// Sub-collection entries (`<item>#<collection>/<name>`, see lib/sync/entries.mjs).
export interface TargetOnlyEntry { key: string; collection: string; name: string }
export const targetOnlyEntries: (mod: EngineModule | undefined, itemKey: string, source: unknown, target: unknown) => TargetOnlyEntry[] = entriesModule.targetOnlyEntries;
export const parseEntryKey: (key: string) => { itemKey: string; field: string; segment: string } | null = entriesModule.parseEntryKey;
export const isEntryKey: (key: string) => boolean = entriesModule.isEntryKey;
export const collectionWord: (field: string) => string = entriesModule.collectionWord;
