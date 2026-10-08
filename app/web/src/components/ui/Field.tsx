// Form controls: labelled fields, text inputs and a switch.
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from './cn';

export const inputClasses = 'h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg shadow-card '
  + 'placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-3 focus:ring-ring disabled:opacity-60 '
  + 'aria-invalid:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputClasses, className)} {...rest} />;
});

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  aside?: ReactNode;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
  className?: string;
}

// Renders a label, the control (given its id) and a hint or error.
export function Field({ label, hint, error, aside, children, className }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-fg">{label}</label>
        {aside}
      </div>
      {children({ id, 'aria-describedby': hint || error ? noteId : undefined, 'aria-invalid': error ? true : undefined })}
      {(error || hint) && (
        <p id={noteId} className={cn('text-xs', error ? 'text-danger' : 'text-muted')}>{error || hint}</p>
      )}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, description, disabled }: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-surface-3 transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-card transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchPrimitive.Root>
      <div>
        <label htmlFor={id} className="text-[13px] font-medium text-fg">{label}</label>
        {description && <p id={`${id}-d`} className="text-xs text-muted">{description}</p>}
      </div>
    </div>
  );
}
