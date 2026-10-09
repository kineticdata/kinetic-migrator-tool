// Layout 1 → 2: the file-name encoding changed (see store.mjs encodeSegment),
// so keys of older trees differ for names with characters Windows forbids,
// device names, leading/trailing dots or spaces and long names. Old keys are
// never matched against new ones: every older tree is re-keyed from its
// content (the same name, slug, event and id fields the exporter builds keys
// from), on read (loadTree, and readTreeAt in the server) and once on disk
// (upgradeTree, upgradeProjectLayout). An item whose key cannot be derived
// from its content with certainty is "unresolved": it keeps its old key and
// every plan that reads it refuses with an error, so nothing is ever created
// or pruned on a guess.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { markerOmitted } from './omitted.mjs';
import { encodeSegment, keyFor, MARKER, MARKER_TEXT, LAYOUT_VERSION, markerLayout, readTree, readText } from './store.mjs';
import { stableStringify } from './normalize.mjs';
import { normalizeConnection } from './artifacts/connections.mjs';

export { LAYOUT_VERSION };

// The encoding of layout 1 (kept to check a name against its old file name).
export function legacySafeName(name) {
  const cleaned = String(name).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/^\./, '_').trim();
  return cleaned || '_';
}

// Kinetic slugs are letters, digits, "-" and "_": the old file name of such
// a slug is the slug itself.
const PLAIN_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

// Re-keys the entries (old key → data) of a layout-1 tree. Returns the new
// key of every entry it could derive (`keys`: old → new, including unchanged
// ones) and the ones it could not (`unresolved`: old key → reason).
export function rekeyEntries(entries) {
  const list = [...entries];
  const connById = new Map();
  // A name is found under its old file name and its new one: an upgrade that
  // was interrupted leaves some items moved and some not.
  // The segment an item actually sits under is authoritative; its other
  // spellings are added only where no other item claims them, and a spelling
  // two items claim is dropped (an item under it is then unresolved, never
  // guessed). A pristine layout-1 tree resolves by actual segments alone.
  const spellings = (name) => (name === undefined ? [] : [legacySafeName(name), encodeSegment(name)]);
  const lookup = (entries) => {
    const actual = new Map(entries.map(([seg, name]) => [seg, name]));
    const alt = new Map();
    const clash = new Set();
    for (const [seg, name, alts] of entries) {
      for (const a of alts) {
        if (a === seg || actual.has(a)) continue;
        if (alt.has(a) && alt.get(a) !== name) clash.add(a);
        alt.set(a, name);
      }
    }
    for (const a of clash) alt.delete(a);
    return { get: (seg) => (actual.has(seg) ? actual.get(seg) : alt.has(seg) ? alt.get(seg) : clash.has(seg) ? null : undefined) };
  };
  const kappEntries = [];
  const connEntries = [];
  for (const [k, d] of list) {
    let m;
    if ((m = /^kapps\/([^/]+)\/kapp$/.exec(k)) && str(d?.slug)) kappEntries.push([m[1], d.slug, spellings(d.slug)]);
    if ((m = /^connections\/([^/]+)\/connection$/.exec(k)) && str(d?.name)) {
      connEntries.push([m[1], d.name, spellings(d.name)]);
      if (str(d.id)) connById.set(d.id, d.name);
    }
  }
  const kapps = lookup(kappEntries);
  const conns = lookup(connEntries);
  // null: a clash, so no fallback to the segment itself either.
  const kapp = (seg) => { const v = kapps.get(seg); return v === null ? undefined : v ?? (PLAIN_SLUG.test(seg) ? seg : undefined); };
  const formEntries = [];
  for (const [k, d] of list) {
    const m = /^kapps\/([^/]+)\/forms\/([^/]+)\/form$/.exec(k);
    if (!m || !str(d?.slug)) continue;
    const kn = kapp(m[1]);
    const kSpell = [m[1], ...spellings(kn)];
    formEntries.push([`${m[1]}/${m[2]}`, d.slug, kSpell.flatMap((ks) => [m[2], ...spellings(d.slug)].map((fs) => `${ks}/${fs}`))]);
  }
  const forms = lookup(formEntries);
  const form = (k, f) => { const v = forms.get(`${k}/${f}`); return v === null ? undefined : v ?? (PLAIN_SLUG.test(f) ? f : undefined); };

  // Each derivation: [fixed or derived name, old segment it must match] pairs.
  const derive = (key, d) => {
    const p = key.split('/');
    const n = p.length;
    const fixed = (s) => [s, s];
    if (key === 'space' || key === 'task-refs') return [fixed(key)];
    if (p[0] === 'kapps' && n === 3 && p[2] === 'kapp') return [fixed('kapps'), [str(d?.slug) ?? kapp(p[1]), p[1]], fixed('kapp')];
    if (p[0] === 'kapps' && n >= 5 && p[2] === 'forms') {
      const base = [fixed('kapps'), [kapp(p[1]), p[1]], fixed('forms')];
      if (n === 5 && p[4] === 'form') return [...base, [str(d?.slug) ?? form(p[1], p[3]), p[3]], fixed('form')];
      if (n === 5 && p[4] === 'data') return [...base, [form(p[1], p[3]), p[3]], fixed('data')];
      if (n === 7 && p[4] === 'workflows') return [...base, [form(p[1], p[3]), p[3]], fixed('workflows'), [str(d?.event), p[5]], [str(d?.name), p[6]]];
      return null;
    }
    if (p[0] === 'kapps' && n === 5 && p[2] === 'workflows') return [fixed('kapps'), [kapp(p[1]), p[1]], fixed('workflows'), [str(d?.event), p[3]], [str(d?.name), p[4]]];
    if (p[0] === 'kapps' && n === 4 && p[2] === 'webapis') return [fixed('kapps'), [kapp(p[1]), p[1]], fixed('webapis'), [str(d?.slug), p[3]]];
    if (p[0] === 'workflows' && n === 3) return [fixed('workflows'), [str(d?.event), p[1]], [str(d?.name), p[2]]];
    if (p[0] === 'webapis' && n === 2) return [fixed('webapis'), [str(d?.slug), p[1]]];
    if (p[0] === 'file-resources' && n === 2) return [fixed('file-resources'), [str(d?.slug), p[1]]];
    if (['teams', 'models', 'routines', 'task-categories'].includes(p[0]) && n === 2) return [fixed(p[0]), [str(d?.name), p[1]]];
    if (p[0] === 'connections' && n === 3 && p[2] === 'connection') return [fixed('connections'), [str(d?.name), p[1]], fixed('connection')];
    if (p[0] === 'connections' && n === 4 && p[2] === 'operations') {
      return [fixed('connections'), [connById.get(d?.connectionId) ?? conns.get(p[1]) ?? undefined, p[1]], fixed('operations'), [str(d?.name), p[3]]];
    }
    if (p[0] === 'handlers' && n === 3 && p[2] === 'handler') return [fixed('handlers'), [str(d?.definitionId), p[1]], fixed('handler')];
    return null;
  };

  const keys = new Map();
  const unresolved = new Map();
  for (const [key, d] of list) {
    const parts = derive(key, d);
    if (!parts) {
      unresolved.set(key, 'not a known kind of item');
      continue;
    }
    const missing = parts.findIndex(([name]) => name === undefined);
    if (missing >= 0) {
      unresolved.set(key, `its name or slug cannot be read from the file (segment "${parts[missing][1]}")`);
      continue;
    }
    // The content must be what the file name was made from: by the old
    // encoding, or by the new one for an item an interrupted upgrade moved.
    const mismatch = parts.find(([name, seg]) => legacySafeName(name) !== seg && encodeSegment(name) !== seg);
    if (mismatch) {
      unresolved.set(key, `its content ("${mismatch[0]}") does not match its file name ("${mismatch[1]}")`);
      continue;
    }
    keys.set(key, keyFor(...parts.map(([name]) => name)));
  }
  // Two old items that now map to one key cannot both be kept.
  const byNew = new Map();
  for (const [oldKey, newKey] of keys) byNew.set(newKey, [...(byNew.get(newKey) ?? []), oldKey]);
  for (const olds of byNew.values()) {
    if (olds.length < 2) continue;
    for (const o of olds) {
      keys.delete(o);
      unresolved.set(o, `it maps to the same file as ${olds.filter((x) => x !== o).join(', ')}`);
    }
  }
  return { keys, unresolved };
}

// A re-keyed tree: a Map like readTree's, plus `rekeyed` (old → new key, for
// keys that changed) and `unresolved` (old key → reason) when it was layout 1,
// and `omitted` (what its export left out, from the marker; see omitted.mjs).
// (Non-enumerable, so the result still compares equal to a plain Map.)
const withInfo = (map, info) => Object.defineProperties(map, Object.fromEntries(Object.entries(info).map(([k, value]) => [k, { value }])));

// Every tree read (loadTree, and readTreeAt in the server) strips connection
// credentials again, so a snapshot taken before a credential was stripped at
// export (a SQL connection's config.password) plans, compares, applies and
// restores exactly like a new one: the stored value is never sent.
const CONNECTION = /^connections\/[^/]+\/connection$/;
const onRead = (key, data) => (CONNECTION.test(key) && data && typeof data === 'object' ? normalizeConnection(data) : data);

export function rekeyTree(raw, layout, omitted = []) {
  const out = new Map();
  if (layout >= LAYOUT_VERSION) {
    for (const [k, v] of raw) out.set(k, onRead(k, v));
    return withInfo(out, { layout, rekeyed: new Map(), unresolved: new Map(), omitted });
  }
  const { keys, unresolved } = rekeyEntries(raw);
  const rekeyed = new Map();
  for (const [k, v] of raw) {
    const nk = keys.get(k) ?? k;
    if (nk !== k) rekeyed.set(k, nk);
    out.set(nk, onRead(nk, v));
  }
  return withInfo(out, { layout, rekeyed, unresolved, omitted });
}

const markerText = (dir) => {
  const marker = join(dir, MARKER);
  return existsSync(marker) ? readFileSync(marker, 'utf8') : undefined;
};
export const treeLayout = (dir) => markerLayout(markerText(dir));

// readTree for any layout: older trees come back re-keyed from content.
export function loadTree(dir) {
  const tree = readTree(dir);
  return rekeyTree(tree, existsSync(dir) ? treeLayout(dir) : LAYOUT_VERSION, markerOmitted(markerText(dir)));
}

// Plan errors for items of an older tree that could not be re-keyed.
export function unresolvedErrors(tree, sourceName = 'the source') {
  return [...(tree?.unresolved ?? new Map())].map(([key, why]) => (
    `${key}: cannot be matched safely after the file-name layout change (${why}); take a new snapshot of ${sourceName} and choose the item again`
  ));
}

// ---- Upgrading on disk ---------------------------------------------------
// Crash-safe by construction: files are moved one by one inside the tree
// (each rename is atomic), so the tree's folder is never missing, and every
// mapping is derived from file content (an item already moved is recognised
// under its new name), so re-running after any interruption carries on where
// it stopped. A tree's marker says layout 2 only once all its files moved.

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Renames, retrying for about two seconds on Windows while antivirus or the
// indexer holds a file (the upgrade runs once, so a short blocking wait is
// acceptable here).
export function renameRetrying(from, to, { rename = renameSync, platform = process.platform, sleep = pause } = {}) {
  for (let i = 1; ; i++) {
    try {
      return rename(from, to);
    } catch (err) {
      if (platform !== 'win32' || i >= 8 || !TRANSIENT.has(err?.code)) throw err;
      sleep(Math.min(50 * 2 ** (i - 1), 500));
    }
  }
}

// Writes a small file through a temporary sibling and a rename.
function writeAtomic(file, text, ops) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  try {
    renameRetrying(temp, file, ops);
  } catch (err) {
    // Never left behind (inside snapshots/ or state/ it would be committed).
    rmSync(temp, { force: true });
    throw err;
  }
}

function removeEmptyDirs(dir, root) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(join(dir, e.name), root);
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}

// Plans the upgrade of one tree: its re-keying, from content. `moves` lists
// the files to rename (old key → new key, only the ones that change).
export function planTree(dir) {
  if (!existsSync(dir) || treeLayout(dir) >= LAYOUT_VERSION) return { dir, current: true, rekeyed: new Map(), unresolved: new Map() };
  const raw = readTree(dir);
  const tree = rekeyTree(raw, 1);
  return { dir, current: false, rekeyed: tree.rekeyed, unresolved: tree.unresolved };
}

// Applies a planned tree upgrade in place. A tree with unresolved items is
// left as it is (it is re-keyed on every read, and plans from it refuse those
// items); a tree with nothing to rename keeps its layout-1 marker (re-keying
// it on read changes nothing), so no file changes at all.
// `renaming`: the tree is known to need renames (an interrupted run may have
// done them all already); its marker is then brought to layout 2.
export function applyTree(plan, ops = {}, renaming = plan.rekeyed.size > 0) {
  if (plan.current || plan.unresolved.size || !renaming) return { moved: 0 };
  const { dir } = plan;
  const path = (key) => join(dir, ...key.split('/'));
  let moved = 0;
  // A name's new file can be another name's old one ("a%3Ab" for "a:b" is
  // the old file of the literal name "a%3Ab"): move the blocking one first.
  const pending = new Map([...plan.rekeyed].filter(([o]) => existsSync(`${path(o)}.json`)));
  const order = [];
  while (pending.size) {
    const next = [...pending].find(([, n]) => !pending.has(n));
    if (!next) throw new Error(`${dir}: file names that would replace each other in a cycle; take a new snapshot instead`);
    order.push(next);
    pending.delete(next[0]);
  }
  for (const [oldKey, newKey] of order) {
    const src = `${path(oldKey)}.json`;
    const dst = `${path(newKey)}.json`;
    if (!existsSync(src)) continue; // moved by an earlier, interrupted run
    if (existsSync(dst)) throw new Error(`${dir}: both ${oldKey} and ${newKey} exist; remove one and try again`);
    mkdirSync(dirname(dst), { recursive: true });
    renameRetrying(src, dst, ops);
    moved++;
    // Attachments sit in an item's own folder (handlers/<id>/package.zip).
    const from = dirname(src);
    const to = dirname(dst);
    if (/\/handler$/.test(oldKey) && from !== to && existsSync(from)) {
      for (const e of readdirSync(from, { withFileTypes: true })) {
        if (e.isFile() && !e.name.endsWith('.json')) renameRetrying(join(from, e.name), join(to, e.name), ops);
      }
    }
  }
  removeEmptyDirs(dir, dir);
  writeAtomic(join(dir, MARKER), MARKER_TEXT, ops);
  return { moved };
}

// Upgrades one tree (pinned trees materialised for a plan).
export function upgradeTree(dir, ops = {}) {
  const plan = planTree(dir);
  const { moved } = applyTree(plan, ops);
  return { upgraded: moved > 0, rekeyed: plan.rekeyed, unresolved: plan.unresolved };
}

const readJsonIf = (file) => (existsSync(file) ? JSON.parse(readText(file)) : undefined);
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const CONFIG_FILE = 'kinetic-sync.config.json';
// Local, never committed (plans/ is git-ignored): the upgrade's progress, and
// a note that a project with nothing to rename has been checked.
const JOURNAL = join('plans', 'layout-upgrade.json');
const CHECKED = join('plans', 'layout-checked');

export function projectLayout(projectDir) {
  const config = readJsonIf(join(projectDir, CONFIG_FILE));
  if (Number.isInteger(config?.layoutVersion)) return config.layoutVersion;
  return existsSync(join(projectDir, CHECKED)) ? LAYOUT_VERSION : 1;
}

// Upgrades a project's working tree once: every snapshot (and the legacy
// export/ folder), the keys of state/<env>.json and overrides/<env>.json, and
// records layoutVersion in kinetic-sync.config.json when anything changed.
//  1. Every tree's re-keying is computed first, from its layout-1 content,
//     and saved in a journal under plans/ (git-ignored) before anything else
//     is written. A re-run uses the journal, never a mapping recomputed from
//     half-moved trees.
//  2. state/ and overrides/ are re-keyed from their original content (also
//     kept in the journal), so a file rewritten twice comes out the same.
//  3. Trees are moved in place, one file at a time (see applyTree).
//  4. The version is recorded and the journal removed.
// Re-running after an interruption at any step finishes the job. A project
// with nothing to rename gets no file changes, only a note under plans/.
// Returns { changed, fromLayout, rekeyed (union old → new), notes }.
export function upgradeProjectLayout(projectDir, ops = {}) {
  const fromLayout = projectLayout(projectDir);
  const journalFile = join(projectDir, JOURNAL);
  const nothing = { changed: false, fromLayout, rekeyed: new Map(), notes: [] };
  if (fromLayout >= LAYOUT_VERSION && !existsSync(journalFile)) return nothing;
  const trees = [];
  const snapRoot = join(projectDir, 'snapshots');
  for (const env of existsSync(snapRoot) ? readdirSync(snapRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []) {
    trees.push({ env, dir: join(snapRoot, env) });
  }
  if (existsSync(join(projectDir, 'export'))) trees.push({ env: null, dir: join(projectDir, 'export') });
  const envId = (env) => env ?? '';

  // 1. Plan everything (or take the plan of an interrupted run).
  const plans = trees.map((t) => ({ ...t, ...planTree(t.dir) }));
  const notes = [];
  for (const p of plans) {
    for (const [k, why] of p.unresolved) notes.push(`${p.env ? `snapshots/${p.env}` : 'export'}: ${k} left as it is (${why}); take a new snapshot`);
  }
  let journal = readJsonIf(journalFile);
  if (!journal) {
    const maps = Object.fromEntries(plans.filter((p) => p.rekeyed.size).map((p) => [envId(p.env), [...p.rekeyed]]));
    if (!Object.keys(maps).length) {
      // Nothing to rename anywhere: remember that, locally, and change nothing.
      if (!plans.some((p) => p.unresolved.size)) writeAtomic(join(projectDir, CHECKED), `${LAYOUT_VERSION}\n`, ops);
      return { ...nothing, notes };
    }
    const files = [
      ...jsonFiles(join(projectDir, 'state')).map((f) => `state/${f}`),
      ...jsonFiles(join(projectDir, 'overrides')).map((f) => `overrides/${f}`),
    ];
    journal = { maps, files, done: [], originals: {} };
    writeAtomic(journalFile, stableStringify(journal), ops);
  }
  const saveJournal = () => writeAtomic(journalFile, stableStringify(journal), ops);
  const byEnv = new Map(Object.entries(journal.maps).map(([env, list]) => [env, new Map(list)]));
  const union = new Map();
  for (const m of byEnv.values()) for (const [o, n] of m) if (!union.has(o)) union.set(o, n);
  let changed = false;

  // 2. state/ and overrides/, each from its original content.
  const mapFor = (env) => (k) => byEnv.get(env)?.get(k) ?? union.get(k) ?? k;
  const rekeyObject = (obj, map) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [map(k), v]));
  // Only the files that existed when the journal was made: one written later
  // (by an apply while a tree waits on unresolved items) already has
  // today's keys.
  const files = journal.files.map((rel) => {
    const [dir, f] = rel.split('/');
    return { rel, env: f.slice(0, -5), field: dir === 'overrides' ? 'artifacts' : null };
  });
  for (const f of files) {
    if (!existsSync(join(projectDir, ...f.rel.split('/'))) && !(f.rel in journal.originals)) continue;
    if (journal.done.includes(f.rel)) continue;
    const file = join(projectDir, ...f.rel.split('/'));
    if (!(f.rel in journal.originals)) {
      journal.originals[f.rel] = readJsonIf(file) ?? {};
      saveJournal();
    }
    const raw = journal.originals[f.rel];
    const next = f.field
      ? (raw[f.field] && typeof raw[f.field] === 'object' ? { ...raw, [f.field]: rekeyObject(raw[f.field], mapFor(f.env)) } : raw)
      : rekeyObject(raw, mapFor(f.env));
    if (stableStringify(next) !== stableStringify(readJsonIf(file) ?? {})) writeAtomic(file, stableStringify(next), ops);
    if (stableStringify(next) !== stableStringify(raw)) notes.push(`${f.rel}: re-keyed`);
    changed = true;
    journal.done.push(f.rel);
    delete journal.originals[f.rel];
    saveJournal();
  }

  // 3. The trees. Moves follow each file's current content (an item already
  // moved is recognised under its new name), so a half-moved tree finishes.
  for (const p of plans) {
    const { moved } = applyTree(p, ops, p.rekeyed.size > 0 || byEnv.has(envId(p.env)));
    if (moved) notes.push(`${p.env ? `snapshots/${p.env}` : 'export'}: ${moved} item(s) renamed`);
    changed = true;
  }

  // 4. Done unless a tree was left behind (it is tried again next time).
  if (plans.some((p) => p.unresolved.size)) return { changed, fromLayout, rekeyed: union, notes };
  const configFile = join(projectDir, CONFIG_FILE);
  const config = readJsonIf(configFile) ?? {};
  if (config.layoutVersion !== LAYOUT_VERSION) writeAtomic(configFile, stableStringify({ ...config, layoutVersion: LAYOUT_VERSION }), ops);
  writeAtomic(join(projectDir, CHECKED), `${LAYOUT_VERSION}\n`, ops);
  rmSync(journalFile, { force: true });
  return { changed: true, fromLayout, rekeyed: union, notes };
}
