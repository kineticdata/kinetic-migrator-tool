// HTTP API contract types for snapshots, explore, compare, changesets, plans,
// apply and history (no runtime code). Secrets never appear: only `has` flags.

// ---- Snapshots -------------------------------------------------------------

export interface SnapshotRequest {
  env: string;
}

export interface SnapshotResult {
  env: string;
  // null when the export matched the previous snapshot exactly.
  commit: string | null;
  total: number;
  counts: Record<string, number>;
  // Items changed in the environment since they were last promoted.
  drifted: string[];
}

// ---- Trees (Explore and Compare) -------------------------------------------

export type NodeKind =
  | 'group' | 'space' | 'kapp' | 'form' | 'workflow' | 'webapi' | 'data'
  | 'connection' | 'operation' | 'handler' | 'team' | 'model' | 'file-resource' | 'routine' | 'task-category' | 'other';

export interface TreeNode {
  id: string;
  label: string;
  kind: NodeKind;
  // Present when the node is an item (groups and placeholder parents have none).
  key?: string;
  // Items below this node (not counting itself).
  count: number;
  hasChildren: boolean;
}

export type CompareStatus = 'new' | 'changed' | 'drifted' | 'manual' | 'only-target' | 'same';

export interface CompareTreeNode extends TreeNode {
  // The item's own status (items only).
  status?: CompareStatus;
  // Statuses of the items below this node, rolled up.
  counts: Partial<Record<CompareStatus, number>>;
  // Sub-collection entries only in the target: on this item, and below it.
  entries?: number;
  entriesBelow?: number;
}

// One entry of an item's sub-collection (an attribute definition, a
// category…) that only the target has. Kept unless removed on purpose.
export interface TargetOnlyEntryOut {
  // `<item key>#<collection>/<encoded name>`: the removal key.
  key: string;
  collection: string;
  // The collection in words ("category", "form attribute definition").
  word: string;
  name: string;
}

// ---- Explore ---------------------------------------------------------------

export interface RelatedItem {
  key: string;
  label: string;
  kind: string;
  reason: string;
}

export interface ItemHistoryEntry {
  commit: string;
  at: string;
  message: string;
}

export interface SummaryCard {
  title: string;
  subtitle: string;
  sections: Array<{ heading: string; rows?: Array<{ label: string; value: unknown }>; items?: unknown[] }>;
}

export interface ExploreItem {
  key: string;
  type: string;
  label: string;
  summary: SummaryCard;
  relationships: { uses: RelatedItem[]; usedBy: RelatedItem[] };
  // The normalized item as stored in the snapshot (secrets are never exported).
  json: unknown;
  history: ItemHistoryEntry[];
}

export interface SearchResult {
  key: string;
  label: string;
  kind: NodeKind;
  match: 'name' | 'slug' | 'field';
  // The matching field name, for `field` matches.
  field?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean;
}

// ---- Compare ---------------------------------------------------------------

export type CompareMode = 'preview' | 'raw';

export interface CompareRequest {
  from: string;
  to: string;
  mode: CompareMode;
  // Preview against snapshots/<to> instead of the live target.
  useSnapshots?: boolean;
  // Compare the snapshot of `from` at this commit (a changeset's pinned
  // source) instead of its newest snapshot.
  sourceCommit?: string;
}

export interface CompareResult {
  compareId: string;
  from: string;
  // Display name of the source ("Dev", or "the backup of …" for a restore).
  fromName: string;
  to: string;
  mode: CompareMode;
  // The source snapshot commit (pinning for changesets and restores).
  sourceCommit: string | null;
  counts: Partial<Record<CompareStatus, number>>;
  // Items to tick up front (a restore pre-ticks what the apply touched).
  preselected: string[];
}

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

export interface ThreeWay {
  // The item as last promoted into the target (null when unknown).
  lastPromoted: unknown;
  lastPromotedAt: string | null;
  target: unknown;
  incoming: unknown;
  // What changed in the target since the last promotion (`from` = last
  // promoted, `to` = target now); empty when the last promotion is unknown.
  targetChanges: DiffEntry[];
}

export interface CompareItem {
  key: string;
  type: string;
  label: string;
  status: CompareStatus;
  // `from` is the target's value, `to` the incoming one.
  diff: DiffEntry[];
  incoming: unknown;
  current: unknown;
  threeWay?: ThreeWay;
  // Sub-collection entries only in the target (space and kapps).
  targetOnlyEntries?: TargetOnlyEntryOut[];
}

export interface SuggestionsRequest {
  selected: string[];
}

export interface SuggestionOut {
  key: string;
  label: string;
  forKey: string;
  kind: string;
  status: CompareStatus;
  // Plain reason ending in "which is new in Dev" / "which changed in Dev".
  reason: string;
}

// ---- Changesets ------------------------------------------------------------

export interface AppliedTo {
  env: string;
  runId: string;
  at: string;
}

export interface Changeset {
  id: string;
  name: string;
  description: string;
  from: string;
  sourceCommit: string;
  keys: string[];
  // Items only in the target to remove (absent in changesets saved before
  // removals existed: nothing to remove).
  remove?: string[];
  // The environment the removals were chosen for: they are only planned
  // against it. Absent with `remove`: saved before removals were bound to a
  // target; they are not planned until confirmed for one (update removeFrom).
  removeFrom?: string;
  createdAt: string;
  appliedTo: AppliedTo[];
  // 2: `keys` use today's file-name encoding. Absent: saved against a
  // snapshot from before it, so the keys are mapped through that snapshot's
  // re-keying wherever they are used (see currentKeys).
  layoutVersion?: number;
}

export interface CreateChangesetRequest {
  name: string;
  description?: string;
  from: string;
  // May be empty when `remove` is not.
  keys: string[];
  remove?: string[];
  // Required with `remove`: the target the removals were chosen against.
  removeFrom?: string;
  // Defaults to the newest snapshot of `from`.
  sourceCommit?: string;
}

export interface UpdateChangesetRequest {
  name?: string;
  description?: string;
  keys?: string[];
  remove?: string[];
  removeFrom?: string;
}

// ---- Plans and apply -------------------------------------------------------

export type Resolution = 'overwrite' | 'keep';

export interface PlanRequest {
  to: string;
  changesetId?: string;
  from?: string;
  selected?: string[];
  // Items only in the target to remove (added to a changeset's own).
  remove?: string[];
  // Pin the source to the snapshots/<from> tree at this commit (restores).
  sourceCommit?: string;
  restore?: boolean;
  resolutions?: Record<string, Resolution>;
}

export type PlanAction = 'create' | 'update' | 'unchanged' | 'manual' | 'skip-drift';

export interface PlanItemOut {
  key: string;
  type: string;
  label: string;
  action: PlanAction;
  drift: boolean;
  diff: DiffEntry[];
}

// An explicit removal: `delete`, or `skip-drift` (changed since it was last
// promoted; kept), or `gone` (already not in the target).
export type RemovalAction = 'delete' | 'skip-drift' | 'gone';

export interface RemovalUser {
  key: string;
  label: string;
  reason: string;
  // Only in the target, so it can be removed too.
  onlyTarget: boolean;
}

export interface PlanRemovalOut {
  key: string;
  type: string;
  label: string;
  action: RemovalAction;
  // What the delete takes with it (a kapp's forms and workflows, a
  // connection's operations).
  children: Array<{ key: string; type: string; label: string }>;
  // What will still use it after the apply (a warning, never a block).
  usedBy: RemovalUser[];
  notes: string[];
  // What restoring it from the backup cannot bring back (null: everything).
  restore: string | null;
  // For one entry of an item's sub-collection (key `<item>#<collection>/<name>`).
  entry?: { item: string; itemLabel: string; collection: string; name: string };
}

export type AttentionKind = 'handler' | 'handler-settings' | 'index' | 'data-workflows' | 'connection-secrets' | 'drift';

export interface NeedsAttention {
  id: string;
  kind: AttentionKind;
  key: string;
  message: string;
  // What takes care of this entry once entered: a SecretNeeded id or an
  // EnvironmentValue id (handler settings).
  valueId?: string;
}

export interface EnvironmentValue {
  id: string;
  key: string;
  // Override path (as in overrides/<env>.json).
  path: string;
  label: string;
  from: unknown;
  to: unknown;
  origin: 'override' | 'environment' | 'attribute' | 'setting';
  // Missing in the target with no override: a value must be given.
  required: boolean;
  // A kept space setting the target has no value for: the source's value,
  // offered for the user to take on purpose (never applied by itself).
  suggested?: unknown;
  // Linked settings offered together (e.g. "displayType+displayValue").
  pair?: string;
}

export interface SecretNeeded {
  // `<scope>/<name>`; the key of ApplyRequest.secrets.
  id: string;
  key: string;
  scope: 'secret' | 'handler';
  name: string;
  label: string;
  has: boolean;
}

export interface PlanResult {
  planId: string;
  name: string;
  to: string;
  from: string;
  changesetId: string | null;
  sourceCommit: string | null;
  // The keys promoted and the keys removed, as planned.
  selected: string[];
  remove: string[];
  items: PlanItemOut[];
  removals: PlanRemovalOut[];
  // delete: removals that will be deleted (not counting what they take with them).
  counts: Record<PlanAction | 'delete', number>;
  needsAttention: NeedsAttention[];
  environmentValues: EnvironmentValue[];
  secretsNeeded: SecretNeeded[];
  errors: string[];
  warnings: string[];
}

export interface ApplyRequest {
  // Ids of needs-attention entries.
  acknowledgements: string[];
  // { [itemKey]: { [path]: value } }, saved to overrides/<to>.json.
  values?: Record<string, Record<string, unknown>>;
  // { [SecretNeeded.id]: value } — write-only.
  secrets?: Record<string, string>;
  // Keep the secrets in the keychain; otherwise they are used for this run only.
  remember?: boolean;
  resolutions?: Record<string, Resolution>;
  // The target environment's name, typed to confirm.
  confirm: string;
}

export type RunStatus = 'applied' | 'partial' | 'failed' | 'cancelled';

export interface RunItemOutcome {
  key: string;
  status: 'done' | 'skipped' | 'failed' | 'running';
  message?: string;
}

export interface RunRecord {
  id: string;
  kind: 'apply' | 'restore';
  name: string;
  planId: string;
  changesetId: string | null;
  from: string;
  to: string;
  source: { commit: string | null; path: string };
  backupCommit: string | null;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  selection: string[];
  // Items asked to be removed (absent before removals existed).
  removals?: string[];
  acknowledgements: string[];
  resolutions: Record<string, Resolution>;
  // Environment values used (never secrets).
  values: Record<string, Record<string, unknown>>;
  // Names of the secrets supplied (never values).
  secretsUsed: string[];
  items: RunItemOutcome[];
  done: number;
  error: string | null;
}

export interface ApplyResult {
  runId: string;
  status: RunStatus;
  commit: string | null;
  backupCommit: string | null;
  // The target's snapshot taken after the apply (null when nothing was
  // written or it could not be taken).
  snapshotCommit?: string | null;
  done: number;
  error: string | null;
}

// ---- History ---------------------------------------------------------------

export type HistoryType = 'snapshot' | 'changeset' | 'applied' | 'backup' | 'restore' | 'drift' | 'project';

export interface HistoryEvent {
  id: string;
  commit: string;
  type: HistoryType;
  title: string;
  at: string;
  author: string;
  env: string | null;
  runId: string | null;
  changesetId: string | null;
  status: RunStatus | null;
  drifted: string[];
}

export interface HistoryDetail {
  event: HistoryEvent;
  run: RunRecord | null;
}

export interface RestoreRequest {
  commit: string;
  mode?: CompareMode;
}
