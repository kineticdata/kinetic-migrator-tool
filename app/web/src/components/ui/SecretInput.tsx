// A write-only secret field: it never receives or renders a stored value,
// only whether one is set. What the user types is masked and is not echoed
// anywhere; the parent clears it after sending.
import { Check, CircleDashed } from 'lucide-react';
import { Field, Input } from './Field';
import { Badge } from './Badge';

export interface SecretInputProps {
  label: string;
  isSet: boolean;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
}

export function SecretInput({ label, isSet, value, onChange, hint, disabled }: SecretInputProps) {
  return (
    <Field
      label={label}
      hint={hint ?? 'Stored securely on this computer. It is never shown again.'}
      aside={isSet
        ? <Badge tone="added" icon={<Check size={12} aria-hidden />}>Set</Badge>
        : <Badge icon={<CircleDashed size={12} aria-hidden />}>Not set</Badge>}
    >
      {(p) => (
        <Input
          {...p}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          value={value}
          placeholder={isSet ? 'Type to replace the stored value' : 'Enter a value'}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
