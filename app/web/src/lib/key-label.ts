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
// Only the space, kapps and workflow categories (their handlers and routines)
// have entries; other keys may contain '#' in a name, and so may a Task
// category's (mirrors lib/sync/entries.mjs).
const ENTRY = /^(space|kapps\/[^/#]+\/kapp|task-categories\/[^/]+)#([^/#]+)\/(.+)$/;
export const isEntryKey = (key: string): boolean => ENTRY.test(key);
export const entryItemKey = (key: string): string => ENTRY.exec(key)?.[1] ?? key;

const WORDS: Record<string, string> = {
  spaceAttributeDefinitions: 'space attribute definition', teamAttributeDefinitions: 'team attribute definition',
  userAttributeDefinitions: 'user attribute definition', userProfileAttributeDefinitions: 'user profile attribute definition',
  kappAttributeDefinitions: 'kapp attribute definition', formAttributeDefinitions: 'form attribute definition',
  categoryAttributeDefinitions: 'category attribute definition', securityPolicyDefinitions: 'security policy definition',
  formTypes: 'form type', categories: 'category', integrations: 'integration', handlers: 'handler', routines: 'routine',
};

// "hardware (category)" for `kapps/services/kapp#categories/hardware`.
export function entryLabel(key: string): string {
  const m = ENTRY.exec(key);
  if (!m) return segmentLabel(key);
  const [, , field, name] = m;
  return `${segmentLabel(name)} (${WORDS[field] ?? field})`;
}
