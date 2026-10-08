// The app mark and the plain top bar used outside a project.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ThemeToggle } from './ThemeToggle';

// The Kinetic "KD" mark (drawn as shapes, so it needs no font) on Kinetic
// orange, as in the platform's favicon.
export function KineticMark({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 72 72" className="shrink-0">
      <rect width="72" height="72" rx="16" fill="var(--brand)" />
      <g fill="#fff" transform="translate(36 36.5) scale(0.86) translate(-36 -36.5)">
        <path d="M3 19h7v35H3z" />
        <path d="M25 19h9L17.5 37.5 10 44V33z" />
        <path d="M15 35.5 21 30l14.5 24H26z" />
        <path fillRule="evenodd" d="M37 19h13a17.5 17.5 0 0 1 0 35H37zm7 7v21h6a10.5 10.5 0 0 0 0-21z" />
      </g>
    </svg>
  );
}

export function BrandMark() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-lg text-header-fg" aria-label="Kinetic Migrator: all projects">
      <KineticMark />
      <span className="text-[15px] font-semibold tracking-tight whitespace-nowrap">Kinetic Migrator</span>
    </Link>
  );
}

export function PlainFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-header-border bg-header">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <BrandMark />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
