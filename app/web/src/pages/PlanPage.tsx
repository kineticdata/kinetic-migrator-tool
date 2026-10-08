// Plan & apply, as guided steps: Review (counts, the needs-attention
// checklist, blocking errors with plain fixes, per-item changes) →
// Environment values (from → to, editable, required markers; secrets needed)
// → Confirm (summary, backup note, typed environment name) → Apply (a live
// checklist; on failure Resume, View backup and Restore…).
//
// Secrets typed here live in component state only until the apply request is
// sent, are sent with a plain request (never a query or mutation cache) and
// are cleared as it goes out.
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  AlertOctagon, ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, DatabaseBackup, History, KeyRound, Lock, RotateCcw, ShieldCheck, Undo2,
} from 'lucide-react';
import type { ApplyRequest, ApplyResult, PlanItemOut, PlanResult } from '../../../shared/sync-api';
import { ApiError } from '../api/client';
import { startApply, usePlan } from '../api/plans';
import { qk } from '../api/queries';
import { useJob, type JobState } from '../api/useJob';
import { ApplyChecklist } from '../components/ApplyChecklist';
import { EnvironmentValuesForm } from '../components/EnvironmentValuesForm';
import { FieldDiffTable } from '../components/FieldDiffTable';
import { NeedsAttention } from '../components/NeedsAttention';
import { KindIcon } from '../components/ObjectTree';
import { Stepper } from '../components/Stepper';
import { Badge, type Tone } from '../components/ui/Badge';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../components/ui/EmptyState';
import { Field, Input } from '../components/ui/Field';
import { SecretInput } from '../components/ui/SecretInput';
import { cn } from '../components/ui/cn';
import { envLabel, plural } from '../lib/format';
import {
  applyOutcome, attentionList, backupHref, carryOver, checklistFrom, errorFix, groupByPhase, restoreHref, satisfied, settleChecklist, valuesPayload,
  writes, type ApplyOutcome, type ItemProgress,
} from '../lib/plan';
import { useProjectContext } from '../lib/project';
import { kindOfKey } from '../lib/tree-layout';

const STEPS = ['Review', 'Environment values', 'Confirm', 'Apply'];

export function PlanPage() {
  const { project } = useProjectContext();
  const { planId = '' } = useParams();
  const plan = usePlan(project.id, planId);
  const back = <LinkButton to={`/p/${project.id}/compare`} variant="secondary" icon={<ArrowLeft size={15} aria-hidden />}>Back to Compare</LinkButton>;

  if (plan.isPending) return <div className="mx-auto max-w-5xl px-6 py-8"><LoadingState label="Loading the plan…" /></div>;
  if (plan.isError) {
    const expired = plan.error instanceof ApiError && plan.error.status === 404;
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Card>
          {expired
            ? <EmptyState icon={<RotateCcw size={20} />} title="Plan again" description={plan.error.message} action={back} />
            : <ErrorState title="Could not load the plan" error={plan.error} onRetry={() => plan.refetch()} />}
        </Card>
      </div>
    );
  }
  return <PlanFlow key={planId} projectId={project.id} plan={plan.data} />;
}

// ---- The flow ----------------------------------------------------------------

function PlanFlow({ projectId, plan }: { projectId: string; plan: PlanResult }) {
  const { project } = useProjectContext();
  const target = project.environments.find((e) => e.name === plan.to);
  const isProtected = Boolean(target?.readOnly);
  const To = envLabel(plan.to);
  const From = envLabel(plan.from);

  const [step, setStep] = useState(0);
  const attention = useMemo(() => attentionList(plan), [plan]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Write-only: cleared when the apply request is sent.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  // Ids of secrets given for one run only (never their values): Resume asks again.
  const [oneRun, setOneRun] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [carried, setCarried] = useState<Record<string, ItemProgress>>({});

  const values = useMemo(() => valuesPayload(plan.environmentValues, edits), [plan.environmentValues, edits]);
  const missing = useMemo(() => new Set(values.missing), [values.missing]);
  const applied = useMemo(() => plan.items.filter(writes), [plan.items]);
  const groups = useMemo(() => groupByPhase(applied), [applied]);

  const job = useJob<ApplyResult>(jobId, { invalidate: [qk.project(projectId)] });
  const live = useMemo(() => checklistFrom(job.events, carried), [job.events, carried]);
  const finished = job.status !== 'idle' && job.status !== 'running';
  const outcome = useMemo(() => (finished ? applyOutcome(job, live) : null), [finished, job, live]);
  const checklist = useMemo(() => settleChecklist(live, outcome?.status ?? null, applied), [live, outcome, applied]);
  const filled = useMemo(() => new Set(values.filled), [values.filled]);
  const blank = useMemo(() => new Set(values.blank), [values.blank]);

  const reviewOk = plan.errors.length === 0 && attention.every((a) => satisfied(a, ticked, filled));
  const valuesOk = values.missing.length === 0 && Object.keys(values.errors).length === 0;
  const confirmOk = confirm === plan.to && !isProtected;

  const send = async (given: Record<string, string>) => {
    const entered = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== ''));
    const body: ApplyRequest = {
      acknowledgements: attention.filter((a) => a.send && ticked.has(a.id)).map((a) => a.id),
      ...(Object.keys(values.values).length ? { values: values.values } : {}),
      ...(Object.keys(entered).length ? { secrets: entered, remember } : {}),
      confirm,
    };
    const ids = Object.keys(entered);
    setSecrets({});
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { jobId: id } = await startApply(projectId, plan.planId, body);
      if (!remember) setOneRun((cur) => [...new Set([...cur, ...ids])]);
      setJobId(id);
      setStep(3);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const resume = (again: Record<string, string>) => {
    setCarried(carryOver(checklist));
    return send(again);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <Link to={`/p/${projectId}/compare`} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
          <ArrowLeft size={14} aria-hidden />Compare
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-subtle uppercase">Promote</p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-fg">{plan.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
              <span className="font-medium text-fg">{From}</span>
              <ArrowRight size={14} aria-hidden />
              <span className="inline-flex items-center gap-1 font-medium text-fg">
                {isProtected && <Lock size={13} aria-label="Protected" />}{To}
              </span>
              {plan.changesetId && <span className="text-subtle">· saved changeset</span>}
            </p>
          </div>
        </div>
        <Stepper steps={STEPS} current={step} className="mt-6" />
      </header>

      {isProtected && step < 3 && (
        <div role="note" className="mb-5 flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-fg">
          <Lock size={16} aria-hidden className="mt-0.5 shrink-0 text-muted" />
          <p>
            {To} is protected (read-only), so nothing can be applied to it. You can still review the plan.{' '}
            <Link to={`/p/${projectId}/settings/environments`} className="font-medium text-accent hover:underline">Environment settings</Link>
          </p>
        </div>
      )}

      {step === 0 && (
        <Review plan={plan} attention={attention} ticked={ticked} filled={filled} onToggle={(id) => setTicked((cur) => {
          const nextSet = new Set(cur);
          if (nextSet.has(id)) nextSet.delete(id);
          else nextSet.add(id);
          return nextSet;
        })} footer={(
          <Footer
            hint={plan.errors.length ? 'Fix the problems above, then plan again.' : !reviewOk ? 'Tick every item that needs attention to continue.' : undefined}
            next={<Button variant="primary" disabled={!reviewOk} onClick={() => setStep(1)}>Next: Environment values<ArrowRight size={15} aria-hidden /></Button>}
          />
        )} />
      )}

      {step === 1 && (
        <StepCard title="Environment values" description={`Values that differ per environment, ${From} beside ${To}. Changes are saved for ${To} when the apply starts.`}>
          <EnvironmentValuesForm values={plan.environmentValues} from={plan.from} to={plan.to} edits={edits} onEdit={(id, text) => setEdits((cur) => ({ ...cur, [id]: text }))} missing={missing} blank={blank} errors={values.errors} />
          {plan.secretsNeeded.length > 0 && (
            <section aria-label="Secrets needed" className="mt-6 rounded-xl border border-border bg-surface p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-fg"><KeyRound size={15} aria-hidden className="text-muted" />Secrets needed</h3>
              <p className="mt-0.5 text-[13px] text-muted">Passwords and keys for new connections and handlers. They are never shown again; leave one empty to keep what {To} has.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {plan.secretsNeeded.map((s) => (
                  <SecretInput
                    key={s.id}
                    label={s.label}
                    isSet={s.has}
                    value={secrets[s.id] ?? ''}
                    onChange={(v) => setSecrets((cur) => ({ ...cur, [s.id]: v }))}
                    hint={s.has ? `Already stored for ${To}.` : 'Used for this apply.'}
                  />
                ))}
              </div>
              <div className="mt-4 flex items-start gap-2.5 text-sm">
                <input id="remember-secrets" type="checkbox" aria-describedby="remember-secrets-note" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 size-4 cursor-pointer accent-[var(--accent)]" />
                <div>
                  <label htmlFor="remember-secrets" className="cursor-pointer font-medium text-fg">Remember in keychain</label>
                  <p id="remember-secrets-note" className="text-xs text-muted">Otherwise they are used for this apply only and then forgotten.</p>
                </div>
              </div>
            </section>
          )}
          <Footer
            onBack={() => setStep(0)}
            hint={!valuesOk ? (values.missing.length ? `${plural(values.missing.length, 'required value')} still empty.` : 'Fix the values marked above.') : undefined}
            next={<Button variant="primary" disabled={!valuesOk} onClick={() => setStep(2)}>Next: Confirm<ArrowRight size={15} aria-hidden /></Button>}
          />
        </StepCard>
      )}

      {step === 2 && (
        <StepCard title="Confirm" description={`Check the summary, then type the environment name to apply to ${To}.`}>
          <ConfirmSummary plan={plan} changedValues={Object.values(values.values).reduce((n, v) => n + Object.keys(v).length, 0)} secrets={Object.values(secrets).filter(Boolean).length} remember={remember} acknowledged={attention.length} />
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-fg">
            <DatabaseBackup size={18} aria-hidden className="mt-0.5 shrink-0 text-accent" />
            <p>A backup snapshot of {To} is taken first, so you can restore it if anything goes wrong.</p>
          </div>
          <Field className="mt-5 max-w-sm" label={<>Type <span className="font-mono font-semibold">{plan.to}</span> to confirm</>} hint={isProtected ? `${To} is protected; it cannot be applied to.` : undefined}>
            {(p) => <Input {...p} value={confirm} autoComplete="off" spellCheck={false} onChange={(e) => setConfirm(e.target.value)} className="font-mono" />}
          </Field>
          {submitError ? <div className="mt-4"><InlineError error={submitError} />{oneRunNote(plan.secretsNeeded.length > 0)}</div> : null}
          <Footer
            onBack={() => setStep(1)}
            next={<Button variant="primary" icon={<ShieldCheck size={15} aria-hidden />} disabled={!confirmOk} loading={submitting} onClick={() => send(secrets)}>Apply to {To}</Button>}
          />
        </StepCard>
      )}

      {step === 3 && (
        <ApplyStep
          projectId={projectId} plan={plan} groups={groups} checklist={checklist} job={job} outcome={outcome} oneRun={oneRun}
          onResume={resume} resuming={submitting} resumeError={submitError}
        />
      )}
    </div>
  );
}

const oneRunNote = (hasSecrets: boolean) => (hasSecrets ? <p className="mt-2 text-xs text-muted">Secrets are not kept after a request; enter them again before retrying.</p> : null);

function StepCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div>
      <h2 id="step-title" className="text-[15px] font-semibold text-fg">{title}</h2>
      <p className="mt-0.5 mb-4 text-sm text-muted">{description}</p>
      {children}
    </div>
  );
}

function Footer({ onBack, next, hint }: { onBack?: () => void; next: ReactNode; hint?: string }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div>{onBack && <Button onClick={onBack} icon={<ArrowLeft size={15} aria-hidden />}>Back</Button>}</div>
      <div className="flex items-center gap-3">
        {hint && <p className="text-[13px] text-muted" aria-live="polite">{hint}</p>}
        {next}
      </div>
    </div>
  );
}

// ---- Review ------------------------------------------------------------------

const ACTION: Record<PlanItemOut['action'], { label: string; tone: Tone; symbol: string }> = {
  create: { label: 'Create', tone: 'added', symbol: '+' },
  update: { label: 'Update', tone: 'changed', symbol: '~' },
  unchanged: { label: 'No change', tone: 'neutral', symbol: '=' },
  manual: { label: 'By hand', tone: 'neutral', symbol: '•' },
  'skip-drift': { label: 'Kept', tone: 'drift', symbol: '!' },
};

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <span className={cn('block text-2xl font-semibold tabular-nums', value ? tone : 'text-subtle')}>{value.toLocaleString('en')}</span>
      <span className="text-[13px] text-muted">{label}</span>
    </div>
  );
}

function Review({ plan, attention, ticked, filled, onToggle, footer }: {
  plan: PlanResult; attention: ReturnType<typeof attentionList>; ticked: Set<string>; filled: ReadonlySet<string>; onToggle: (id: string) => void; footer: ReactNode;
}) {
  const c = plan.counts;
  const skip = c.unchanged + c.manual + c['skip-drift'];
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const all = groupByPhase(plan.items);
  return (
    <div className="space-y-5">
      <h2 id="step-title" className="sr-only">Review</h2>
      <div role="region" aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={c.create} label="create" tone="text-added" />
        <Stat value={c.update} label="update" tone="text-changed" />
        <Stat value={c.delete} label="delete" tone="text-danger" />
        <Stat value={skip} label="no change" tone="text-fg" />
      </div>

      {plan.errors.length > 0 && (
        <section aria-label="Problems" className="overflow-hidden rounded-xl border border-danger/40 bg-surface">
          <h3 className="flex items-center gap-2 border-b border-danger/30 bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger">
            <AlertOctagon size={15} aria-hidden />{plan.errors.length === 1 ? 'A problem blocks this plan' : `${plan.errors.length} problems block this plan`}
          </h3>
          <ul className="divide-y divide-border">
            {plan.errors.map((e) => {
              const f = errorFix(e, plan.from, plan.to);
              return (
                <li key={e} className="px-4 py-3">
                  <p className="text-sm text-fg">{f.message}</p>
                  <p className="mt-1 text-[13px] text-muted"><span className="font-medium text-fg">Fix: </span>{f.fix}</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {attention.length > 0 && <NeedsAttention entries={attention} ticked={ticked} filled={filled} onToggle={onToggle} />}

      <section aria-label="Items" className="overflow-hidden rounded-xl border border-border bg-surface">
        {all.map((g) => (
          <div key={g.id}>
            <h3 className="border-b border-border bg-surface-2/60 px-4 py-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{g.label}</h3>
            <ul className="divide-y divide-border border-b border-border last:border-b-0">
              {g.items.map((i) => {
                const a = ACTION[i.action];
                const expandable = i.diff.length > 0;
                const isOpen = open.has(i.key);
                const row = (
                  <>
                    {expandable
                      ? <ChevronRight size={14} aria-hidden className={cn('shrink-0 text-subtle transition-transform', isOpen && 'rotate-90')} />
                      : <span className="w-3.5 shrink-0" />}
                    <KindIcon kind={kindOfKey(i.key)} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{i.label}</span>
                      <span className="block truncate font-mono text-[11px] text-subtle">{i.key}</span>
                    </span>
                    {i.drift && i.action !== 'skip-drift' && <Badge tone="drift"><span aria-hidden>!</span>Overwrites drift</Badge>}
                    {expandable && <span className="text-xs text-subtle">{plural(i.diff.length, 'change')}</span>}
                    <Badge tone={a.tone}><span aria-hidden className="font-mono">{a.symbol}</span>{a.label}</Badge>
                  </>
                );
                return (
                  <li key={i.key}>
                    {expandable ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setOpen((cur) => {
                          const n = new Set(cur);
                          if (n.has(i.key)) n.delete(i.key);
                          else n.add(i.key);
                          return n;
                        })}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                      >
                        {row}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2.5 px-4 py-2">{row}</div>
                    )}
                    {isOpen && <div className="px-4 pb-3 pl-11"><FieldDiffTable diff={i.diff} from={plan.from} to={plan.to} /></div>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {all.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">This plan has no items.</p>}
      </section>
      {footer}
    </div>
  );
}

// ---- Confirm -----------------------------------------------------------------

function ConfirmSummary({ plan, changedValues, secrets, remember, acknowledged }: {
  plan: PlanResult; changedValues: number; secrets: number; remember: boolean; acknowledged: number;
}) {
  const To = envLabel(plan.to);
  const n = plan.counts.create + plan.counts.update;
  const rows: Array<[string, string]> = [
    ['Changes', n ? `${plural(n, 'item')} written to ${To} (${plan.counts.create} new, ${plan.counts.update} updated)` : `Nothing to write to ${To}`],
    ['From', `${envLabel(plan.from)}${plan.changesetId ? ', as saved in the changeset' : ', newest snapshot'}`],
    ['Environment values', changedValues ? `${plural(changedValues, 'value')} saved for ${To}` : 'No changes'],
    ...(plan.secretsNeeded.length ? [['Secrets', secrets ? `${plural(secrets, 'secret')} ${remember ? 'kept in the keychain' : 'for this apply only'}` : 'None entered']] as Array<[string, string]> : []),
    ...(acknowledged ? [['Needs attention', `${plural(acknowledged, 'item')} reviewed`]] as Array<[string, string]> : []),
  ];
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[10rem_1fr] gap-3 px-4 py-2.5 text-sm">
          <dt className="text-muted">{k}</dt>
          <dd className="text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---- Apply -------------------------------------------------------------------

function ApplyStep({ projectId, plan, groups, checklist, job, outcome, oneRun, onResume, resuming, resumeError }: {
  projectId: string;
  plan: PlanResult;
  groups: ReturnType<typeof groupByPhase>;
  checklist: ReturnType<typeof checklistFrom>;
  job: JobState<ApplyResult>;
  outcome: ApplyOutcome | null;
  oneRun: string[];
  onResume: (secrets: Record<string, string>) => Promise<void>;
  resuming: boolean;
  resumeError: unknown;
}) {
  const To = envLabel(plan.to);
  const running = !outcome;
  const success = outcome?.status === 'applied';
  const failed = Boolean(outcome && !success);
  const backup = outcome?.backupCommit ?? null;
  const [again, setAgain] = useState<Record<string, string>>({});
  const resumeSecrets = plan.secretsNeeded.filter((s) => oneRun.includes(s.id));

  const heading = !outcome ? `Applying to ${To}…` : {
    applied: `Applied to ${To}`, partial: `Partly applied to ${To}`, failed: `Failed to apply to ${To}`, cancelled: `Cancelled applying to ${To}`,
  }[outcome.status];
  // A partial run with no failed row finished, but skipped what changed since review.
  const stoppedEarly = outcome?.status !== 'partial' || Object.values(checklist.items).some((i) => i.status === 'failed');
  const summary = !outcome ? '' : outcome.done > 0
    ? (stoppedEarly ? `${outcome.status === 'cancelled' ? 'Cancelled' : 'Stopped'} after ${plural(outcome.done, 'change')}.` : `${plural(outcome.done, 'change')} applied.`)
    : 'Nothing was applied.';

  const resume = () => {
    const given = again;
    setAgain({});
    onResume(given);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="step-title" className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          {success && <CheckCircle2 size={18} aria-hidden className="text-added" />}
          {heading}
        </h2>
        {running && <Button size="sm" variant="ghost" onClick={job.cancel}>Cancel</Button>}
      </div>

      {success && outcome && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-added/30 bg-added-soft px-4 py-3">
          <p className="text-sm text-fg">
            {plural(outcome.done, 'change')} applied to {To}. A backup was taken first and the run is recorded in History.
          </p>
          <div className="flex items-center gap-2">
            <LinkButton size="sm" to={`/p/${projectId}/compare`} icon={<Undo2 size={14} aria-hidden />}>Back to Compare</LinkButton>
            <LinkButton size="sm" variant="primary" to={`/p/${projectId}/history`} icon={<History size={14} aria-hidden />}>View in History</LinkButton>
          </div>
        </div>
      )}

      {failed && outcome && (
        <div role="alert" className={cn('rounded-xl border px-4 py-3', outcome.status === 'cancelled' ? 'border-drift/40 bg-drift-soft' : 'border-danger/40 bg-danger-soft')}>
          <p className={cn('flex items-start gap-2 text-sm font-medium', outcome.status === 'cancelled' ? 'text-drift' : 'text-danger')}>
            <AlertOctagon size={16} aria-hidden className="mt-0.5 shrink-0" />
            <span>{summary}{outcome.error && outcome.error !== 'The apply was cancelled.' ? ` ${outcome.error}` : ''}</span>
          </p>
          <p className="mt-1 pl-6 text-[13px] text-fg">
            Nothing was rolled back. Resume plans again against {To} and continues with what is left; or restore {To} from the backup.
          </p>
          {resumeSecrets.length > 0 && (
            <div className="mt-3 grid gap-3 pl-6 sm:grid-cols-2">
              {resumeSecrets.map((s) => (
                <SecretInput key={s.id} label={s.label} isSet={false} value={again[s.id] ?? ''} onChange={(v) => setAgain((cur) => ({ ...cur, [s.id]: v }))} hint="Not kept after the last apply; enter it again to use it." />
              ))}
            </div>
          )}
          {resumeError ? <div className="mt-3 pl-6"><InlineError error={resumeError} /></div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
            <Button size="sm" variant="primary" icon={<RotateCcw size={14} aria-hidden />} loading={resuming} onClick={resume}>Resume</Button>
            {backup && <LinkButton size="sm" to={backupHref(projectId, backup)} icon={<DatabaseBackup size={14} aria-hidden />}>View backup</LinkButton>}
            {backup && <LinkButton size="sm" to={restoreHref(projectId, backup, plan.to)}>Restore…</LinkButton>}
          </div>
        </div>
      )}

      <ApplyChecklist to={plan.to} groups={groups} state={checklist} />
    </div>
  );
}
