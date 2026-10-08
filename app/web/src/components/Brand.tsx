// The app mark and the plain top bar used outside a project.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ThemeToggle } from './ThemeToggle';

export function BrandMark() {
  return (
    <Link to="/" className="flex items-center gap-2 rounded-lg text-fg" aria-label="kinetic-migrate: all projects">
      <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h11M11 3l4 4-4 4M20 17H9M13 13l-4 4 4 4" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight">kinetic-migrate</span>
    </Link>
  );
}

export function PlainFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <BrandMark />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
