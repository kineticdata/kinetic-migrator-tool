// First-run wizard: project name → first environment (tested before Next is
// allowed) → first snapshot with live progress → Overview.
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, Check } from 'lucide-react';
import type { ConnectionTestResult, CredentialsStatus, ProjectDetail } from '../../../shared/api';
import type { SnapshotResult } from '../../../shared/sync-api';
import { api, projectPath } from '../api/client';
import { qk, startSnapshot, testConnection } from '../api/queries';
import { useJob } from '../api/useJob';
import { PlainFrame } from '../components/Brand';
import { ConnectionTestSteps } from '../components/ConnectionTest';
import { EnvironmentFields, draftErrors, emptyDraft, type EnvironmentDraft } from '../components/EnvironmentFields';
import { JobProgress } from '../components/JobProgress';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { InlineError } from '../components/ui/EmptyState';
import { Field, Input } from '../components/ui/Field';
import { cn } from '../components/ui/cn';
import { envLabel, plural } from '../lib/format';

const STEPS = ['Project', 'Environment', 'Snapshot'];

function Stepper({ step }: { step: number }) {
  return (
    <ol aria-label="Setup steps" className="mb-8 flex items-center gap-3">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-3" aria-current={i === step ? 'step' : undefined}>
          {i > 0 && <span aria-hidden className={cn('h-px w-8', i <= step ? 'bg-accent' : 'bg-border-strong')} />}
          <span className="flex items-center gap-2">
            <span className={cn(
              'flex size-6 items-center justify-center rounded-full text-xs font-semibold',
              i < step ? 'bg-accent text-accent-fg' : i === step ? 'bg-accent-soft text-accent ring-1 ring-accent' : 'bg-surface-3 text-muted',
            )}>
              {i < step ? <Check size={13} aria-hidden /> : i + 1}
            </span>
            <span className={cn('text-sm', i === step ? 'font-medium text-fg' : 'text-muted')}>{label}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// What a passing test is valid for: editing any of it means testing again.
const signature = (d: EnvironmentDraft) => JSON.stringify([d.name, d.url.trim(), d.readOnly, d.username, d.password]);

export function NewProjectWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<EnvironmentDraft>(emptyDraft('dev'));
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [saved, setSaved] = useState<{ url: string; readOnly: boolean; username: string } | null>(null);
  const [credentials, setCredentials] = useState<CredentialsStatus>({ username: false, password: false });
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [tested, setTested] = useState<{ sig: string; result: ConnectionTestResult } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const job = useJob<SnapshotResult>(jobId, { invalidate: project ? [qk.project(project.id), qk.projects] : [] });
  const passed = useMemo(() => Boolean(tested?.result.ok && tested.sig === signature(draft)), [tested, draft]);

  const runTest = async () => {
    setShowErrors(true);
    setError(null);
    if (Object.keys(draftErrors(draft)).length) return;
    setTesting(true);
    try {
      const url = draft.url.trim();
      let p = project;
      if (!p) {
        p = await api.post<ProjectDetail>('/api/projects', { name: name.trim(), environment: { name: draft.name, url, readOnly: draft.readOnly } });
        setProject(p);
        qc.setQueryData(qk.project(p.id), p);
        void qc.invalidateQueries({ queryKey: qk.projects });
        setSaved({ url, readOnly: draft.readOnly, username: '' });
      } else if (!saved || saved.url !== url || saved.readOnly !== draft.readOnly) {
        p = await api.put<ProjectDetail>(projectPath(p.id, 'environments', draft.name), { url, readOnly: draft.readOnly });
        setProject(p);
        setSaved((s) => ({ username: s?.username ?? '', url, readOnly: draft.readOnly }));
      }
      const creds: { username?: string; password?: string } = {};
      if (draft.username && draft.username !== saved?.username) creds.username = draft.username;
      if (draft.password) creds.password = draft.password;
      let next = draft;
      if (Object.keys(creds).length) {
        setCredentials(await api.put<CredentialsStatus>(projectPath(p.id, 'environments', draft.name, 'credentials'), creds));
        setSaved((s) => ({ url: s?.url ?? url, readOnly: s?.readOnly ?? draft.readOnly, username: draft.username }));
        // The password is sent; never keep it in the page.
        next = { ...draft, password: '' };
        setDraft(next);
      }
      const result = await testConnection(p.id, draft.name);
      setTested({ sig: signature(next), result });
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  };

  const takeSnapshot = async () => {
    if (!project) return;
    setStarting(true);
    setError(null);
    try {
      setJobId((await startSnapshot(project.id, draft.name)).jobId);
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };

  const overview = project ? `/p/${project.id}/overview` : '/';

  return (
    <PlainFrame>
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">New project</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Connect your first environment and take a snapshot of it.</p>
        <Stepper step={step} />

        {step === 0 && (
          <Card className="p-6">
            <form
              onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) setStep(1); }}
              className="space-y-5"
            >
              <Field label="Project name" hint="Usually the customer or the platform, for example “Service portal”.">
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />}
              </Field>
              <div className="flex justify-between">
                <LinkButton to="/" variant="ghost">Cancel</LinkButton>
                <Button type="submit" variant="primary" disabled={!name.trim()}>Next</Button>
              </div>
            </form>
          </Card>
        )}

        {step === 1 && (
          <Card className="p-6">
            <div className="mb-5">
              <h2 className="text-[15px] font-semibold text-fg">First environment</h2>
              <p className="mt-0.5 text-sm text-muted">Usually the one where changes are made first, such as Dev. You can add more later.</p>
            </div>
            <EnvironmentFields
              draft={draft}
              onChange={setDraft}
              nameLocked={Boolean(project)}
              credentials={credentials}
              showErrors={showErrors}
            />
            <div className="mt-5 space-y-3">
              {tested && <ConnectionTestSteps result={tested.result} />}
              <InlineError error={error} />
            </div>
            <div className="mt-6 flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(0)} disabled={Boolean(project)}>Back</Button>
              <div className="flex gap-2">
                <Button onClick={runTest} loading={testing}>Test connection</Button>
                <Button variant="primary" disabled={!passed || testing} onClick={() => setStep(2)}>Next</Button>
              </div>
            </div>
            {!passed && !testing && (
              <p className="mt-3 text-right text-xs text-muted">Test the connection to continue.</p>
            )}
          </Card>
        )}

        {step === 2 && project && (
          <Card className="p-6">
            <div className="flex items-start gap-4">
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Camera size={20} /></span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold text-fg">Take a snapshot of {envLabel(draft.name)}</h2>
                <p className="mt-0.5 text-sm text-muted">
                  A snapshot reads every item in the environment so you can explore and compare it. It only reads; nothing is changed. It can take a minute or two.
                </p>
              </div>
            </div>
            <div className="mt-6 space-y-4">
              {job.status === 'running' && <JobProgress job={job} label={`Snapshot of ${envLabel(draft.name)}`} />}
              {job.status === 'succeeded' && (
                <p role="status" className="flex items-center gap-2 rounded-lg bg-added-soft px-3 py-2 text-sm text-added">
                  <Check size={16} aria-hidden />
                  Snapshot taken{job.result ? `: ${plural(job.result.total, 'item')}` : ''}.
                </p>
              )}
              {(job.status === 'failed' || job.status === 'cancelled') && <InlineError error={job.error ?? 'The snapshot was cancelled.'} />}
              <InlineError error={error} />
            </div>
            <div className="mt-6 flex items-center justify-between gap-2">
              {job.status === 'succeeded'
                ? <span />
                : <Button variant="ghost" onClick={() => navigate(overview)}>Skip for now</Button>}
              {job.status === 'succeeded' ? (
                <Button variant="primary" onClick={() => navigate(overview)}>Open overview</Button>
              ) : job.status === 'running' ? (
                <Button onClick={job.cancel}>Cancel</Button>
              ) : (
                <Button variant="primary" loading={starting} onClick={takeSnapshot}>
                  {job.status === 'idle' ? 'Take snapshot' : 'Try again'}
                </Button>
              )}
            </div>
          </Card>
        )}
      </div>
    </PlainFrame>
  );
}
