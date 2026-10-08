// History: every snapshot, changeset, promotion, backup, restore and drift in
// plain words, as a timeline grouped by day with environment and type filters
// (kept in the URL). `?commit=` opens that entry's detail panel (who, when,
// duration, counts, acknowledgements, values used) with Open in Compare,
// View plan and Restore…; the commit id shows under Advanced only.
import { useId, useMemo, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { GitCompare, History as HistoryIcon, ListChecks, RotateCcw } from 'lucide-react';
import type { HistoryEvent, RunRecord } from '../../../shared/sync-api';
import { useHistoryDetail } from '../api/history';
import { Timeline } from '../components/Timeline';
import { Badge } from '../components/ui/Badge';
import { Button, LinkButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState, InlineError, LoadingState } from '../components/ui/EmptyState';
import { inputClasses } from '../components/ui/Field';
import { cn } from '../components/ui/cn';
import { envLabel, formatDateTime, plural } from '../lib/format';
import {
  TYPE_FILTERS, compareHrefFor, eventForCommit, eventInfo, filterEvents, restoreTargetFor, runCounts, runDuration, runValues,
} from '../lib/history';
import { restoreHref, valueText } from '../lib/plan';
import { useProjectContext } from '../lib/project';

const DRIFT = ':drift';

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-muted">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputClasses, 'h-8 w-auto min-w-32 py-0 text-[13px]')}>
        {children}
      </select>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}

function RunFacts({ run }: { run: RunRecord }) {
  const c = runCounts(run);
  const values = runValues(run);
  const failed = run.items.filter((i) => i.status === 'failed');
  return (
    <>
      <div className="flex flex-wrap gap-1.5 text-sm">
        <Badge>{c.selected} selected</Badge>
        <Badge tone="added">{c.done} done</Badge>
        {c.failed > 0 && <Badge tone="danger">{c.failed} failed</Badge>}
        {c.skipped > 0 && <Badge>{c.skipped} skipped</Badge>}
      </div>
      {run.error && <InlineError error={run.error} />}
      {failed.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-muted">Failed items</h3>
          <ul className="space-y-1 text-sm">
            {failed.map((i) => (
              <li key={i.key}><span className="font-mono text-[13px]">{i.key}</span>{i.message && <span className="text-muted"> — {i.message}</span>}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-semibold text-muted">Acknowledgements</h3>
        {run.acknowledgements.length
          ? <ul className="space-y-0.5 font-mono text-[13px]">{run.acknowledgements.map((a) => <li key={a}>{a}</li>)}</ul>
          : <p className="text-sm text-subtle">None needed</p>}
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold text-muted">Environment values used</h3>
        {values.length ? (
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-muted"><tr><th className="py-1 pr-2 font-medium">Item</th><th className="py-1 pr-2 font-medium">Value</th><th className="py-1 font-medium">Set to</th></tr></thead>
            <tbody>
              {values.map((v) => (
                <tr key={`${v.key}#${v.path}`} className="border-t border-border align-top">
                  <td className="py-1 pr-2 font-mono break-all">{v.key}</td>
                  <td className="py-1 pr-2 break-all">{v.path.split('/').at(-1)}</td>
                  <td className="py-1 font-mono break-all">{valueText(v.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-subtle">None changed</p>}
      </div>
    </>
  );
}

function DetailPanel({ projectId, selected, listed }: { projectId: string; selected: string; listed: HistoryEvent | undefined }) {
  const navigate = useNavigate();
  const commit = selected.endsWith(DRIFT) ? selected.slice(0, -DRIFT.length) : selected;
  const detail = useHistoryDetail(projectId, commit);
  // The timeline's own entry (a drift entry shares its snapshot's commit).
  const event = listed ?? detail.data?.event;
  const run = detail.data?.run ?? null;
  const restore = event ? restoreTargetFor(event, run) : null;
  const compare = event ? compareHrefFor(projectId, event, run) : null;
  const info = event ? eventInfo(event) : null;
  const duration = run ? runDuration(run) : null;

  return (
    <section aria-label="Details">
      <Card className="space-y-4 p-5">
        {!event && detail.isPending && <LoadingState />}
        {!event && detail.isError && <InlineError error={detail.error} />}
        {event && info && (
          <>
            <div className="space-y-2">
              <Badge tone={info.tone}><span aria-hidden className="font-mono">{info.symbol}</span><span>{info.label}</span></Badge>
              <h2 className="text-base font-semibold text-fg">{event.title}</h2>
            </div>
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Who">{event.author || 'Unknown'}</Fact>
              <Fact label="When">{formatDateTime(event.at)}</Fact>
              {event.env && <Fact label="Environment">{envLabel(event.env)}</Fact>}
              {run && <Fact label="Duration">{duration ?? '—'}</Fact>}
              {run && run.from !== run.to && <Fact label="From">{envLabel(run.from)}</Fact>}
            </dl>
            {event.drifted.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold text-muted">{plural(event.drifted.length, 'item')} changed since the last promotion</h3>
                <ul className="space-y-0.5 font-mono text-[13px]">{event.drifted.map((k) => <li key={k}>{k}</li>)}</ul>
              </div>
            )}
            {detail.isPending && event.runId && <LoadingState label="Loading the run…" className="py-4" />}
            {detail.isError && listed && <InlineError error={detail.error} />}
            {run && <RunFacts run={run} />}
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {compare && <LinkButton size="sm" to={compare} icon={<GitCompare size={14} aria-hidden />}>Open in Compare</LinkButton>}
              {run && <LinkButton size="sm" to={`/p/${encodeURIComponent(projectId)}/plan/${encodeURIComponent(run.planId)}`} icon={<ListChecks size={14} aria-hidden />}>View plan</LinkButton>}
              {restore && (
                <Button size="sm" icon={<RotateCcw size={14} aria-hidden />} onClick={() => navigate(restoreHref(projectId, restore.commit, restore.env))}>
                  Restore…
                </Button>
              )}
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-muted select-none">Advanced</summary>
              <dl className="mt-2 space-y-1 text-[13px]">
                <div><dt className="inline text-muted">Commit id: </dt><dd className="inline font-mono break-all">{event.commit}</dd></div>
                {run?.backupCommit && <div><dt className="inline text-muted">Backup commit id: </dt><dd className="inline font-mono break-all">{run.backupCommit}</dd></div>}
                {event.runId && <div><dt className="inline text-muted">Run id: </dt><dd className="inline font-mono break-all">{event.runId}</dd></div>}
              </dl>
            </details>
          </>
        )}
      </Card>
    </section>
  );
}

export function HistoryPage() {
  const { project, history } = useProjectContext();
  const [params, setParams] = useSearchParams();
  const names = project.environments.map((e) => e.name);
  const env = params.get('env');
  const type = params.get('type');
  const selectedParam = params.get('commit');
  const events = useMemo(() => filterEvents(history, { env: env && names.includes(env) ? env : null, type }), [history, env, type, names]);

  // The entry ?commit= points at: an exact id, else the commit's own entry.
  const listed = useMemo(() => {
    if (!selectedParam) return undefined;
    return history.find((e) => e.id === selectedParam) ?? eventForCommit(history, selectedParam);
  }, [history, selectedParam]);
  const selectedId = listed?.id ?? selectedParam;

  const setParam = (changes: Record<string, string | null>) => setParams((cur) => {
    const next = new URLSearchParams(cur);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    return next;
  });

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">History</h1>
          <p className="mt-0.5 text-sm text-muted">Every snapshot, promotion and backup, in plain words.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <FilterSelect label="Environment" value={env ?? ''} onChange={(v) => setParam({ env: v || null })}>
            <option value="">All environments</option>
            {names.map((n) => <option key={n} value={n}>{envLabel(n)}</option>)}
          </FilterSelect>
          <FilterSelect label="Type" value={type ?? ''} onChange={(v) => setParam({ type: v || null })}>
            <option value="">Everything</option>
            {TYPE_FILTERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </FilterSelect>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">
          {history.length === 0 ? (
            <EmptyState icon={<HistoryIcon size={20} />} title="Nothing has happened yet" description="Take a snapshot of an environment to start the history." />
          ) : events.length === 0 ? (
            <EmptyState icon={<HistoryIcon size={20} />} title="No matching events" description="Try another environment or type." />
          ) : (
            <Timeline events={events} selectedId={selectedId} onSelect={(e) => setParam({ commit: e.type === 'drift' ? e.id : e.commit })} />
          )}
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          {selectedParam
            ? <DetailPanel key={selectedParam} projectId={project.id} selected={selectedParam} listed={listed} />
            : history.length > 0 && <p className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted">Select an event to see its details.</p>}
        </div>
      </div>
    </div>
  );
}
