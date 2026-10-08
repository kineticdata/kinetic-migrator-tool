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

export interface EnginePlan {
  items: PlanItem[];
  targetOnly: Array<{ key: string; type: string; existing: TargetArtifact; excluded?: boolean }>;
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
  envName: string; from?: string; sourceName?: string; sourceDir?: string; sourceArtifacts?: Artifact[]; select?: Set<string>; resolutions?: Record<string, 'overwrite' | 'keep'>;
}) => Promise<{ env: EngineEnv; config: EngineConfig; plan: EnginePlan; targetList: TargetArtifact[] }> = commandsModule.computePlan;
export const runApply: (opts: RunCommon & {
  envName: string; from?: string; sourceName?: string; sourceDir?: string; yes: boolean; select?: Set<string>; resolutions?: Record<string, 'overwrite' | 'keep'>;
  onPlan?: (plan: EnginePlan) => void;
}) => Promise<{ code: number; done: number; backupDir?: string }> = commandsModule.runApply;
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
export const readTree: (dir: string) => Map<string, unknown> = storeModule.readTree;
export const writeTree: (dir: string, artifacts: Artifact[]) => void = storeModule.writeTree;
export const MODULES: EngineModule[] = indexModule.MODULES;
export const moduleFor: (key: string) => EngineModule | undefined = indexModule.moduleFor;
export const buildRelationships: (artifacts: Array<{ key: string; data: unknown }>) => Relationships = relationshipsModule.buildRelationships;
export const suggest: (opts: { selected: Set<string>; relationships: Relationships; changedKeys: Set<string> }) => Suggestion[] = relationshipsModule.suggest;
export const summarize: (key: string, data: unknown, type: string, extra?: Record<string, unknown>) => Summary = summariesModule.summarize;
export const compareText: (a: string, b: string) => number = normalizeModule.compareText;
export const hashOf: (value: unknown) => string = normalizeModule.hashOf;
export const withoutEnvBound: (scope: string | null, data: unknown, eba?: EnvBoundAttributes, key?: string) => unknown = normalizeModule.withoutEnvBound;
export const ENV_BOUND_FIELDS: Record<string, string[]> = normalizeModule.ENV_BOUND_FIELDS;
export const isSecretName: (name: string) => boolean = secretsModule.isSecretName;
export const AUTH_SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = secretsModule.AUTH_SECRET_FIELDS;
export const isSecretProperty: (p: unknown) => boolean = secretsModule.isSecretProperty;
export const secretFieldKey: (field: string) => string = envModule.secretFieldKey;
export const parsePath: (path: string) => string[] = overridesModule.parsePath;
export const loadState: (projectDir: string, env: string) => Record<string, string> = stateModule.loadState;
