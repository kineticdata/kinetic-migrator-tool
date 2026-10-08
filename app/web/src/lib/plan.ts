// Plan and apply rules, as pure functions: the needs-attention checklist
// (server entries plus other preflight warnings), plain fixes for plan
// errors, environment values to send (and which required ones are missing),
// the apply phases and the live checklist built from streamed job events.
import type { JobEventData } from '../../../shared/api';
import type { AttentionKind, EnvironmentValue, PlanItemOut, PlanRemovalOut, PlanRequest, PlanResult, Resolution } from '../../../shared/sync-api';
import { envLabel } from './format';
import { nameOfKey } from './tree-layout';

// ---- Needs attention -------------------------------------------------------

export interface AttentionEntry {
  id: string;
  kind: AttentionKind | 'warning';
  key: string | null;
  message: string;
  // Sent as an acknowledgement (server entries); warnings are ticked here only.
  send: boolean;
  // An environment value that, once filled in, takes care of this entry.
  valueId?: string;
}

// Warnings the server already turns into needs-attention entries, and those
// shown with the removals they are about (in use is a warning to read, not
// something to tick).
const COVERED = [
  /: creating\/updating rows will run these workflows in the target: /,
  /: will be created without credentials/,
  /: still used by .+; removing it may break them$/,
  /: already gone from the target$/,
  /: changed in the target since it was reviewed; it is not removed$/,
  // Shown as an offered value under Environment values instead.
  /: "[^"]+" is kept per environment and empty in the target; the source has a value/,
];

// Engine warnings in plain words, where they are recognised.
function plainWarning(w: string, plan: PlanResult): { message: string; key: string | null; valueId?: string } {
  const To = envLabel(plan.to);
  let m = /^(.+?): environment-bound attribute "(.+)" is empty in the target and no override sets it$/.exec(w);
  if (m) {
    const [, key, name] = m;
    const value = plan.environmentValues.find((v) => v.key === key && v.origin === 'attribute' && v.label === name);
    return {
      key,
      message: `${name} of ${nameOfKey(key)} is empty in ${To} and nothing sets it.${value ? ' Fill it in under Environment values, or tick to go ahead without it.' : ''}`,
      ...(value ? { valueId: value.id } : {}),
    };
  }
  if (w.startsWith('Drift check for the space skipped: ')) {
    return { key: 'space', message: `The space's kept settings changed since it was last promoted to ${To}, so changes made to it in ${To} since then cannot be detected this time; this plan does not report the space as drifted. Applying records the current settings, and later plans check again.` };
  }
  m = /^Override for "(.+)" matches nothing in the export/.exec(w);
  if (m) return { key: m[1], message: `A saved environment value for ${nameOfKey(m[1])} matches nothing being promoted, so it is ignored.` };
  m = /^(.+?): secret property "(.+)" is not set; set it in the target console$/.exec(w);
  if (m) return { key: m[1], message: `The secret ${m[2]} of ${nameOfKey(m[1])} is not set; set it in ${To}’s console.` };
  m = /^(.+?): this server has no space WebAPI import endpoint/.exec(w);
  if (m) return { key: m[1], message: `${nameOfKey(m[1])} cannot be imported by this server; recreate it by hand in ${To}.` };
  m = /^(.+?): (.+) differ but come from the package or the console; change them in the target by hand$/.exec(w);
  if (m) return { key: m[1], message: `${m[2]} of ${nameOfKey(m[1])} come from the handler package or console; change them in ${To} by hand.` };
  return { key: null, message: w };
}

export function attentionList(plan: PlanResult): AttentionEntry[] {
  const kept = new Set(plan.items.filter((i) => i.action === 'skip-drift').map((i) => i.key));
  const out: AttentionEntry[] = plan.needsAttention
    // A drifted item kept as it is in the target is not overwritten.
    .filter((n) => !(n.kind === 'drift' && kept.has(n.key)))
    .map((n) => ({
      id: n.id, kind: n.kind, key: n.key, send: true,
      message: n.kind === 'handler-settings' ? `${n.message} Enter it under Environment values, or tick to go ahead without it.` : n.message,
      ...(n.valueId ? { valueId: n.valueId } : {}),
    }));
  plan.warnings.forEach((w, i) => {
    if (!COVERED.some((re) => re.test(w))) out.push({ id: `warning:${i}`, kind: 'warning', send: false, ...plainWarning(w, plan) });
  });
  return out;
}

// Entries taken care of: ticked, or (for a missing value) filled in.
export function satisfied(entry: AttentionEntry, ticked: ReadonlySet<string>, filled: ReadonlySet<string>): boolean {
  return ticked.has(entry.id) || Boolean(entry.valueId && filled.has(entry.valueId));
}

// ---- Errors ----------------------------------------------------------------

export function errorFix(message: string, from: string, to: string): { message: string; fix: string } {
  const From = envLabel(from);
  const To = envLabel(to);
  const rules: Array<[RegExp, string]> = [
    [/^Routine .+ is used by exported workflows but does not exist in the target/, `Add the routine to the changeset, or create it in ${To} first, then plan again.`],
    [/^Handler .+ is used by exported workflows but is not installed in the target/, `Add the handler to the changeset, or install it in ${To} first, then plan again.`],
    [/: not in the source snapshot$/, `Take a new snapshot of ${From}, or take this item out of the changeset.`],
    [/(same name but id|probably renamed)/, `Reconcile it by hand in ${To} (rename or remove one of the two), take a new snapshot, then plan again.`],
    [/^Unrecognized file in export/, `Take a new snapshot of ${From}.`],
    [/can never be removed|cannot be removed|are never removed as an item/, 'Take it out of the removals, then plan again.'],
    [/: is in the source too; only items that are only in the target can be removed$/, `It is in ${From} too, so it would be promoted, not removed: take it out of the removals, then plan again.`],
  ];
  const hit = rules.find(([re]) => re.test(message));
  return { message, fix: hit ? hit[1] : `Fix the cause in ${From} or ${To}, then plan again.` };
}

// ---- Environment values ----------------------------------------------------

// How a value is shown in its text box.
export function valueText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

// Parses typed text back to the type of the value it replaces.
export function parseValueText(text: string, original: unknown): { value: unknown } | { error: string } {
  const t = text.trim();
  if (typeof original === 'number') return t !== '' && Number.isFinite(Number(t)) ? { value: Number(t) } : { error: 'Enter a number.' };
  if (typeof original === 'boolean' && (t === 'true' || t === 'false')) return { value: t === 'true' };
  if (original !== null && typeof original === 'object') {
    try {
      return { value: JSON.parse(t) };
    } catch {
      return { error: 'Enter valid JSON.' };
    }
  }
  return { value: t };
}

export interface ValuesPayload {
  // { [itemKey]: { [path]: value } }
  values: Record<string, Record<string, unknown>>;
  // Required values with nothing entered (ids).
  missing: string[];
  // Optional values cleared on purpose: not sent, so the target keeps its own (ids).
  blank: string[];
  // Values with something in them, as sent or as planned (ids).
  filled: string[];
  // Values that could not be read ({ id: message }).
  errors: Record<string, string>;
}

// `edits` maps value ids to the text typed; untouched values are not sent.
export function valuesPayload(list: EnvironmentValue[], edits: Record<string, string>): ValuesPayload {
  const out: ValuesPayload = { values: {}, missing: [], blank: [], filled: [], errors: {} };
  for (const v of list) {
    const text = edits[v.id] ?? valueText(v.to);
    if (!text.trim()) {
      if (v.required) out.missing.push(v.id);
      else if (edits[v.id] !== undefined) out.blank.push(v.id);
      continue;
    }
    if (edits[v.id] === undefined || edits[v.id] === valueText(v.to)) {
      out.filled.push(v.id);
      continue;
    }
    const parsed = parseValueText(text, v.to ?? v.from);
    if ('error' in parsed) {
      out.errors[v.id] = parsed.error;
      continue;
    }
    out.filled.push(v.id);
    (out.values[v.key] ??= {})[v.path] = parsed.value;
  }
  return out;
}

// ---- Apply phases ----------------------------------------------------------

export interface Phase {
  id: string;
  label: string;
  types: string[];
}

// The order the engine applies item types in.
export const PHASES: Phase[] = [
  { id: 'space', label: 'Space', types: ['space'] },
  { id: 'teams', label: 'Teams', types: ['teams'] },
  { id: 'models', label: 'Models', types: ['models'] },
  { id: 'file-resources', label: 'File resources', types: ['file-resources'] },
  { id: 'connections', label: 'Connections', types: ['connections', 'operations'] },
  { id: 'handlers', label: 'Handlers', types: ['handlers'] },
  { id: 'routines', label: 'Routines', types: ['routines'] },
  { id: 'task-categories', label: 'Workflow categories', types: ['task-categories'] },
  { id: 'kapps', label: 'Kapps', types: ['kapps'] },
  { id: 'forms', label: 'Forms', types: ['forms'] },
  { id: 'webapis', label: 'WebAPIs', types: ['webapis'] },
  { id: 'workflows', label: 'Workflows', types: ['workflows'] },
  { id: 'data', label: 'Reference data', types: ['data'] },
];
const OTHER: Phase = { id: 'other', label: 'Other', types: [] };

// Items the apply writes.
export const writes = (i: PlanItemOut): boolean => i.action === 'create' || i.action === 'update';

export function groupByPhase(items: PlanItemOut[]): Array<Phase & { items: PlanItemOut[] }> {
  return [...PHASES, OTHER]
    .map((ph) => {
      const own = ph === OTHER
        ? items.filter((i) => !PHASES.some((p) => p.types.includes(i.type)))
        : ph.types.flatMap((t) => items.filter((i) => i.type === t));
      return { ...ph, items: own };
    })
    .filter((g) => g.items.length > 0);
}

// ---- Removals --------------------------------------------------------------

// Removals the apply deletes.
export const deletes = (plan: PlanResult): PlanRemovalOut[] => (plan.removals ?? []).filter((r) => r.action === 'delete');

// The apply checklist's rows for removals: each removal, then what it takes
// with it (deleted with it, reported done with it).
export function removalRows(plan: PlanResult): Array<{ key: string; label: string; sub?: string }> {
  return deletes(plan).flatMap((r) => [
    { key: r.key, label: r.label },
    ...r.children.map((c) => ({ key: c.key, label: c.label, sub: `with ${r.label}` })),
  ]);
}

// Removals whose item is still used by something that stays.
export const inUse = (plan: PlanResult): PlanRemovalOut[] => deletes(plan).filter((r) => r.usedBy.length > 0);

// A new plan with the same inputs and `extra` removed too (Also remove).
// Drift decisions made for this plan (overwrites) are carried over.
export function planWithRemovals(plan: PlanResult, extra: string[]): PlanRequest {
  const remove = [...new Set([...(plan.remove ?? []), ...extra])].sort();
  const resolutions: Record<string, Resolution> = {};
  for (const i of plan.items) if (i.drift && i.action !== 'skip-drift') resolutions[i.key] = 'overwrite';
  const decided = Object.keys(resolutions).length ? { resolutions } : {};
  if (plan.changesetId) return { to: plan.to, changesetId: plan.changesetId, remove, ...decided };
  return {
    to: plan.to, from: plan.from, selected: plan.selected ?? [], remove,
    ...(plan.sourceCommit ? { sourceCommit: plan.sourceCommit } : {}), ...decided,
  };
}

// ---- Live checklist --------------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ItemProgress {
  status: StepStatus;
  message?: string;
  // Done, but left needing attention (a handler without required settings).
  attention?: boolean;
}

export interface ChecklistState {
  backup: StepStatus;
  items: Record<string, ItemProgress>;
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'done', 'failed', 'skipped']);

// `carried` holds what earlier runs of the same plan finished (Resume).
export function checklistFrom(events: JobEventData[], carried: Record<string, ItemProgress> = {}): ChecklistState {
  const state: ChecklistState = { backup: 'pending', items: { ...carried } };
  for (const e of events) {
    if (e.type === 'step' && e.step === 'backup' && typeof e.status === 'string' && STATUSES.has(e.status)) {
      state.backup = e.status as StepStatus;
    } else if (e.type === 'progress' && e.phase === 'backup' && state.backup === 'pending') {
      state.backup = 'running';
    } else if (e.type === 'item' && typeof e.key === 'string' && typeof e.status === 'string' && STATUSES.has(e.status)) {
      // Done in an earlier run of this plan stays done when this run finds it up to date.
      if (e.status === 'skipped' && carried[e.key]?.status === 'done' && state.items[e.key]?.status === 'done') continue;
      state.items[e.key] = {
        status: e.status as StepStatus,
        ...(typeof e.message === 'string' && e.message ? { message: e.message } : {}),
        ...(e.attention === true ? { attention: true } : {}),
      };
    }
  }
  return state;
}

export type Outcome = 'applied' | 'partial' | 'failed' | 'cancelled';

export interface ApplyOutcome {
  status: Outcome;
  done: number;
  error: string | null;
  backupCommit: string | null;
}

// The outcome of a finished apply job, with or without a result (a job that
// failed or was cancelled before reporting has none).
export function applyOutcome(
  job: { status: string; result?: { status: Outcome; done: number; error: string | null; backupCommit: string | null }; error: string | null },
  checklist: ChecklistState,
): ApplyOutcome {
  const r = job.status === 'succeeded' ? job.result : undefined;
  if (r) return { status: r.status, done: r.done, error: r.error, backupCommit: r.backupCommit };
  const status: Outcome = job.status === 'cancelled' ? 'cancelled' : 'failed';
  const done = Object.values(checklist.items).filter((i) => i.status === 'done').length;
  const error = job.error ?? (status === 'cancelled' ? 'The apply was cancelled.' : 'The apply did not finish.');
  return { status, done, error, backupCommit: null };
}

// A finished run leaves no row running: on success a row still running
// finished; otherwise it stopped (or, on a cancel, was skipped). A row never
// reached is settled as skipped only when the plan marked it unchanged (it
// was already as wanted); any other unreached row stays as it is, because
// the server reports every item it skipped, with the reason.
export function settleChecklist(state: ChecklistState, outcome: Outcome | null, items: Array<{ key: string; action?: PlanItemOut['action'] }>): ChecklistState {
  if (!outcome) return state;
  const stopped: ItemProgress = outcome === 'cancelled' ? { status: 'skipped', message: 'Cancelled before it finished.' } : { status: 'failed', message: 'Stopped before it finished.' };
  const unchanged = new Set(items.filter((i) => i.action === 'unchanged').map((i) => i.key));
  const settle = (p: ItemProgress | undefined, key?: string): ItemProgress | undefined => {
    if (p?.status === 'running') return outcome === 'applied' ? { status: 'done' } : stopped;
    if ((!p || p.status === 'pending') && key !== undefined && unchanged.has(key)) return { status: 'skipped', message: 'Already up to date.' };
    return p;
  };
  const out: Record<string, ItemProgress> = {};
  for (const k of new Set([...Object.keys(state.items), ...items.map((i) => i.key)])) {
    const p = settle(state.items[k], k);
    if (p) out[k] = p;
  }
  const backup = settle({ status: state.backup })!.status;
  return { backup, items: out };
}

// What a Resume starts from: only rows that finished (never running ones).
export function carryOver(state: ChecklistState): Record<string, ItemProgress> {
  return Object.fromEntries(Object.entries(state.items).filter(([, p]) => p.status === 'done' || p.status === 'skipped'));
}

// ---- Links -----------------------------------------------------------------

export const backupHref = (p: string, commit: string): string => `/p/${encodeURIComponent(p)}/history?commit=${encodeURIComponent(commit)}`;

// Compare with the backup as From and the live environment as To.
export const restoreHref = (p: string, commit: string, env: string): string => (
  `/p/${encodeURIComponent(p)}/compare?restore=${encodeURIComponent(commit)}&to=${encodeURIComponent(env)}`
);
