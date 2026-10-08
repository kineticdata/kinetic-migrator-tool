// Settings → Data & values → Environment-specific attributes: a list of rules,
// each a level, where it applies (any or one kapp, form, team or category)
// and the attribute name. Plain names in the config are rules that apply
// everywhere at their level, and are saved back the same way.
import { useEffect, useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { EnvBoundLevel, EnvBoundRule, ProjectCatalog, ProjectConfig } from '../../../../shared/api';
import { usePutConfig } from '../../api/queries';
import { Button, IconButton } from '../../components/ui/Button';
import { Card, CardFooter, CardHeader } from '../../components/ui/Card';
import { InlineError } from '../../components/ui/EmptyState';
import { inputClasses } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { CatalogHint, OptionList, formsOf, kappOf, uniq } from './catalog';

export const LEVELS: Array<{ key: EnvBoundLevel; label: string }> = [
  { key: 'space', label: 'Space' },
  { key: 'kapp', label: 'Kapp' },
  { key: 'form', label: 'Form' },
  { key: 'category', label: 'Category' },
  { key: 'team', label: 'Team' },
];

export interface RuleRow {
  level: EnvBoundLevel;
  name: string;
  kapp: string;
  form: string;
  team: string;
  category: string;
}

const WHERE: Record<EnvBoundLevel, Array<'kapp' | 'form' | 'team' | 'category'>> = {
  space: [],
  kapp: ['kapp'],
  form: ['kapp', 'form'],
  team: ['team'],
  category: ['kapp', 'category'],
};

const emptyRow = (level: EnvBoundLevel = 'kapp'): RuleRow => ({ level, name: '', kapp: '', form: '', team: '', category: '' });

export function toRuleRows(eba: ProjectConfig['envBoundAttributes']): RuleRow[] {
  const rows: RuleRow[] = [];
  for (const { key: level } of LEVELS) {
    for (const rule of eba[level] ?? []) {
      if (typeof rule === 'string') rows.push({ ...emptyRow(level), name: rule });
      else rows.push({ ...emptyRow(level), name: rule.name ?? '', kapp: rule.kapp ?? '', form: rule.form ?? '', team: rule.team ?? '', category: rule.category ?? '' });
    }
  }
  return rows;
}

// A rule with no where-parts is saved as a plain name (applies everywhere).
export function toRule(row: RuleRow): EnvBoundRule {
  const name = row.name.trim();
  const where: Record<string, string> = {};
  for (const part of WHERE[row.level]) if (row[part].trim()) where[part] = row[part].trim();
  return Object.keys(where).length ? { name, ...where } : name;
}

const isBlank = (r: RuleRow) => !r.name.trim() && WHERE[r.level].every((p) => !r[p].trim());

// A select of "Any …" plus the catalog's options, or a text box (empty means
// any) when there is no snapshot to pick from.
function WhereControl({ label, anyLabel, value, options, onChange }: {
  label: string; anyLabel: string; value: string; options: Array<{ value: string; label: string }> | null; onChange: (v: string) => void;
}) {
  if (!options) {
    return <input aria-label={label} className={inputClasses} value={value} placeholder={anyLabel} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }
  const known = options.some((o) => o.value === value);
  return (
    <select aria-label={label} className={inputClasses} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{anyLabel}</option>
      {!known && value && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function RuleEditor({ row, index, catalog, onChange, onRemove }: {
  row: RuleRow; index: number; catalog: ProjectCatalog | null; onChange: (patch: Partial<RuleRow>) => void; onRemove: () => void;
}) {
  const listId = useId();
  const n = index + 1;
  const has = Boolean(catalog?.env);
  const kapp = kappOf(catalog, row.kapp);
  const kappOptions = has ? catalog!.kapps.map((k) => ({ value: k.slug, label: k.name })) : null;
  const formOptions = has ? formsOf(catalog, row.kapp).map((f) => ({ value: f.slug, label: f.name })) : null;
  const categoryOptions = has
    ? uniq((kapp ? [kapp] : catalog!.kapps).flatMap((k) => k.categories), (c) => c.slug).map((c) => ({ value: c.slug, label: c.name }))
    : null;
  const teamOptions = has ? catalog!.teams.map((t) => ({ value: t, label: t })) : null;
  const scoped = row.level === 'kapp' || row.level === 'form' || row.level === 'category';
  const attributeNames = !catalog ? [] : scoped && kapp ? kapp.attributes[row.level as 'kapp' | 'form' | 'category'] : catalog.attributes[row.level];

  return (
    <div className="grid items-start gap-2 sm:grid-cols-[8rem_minmax(0,2fr)_minmax(0,1.4fr)_2rem]" data-rule={n}>
      <select
        aria-label={`Level for rule ${n}`}
        className={inputClasses}
        value={row.level}
        onChange={(e) => onChange({ ...emptyRow(e.target.value as EnvBoundLevel), name: row.name })}
      >
        {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
      </select>
      <div className="grid gap-2 sm:grid-cols-2">
        {row.level === 'space' && <p className="col-span-full flex h-9 items-center text-sm text-muted">The whole space</p>}
        {(row.level === 'kapp' || row.level === 'form' || row.level === 'category') && (
          <WhereControl
            label={`Kapp for rule ${n}`}
            anyLabel="Any kapp"
            value={row.kapp}
            options={kappOptions}
            onChange={(v) => onChange({ kapp: v, form: '', category: '' })}
          />
        )}
        {row.level === 'form' && (
          <WhereControl label={`Form for rule ${n}`} anyLabel="Any form" value={row.form} options={formOptions} onChange={(v) => onChange({ form: v })} />
        )}
        {row.level === 'category' && (
          <WhereControl label={`Category for rule ${n}`} anyLabel="Any category" value={row.category} options={categoryOptions} onChange={(v) => onChange({ category: v })} />
        )}
        {row.level === 'team' && (
          <WhereControl label={`Team for rule ${n}`} anyLabel="Any team" value={row.team} options={teamOptions} onChange={(v) => onChange({ team: v })} />
        )}
      </div>
      <div>
        <input
          aria-label={`Attribute for rule ${n}`}
          className={inputClasses}
          list={listId}
          value={row.name}
          placeholder="Attribute name"
          onChange={(e) => onChange({ name: e.target.value })}
          spellCheck={false}
        />
        <OptionList id={listId} values={attributeNames} />
      </div>
      <IconButton label={`Remove rule ${n}`} onClick={onRemove}><Trash2 size={15} aria-hidden /></IconButton>
    </div>
  );
}

export function AttributeRulesCard({ projectId, config, catalog }: { projectId: string; config: ProjectConfig; catalog: ProjectCatalog | null }) {
  const save = usePutConfig(projectId);
  const toast = useToast();
  const [rows, setRows] = useState<RuleRow[]>(() => toRuleRows(config.envBoundAttributes));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setRows(toRuleRows(config.envBoundAttributes)), [config]);

  const set = (i: number, patch: Partial<RuleRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () => {
    const kept = rows.filter((r) => !isBlank(r));
    if (kept.some((r) => !r.name.trim())) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const envBoundAttributes: Record<EnvBoundLevel, EnvBoundRule[]> = { space: [], kapp: [], form: [], team: [], category: [] };
    for (const r of kept) envBoundAttributes[r.level].push(toRule(r));
    save.mutate({ envBoundAttributes }, { onSuccess: () => toast.show({ tone: 'success', title: 'Environment-specific attributes saved' }) });
  };

  return (
    <Card>
      <CardHeader
        title="Environment-specific attributes"
        description="Attributes whose values differ in each environment, such as a server address. They are never copied when promoting; each environment keeps its own value."
        actions={<Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setRows((rs) => [...rs, emptyRow()])}>Add rule</Button>}
      />
      <div className="px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No attributes are environment-specific. Every attribute is promoted with its value.</p>
        ) : (
          <div className="space-y-2">
            <div className="hidden grid-cols-[8rem_minmax(0,2fr)_minmax(0,1.4fr)_2rem] gap-2 text-xs font-medium text-muted sm:grid">
              <span>Level</span><span>Where</span><span>Attribute</span><span />
            </div>
            {rows.map((r, i) => (
              <RuleEditor key={i} row={r} index={i} catalog={catalog} onChange={(p) => set(i, p)} onRemove={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="mt-3 space-y-2">
          <CatalogHint catalog={catalog} />
          {invalid && <InlineError error="Each rule needs an attribute name." />}
          <InlineError error={save.error} />
        </div>
      </div>
      <CardFooter>
        <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>Save attributes</Button>
      </CardFooter>
    </Card>
  );
}
