// DetailPane: one item of a snapshot, summary first, with tabs Summary /
// Relationships / JSON / History. Summaries come from the engine as sections
// of rows and lists; secret values arrive only as "•••• set" / "not set" /
// "•••• hidden" and are shown as such.
import { useId, useState, type ReactNode } from 'react';
import { ArrowUpRight, Camera, CheckCircle2, CircleDashed, GitCommitHorizontal, Lock, RotateCcw, Server, Undo2 } from 'lucide-react';
import type { ExploreItem, HistoryEvent, HistoryType, ItemHistoryEntry, RelatedItem, SummaryCard } from '../../../shared/sync-api';
import { formatDateTime, timeAgo } from '../lib/format';
import { JsonView } from './JsonView';
import { KindIcon } from './ObjectTree';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/Tabs';

export const SECRET_SET = '•••• set';
export const SECRET_NOT_SET = 'not set';
export const SECRET_HIDDEN = '•••• hidden';

// A summary value as display text, with secret states as badges.
export function SummaryValue({ value }: { value: unknown }) {
  if (value === SECRET_SET) return <Badge tone="added" icon={<Lock size={11} aria-hidden />}>{SECRET_SET}</Badge>;
  if (value === SECRET_NOT_SET) return <Badge icon={<CircleDashed size={11} aria-hidden />}>{SECRET_NOT_SET}</Badge>;
  if (value === SECRET_HIDDEN) return <Badge icon={<Lock size={11} aria-hidden />}>{SECRET_HIDDEN}</Badge>;
  if (value === null || value === undefined || value === '') return <span className="text-subtle">—</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number') return <span className="tabular-nums">{value.toLocaleString('en')}</span>;
  if (typeof value === 'string') return <span className="break-words">{value}</span>;
  return <span className="text-subtle">(details in JSON)</span>;
}

type Section = SummaryCard['sections'][number];

function RowsTable({ section }: { section: Section }) {
  return (
    <table aria-label={section.heading} className="w-full text-sm">
      <tbody className="divide-y divide-border">
        {(section.rows ?? []).map((r, i) => (
          <tr key={`${r.label}-${i}`}>
            <th scope="row" className="w-2/5 py-2 pr-4 text-left align-top font-normal text-muted">{r.label}</th>
            <td className="py-2 align-top text-fg"><SummaryValue value={r.value} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Fields arrive as "type, required"; shown as Name · Type · Required.
function FieldsTable({ section }: { section: Section }) {
  return (
    <table aria-label={section.heading} className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-subtle">
          <th scope="col" className="pb-1.5 font-medium">Name</th>
          <th scope="col" className="pb-1.5 font-medium">Type</th>
          <th scope="col" className="pb-1.5 font-medium"><span className="sr-only">Required</span></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {(section.rows ?? []).map((r, i) => {
          const parts = typeof r.value === 'string' ? r.value.split(', ').filter(Boolean) : [];
          const required = parts.includes('required');
          return (
            <tr key={`${r.label}-${i}`}>
              <td className="py-1.5 pr-4 text-fg">{r.label}</td>
              <td className="py-1.5 pr-4 font-mono text-xs text-muted">{parts.filter((p) => p !== 'required').join(', ') || '—'}</td>
              <td className="py-1.5 text-right">{required && <Badge tone="accent">Required</Badge>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ItemsList({ section }: { section: Section }) {
  return (
    <ul aria-label={section.heading} className="flex flex-wrap gap-1.5">
      {(section.items ?? []).map((item, i) => (
        <li key={i} className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[13px] text-fg">
          {typeof item === 'string' || typeof item === 'number' ? String(item) : <SummaryValue value={item} />}
        </li>
      ))}
    </ul>
  );
}

function SummarySections({ summary }: { summary: SummaryCard }) {
  if (!summary.sections.length) return <p className="text-sm text-muted">Nothing to summarize. See the JSON tab for the full item.</p>;
  return (
    <div className="space-y-4">
      {summary.sections.map((s, i) => {
        const count = s.rows?.length ?? s.items?.length ?? 0;
        return (
          <Card key={`${s.heading}-${i}`}>
            <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
              <h3 className="text-[13px] font-semibold text-fg">{s.heading}</h3>
              {s.heading !== 'Overview' && <span className="text-xs text-subtle tabular-nums">{count.toLocaleString('en')}</span>}
            </div>
            <div className="px-5 py-2">
              {s.rows ? (s.heading === 'Fields' ? <FieldsTable section={s} /> : <RowsTable section={s} />) : <div className="py-1.5"><ItemsList section={s} /></div>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function RelatedList({ title, items, empty, onOpen }: { title: string; items: RelatedItem[]; empty: string; onOpen: (key: string) => void }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="mb-2 text-[13px] font-semibold text-fg">{title} <span className="font-normal text-subtle">{items.length || ''}</span></h3>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">{empty}</p>
      ) : (
        <Card>
          <ul aria-label={title} className="divide-y divide-border">
            {items.map((r) => (
              <li key={`${r.key}-${r.reason}`}>
                <button
                  type="button"
                  onClick={() => onOpen(r.key)}
                  className="group flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><KindIcon kind={r.kind} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{r.label}</span>
                    <span className="block truncate text-xs text-muted">{r.reason}</span>
                  </span>
                  <ArrowUpRight size={14} aria-hidden className="shrink-0 text-subtle group-hover:text-accent" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

const historyKind: Partial<Record<HistoryType, { label: string; icon: typeof Camera; tone: 'neutral' | 'added' | 'drift' | 'accent' }>> = {
  snapshot: { label: 'Snapshot', icon: Camera, tone: 'neutral' },
  applied: { label: 'Promotion', icon: CheckCircle2, tone: 'added' },
  backup: { label: 'Backup', icon: Server, tone: 'neutral' },
  restore: { label: 'Restore', icon: Undo2, tone: 'accent' },
  drift: { label: 'Drift', icon: RotateCcw, tone: 'drift' },
};

function guessType(message: string): HistoryType | null {
  if (/^snapshot/i.test(message)) return 'snapshot';
  if (/^(applied|promoted)/i.test(message)) return 'applied';
  if (/^backup/i.test(message)) return 'backup';
  if (/^restor/i.test(message)) return 'restore';
  return null;
}

function HistoryList({ entries, events }: { entries: ItemHistoryEntry[]; events: HistoryEvent[] }) {
  if (!entries.length) {
    return <EmptyState icon={<GitCommitHorizontal size={20} />} title="No history yet" description="Snapshots and promotions that change this item will be listed here." className="py-10" />;
  }
  const byCommit = new Map(events.map((e) => [e.commit, e]));
  return (
    <Card>
      <ol aria-label="History" className="divide-y divide-border">
        {entries.map((h) => {
          const event = byCommit.get(h.commit);
          const type = event?.type ?? guessType(h.message);
          const kind = type ? historyKind[type] : undefined;
          const Icon = kind?.icon ?? GitCommitHorizontal;
          return (
            <li key={h.commit} className="flex items-center gap-3 px-4 py-3">
              <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><Icon size={14} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{event?.title ?? h.message}</span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                  <Badge tone={kind?.tone ?? 'neutral'}>{kind?.label ?? 'Change'}</Badge>
                  <span className="font-mono text-subtle" title="Version">{h.commit.slice(0, 7)}</span>
                </span>
              </span>
              <time dateTime={h.at} title={formatDateTime(h.at)} className="shrink-0 text-xs text-subtle">{timeAgo(h.at)}</time>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export interface DetailPaneProps {
  item: ExploreItem;
  // Project history, to name the snapshots and promotions in History.
  events: HistoryEvent[];
  onOpen: (key: string) => void;
  actions?: ReactNode;
}

export function DetailPane({ item, events, onOpen, actions }: DetailPaneProps) {
  const headingId = useId();
  const [tab, setTab] = useState('summary');
  const { uses, usedBy } = item.relationships;
  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><KindIcon kind={item.type} className="size-[18px]" /></span>
          <div className="min-w-0">
            <h2 id={headingId} className="truncate text-lg font-semibold tracking-tight text-fg">{item.label}</h2>
            <p className="mt-0.5 text-sm text-muted">{item.summary.subtitle}</p>
            <p className="mt-1 truncate font-mono text-xs text-subtle" title={item.key}>{item.key}</p>
          </div>
        </div>
        {actions}
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="px-6">
          <TabsList label="Item details">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="relationships">Relationships{uses.length + usedBy.length > 0 && <span className="ml-1.5 text-subtle tabular-nums">{uses.length + usedBy.length}</span>}</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
            <TabsTrigger value="history">History{item.history.length > 0 && <span className="ml-1.5 text-subtle tabular-nums">{item.history.length}</span>}</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-8">
          <TabsContent value="summary" className="outline-none"><SummarySections summary={item.summary} /></TabsContent>
          <TabsContent value="relationships" className="space-y-6 outline-none">
            <RelatedList title="Uses" items={uses} empty="This item doesn’t use anything else." onOpen={onOpen} />
            <RelatedList title="Used by" items={usedBy} empty="Nothing uses this item." onOpen={onOpen} />
          </TabsContent>
          <TabsContent value="json" className="outline-none"><JsonView value={item.json} /></TabsContent>
          <TabsContent value="history" className="outline-none"><HistoryList entries={item.history} events={events} /></TabsContent>
        </div>
      </Tabs>
    </section>
  );
}
