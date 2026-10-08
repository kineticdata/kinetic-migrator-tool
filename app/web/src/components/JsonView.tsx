// JsonView: a read-only, collapsible JSON viewer with copy. Objects and
// arrays fold; big ones start folded. Expand all / Collapse all remount the
// tree with a new default; Expand all stops at a depth, and long lists show
// their first entries with "Show more", so a huge item stays responsive.
import { useState } from 'react';
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy } from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

const FOLD_OVER = 50;
const OPEN_DEPTH = 3;
export const EXPAND_ALL_DEPTH = 6;
export const PAGE = 100;

type Mode = 'auto' | 'open' | 'closed';

const sizeOf = (v: object) => (Array.isArray(v) ? v.length : Object.keys(v).length);

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-subtle">null</span>;
  if (typeof value === 'string') return <span className="break-all text-added">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-changed">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-drift">{String(value)}</span>;
  return <span className="text-subtle">{JSON.stringify(value) ?? 'undefined'}</span>;
}

function Key({ name }: { name?: string | number }) {
  if (name === undefined || typeof name === 'number') return null;
  return <><span className="text-fg">{JSON.stringify(name)}</span><span className="text-subtle">: </span></>;
}

function JsonNode({ name, value, depth, last, mode }: { name?: string | number; value: unknown; depth: number; last: boolean; mode: Mode }) {
  const isContainer = value !== null && typeof value === 'object';
  const size = isContainer ? sizeOf(value as object) : 0;
  const [open, setOpen] = useState(mode === 'open' ? depth < EXPAND_ALL_DEPTH : mode === 'closed' ? depth === 0 : depth < OPEN_DEPTH && size <= FOLD_OVER);
  const [shown, setShown] = useState(PAGE);
  const comma = last ? '' : <span className="text-subtle">,</span>;

  if (!isContainer) {
    return <div className="pl-4"><Key name={name} /><Primitive value={value} />{comma}</div>;
  }
  const arr = Array.isArray(value);
  const [l, r] = arr ? ['[', ']'] : ['{', '}'];
  if (size === 0) return <div className="pl-4"><Key name={name} /><span className="text-subtle">{l}{r}</span>{comma}</div>;
  const entries: Array<[string | number, unknown]> = arr ? (value as unknown[]).map((v, i) => [i, v]) : Object.entries(value as object);
  return (
    <div className="pl-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-ml-4 inline-flex items-center rounded text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ChevronRight size={12} aria-hidden className={cn('mr-1 text-subtle transition-transform', open && 'rotate-90')} />
        <Key name={name} />
        <span className="text-subtle">{l}</span>
        {!open && <span className="mx-1 rounded bg-surface-2 px-1 text-[11px] text-muted">{size.toLocaleString('en')} {arr ? (size === 1 ? 'item' : 'items') : (size === 1 ? 'key' : 'keys')}</span>}
        {!open && <span className="text-subtle">{r}</span>}
      </button>
      {!open && comma}
      {open && (
        <>
          <div className="border-l border-border">
            {entries.slice(0, shown).map(([k, v], i) => <JsonNode key={k} name={k} value={v} depth={depth + 1} last={i === entries.length - 1} mode={mode} />)}
            {entries.length > shown && (
              <div className="pl-4">
                <button type="button" onClick={() => setShown((n) => n + PAGE)} className="rounded px-1 font-sans text-xs font-medium text-accent hover:underline">
                  Show {Math.min(PAGE, entries.length - shown).toLocaleString('en')} more of {(entries.length - shown).toLocaleString('en')}
                </button>
              </div>
            )}
          </div>
          <div><span className="text-subtle">{r}</span>{comma}</div>
        </>
      )}
    </div>
  );
}

export function JsonView({ value, label = 'JSON' }: { value: unknown; label?: string }) {
  const [mode, setMode] = useState<{ mode: Mode; n: number }>({ mode: 'auto', n: 0 });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; nothing to do.
    }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-xs text-muted">Exactly as stored in the snapshot. Read-only.</p>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={<ChevronsUpDown size={14} aria-hidden />} title={`Opens up to ${EXPAND_ALL_DEPTH} levels`} onClick={() => setMode((m) => ({ mode: 'open', n: m.n + 1 }))}>Expand all</Button>
          <Button size="sm" variant="ghost" icon={<ChevronsDownUp size={14} aria-hidden />} onClick={() => setMode((m) => ({ mode: 'closed', n: m.n + 1 }))}>Collapse all</Button>
          <Button size="sm" variant="secondary" aria-label="Copy JSON" icon={copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <div role="region" aria-label={label} className="overflow-auto px-3 py-3 font-mono text-[12.5px] leading-5">
        <JsonNode key={mode.n} value={value} depth={0} last mode={mode.mode} />
      </div>
    </div>
  );
}
