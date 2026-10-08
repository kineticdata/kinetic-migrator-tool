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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keyFor, MARKER, MARKER_TEXT, LAYOUT_VERSION, markerLayout, readTree, readText, removeTree, writeTree } from './store.mjs';
import { stableStringify } from './normalize.mjs';

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
  const kappSlug = new Map();
  const formSlug = new Map();
  const connName = new Map();
  const connById = new Map();
  for (const [k, d] of list) {
    let m;
    if ((m = /^kapps\/([^/]+)\/kapp$/.exec(k)) && str(d?.slug)) kappSlug.set(m[1], d.slug);
    if ((m = /^kapps\/([^/]+)\/forms\/([^/]+)\/form$/.exec(k)) && str(d?.slug)) formSlug.set(`${m[1]}/${m[2]}`, d.slug);
    if ((m = /^connections\/([^/]+)\/connection$/.exec(k)) && str(d?.name)) {
      connName.set(m[1], d.name);
      if (str(d.id)) connById.set(d.id, d.name);
    }
  }
  const kapp = (seg) => kappSlug.get(seg) ?? (PLAIN_SLUG.test(seg) ? seg : undefined);
  const form = (k, f) => formSlug.get(`${k}/${f}`) ?? (PLAIN_SLUG.test(f) ? f : undefined);

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
    if (['teams', 'models', 'routines'].includes(p[0]) && n === 2) return [fixed(p[0]), [str(d?.name), p[1]]];
    if (p[0] === 'connections' && n === 3 && p[2] === 'connection') return [fixed('connections'), [str(d?.name), p[1]], fixed('connection')];
    if (p[0] === 'connections' && n === 4 && p[2] === 'operations') {
      return [fixed('connections'), [connById.get(d?.connectionId) ?? connName.get(p[1]), p[1]], fixed('operations'), [str(d?.name), p[3]]];
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
    // The content must be what the old file name was made from.
    const mismatch = parts.find(([name, seg]) => legacySafeName(name) !== seg);
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
// keys that changed) and `unresolved` (old key → reason) when it was layout 1.
// (Non-enumerable, so the result still compares equal to a plain Map.)
const withInfo = (map, info) => Object.defineProperties(map, Object.fromEntries(Object.entries(info).map(([k, value]) => [k, { value }])));

export function rekeyTree(raw, layout) {
  const out = new Map();
  if (layout >= LAYOUT_VERSION) {
    for (const [k, v] of raw) out.set(k, v);
    return withInfo(out, { layout, rekeyed: new Map(), unresolved: new Map() });
  }
  const { keys, unresolved } = rekeyEntries(raw);
  const rekeyed = new Map();
  for (const [k, v] of raw) {
    const nk = keys.get(k) ?? k;
    if (nk !== k) rekeyed.set(k, nk);
    out.set(nk, v);
  }
  return withInfo(out, { layout, rekeyed, unresolved });
}

export const treeLayout = (dir) => {
  const marker = join(dir, MARKER);
  return markerLayout(existsSync(marker) ? readFileSync(marker, 'utf8') : undefined);
};

// readTree for any layout: older trees come back re-keyed from content.
export function loadTree(dir) {
  return rekeyTree(readTree(dir), existsSync(dir) ? treeLayout(dir) : LAYOUT_VERSION);
}

// Plan errors for items of an older tree that could not be re-keyed.
export function unresolvedErrors(tree, sourceName = 'the source') {
  return [...(tree?.unresolved ?? new Map())].map(([key, why]) => (
    `${key}: cannot be matched safely after the file-name layout change (${why}); take a new snapshot of ${sourceName} and choose the item again`
  ));
}

// Rewrites a layout-1 tree on disk under the new names (same bytes in every
// file; handler packages move with their handler). A tree with unresolved
// items is left as it is (it is still re-keyed on every read, and plans from
// it refuse those items). Returns what changed.
export function upgradeTree(dir) {
  if (!existsSync(dir) || treeLayout(dir) >= LAYOUT_VERSION) return { upgraded: false, rekeyed: new Map(), unresolved: new Map() };
  const raw = readTree(dir);
  const tree = rekeyTree(raw, 1);
  if (tree.unresolved.size) return { upgraded: false, rekeyed: tree.rekeyed, unresolved: tree.unresolved };
  if (tree.rekeyed.size) {
    const artifacts = [...raw].map(([oldKey, data]) => {
      const key = tree.rekeyed.get(oldKey) ?? oldKey;
      const folder = join(dir, ...oldKey.split('/').slice(0, -1));
      const files = {};
      // Attachments sit in an item's own folder (handlers/<id>/package.zip).
      if (/\/handler$/.test(oldKey) && existsSync(folder)) {
        for (const e of readdirSync(folder, { withFileTypes: true })) {
          if (e.isFile() && !e.name.endsWith('.json')) files[e.name] = readFileSync(join(folder, e.name));
        }
      }
      return { key, data, ...(Object.keys(files).length ? { files } : {}) };
    });
    const temp = `${dir}.upgrade-${process.pid}-${Date.now()}`;
    const aside = `${dir}.old-${process.pid}-${Date.now()}`;
    writeTree(temp, artifacts);
    renameSync(dir, aside);
    try {
      renameSync(temp, dir);
    } catch (err) {
      renameSync(aside, dir);
      removeTree(temp);
      throw err;
    }
    removeTree(aside);
  } else {
    writeFileSync(join(dir, MARKER), MARKER_TEXT);
  }
  return { upgraded: true, rekeyed: tree.rekeyed, unresolved: new Map() };
}

const readJsonIf = (file) => (existsSync(file) ? JSON.parse(readText(file)) : undefined);
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const CONFIG_FILE = 'kinetic-sync.config.json';

export function projectLayout(projectDir) {
  const config = readJsonIf(join(projectDir, CONFIG_FILE));
  return Number.isInteger(config?.layoutVersion) ? config.layoutVersion : 1;
}

// Upgrades a project's working tree once: every snapshot (and the legacy
// export/ folder), then the keys of state/<env>.json and overrides/<env>.json,
// and records layoutVersion in kinetic-sync.config.json. Returns a summary
// (`changed`: files were touched; `rekeyed`: union old → new; `notes`).
export function upgradeProjectLayout(projectDir) {
  const trees = [];
  const snapRoot = join(projectDir, 'snapshots');
  for (const env of existsSync(snapRoot) ? readdirSync(snapRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []) {
    trees.push({ env, dir: join(snapRoot, env) });
  }
  if (existsSync(join(projectDir, 'export'))) trees.push({ env: null, dir: join(projectDir, 'export') });
  const fromLayout = projectLayout(projectDir);
  const needed = fromLayout < LAYOUT_VERSION || trees.some((t) => treeLayout(t.dir) < LAYOUT_VERSION);
  if (!needed) return { changed: false, fromLayout, rekeyed: new Map(), notes: [] };

  const notes = [];
  const union = new Map();
  const byEnv = new Map();
  let changed = false;
  for (const t of trees) {
    const r = upgradeTree(t.dir);
    changed ||= r.upgraded;
    byEnv.set(t.env, r.rekeyed);
    for (const [o, n] of r.rekeyed) if (!union.has(o)) union.set(o, n);
    if (r.rekeyed.size) notes.push(`${t.env ? `snapshots/${t.env}` : 'export'}: ${r.rekeyed.size} item(s) renamed`);
    for (const [k, why] of r.unresolved) notes.push(`${t.env ? `snapshots/${t.env}` : 'export'}: ${k} left as it is (${why}); take a new snapshot`);
  }
  const mapFor = (env) => (k) => byEnv.get(env)?.get(k) ?? union.get(k) ?? k;
  const rekeyObject = (obj, map) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [map(k), v]));
  for (const f of jsonFiles(join(projectDir, 'state'))) {
    const file = join(projectDir, 'state', f);
    const state = readJsonIf(file) ?? {};
    const next = rekeyObject(state, mapFor(f.slice(0, -5)));
    if (stableStringify(next) !== stableStringify(state)) { writeFileSync(file, stableStringify(next)); changed = true; notes.push(`state/${f}: re-keyed`); }
  }
  for (const f of jsonFiles(join(projectDir, 'overrides'))) {
    const file = join(projectDir, 'overrides', f);
    const raw = readJsonIf(file) ?? {};
    if (!raw.artifacts || typeof raw.artifacts !== 'object') continue;
    const next = { ...raw, artifacts: rekeyObject(raw.artifacts, mapFor(f.slice(0, -5))) };
    if (stableStringify(next) !== stableStringify(raw)) { writeFileSync(file, stableStringify(next)); changed = true; notes.push(`overrides/${f}: re-keyed`); }
  }
  // Recorded once every tree is upgraded; a tree left behind (unresolved
  // items) is tried again next time.
  const configFile = join(projectDir, CONFIG_FILE);
  const allUpgraded = trees.every((t) => treeLayout(t.dir) >= LAYOUT_VERSION);
  if (allUpgraded && fromLayout < LAYOUT_VERSION && (existsSync(configFile) || changed)) {
    const config = readJsonIf(configFile) ?? {};
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, stableStringify({ ...config, layoutVersion: LAYOUT_VERSION }));
    changed = true;
  }
  return { changed, fromLayout, rekeyed: union, notes };
}
