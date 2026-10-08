// The export tree on disk: one stable JSON file per artifact, keyed by path.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { stableStringify } from './normalize.mjs';

export const MARKER = '.kinetic-sync-export';

// File names: every key segment is an item name or slug encoded so the same
// key is a valid, distinct path on Windows, macOS and Linux. The encoding is
// the same on every OS (a repository committed on one opens on the others),
// deterministic, and leaves names that are already safe unchanged:
// - `< > : " / \ | ? *`, control characters and DEL become %XX (uppercase
//   hex of the character code);
// - `%` itself becomes %25 only where it would otherwise read as an escape
//   (followed by two hex digits or by `~`), so "100% done" stays as it is;
// - a leading `.` or space and a trailing `.` or space become %2E / %20
//   (Windows drops trailing dots and spaces; `.`/`..` are special);
// - Windows device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, CONIN$,
//   CONOUT$, with or without an extension) get their first letter escaped;
// - names are NFC-normalised (macOS may hand back decomposed names);
// - a segment longer than MAX_SEGMENT_BYTES (UTF-8) is cut and ends with
//   %~ plus 8 hex digits of the SHA-256 of the full name. Only these cut
//   segments cannot be decoded back to the name (the JSON inside still holds
//   it).
// Decoding (decodeSegment) inverts every step but the cut.

export const MAX_SEGMENT_BYTES = 80;
const FORBIDDEN = /[<>:"/\\|?*\x00-\x1f\x7f]/;
const HEX2 = /^[0-9A-Fa-f]{2}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
const CUT = /%~[0-9a-f]{8}$/;

// A name Windows reserves for a device, whatever the extension: "con",
// "NUL.json", "aux .txt". Such a file or folder cannot be created there.
export const isReservedDeviceName = (name) => RESERVED.test(String(name).split('.')[0].replace(/ +$/, ''));
const esc = (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
const utf8Length = (s) => Buffer.byteLength(s, 'utf8');

export function encodeSegment(name) {
  const text = String(name).normalize('NFC');
  if (!text) return '_';
  const chars = [...text];
  const tokens = chars.map((ch, i) => {
    if (FORBIDDEN.test(ch)) return esc(ch);
    if (ch === '%') {
      const next = chars.slice(i + 1, i + 3).join('');
      return HEX2.test(next) || chars[i + 1] === '~' ? '%25' : '%';
    }
    return ch;
  });
  if (tokens[0] === '.' || tokens[0] === ' ') tokens[0] = esc(tokens[0]);
  const last = tokens.length - 1;
  if (tokens[last] === '.' || tokens[last] === ' ') tokens[last] = esc(tokens[last]);
  // Device names: the part before the first dot, trailing spaces ignored.
  if (isReservedDeviceName(text) && tokens[0].length === 1) tokens[0] = esc(tokens[0]);
  const encoded = tokens.join('');
  if (utf8Length(encoded) <= MAX_SEGMENT_BYTES) return encoded;
  const suffix = `%~${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
  let out = '';
  for (const t of tokens) {
    if (utf8Length(out + t) + suffix.length > MAX_SEGMENT_BYTES) break;
    out += t;
  }
  return out + suffix;
}

// The deprecated name of encodeSegment.
export const safeName = encodeSegment;

export const isCutSegment = (segment) => CUT.test(segment);

// The name a segment was encoded from; throws for a cut segment, whose full
// name is only in the artifact's JSON.
export function decodeSegment(segment) {
  if (isCutSegment(segment)) throw new Error(`"${segment}" is a shortened file name; the full name is only stored inside the file`);
  if (segment === '_') return '_';
  return segment.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// The name a segment encodes, or undefined for a cut segment.
export const tryDecodeSegment = (segment) => (isCutSegment(segment) ? undefined : decodeSegment(segment));

// A readable label for any segment (a cut one shows its kept start and "…").
export const segmentLabel = (segment) => (isCutSegment(segment) ? `${decodeSegment(segment.replace(CUT, ''))}…` : decodeSegment(segment));

// Segment `i` of a key, decoded: the slug or name it was built from.
export const keySegment = (key, i) => decodeSegment(String(key).split('/')[i]);

export function keyFor(...segments) {
  return segments.map(encodeSegment).join('/');
}

// Fails on two keys that would be the same path on a case-insensitive or
// normalisation-insensitive file system (Windows and macOS defaults),
// including a folder of one colliding with a folder of another. Folding
// collisions are not renamed automatically: a suffix chosen from the set of
// items would differ between environments and break matching by key.
const fold = (s) => s.normalize('NFC').toLowerCase();
const describe = (key) => key.split('/').map(segmentLabel).join(' / ');

export function assertUniqueKeys(artifacts) {
  const files = new Map();
  const dirs = new Map();
  for (const { key } of artifacts) {
    const f = fold(key);
    if (files.has(f)) {
      const other = files.get(f);
      throw new Error(other === key
        ? `Two artifacts map to the same file: ${describe(key)} (rename one of them in the source space)`
        : `Artifacts "${describe(other)}" and "${describe(key)}" differ only by case and would collide on case-insensitive file systems (Windows, macOS); rename one of them in the source space`);
    }
    files.set(f, key);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const fd = fold(dir);
      const seen = dirs.get(fd);
      if (seen === undefined) dirs.set(fd, dir);
      else if (seen !== dir) {
        throw new Error(`Folders "${describe(seen)}" and "${describe(dir)}" differ only by case and would collide on case-insensitive file systems (Windows, macOS); rename one of them in the source space`);
      }
    }
  }
}

// Removes a folder tree, retrying the transient EBUSY/EPERM errors antivirus
// and indexers cause on Windows.
export const removeTree = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// Text read from disk: a UTF-8 byte-order mark (PowerShell 5 and some editors
// write one) is dropped and CRLF line ends read as LF.
export const readText = (file) => readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

export function writeTree(dir, artifacts) {
  assertUniqueKeys(artifacts);
  if (existsSync(dir)) {
    if (readdirSync(dir).length && !existsSync(join(dir, MARKER))) {
      throw new Error(`${dir} is not empty and is not a kinetic-sync export (no ${MARKER}); refusing to overwrite it`);
    }
    removeTree(dir);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARKER), 'Generated by kinetic-sync. Do not edit by hand; re-run export.\n');
  for (const { key, data, files } of artifacts) {
    const file = join(dir, ...key.split('/')) + '.json';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stableStringify(data));
    // Binary attachments (handler packages) sit beside the artifact's JSON.
    for (const [name, bytes] of Object.entries(files ?? {})) {
      if (safeName(name) !== name || name.endsWith('.json')) throw new Error(`${key}: invalid attachment name "${name}"`);
      writeFileSync(join(dirname(file), name), bytes);
    }
  }
}

export function readTree(dir) {
  if (!existsSync(dir)) throw new Error(`No export found at ${dir}; run export first`);
  const out = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    const key = relative(dir, file).slice(0, -'.json'.length).split(sep).join('/').normalize('NFC');
    out.set(key, JSON.parse(readText(file)));
  }
  return out;
}
