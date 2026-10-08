// The readable name in one segment of an artifact key. Key segments are file
// names encoded by the engine (lib/sync/store.mjs): `%XX` escapes stand for
// characters a file name cannot hold, a literal `%` may remain, and a segment
// cut for length ends in `%~` plus 8 hex digits. decodeURIComponent would
// throw on a literal `%` (as in "100% / 2"), so only `%XX` is decoded.
const CUT = /%~[0-9a-f]{8}$/;

export function segmentLabel(segment: string): string {
  const cut = CUT.test(segment);
  const text = (cut ? segment.replace(CUT, '') : segment).replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return cut ? `${text}…` : text;
}

// Sub-collection entry keys: `<item key>#<collection>/<encoded name>`.
export const isEntryKey = (key: string): boolean => key.includes('#');
export const entryItemKey = (key: string): string => key.split('#')[0];

const WORDS: Record<string, string> = {
  spaceAttributeDefinitions: 'space attribute definition', teamAttributeDefinitions: 'team attribute definition',
  userAttributeDefinitions: 'user attribute definition', userProfileAttributeDefinitions: 'user profile attribute definition',
  kappAttributeDefinitions: 'kapp attribute definition', formAttributeDefinitions: 'form attribute definition',
  categoryAttributeDefinitions: 'category attribute definition', securityPolicyDefinitions: 'security policy definition',
  formTypes: 'form type', categories: 'category', integrations: 'integration',
};

// "hardware (category)" for `kapps/services/kapp#categories/hardware`.
export function entryLabel(key: string): string {
  const rest = key.slice(key.indexOf('#') + 1);
  const slash = rest.indexOf('/');
  const field = rest.slice(0, slash);
  return `${segmentLabel(rest.slice(slash + 1))} (${WORDS[field] ?? field})`;
}
