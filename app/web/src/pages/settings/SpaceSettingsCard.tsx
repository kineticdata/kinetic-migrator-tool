// Settings → Data & values → Space settings kept per environment: which space
// settings each environment keeps for itself (envBoundSpaceFields). The
// fields that say where an environment lives are always kept and shown fixed.
// Mirrors the lists in lib/sync/env-bound.mjs.
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { ProjectConfig } from '../../../../shared/api';
import { usePutConfig } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { Card, CardFooter, CardHeader } from '../../components/ui/Card';
import { InlineError } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';

interface SpaceField { name: string; description: string }

export const DEFAULT_SPACE_FIELDS: SpaceField[] = [
  { name: 'displayType', description: "How the space's UI is shown, such as a single-page app or a redirect" },
  { name: 'displayValue', description: "Where the space's UI is served from" },
  { name: 'trustedFrameDomains', description: 'Sites allowed to show the space inside a frame' },
  { name: 'trustedResourceDomains', description: 'Sites the space may load scripts, styles and images from' },
  { name: 'allowedIps', description: 'IP addresses allowed to reach the space' },
  { name: 'allowedIpsEnabled', description: 'Whether the IP address restriction is switched on' },
];

export const OPTIONAL_SPACE_FIELDS: SpaceField[] = [
  { name: 'loginPage', description: 'The page people sign in on' },
  { name: 'resetPasswordPage', description: 'The page for resetting a password' },
  { name: 'afterLogoutPath', description: 'Where people land after signing out' },
  { name: 'defaultLocale', description: "The space's default language and region" },
  { name: 'defaultTimezone', description: "The space's default time zone" },
  { name: 'sessionInactiveLimitInSeconds', description: 'How long an idle session lasts before signing out' },
];

export const ALWAYS_KEPT_SPACE_FIELDS: SpaceField[] = [
  { name: 'name', description: "The space's name" },
  { name: 'slug', description: "The space's slug" },
  { name: 'platformComponents', description: 'Where the platform components run (UI location, task server)' },
  { name: 'bundlePath', description: "The space's bundle path" },
  { name: 'sharedBundleBase', description: 'The shared bundle base' },
];

const CHOICES = [...DEFAULT_SPACE_FIELDS, ...OPTIONAL_SPACE_FIELDS].map((f) => f.name);
const DEFAULT_NAMES = DEFAULT_SPACE_FIELDS.map((f) => f.name);

// The saved list, or the defaults from an older server that sends none.
const savedList = (config: ProjectConfig) => config.envBoundSpaceFields ?? DEFAULT_NAMES;
// In the order shown, so a save without changes writes the same list.
const ordered = (names: string[]) => CHOICES.filter((n) => names.includes(n));

function FieldCheckbox({ field, checked, disabled, onChange }: { field: SpaceField; checked: boolean; disabled?: boolean; onChange?: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)] disabled:cursor-default disabled:opacity-60"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-d`}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="min-w-0">
        <label htmlFor={id} className={`block font-mono text-[13px] text-fg ${disabled ? '' : 'cursor-pointer'}`}>{field.name}</label>
        <span id={`${id}-d`} className="block text-xs text-muted">{field.description}</span>
      </span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-xs font-medium text-muted">{title}</legend>
      <div className="grid gap-x-6 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export function SpaceSettingsCard({ projectId, config }: { projectId: string; config: ProjectConfig }) {
  const save = usePutConfig(projectId);
  const toast = useToast();
  const [kept, setKept] = useState<string[]>(() => ordered(savedList(config)));
  // Only this card's slice: saving another card must not reset these boxes.
  const saved = JSON.stringify(savedList(config));
  useEffect(() => setKept(ordered(JSON.parse(saved))), [saved]);
  const warnings = (config.warnings ?? []).filter((w) => w.includes('"envBoundSpaceFields"'));

  const toggle = (name: string, on: boolean) => setKept((list) => ordered(on ? [...list, name] : list.filter((n) => n !== name)));
  const box = (f: SpaceField) => <FieldCheckbox key={f.name} field={f} checked={kept.includes(f.name)} onChange={(on) => toggle(f.name, on)} />;

  const submit = () => {
    save.mutate({ envBoundSpaceFields: kept }, { onSuccess: () => toast.show({ tone: 'success', title: 'Space settings saved' }) });
  };

  return (
    <Card>
      <CardHeader
        title="Space settings kept per environment"
        description="Ticked settings are never overwritten when promoting: each environment keeps its own value. A space that has no value yet takes the source's. An override for the environment still wins."
      />
      <div className="space-y-5 px-5 py-4">
        <Group title="Usually different per environment">{DEFAULT_SPACE_FIELDS.map(box)}</Group>
        <Group title="Optional">{OPTIONAL_SPACE_FIELDS.map(box)}</Group>
        <Group title="Always kept">
          {ALWAYS_KEPT_SPACE_FIELDS.map((f) => <FieldCheckbox key={f.name} field={f} checked disabled />)}
        </Group>
        <p className="text-xs text-muted">These describe where each environment lives, so they are always kept and cannot be unticked.</p>
        {warnings.length ? (
          <div className="space-y-1">
            <p className="text-xs text-muted">Ignored in the project file (saving replaces the list):</p>
            {warnings.map((w) => <InlineError key={w} error={w} />)}
          </div>
        ) : null}
        <InlineError error={save.error} />
      </div>
      <CardFooter>
        <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>Save space settings</Button>
      </CardFooter>
    </Card>
  );
}
