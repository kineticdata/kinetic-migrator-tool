// EnvironmentValuesForm: every environment-bound value the plan touches, the
// source's value beside the target's, with the target value editable. Edits
// are saved to the target's environment values when the apply starts.
// Required values (missing in the target, with nothing set for it) are
// marked, and say so in words.
import { useId } from 'react';
import { ArrowRight } from 'lucide-react';
import type { EnvironmentValue } from '../../../shared/sync-api';
import { displayValue } from '../lib/diff';
import { envLabel } from '../lib/format';
import { valueText } from '../lib/plan';
import { Badge } from './ui/Badge';
import { inputClasses } from './ui/Field';
import { cn } from './ui/cn';

const ORIGIN: Record<EnvironmentValue['origin'], string> = {
  override: 'Saved value',
  environment: 'Environment-bound',
  attribute: 'Attribute',
  setting: 'Handler setting',
};

export interface EnvironmentValuesFormProps {
  values: EnvironmentValue[];
  from: string;
  to: string;
  edits: Record<string, string>;
  onEdit: (id: string, text: string) => void;
  missing: ReadonlySet<string>;
  errors: Record<string, string>;
}

export function EnvironmentValuesForm({ values, from, to, edits, onEdit, missing, errors }: EnvironmentValuesFormProps) {
  const uid = useId();
  if (!values.length) {
    return (
      <section aria-label="Environment values" className="rounded-xl border border-dashed border-border-strong px-5 py-6 text-center text-sm text-muted">
        Nothing in this plan depends on the environment.
      </section>
    );
  }
  return (
    <section aria-label="Environment values" className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16px_minmax(0,1.2fr)] gap-3 border-b border-border bg-surface-2/60 px-4 py-2 text-xs font-medium text-subtle md:grid">
        <span>What</span>
        <span>{envLabel(from)}</span>
        <span aria-hidden />
        <span>{envLabel(to)}</span>
      </div>
      <ul className="divide-y divide-border">
        {values.map((v, index) => {
          const text = edits[v.id] ?? valueText(v.to);
          const multiline = v.to !== null && typeof v.to === 'object';
          const isMissing = missing.has(v.id);
          const error = errors[v.id];
          const note = error ?? (isMissing ? `${envLabel(to)} has no value for this yet.` : undefined);
          const noteId = `${uid}-${index}-note`;
          const inputProps = {
            'aria-label': `${v.label} in ${envLabel(to)}`,
            'aria-required': v.required || undefined,
            'aria-invalid': error ? true : undefined,
            'aria-describedby': note ? noteId : undefined,
            value: text,
            spellCheck: false,
            placeholder: v.required ? 'Required' : 'Leave as it is',
          };
          const edited = edits[v.id] !== undefined && edits[v.id] !== valueText(v.to);
          return (
            <li key={v.id} className="grid grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16px_minmax(0,1.2fr)] md:items-start md:gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                  <span className="break-words">{v.label}</span>
                  {v.required && <Badge tone="danger">Required</Badge>}
                  {edited && <Badge tone="accent">Edited</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-subtle">{ORIGIN[v.origin]}</p>
              </div>
              <div className="min-w-0 pt-1.5 text-sm">
                <span className="mr-1 text-xs text-subtle md:hidden">{envLabel(from)}:</span>
                <span className={cn('break-words', v.from === null || v.from === undefined || v.from === '' ? 'italic text-subtle' : 'text-muted', typeof v.from === 'object' && v.from !== null && 'font-mono text-xs')}>
                  {displayValue(v.from)}
                </span>
              </div>
              <ArrowRight size={14} aria-hidden className="mt-2.5 hidden text-subtle md:block" />
              <div className="min-w-0">
                {multiline ? (
                  <textarea {...inputProps} rows={Math.min(8, text.split('\n').length + 1)} onChange={(e) => onEdit(v.id, e.target.value)} className={cn(inputClasses, 'h-auto py-2 font-mono text-xs')} />
                ) : (
                  <input {...inputProps} type="text" onChange={(e) => onEdit(v.id, e.target.value)} className={inputClasses} />
                )}
                {note && <p id={noteId} className={cn('mt-1 text-xs', error ? 'text-danger' : 'text-drift')}>{note}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
