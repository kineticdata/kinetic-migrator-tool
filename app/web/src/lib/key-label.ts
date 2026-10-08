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
