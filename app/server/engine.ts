// Typed bridge to the plain-JS engine (lib/sync). The engine ships no type
// declarations, so each import is typed here once and the rest of the server
// imports from this module.
// @ts-expect-error -- untyped engine module
import * as envModule from '../../lib/sync/env.mjs';
// @ts-expect-error -- untyped engine module
import * as commandsModule from '../../lib/sync/commands.mjs';
// @ts-expect-error -- untyped engine module
import * as httpModule from '../../lib/sync/http.mjs';
// @ts-expect-error -- untyped engine module
import * as normalizeModule from '../../lib/sync/normalize.mjs';
// @ts-expect-error -- untyped engine module
import * as envBoundModule from '../../lib/sync/env-bound.mjs';
// @ts-expect-error -- untyped engine module
import * as dataModule from '../../lib/sync/artifacts/data.mjs';

// The resolved environment every engine run accepts.
export interface EngineEnv {
  name: string;
  url: string;
  readOnly: boolean;
  username: string;
  password: string;
  vars: Record<string, string>;
}

export interface EngineClient {
  mode: 'read' | 'write';
  request(api: string, method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<unknown>;
  get(api: string, path: string, query?: Record<string, unknown>): Promise<unknown>;
}

export type ClientFactory = (opts: { env: EngineEnv; mode: 'read' | 'write' }) => EngineClient;

// An environment-specific attribute rule: a name (every item at its level)
// or a name plus where it applies (see lib/sync/env-bound.mjs).
export type EnvBoundRule = string | { name: string; kapp?: string; form?: string; team?: string; category?: string };
export type EnvBoundAttributes = Record<string, EnvBoundRule[]>;

export interface EngineDataEntry {
  kapp: string;
  form: string;
  key?: string[];
  filter?: Array<{ field: string; value: string }>;
}

export interface EngineConfig {
  data: EngineDataEntry[];
  exclude: { kapps: string[]; forms: string[]; [k: string]: unknown };
  envBoundAttributes: EnvBoundAttributes;
  // Space settings each environment keeps (the defaults when the file has none).
  envBoundSpaceFields: string[];
  warnings?: string[];
}

export interface EngineOverrides {
  artifacts: Record<string, unknown>;
  replace: Array<{ from: string; to: string }>;
}

export const envKey: (name: string) => string = envModule.envKey;
export const validateEnvName: (name: string) => void = envModule.validateEnvName;
export const loadConfig: (projectDir: string) => EngineConfig = envModule.loadConfig;
export const loadOverrides: (projectDir: string, env: string) => EngineOverrides = envModule.loadOverrides;
export const runInit: (opts: { projectDir: string; log: (line: string) => void }) => Promise<number> = commandsModule.runInit;
export const snapshotDir: (projectDir: string, env: string) => string = commandsModule.snapshotDir;
export const createClient: ClientFactory = httpModule.createClient;
export const stableStringify: (value: unknown) => string = normalizeModule.stableStringify;
export const GITATTRIBUTES: string = commandsModule.GITATTRIBUTES;
export const envBoundAttributesError: (value: unknown) => string | null = envBoundModule.envBoundAttributesError;
export const envBoundSpaceFieldsError: (value: unknown) => string | null = envBoundModule.envBoundSpaceFieldsError;
export const envBoundNamesFor: (eba: EnvBoundAttributes, scope: string | null, key: string, data?: unknown) => Set<string> = envBoundModule.envBoundNamesFor;
export const dataConfigError: (entries: unknown) => string | null = dataModule.dataConfigError;
