// Shared HTTP API contract types (no runtime code). Used by app/server and app/web.

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export interface SessionInfo {
  version: string;
  workspace: string;
  keychain: { available: boolean };
}

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

// An engine event (see lib/sync/events.mjs): always has a type, plus fields.
export interface JobEventData {
  type: string;
  [field: string]: unknown;
}

export interface JobEvent {
  seq: number;
  at: string;
  type: string;
  data: JobEventData;
}

export interface JobInfo<R = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  result?: R;
  error?: { code: string; message: string };
}

// Data of the final SSE event (`event: end`).
export interface JobEndEvent {
  status: JobStatus;
}

// The response of any endpoint that starts a job.
export interface JobStarted {
  jobId: string;
}

// Projects and environments. Secrets are never returned: only `has` flags.
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
}

export interface CredentialsStatus {
  username: boolean;
  password: boolean;
}

export interface SnapshotInfo {
  commit: string;
  at: string;
  message: string;
}

export interface EnvironmentInfo {
  name: string;
  url: string;
  readOnly: boolean;
  credentials: CredentialsStatus;
  lastSnapshot: SnapshotInfo | null;
}

export interface ProjectDetail extends ProjectSummary {
  // In pipeline order.
  environments: EnvironmentInfo[];
}

export interface NewEnvironment {
  name: string;
  url: string;
  readOnly?: boolean;
}

export interface CreateProjectRequest {
  name: string;
  environment?: NewEnvironment;
}

export interface OpenProjectRequest {
  path: string;
}

export interface PutEnvironmentRequest {
  url: string;
  readOnly?: boolean;
  // 0-based pipeline position; omitted keeps the current one (new: last).
  position?: number;
}

// Write-only.
export interface PutCredentialsRequest {
  username?: string;
  password?: string;
}

export type ConnectionStep = 'core' | 'integrator';

export interface ConnectionTestStep {
  step: ConnectionStep;
  label: string;
  ok: boolean;
  skipped?: boolean;
  message?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  steps: ConnectionTestStep[];
}

// A Field = Value condition; a reference-data entry copies only the records
// that meet all of its conditions.
export interface DataFilterCondition {
  field: string;
  value: string;
}

// `key` (match fields) is optional: without it a record is matched by all of
// its values, so an edited record is copied as a new one.
export interface DataEntry {
  kapp: string;
  form: string;
  key?: string[];
  filter?: DataFilterCondition[];
}

export type EnvBoundLevel = 'space' | 'kapp' | 'form' | 'team' | 'category';

// An attribute name applies to every item at its level; an object narrows it
// to a kapp (slug), a form (slug), a team (name) or a category (slug or name).
export interface EnvBoundScopedRule {
  name: string;
  kapp?: string;
  form?: string;
  team?: string;
  category?: string;
}
export type EnvBoundRule = string | EnvBoundScopedRule;

export interface ProjectConfig {
  data: DataEntry[];
  exclude: { kapps: string[]; forms: string[] };
  envBoundAttributes: Partial<Record<EnvBoundLevel, EnvBoundRule[]>>;
  // Parts of the file that could not be used and are ignored (read-only).
  warnings?: string[];
}

// What the latest snapshot of an environment holds, for the settings pickers.
// `env` is null when no environment has a snapshot yet.
export interface CatalogForm {
  slug: string;
  name: string;
  fields: string[];
}

export interface CatalogKapp {
  slug: string;
  name: string;
  forms: CatalogForm[];
  categories: Array<{ slug: string; name: string }>;
  attributes: { kapp: string[]; form: string[]; category: string[] };
}

export interface ProjectCatalog {
  env: string | null;
  kapps: CatalogKapp[];
  teams: string[];
  attributes: Record<EnvBoundLevel, string[]>;
}

export interface EnvironmentOverrides {
  artifacts: Record<string, Record<string, unknown>>;
  replace: Array<{ from: string; to: string }>;
}
