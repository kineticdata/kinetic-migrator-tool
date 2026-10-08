// Plan and apply rules, as pure functions: the needs-attention checklist
// (server entries plus other preflight warnings), plain fixes for plan
// errors, environment values to send (and which required ones are missing),
// the apply phases and the live checklist built from streamed job events.
import type { JobEventData } from '../../../shared/api';
import type { AttentionKind, EnvironmentValue, PlanItemOut, PlanResult } from '../../../shared/sync-api';
import { envLabel } from './format';

// ---- Needs attention -------------------------------------------------------

export interface AttentionEntry {
  id: string;
  kind: AttentionKind | 'warning';
  key: string | null;
  message: string;
  // Sent as an acknowledgement (server entries); warnings are ticked here only.
  send: boolean;
}

// Warnings the server already turns into needs-attention entries.
const COVERED = [
  /: creating\/updating rows will run these workflows in the target: /,
  /: will be created without credentials/,
];

export function attentionList(plan: PlanResult): AttentionEntry[] {
  const kept = new Set(plan.items.filter((i) => i.action === 'skip-drift').map((i) => i.key));
  const out: AttentionEntry[] = plan.needsAttention
    // A drifted item kept as it is in the target is not overwritten.
    .filter((n) => !(n.kind === 'drift' && kept.has(n.key)))
    .map((n) => ({ id: n.id, kind: n.kind, key: n.key, message: n.message, send: true }));
  plan.warnings.forEach((w, i) => {
    if (!COVERED.some((re) => re.test(w))) out.push({ id: `warning:${i}`, kind: 'warning', key: null, message: w, send: false });
  });
  return out;
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
  if (typeof original === 'number' && t !== '' && Number.isFinite(Number(t))) return { value: Number(t) };
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
  // Values that could not be read ({ id: message }).
  errors: Record<string, string>;
}

// `edits` maps value ids to the text typed; untouched values are not sent.
export function valuesPayload(list: EnvironmentValue[], edits: Record<string, string>): ValuesPayload {
  const out: ValuesPayload = { values: {}, missing: [], errors: {} };
  for (const v of list) {
    const text = edits[v.id] ?? valueText(v.to);
    if (!text.trim()) {
      if (v.required) out.missing.push(v.id);
      continue;
    }
    if (edits[v.id] === undefined || edits[v.id] === valueText(v.to)) continue;
    const parsed = parseValueText(text, v.to ?? v.from);
    if ('error' in parsed) {
      out.errors[v.id] = parsed.error;
      continue;
    }
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
  { id: 'kapps', label: 'Kapps', types: ['kapps'] },
  { id: 'forms', label: 'Forms', types: ['forms'] },
  { id: 'webapis', label: 'WebAPIs', types: ['webapis'] },
  { id: 'workflows', label: 'Workflows', types: ['workflows'] },
  { id: 'data', label: 'Reference data', types: ['data'] },
  { id: 'routines', label: 'Routines', types: ['routines'] },
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

// ---- Live checklist --------------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ItemProgress {
  status: StepStatus;
  message?: string;
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
      state.items[e.key] = typeof e.message === 'string' && e.message
        ? { status: e.status as StepStatus, message: e.message }
        : { status: e.status as StepStatus };
    }
  }
  return state;
}

// ---- Links -----------------------------------------------------------------

export const backupHref = (p: string, commit: string): string => `/p/${encodeURIComponent(p)}/history?commit=${encodeURIComponent(commit)}`;

// Compare with the backup as From and the live environment as To.
export const restoreHref = (p: string, commit: string, env: string): string => (
  `/p/${encodeURIComponent(p)}/compare?restore=${encodeURIComponent(commit)}&to=${encodeURIComponent(env)}`
);
