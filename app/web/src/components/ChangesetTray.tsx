// ChangesetTray: the changeset being built in Compare, always visible. The
// selected items grouped by kind (each can be taken out), the items marked
// for removal from the target in their own section, the suggestions for what
// the selected items depend on, and the actions: Review plan → and Save as
// changeset….
import { useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Layers, Save, Trash2, X } from 'lucide-react';
import { Link } from 'react-router';
import type { CompareStatus, NodeKind, Resolution, SuggestionOut } from '../../../shared/sync-api';
import { envLabel, plural } from '../lib/format';
import { ItemStatus } from './CountBar';
import { KindIcon } from './ObjectTree';
import { SuggestionsList } from './SuggestionsList';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Dialog, DialogContent } from './ui/Dialog';
import { InlineError } from './ui/EmptyState';
import { Field, Input, inputClasses } from './ui/Field';
import { Spinner } from './ui/Spinner';
import { useToastClearance } from './ui/Toast';
import { cn } from './ui/cn';

export interface TrayItem {
  key: string;
  label: string;
  kind: NodeKind;
  status: CompareStatus;
}

const GROUPS: Array<[NodeKind, string]> = [
  ['space', 'Space'], ['kapp', 'Kapps'], ['form', 'Forms'], ['data', 'Reference data'], ['workflow', 'Workflows'], ['webapi', 'WebAPIs'],
  ['connection', 'Connections'], ['operation', 'Operations'], ['handler', 'Handlers'], ['team', 'Teams'], ['model', 'Models'],
  ['file-resource', 'File resources'], ['routine', 'Routines'], ['task-category', 'Task categories'], ['other', 'Other'],
];

export interface ChangesetTrayProps {
  from: string;
  to: string;
  items: TrayItem[];
  // Items only in the target, marked for removal.
  removals?: TrayItem[];
  onUnremove?: (key: string) => void;
  resolutions: Record<string, Resolution>;
  suggestions: SuggestionOut[];
  suggestionsLoading?: boolean;
  suggestionsError?: unknown;
  onOpen: (key: string) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onAdd: (s: SuggestionOut) => void;
  onAddAll: () => void;
  onReview: () => void;
  reviewing: boolean;
  reviewError: unknown;
  onSave: (v: { name: string; description: string }) => Promise<unknown>;
  // The changeset this selection was last saved as.
  saved: { id: string; name: string; href: string } | null;
  // Keys to highlight (just added by a parent tick).
  highlight?: Set<string>;
  // Selected drifted items (their Overwrite decisions are not saved).
  overwrites?: number;
  // Hide Save as changeset… (a restore is a one-off).
  canSave?: boolean;
  // How to name the source (defaults to the From environment).
  fromLabel?: string;
}

function SaveDialog({ open, onOpenChange, count, removals, to, overwrites, onSave }: {
  open: boolean; onOpenChange: (o: boolean) => void; count: number; removals: number; to: string; overwrites: number; onSave: ChangesetTrayProps['onSave'];
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(new Error('Give the changeset a name.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), description: description.trim() });
      onOpenChange(false);
      setName('');
      setDescription('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Save as changeset"
        description={count
          ? `Keeps these ${plural(count, 'item')} as they are in the source snapshot${removals ? `, and the ${plural(removals, 'removal')}` : ''}, so you can promote the same set to each environment later.`
          : `Keeps the ${plural(removals, 'removal')} from ${envLabel(to)}, so you can plan them again later.`}
        footer={(
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" form={formId} variant="primary" loading={busy}>Save changeset</Button>
          </>
        )}
      >
        <form id={formId} onSubmit={submit} className="space-y-4">
          <Field label="Name">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Q4 forms" autoFocus />}
          </Field>
          <Field label="Description" hint="Optional. What this changeset is for.">
            {(p) => <textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} className={cn(inputClasses, 'h-auto py-2')} />}
          </Field>
          {overwrites > 0 && (
            <p className="rounded-lg bg-drift-soft px-3 py-2 text-xs text-fg">
              <span aria-hidden className="text-drift">⚠ </span>
              The Overwrite decision for {overwrites === 1 ? 'the drifted item' : `${overwrites} drifted items`} is not saved: you will be asked again when you plan this changeset.
            </p>
          )}
          <InlineError error={error} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChangesetTray(props: ChangesetTrayProps) {
  const { from, to, items, resolutions, suggestions, onOpen, onRemove, onClear, onAdd, onAddAll, onReview, reviewing, reviewError, saved } = props;
  const removals = props.removals ?? [];
  const total = items.length + removals.length;
  const To = envLabel(to);
  const [saving, setSaving] = useState(false);
  const headingId = useId();
  const footer = useRef<HTMLDivElement>(null);
  useToastClearance(footer);
  const groups = GROUPS.map(([kind, title]) => ({ kind, title, list: items.filter((i) => i.kind === kind) })).filter((g) => g.list.length);

  return (
    <aside aria-labelledby={headingId} className="flex min-h-0 flex-col border-t border-border bg-surface lg:border-t-0 lg:border-l">
      <div className="border-b border-border px-4 pt-3.5 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Layers size={15} aria-hidden className="text-accent" />
            Changeset
            <span className="rounded-full bg-surface-2 px-2 py-px text-xs font-medium text-muted tabular-nums">{total}</span>
          </h2>
          {total > 0 && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClear}>Clear</Button>}
        </div>
        <p className="mt-1 text-xs text-muted">
          {saved ? <>Saved as <Link to={saved.href} className="font-medium text-accent hover:underline">{saved.name}</Link></> : 'Unsaved'} · {props.fromLabel ?? envLabel(from)} → {envLabel(to)}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {total === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm font-medium text-fg">Nothing selected yet</p>
            <p className="mt-1 text-xs text-muted">Tick items in the tree to promote them. Ticking a group selects everything new or changed in it.</p>
          </div>
        ) : items.length === 0 ? null : (
          <div className="space-y-3">
            {groups.map((g) => (
              <section key={g.kind} aria-label={g.title}>
                <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g.title} <span className="tabular-nums">{g.list.length}</span></h3>
                <ul>
                  {g.list.map((i) => (
                    <li key={i.key} data-recent={props.highlight?.has(i.key) || undefined} className={cn('group flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-surface-2', props.highlight?.has(i.key) && 'bg-accent-soft')}>
                      <KindIcon kind={i.kind} className="text-subtle" />
                      <button type="button" onClick={() => onOpen(i.key)} className="min-w-0 flex-1 truncate text-left text-[13px] text-fg hover:underline" title={i.key}>
                        {i.label}
                      </button>
                      {i.status === 'drifted' && resolutions[i.key] === 'overwrite'
                        ? <Badge tone="drift">Overwrite</Badge>
                        : <ItemStatus status={i.status} to={to} />}
                      <button
                        type="button"
                        aria-label={`Remove ${i.label}`}
                        title="Remove"
                        onClick={() => onRemove(i.key)}
                        className="rounded p-0.5 text-subtle hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <X size={13} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {removals.length > 0 && (
          <section aria-label={`Remove from ${To}`} className="mt-3 overflow-hidden rounded-lg border border-danger/40">
            <h3 className="flex items-center gap-1.5 bg-danger-soft px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-danger uppercase">
              <Trash2 size={12} aria-hidden />Remove from {To} <span className="tabular-nums">{removals.length}</span>
            </h3>
            <ul className="py-1">
              {removals.map((i) => (
                <li key={i.key} className="group flex items-center gap-2 px-2 py-1 hover:bg-surface-2">
                  <KindIcon kind={i.kind} className="text-danger" />
                  <button type="button" onClick={() => onOpen(i.key)} className="min-w-0 flex-1 truncate text-left text-[13px] text-fg line-through decoration-danger/60 hover:underline" title={i.key}>
                    {i.label}
                  </button>
                  <Badge tone="danger"><span aria-hidden>−</span>Remove</Badge>
                  <button
                    type="button"
                    aria-label={`Keep ${i.label}`}
                    title="Keep (do not remove)"
                    onClick={() => props.onUnremove?.(i.key)}
                    className="rounded p-0.5 text-subtle hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <X size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <p className="border-t border-danger/20 px-2.5 py-1.5 text-[11px] text-muted">Deleted from {To} after everything else is applied. The plan shows what still uses them.</p>
          </section>
        )}
        {(suggestions.length > 0 || props.suggestionsLoading || Boolean(props.suggestionsError)) && (
          <div className="mt-3 px-1">
            {props.suggestionsError ? (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">Could not check dependencies: {props.suggestionsError instanceof Error ? props.suggestionsError.message : 'try again'}</p>
            ) : suggestions.length > 0 ? (
              <SuggestionsList suggestions={suggestions} onAdd={onAdd} onAddAll={onAddAll} />
            ) : (
              <p className="flex items-center gap-2 px-2 text-xs text-muted"><Spinner size={12} /> Checking dependencies…</p>
            )}
          </div>
        )}
      </div>

      <div ref={footer} className="space-y-2 border-t border-border p-3">
        <InlineError error={reviewError} />
        <Button variant="primary" className="w-full" disabled={!total} loading={reviewing} onClick={onReview}>
          {reviewing ? 'Preparing plan…' : <>Review plan <ArrowRight size={15} aria-hidden /></>}
        </Button>
        {props.canSave !== false && <Button variant="ghost" size="sm" className="w-full" disabled={!total} icon={<Save size={14} aria-hidden />} onClick={() => setSaving(true)}>
          Save as changeset…
        </Button>}
      </div>
      <SaveDialog open={saving} onOpenChange={setSaving} count={items.length} removals={removals.length} to={to} overwrites={props.overwrites ?? 0} onSave={props.onSave} />
    </aside>
  );
}
