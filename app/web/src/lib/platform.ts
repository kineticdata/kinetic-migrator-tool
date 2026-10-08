// Plain words for the Kinetic Platform version an environment runs, and the
// warning shown when two environments run different major versions (the same
// words the server puts in Compare and Plan results).
import type { PlatformInfo } from '../../../shared/api';
import { envLabel } from './format';

export const platformText = (p: PlatformInfo | null | undefined): string | null => (p?.version ? `Kinetic Platform ${p.version}` : null);

export function crossVersionText(
  a: { name: string; platform?: PlatformInfo | null } | undefined,
  b: { name: string; platform?: PlatformInfo | null } | undefined,
): string | null {
  const pa = a?.platform;
  const pb = b?.platform;
  if (!a || !b || !pa || !pb || pa.major === pb.major) return null;
  return `${envLabel(a.name)} runs ${pa.version} and ${envLabel(b.name)} runs ${pb.version} — review differences carefully.`;
}
