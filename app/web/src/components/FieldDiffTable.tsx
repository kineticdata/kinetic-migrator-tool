// FieldDiffTable: what an item's promotion would change, one row per
// difference (What · <To> now · <From> incoming), with readable path labels
// and values summarised in words (the full value one click away).
// ThreeWayDiff: a drifted item — last promoted · target now · incoming — with
// the Overwrite / Keep target decision.
import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import type { DiffEntry, Resolution, ThreeWay } from '../../../shared/sync-api';
import { pathLabel, threeWayRows } from '../lib/diff';
import { fullValueText, hasFullValue, summarizeValue, type IdNames } from '../lib/value-summary';
import { envLabel, formatDateTime, timeAgo } from '../lib/format';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

// Names for connection and operation ids, per side: `target` for the target's
// values, `incoming` for the source's (ids differ between environments).
export interface DiffNames { target: IdNames; incoming: IdNames }
const NamesContext = createContext<DiffNames>({ target: {}, incoming: {} });
export const DiffNamesProvider = NamesContext.Provider;

function Value({ value, strong, side }: { value: unknown; strong?: boolean; side: keyof DiffNames }) {
  const names = useContext(NamesContext)[side];
  const [open, setOpen] = useState(false);
  const s = summarizeValue(value, names);
  const tone = strong ? 'text-fg' : 'text-muted';
  let body: ReactNode;
  if (s.kind === 'empty') body = <span className="text-subtle italic">{s.text}</span>;
  else if (s.kind === 'text') body = <span className={cn('break-words', strong && 'font-medium', tone)}>{s.text}</span>;
  else if (s.kind === 'props') {
    body = (
      <dl className={cn('space-y-0.5', tone)}>
        {s.entries.map(([k, v]) => (
          <div key={k} className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-subtle">{k}:</dt>
            <dd className={cn('min-w-0 break-words', strong && 'font-medium text-fg')}>{v}</dd>
          </div>
        ))}
      </dl>
    );
  } else if (s.items.length === 1 && s.more === 0) {
    body = <span className={cn('break-words', strong && 'font-medium', tone)}>{s.items[0]}</span>;
  } else {
    body = (
      <ul className={cn('list-disc space-y-0.5 pl-4 marker:text-subtle', tone)}>
        {s.items.map((t, i) => <li key={i} className={cn('break-words', strong && 'text-fg')}>{t}</li>)}
        {s.more > 0 && <li className="-ml-4 list-none text-subtle">and {s.more} more</li>}
      </ul>
    );
  }
  if (!hasFullValue(value, s)) return body;
  return (
    <div className="min-w-0">
      {open
        ? <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-fg">{fullValueText(value)}</pre>
        : body}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-1 block text-xs font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {open ? 'Show summary' : 'Show full value'}
      </button>
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={cn('px-4 py-2 text-left text-xs font-medium text-subtle', className)}>{children}</th>;
}

export function FieldDiffTable({ diff, from, to }: { diff: DiffEntry[]; from: string; to: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <table aria-label="Changes" className="w-full table-fixed text-sm">
        <thead className="border-b border-border bg-surface-2/60">
          <tr>
            <Th className="w-[38%]">What</Th>
            <Th>{envLabel(to)} now</Th>
            <Th>{envLabel(from)} incoming</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {diff.map((d) => (
            <tr key={d.path} className="align-top">
              <th scope="row" className="px-4 py-2.5 text-left font-normal text-fg">
                <span className="block break-words">{pathLabel(d.path)}</span>
                {d.path !== '(root)' && <span className="mt-0.5 block truncate font-mono text-[11px] text-subtle" title={d.path}>{d.path}</span>}
              </th>
              <td className="px-4 py-2.5"><Value value={d.from} side="target" /></td>
              <td className="bg-accent-soft/40 px-4 py-2.5"><Value value={d.to} strong side="incoming" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ThreeWayDiffProps {
  threeWay: ThreeWay;
  // The item's diff: target now → incoming.
  incoming: DiffEntry[];
  from: string;
  to: string;
  // The decision so far (none until one is made).
  resolution: Resolution | null;
  onResolve: (r: Resolution) => void;
}

export function ThreeWayDiff({ threeWay, incoming, from, to, resolution, onResolve }: ThreeWayDiffProps) {
  const known = threeWay.lastPromoted !== null && threeWay.lastPromoted !== undefined;
  const rows = threeWayRows(known ? threeWay.targetChanges ?? [] : [], incoming);
  const lost = rows.filter((r) => r.drifted).length;
  return (
    <section aria-label="Drift" className="overflow-hidden rounded-xl border border-drift/40 bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-drift/30 bg-drift-soft px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-drift" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">Changed in {envLabel(to)} since it was last promoted</h3>
            <p className="mt-0.5 text-[13px] text-muted">
              {known
                ? <>Last promoted <time dateTime={threeWay.lastPromotedAt ?? undefined} title={threeWay.lastPromotedAt ? formatDateTime(threeWay.lastPromotedAt) : undefined}>{timeAgo(threeWay.lastPromotedAt)}</time>. {lost > 0 ? `Overwriting replaces ${lost === 1 ? 'the change' : `${lost} changes`} made in ${envLabel(to)}.` : ''}</>
                : `There is no record of the last promotion, so only ${envLabel(to)} now and the incoming item are shown.`}
            </p>
          </div>
        </div>
        <div role="group" aria-label="Decision" className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant={resolution === 'overwrite' ? 'primary' : 'secondary'} aria-pressed={resolution === 'overwrite'} icon={resolution === 'overwrite' ? <Check size={14} aria-hidden /> : undefined} onClick={() => onResolve('overwrite')}>
            Overwrite
          </Button>
          <Button size="sm" variant={resolution === 'keep' ? 'primary' : 'secondary'} aria-pressed={resolution === 'keep'} icon={resolution === 'keep' ? <Check size={14} aria-hidden /> : undefined} onClick={() => onResolve('keep')}>
            Keep {envLabel(to)}
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">The incoming item matches {envLabel(to)} now.</p>
      ) : (
        <table aria-label="Three-way comparison" className="w-full table-fixed text-sm">
          <thead className="border-b border-border bg-surface-2/60">
            <tr>
              <Th className="w-[28%]">What</Th>
              {known && <Th>Last promoted</Th>}
              <Th>{envLabel(to)} now</Th>
              <Th>{envLabel(from)} incoming</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.path} className="align-top">
                <th scope="row" className="px-4 py-2.5 text-left font-normal text-fg">
                  <span className="block break-words">{pathLabel(r.path)}</span>
                  {r.drifted && known && <span className="mt-1 inline-flex items-center gap-1 rounded bg-drift-soft px-1.5 py-px text-[11px] font-medium text-drift"><span aria-hidden>⚠</span>changed in {envLabel(to)}</span>}
                </th>
                {known && <td className="px-4 py-2.5"><Value value={r.last} side="target" /></td>}
                <td className={cn('px-4 py-2.5', r.drifted && known && 'bg-drift-soft/50')}><Value value={r.target} strong={r.drifted && known} side="target" /></td>
                <td className="bg-accent-soft/40 px-4 py-2.5"><Value value={r.incoming} strong side="incoming" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
