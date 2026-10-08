// Settings → Data & values → Reference data: forms whose records are copied
// with the configuration. Each entry names a kapp and a form, which records
// (Field = Value conditions; none means all) and, optionally, the fields that
// match a record across environments.
import { useEffect, useId, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { DataEntry, DataFilterCondition, ProjectCatalog, ProjectConfig } from '../../../../shared/api';
import { usePutConfig } from '../../api/queries';
import { Button, IconButton } from '../../components/ui/Button';
import { Card, CardFooter, CardHeader } from '../../components/ui/Card';
import { InlineError } from '../../components/ui/EmptyState';
import { inputClasses } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { CatalogHint, OptionList, kappOf } from './catalog';

export interface EntryRow {
  kapp: string;
  form: string;
  filter: DataFilterCondition[];
  key: string[];
}

const splitNames = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

const MATCH_HELP = 'Fields used to find the same record in the other environment. Without them, edited records are copied as new ones.';

export const toEntryRows = (data: DataEntry[]): EntryRow[] =>
  data.map((d) => ({ kapp: d.kapp, form: d.form, filter: (d.filter ?? []).map((c) => ({ ...c })), key: [...(d.key ?? [])] }));

export function toEntry(row: EntryRow): DataEntry {
  const filter = row.filter.map((c) => ({ field: c.field.trim(), value: c.value }));
  const key = row.key.map((k) => k.trim()).filter(Boolean);
  return { kapp: row.kapp.trim(), form: row.form.trim(), ...(filter.length ? { filter } : {}), ...(key.length ? { key } : {}) };
}

const isBlank = (r: EntryRow) => !r.kapp.trim() && !r.form.trim() && !r.filter.length && !r.key.length;
const isValid = (e: DataEntry) => Boolean(e.kapp && e.form && (e.filter ?? []).every((c) => c.field && c.value.trim()));

// Picks from the catalog, or a text box when there is nothing to pick from.
function Picker({ label, value, placeholder, options, errorId, onChange }: {
  label: string; value: string; placeholder: string; options: Array<{ value: string; label: string }> | null; errorId?: string; onChange: (v: string) => void;
}) {
  const bad = Boolean(errorId) && !value.trim();
  const a11y = { 'aria-label': label, 'aria-invalid': bad || undefined, 'aria-describedby': bad ? errorId : undefined };
  if (!options) {
    return <input {...a11y} className={inputClasses} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }
  const known = options.some((o) => o.value === value);
  return (
    <select {...a11y} className={inputClasses} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {!known && value && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function MatchFields({ n, fields, value, onChange }: { n: number; fields: string[] | null; value: string[]; onChange: (v: string[]) => void }) {
  const helpId = useId();
  const [text, setText] = useState(value.join(', '));
  // Re-sync only when the value changed from outside (not while typing).
  useEffect(() => setText((t) => (splitNames(t).join('\n') === value.join('\n') ? t : value.join(', '))), [value]);
  return (
    <fieldset aria-describedby={helpId} className="space-y-1.5">
      <legend className="text-[13px] font-medium text-fg">Match records by</legend>
      <p id={helpId} className="text-xs text-muted">{MATCH_HELP}</p>
      {fields ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label={`Match fields for entry ${n}`}>
          {[...fields, ...value.filter((v) => !fields.includes(v))].map((f) => (
            <label key={f} className="flex items-center gap-1.5 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4 cursor-pointer accent-[var(--accent)]"
                checked={value.includes(f)}
                onChange={(e) => onChange(e.target.checked ? [...value, f] : value.filter((x) => x !== f))}
              />
              {f}
            </label>
          ))}
          {fields.length === 0 && value.length === 0 && <span className="text-sm text-muted">This form has no fields in the snapshot.</span>}
        </div>
      ) : (
        <input
          aria-label={`Match fields for entry ${n}`}
          className={inputClasses}
          value={text}
          placeholder="Field names separated by commas"
          onChange={(e) => {
            setText(e.target.value);
            onChange(splitNames(e.target.value));
          }}
          spellCheck={false}
        />
      )}
    </fieldset>
  );
}

function EntryEditor({ row, index, catalog, errorId, onChange, onRemove }: {
  row: EntryRow; index: number; catalog: ProjectCatalog | null; errorId?: string; onChange: (patch: Partial<EntryRow>) => void; onRemove: () => void;
}) {
  const flag = (empty: boolean) => (errorId && empty ? { 'aria-invalid': true, 'aria-describedby': errorId } : {});
  const n = index + 1;
  const fieldListId = useId();
  const has = Boolean(catalog?.env);
  const kapp = kappOf(catalog, row.kapp);
  const form = kapp?.forms.find((f) => f.slug === row.form);
  const kappOptions = has ? catalog!.kapps.map((k) => ({ value: k.slug, label: k.name })) : null;
  // A kapp the snapshot does not have: type the form slug.
  const formOptions = has && kapp ? kapp.forms.map((f) => ({ value: f.slug, label: f.name })) : null;
  const fields = form ? form.fields : null;
  const setCondition = (i: number, patch: Partial<DataFilterCondition>) =>
    onChange({ filter: row.filter.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-entry={n}>
      <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]">
        {/* Picking another kapp or form drops conditions and match fields that
            name the previous form's fields; typing a slug keeps them. */}
        <Picker
          label={`Kapp for entry ${n}`} value={row.kapp} placeholder="Choose a kapp" options={kappOptions} errorId={errorId}
          onChange={(v) => onChange(kappOptions ? { kapp: v, form: '', filter: [], key: [] } : { kapp: v })}
        />
        <Picker
          label={`Form for entry ${n}`} value={row.form} placeholder="Choose a form" options={formOptions} errorId={errorId}
          onChange={(v) => onChange(formOptions ? { form: v, filter: [], key: [] } : { form: v })}
        />
        <IconButton label={`Remove entry ${n}`} onClick={onRemove}><Trash2 size={15} aria-hidden /></IconButton>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-fg">Which records</span>
          <Button size="sm" variant="ghost" icon={<Plus size={14} aria-hidden />} onClick={() => onChange({ filter: [...row.filter, { field: '', value: '' }] })}>
            Add condition
          </Button>
        </div>
        {row.filter.length === 0 ? (
          <p className="text-sm text-muted">All records</p>
        ) : (
          <div className="space-y-2">
            {row.filter.map((c, i) => (
              <div key={i} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_2rem]">
                <input
                  aria-label={`Field for condition ${i + 1} of entry ${n}`}
                  {...flag(!c.field.trim())}
                  className={inputClasses}
                  list={fields ? fieldListId : undefined}
                  value={c.field}
                  placeholder="Field"
                  onChange={(e) => setCondition(i, { field: e.target.value })}
                  spellCheck={false}
                />
                <span className="text-center text-sm text-muted">=</span>
                <input
                  aria-label={`Value for condition ${i + 1} of entry ${n}`}
                  {...flag(!c.value.trim())}
                  className={inputClasses}
                  value={c.value}
                  placeholder="Value"
                  onChange={(e) => setCondition(i, { value: e.target.value })}
                  spellCheck={false}
                />
                <IconButton label={`Remove condition ${i + 1} of entry ${n}`} onClick={() => onChange({ filter: row.filter.filter((_, j) => j !== i) })}>
                  <X size={15} aria-hidden />
                </IconButton>
              </div>
            ))}
            <p className="text-xs text-muted">A record is copied when every condition holds.</p>
          </div>
        )}
        {fields && <OptionList id={fieldListId} values={fields} />}
      </div>

      <MatchFields n={n} fields={fields} value={row.key} onChange={(key) => onChange({ key })} />
    </div>
  );
}

export function ReferenceDataCard({ projectId, config, catalog }: { projectId: string; config: ProjectConfig; catalog: ProjectCatalog | null }) {
  const save = usePutConfig(projectId);
  const toast = useToast();
  const [rows, setRows] = useState<EntryRow[]>(() => toEntryRows(config.data));
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  // Only this card's slice: saving the other card must not reset these rows.
  const saved = JSON.stringify(config.data);
  useEffect(() => setRows(toEntryRows(JSON.parse(saved))), [saved]);

  const set = (i: number, patch: Partial<EntryRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () => {
    const data = rows.filter((r) => !isBlank(r)).map(toEntry);
    if (!data.every(isValid)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate({ data }, { onSuccess: () => toast.show({ tone: 'success', title: 'Reference data saved' }) });
  };

  return (
    <Card>
      <CardHeader
        title="Reference data"
        description="Records copied along with the configuration, such as lookup lists. Each entry names a kapp and a form, which of its records to copy and how to recognise a record in the other environment."
        actions={<Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setRows((rs) => [...rs, { kapp: '', form: '', filter: [], key: [] }])}>Add entry</Button>}
      />
      <div className="px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No reference data is copied. Only configuration is promoted.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r, i) => (
              <EntryEditor key={i} row={r} index={i} catalog={catalog} errorId={invalid && !isBlank(r) ? errorId : undefined} onChange={(p) => set(i, p)} onRemove={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="mt-3 space-y-2">
          <CatalogHint catalog={catalog} />
          {invalid && <div id={errorId}><InlineError error="Each entry needs a kapp and a form, and each condition a field and a value." /></div>}
          <InlineError error={save.error} />
        </div>
      </div>
      <CardFooter>
        <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>Save reference data</Button>
      </CardFooter>
    </Card>
  );
}
