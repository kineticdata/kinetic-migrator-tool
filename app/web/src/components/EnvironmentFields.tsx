// The fields of an environment: name, space URL, protected flag, username
// and a write-only password. Shared by the wizard and Settings.
import type { CredentialsStatus } from '../../../shared/api';
import { Field, Input, Switch } from './ui/Field';
import { SecretInput } from './ui/SecretInput';

export interface EnvironmentDraft {
  name: string;
  url: string;
  readOnly: boolean;
  username: string;
  password: string;
}

export const emptyDraft = (name = ''): EnvironmentDraft => ({ name, url: '', readOnly: false, username: '', password: '' });

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// The server says the same (app/server/environments.ts HTTPS_REQUIRED).
export const HTTPS_REQUIRED = 'Start the address with https://. Plain http:// is only accepted for this computer (localhost, 127.0.0.1 or [::1]).';
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

// https://, or plain http:// to this computer only (credentials never cross a network in clear).
export const secureAddress = (url: string) => /^https:\/\/[^\s/]+/i.test(url) || LOOPBACK.test(url);

export function draftErrors(d: EnvironmentDraft): { name?: string; url?: string } {
  const out: { name?: string; url?: string } = {};
  if (!d.name.trim()) out.name = 'Give the environment a short name, like dev or test.';
  else if (!NAME.test(d.name)) out.name = 'Use letters, digits, - and _, starting with a letter or digit.';
  if (!d.url.trim()) out.url = 'Enter the address of the Kinetic space.';
  else if (/^http:\/\//i.test(d.url.trim()) && !secureAddress(d.url.trim())) out.url = HTTPS_REQUIRED;
  else if (!secureAddress(d.url.trim())) out.url = 'Start the address with https://';
  return out;
}

export function EnvironmentFields({ draft, onChange, nameLocked, credentials, showErrors }: {
  draft: EnvironmentDraft;
  onChange: (d: EnvironmentDraft) => void;
  nameLocked?: boolean;
  credentials: CredentialsStatus;
  showErrors?: boolean;
}) {
  const set = (patch: Partial<EnvironmentDraft>) => onChange({ ...draft, ...patch });
  const errors = showErrors ? draftErrors(draft) : {};
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <Field label="Environment name" hint={nameLocked ? undefined : 'For example dev, test or prod.'} error={errors.name}>
          {(p) => <Input {...p} value={draft.name} readOnly={nameLocked} className={nameLocked ? 'bg-surface-2 text-muted' : undefined} onChange={(e) => set({ name: e.target.value })} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Space URL" error={errors.url}>
          {(p) => <Input {...p} type="url" value={draft.url} placeholder="https://your-space.kinops.io" onChange={(e) => set({ url: e.target.value })} autoComplete="off" spellCheck={false} />}
        </Field>
      </div>
      <Switch
        checked={draft.readOnly}
        onCheckedChange={(readOnly) => set({ readOnly })}
        label="Protected"
        description="Kinetic Migrator only reads from a protected environment and never changes it."
      />
      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <Field label="Username" aside={credentials.username ? <span className="text-xs text-muted">Saved</span> : undefined}>
          {(p) => (
            <Input
              {...p}
              value={draft.username}
              placeholder={credentials.username ? 'Type to replace the saved username' : 'Space admin username'}
              onChange={(e) => set({ username: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <SecretInput label="Password" isSet={credentials.password} value={draft.password} onChange={(password) => set({ password })} />
      </div>
    </div>
  );
}
