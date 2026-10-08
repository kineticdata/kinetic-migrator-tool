// Settings → Data & values: attributes whose values belong to each
// environment (never promoted) and the reference data copied with the
// configuration (kapp, form and the fields that identify a record).
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { DataEntry, ProjectConfig } from '../../../../shared/api';
import { useConfig, usePutConfig } from '../../api/queries';
import { Button, IconButton } from '../../components/ui/Button';
import { Card, CardFooter, CardHeader } from '../../components/ui/Card';
import { ErrorState, InlineError, LoadingState } from '../../components/ui/EmptyState';
import { Field, Input, inputClasses } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { useProjectContext } from '../../lib/project';

const LEVELS: Array<{ key: string; label: string }> = [
  { key: 'space', label: 'Space' },
  { key: 'kapp', label: 'Kapp' },
  { key: 'form', label: 'Form' },
  { key: 'team', label: 'Team' },
  { key: 'category', label: 'Category' },
];

const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const joinList = (xs: string[] | undefined): string => (xs ?? []).join(', ');

interface DataRow {
  kapp: string;
  form: string;
  key: string;
}

const attributeValues = (config: ProjectConfig): Record<string, string> =>
  Object.fromEntries(LEVELS.map((l) => [l.key, joinList(config.envBoundAttributes[l.key])]));

const toRows = (data: DataEntry[]): DataRow[] => data.map((d) => ({ kapp: d.kapp, form: d.form, key: joinList(d.key) }));

function AttributesCard({ projectId, config }: { projectId: string; config: ProjectConfig }) {
  const save = usePutConfig(projectId);
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>(() => attributeValues(config));
  useEffect(() => setValues(attributeValues(config)), [config]);

  const submit = () => {
    const envBoundAttributes: Record<string, string[]> = { ...config.envBoundAttributes };
    for (const l of LEVELS) envBoundAttributes[l.key] = splitList(values[l.key] ?? '');
    save.mutate({ envBoundAttributes }, { onSuccess: () => toast.show({ tone: 'success', title: 'Environment-specific attributes saved' }) });
  };

  return (
    <Card>
      <CardHeader
        title="Environment-specific attributes"
        description="Attributes whose values differ in each environment, such as a server address. They are never copied when promoting."
      />
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        {LEVELS.map((l) => (
          <Field key={l.key} label={`${l.label} attributes`} hint="Names separated by commas">
            {(p) => <Input {...p} value={values[l.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [l.key]: e.target.value }))} spellCheck={false} />}
          </Field>
        ))}
      </div>
      {save.error && <div className="px-5 pb-4"><InlineError error={save.error} /></div>}
      <CardFooter>
        <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>Save attributes</Button>
      </CardFooter>
    </Card>
  );
}

function ReferenceDataCard({ projectId, config }: { projectId: string; config: ProjectConfig }) {
  const save = usePutConfig(projectId);
  const toast = useToast();
  const [rows, setRows] = useState<DataRow[]>(() => toRows(config.data));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setRows(toRows(config.data)), [config]);

  const set = (i: number, patch: Partial<DataRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () => {
    const data = rows
      .filter((r) => r.kapp.trim() || r.form.trim() || r.key.trim())
      .map((r) => ({ kapp: r.kapp.trim(), form: r.form.trim(), key: splitList(r.key) }));
    if (data.some((d) => !d.kapp || !d.form || !d.key.length)) {
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
        description="Records copied along with the configuration, such as lookup lists. Each entry names a kapp, a form and the fields that identify a record."
        actions={<Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setRows((rs) => [...rs, { kapp: '', form: '', key: '' }])}>Add entry</Button>}
      />
      <div className="px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No reference data is copied. Only configuration is promoted.</p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_1.4fr_2rem] gap-2 text-xs font-medium text-muted">
              <span>Kapp</span><span>Form</span><span>Key fields</span><span />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr_2rem] items-center gap-2">
                <input aria-label={`Kapp for entry ${i + 1}`} className={inputClasses} value={r.kapp} onChange={(e) => set(i, { kapp: e.target.value })} spellCheck={false} />
                <input aria-label={`Form for entry ${i + 1}`} className={inputClasses} value={r.form} onChange={(e) => set(i, { form: e.target.value })} spellCheck={false} />
                <input aria-label={`Key fields for entry ${i + 1}`} className={inputClasses} value={r.key} placeholder="Code, Name" onChange={(e) => set(i, { key: e.target.value })} spellCheck={false} />
                <IconButton label={`Remove entry ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden /></IconButton>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-2">
          {invalid && <InlineError error="Each entry needs a kapp, a form and at least one key field." />}
          <InlineError error={save.error} />
        </div>
      </div>
      <CardFooter>
        <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>Save reference data</Button>
      </CardFooter>
    </Card>
  );
}

export function DataSettings() {
  const { project } = useProjectContext();
  const config = useConfig(project.id);
  if (config.isPending) return <LoadingState label="Loading settings…" />;
  if (config.isError) return <ErrorState title="Could not load the project settings" error={config.error} onRetry={() => config.refetch()} />;
  return (
    <div className="space-y-6">
      <AttributesCard projectId={project.id} config={config.data} />
      <ReferenceDataCard projectId={project.id} config={config.data} />
    </div>
  );
}
