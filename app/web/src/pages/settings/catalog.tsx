// Helpers for the Data & values pickers, fed by the project catalog (names
// from the latest snapshot). Every picker falls back to free text without one.
import type { CatalogForm, CatalogKapp, ProjectCatalog } from '../../../../shared/api';
import { envLabel } from '../../lib/format';

export const kappOf = (catalog: ProjectCatalog | null, slug: string): CatalogKapp | undefined =>
  slug ? catalog?.kapps.find((k) => k.slug === slug) : undefined;

export function uniq<T>(list: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

// The forms of one kapp, or of every kapp when none is chosen.
export function formsOf(catalog: ProjectCatalog | null, kappSlug: string): CatalogForm[] {
  if (!catalog) return [];
  const kapp = kappOf(catalog, kappSlug);
  return kapp ? kapp.forms : uniq(catalog.kapps.flatMap((k) => k.forms), (f) => f.slug);
}

export function OptionList({ id, values }: { id: string; values: string[] }) {
  return (
    <datalist id={id}>
      {values.map((v) => <option key={v} value={v} />)}
    </datalist>
  );
}

export function CatalogHint({ catalog }: { catalog: ProjectCatalog | null }) {
  return (
    <p className="text-xs text-muted">
      {catalog?.env ? `Lists come from the latest snapshot of ${envLabel(catalog.env)}.` : 'Take a snapshot to pick from lists.'}
    </p>
  );
}
