// Buttons, and link-buttons that share the same look.
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from './cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const base = 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent '
  + 'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 select-none';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg shadow-card hover:bg-primary-hover',
  secondary: 'border border-border-strong bg-surface text-fg shadow-card hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-danger-fg shadow-card hover:bg-danger-hover',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-sm',
};

export const buttonClasses = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string): string =>
  cn(base, variants[variant], sizes[size], extra);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClasses(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  );
});

export interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function LinkButton({ variant = 'secondary', size = 'md', icon, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={buttonClasses(variant, size, typeof className === 'string' ? className : undefined)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

export function IconButton({ label, className, size = 'sm', variant = 'ghost', ...rest }: ButtonProps & { label: string }) {
  return <Button aria-label={label} title={label} variant={variant} size={size} className={cn(size === 'sm' ? 'w-8 px-0' : 'w-9 px-0', className)} {...rest} />;
}
