// Pure: explicit removals of items that are only in the target. Each key
// asked for is checked (some items can never be removed), expanded to the
// items its delete takes with it (a kapp's forms, workflows, WebAPIs and
// reference data; a form's workflows and data; a connection's operations),
// and checked for what still uses it once the plan is applied. Use is a
// warning, never a block. A removal whose target item (or anything it takes
// with it) changed since it was reviewed is not deleted. A key
// `<item>#<collection>/<name>` removes one entry of an item's sub-collection
// (see entries.mjs); nothing else in the item changes.
import { compareText, hashOf } from './normalize.mjs';
import { driftedSince } from './plan.mjs';
import { keySegment } from './store.mjs';
import { isBuiltInHandler } from './artifacts/common.mjs';
import { buildRelationships } from './relationships.mjs';
import { collectionOf, collectionWord, entryUsers, findEntry, isEntryKey, parseEntryKey } from './entries.mjs';

// Keys whose delete removes everything in their folder.
const CONTAINER = /^(kapps\/[^/]+\/kapp|kapps\/[^/]+\/forms\/[^/]+\/form|connections\/[^/]+\/connection)$/;
const folderOf = (key) => `${key.slice(0, key.lastIndexOf('/'))}/`;

// Why an item can never be removed, or null.
export function notRemovable(key, mod) {
  if (!mod) return `${key}: not an item kinetic-migrate knows; it cannot be removed`;
  if (mod.type === 'space') return 'The space itself can never be removed';
  if (mod.type === 'task-refs') return `${key}: is a summary, not an item; it cannot be removed`;
  if (mod.type === 'data') return `${key}: reference data records are never removed as an item (use --prune data to delete rows)`;
  if (mod.type === 'handlers' && isBuiltInHandler(keySegment(key, 1))) return `${key}: built-in handlers (utilities_*, system_*) can never be removed`;
  if (!mod.prune) return `${key}: ${mod.type} cannot be removed`;
  return null;
}

// What restoring a removed item from the pre-apply backup cannot bring back.
const RESTORE = {
  kapps: 'Restoring from the backup recreates the kapp, its forms, workflows and reference data, but not its other submissions.',
  forms: 'Restoring from the backup recreates the form, its workflows and reference data, but not its other submissions.',
  connections: 'Restoring from the backup recreates the connection and its operations without credentials; set them again in the target.',
  handlers: 'Restoring from the backup re-installs the handler; its secret property values must be set again in the target.',
  teams: 'Restoring from the backup recreates the team without its members.',
};
export const restoreNote = (type) => RESTORE[type] ?? null;

const NOTES = {
  teams: 'Removing a team also removes its memberships; they are not kept in any snapshot.',
  kapps: 'Removing a kapp deletes all of its forms and submissions.',
  forms: 'Removing a form deletes all of its submissions.',
};

// A removal's fingerprint: the item and everything its delete takes with it.
export function removalHash(existing, children) {
  return hashOf({ item: existing?.data ?? null, children: children.map((c) => [c.key, c.existing?.data ?? null]) });
}

const ENTRY_RESTORE = {
  categories: 'Restoring from the backup recreates the category; forms are put back in it only if they are restored too.',
};

// Why an entry key can never be removed, or null.
function entryRefusal(key, moduleFor, exported) {
  const parsed = parseEntryKey(key);
  if (!parsed) return `${key}: not an entry kinetic-migrate knows; it cannot be removed`;
  const spec = collectionOf(moduleFor(parsed.itemKey), parsed.field);
  if (!spec) return `${key}: entries of ${parsed.field} cannot be removed`;
  if (findEntry(exported.get(parsed.itemKey), spec, parsed.segment)) {
    return `${key}: is in the source too; only items that are only in the target can be removed`;
  }
  return null;
}

// Why a key (an item or an entry) can never be removed, without looking at
// any environment; null when it may be.
export function removalRefusal(key, modules) {
  const moduleFor = (k) => modules.find((m) => m.owns(k));
  if (!isEntryKey(key)) return notRemovable(key, moduleFor(key));
  return entryRefusal(key, moduleFor, new Map());
}

// Whether a removal key (an item or an entry) is in a source tree.
export function removalInSource(key, exported, modules) {
  if (!isEntryKey(key)) return exported.has(key);
  const p = parseEntryKey(key);
  const spec = collectionOf(modules.find((m) => m.owns(p.itemKey)), p.field);
  return Boolean(spec && findEntry(exported.get(p.itemKey), spec, p.segment));
}

// Heuristic users relationships do not trace, by name: a team named in a
// security policy rule or an attribute value, a model a form's bridged
// resources use, a file resource named in any value. Said as "may".
const strings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
};
const labelOf = (key, data) => data?.name ?? data?.slug ?? key;
function namedUsers(world, r) {
  const out = [];
  const data = r.existing?.data ?? {};
  for (const [key, d] of world) {
    if (key === r.key) continue;
    if (r.type === 'teams' && data.name) {
      const name = data.name;
      const rules = (d?.securityPolicyDefinitions ?? [])
        .filter((p) => typeof p?.rule === 'string' && p.rule.includes(name)).map((p) => p.name);
      const attrs = [...(d?.attributes ?? [])].filter((a) => (a?.values ?? []).some((v) => v === name)).map((a) => a.name);
      if (rules.length) out.push({ key, kind: 'may-use', reason: `${labelOf(key, d)} may use team "${name}" (named in security policy ${rules.map((x) => `"${x}"`).join(', ')})` });
      else if (attrs.length) out.push({ key, kind: 'may-use', reason: `${labelOf(key, d)} may use team "${name}" (attribute ${attrs.map((x) => `"${x}"`).join(', ')})` });
    }
    if (r.type === 'models' && data.name && (d?.bridgedResources ?? []).some((b) => b?.model === data.name)) {
      out.push({ key, kind: 'uses', reason: `${labelOf(key, d)} uses model "${data.name}" in a bridged resource` });
    }
    if (r.type === 'file-resources' && data.slug && strings(d).some((v) => v === data.slug || v.includes(`fileResources/${data.slug}`) || v.includes(`/${data.slug}/`))) {
      out.push({ key, kind: 'may-use', reason: `${labelOf(key, d)} may use file resource "${data.name ?? data.slug}"` });
    }
  }
  return out;
}

const childrenOf = (key, target) => (CONTAINER.test(key)
  ? [...target.keys()].filter((k) => k !== key && k.startsWith(folderOf(key))).sort(compareText)
  : []);

// remove: keys asked for. expected: { key: removalHash } as reviewed (a
// server passes one for every key it reviewed as a delete; given at all, a
// key without a hash is never deleted). Without `expected` (the CLI), drift
// state recorded after the last apply decides. items: the plan's items
// (creates and updates count as users). sourceName names the source.
export function planRemovals({ modules, exported, target, remove = [], expected, state = {}, config = {}, items = [], overwriteDrift = false, resolutions = {}, sourceName }) {
  const errors = [];
  const warnings = [];
  const moduleFor = (k) => modules.find((m) => m.owns(k));
  const asked = [...new Set(remove)].sort(compareText);
  const ok = [];
  const stillInSource = (key) => warnings.push(`${key}: still exists in ${sourceName ?? 'the source'} — not removed`);
  for (const key of asked) {
    if (isEntryKey(key)) {
      const refused = entryRefusal(key, moduleFor, new Map());
      if (refused) errors.push(refused);
      else if (removalInSource(key, exported, modules)) stillInSource(key);
      else ok.push(key);
      continue;
    }
    const why = notRemovable(key, moduleFor(key));
    if (why) { errors.push(why); continue; }
    if (exported.has(key)) { stillInSource(key); continue; }
    ok.push(key);
  }
  // Reviewed (server): only keys reviewed as deletes, each with its hash.
  const reviewed = (key, hash) => {
    if (expected === undefined) return null;
    if (!expected[key]) return 'not reviewed as a removal';
    return expected[key] !== hash ? 'changed in the target since it was reviewed' : null;
  };
  // A key inside another removal's folder goes with it.
  const containers = ok.filter((k) => CONTAINER.test(k) && target.has(k));
  const inside = (k) => containers.some((c) => c !== k && k.startsWith(folderOf(c)));
  const top = ok.filter((k) => !inside(k));

  const removals = top.map((key) => {
    if (isEntryKey(key)) {
      const { itemKey, field, segment } = parseEntryKey(key);
      const mod = moduleFor(itemKey);
      const spec = collectionOf(mod, field);
      const entry = findEntry(target.get(itemKey)?.data, spec, segment);
      const base = { key, type: mod.type, children: [], usedBy: [], notes: [], restore: ENTRY_RESTORE[field] ?? null };
      if (!entry) {
        warnings.push(`${key}: already gone from the target`);
        return { ...base, action: 'gone', existing: null, hash: null, entry: { itemKey, field, name: null } };
      }
      const hash = hashOf({ entry });
      const why = reviewed(key, hash);
      const changed = Boolean(why);
      if (changed) warnings.push(`${key}: ${why}; it is not removed`);
      return {
        ...base, action: changed ? 'skip-drift' : 'delete', existing: { key, data: entry }, hash,
        entry: { itemKey, field, name: entry[spec.key], word: collectionWord(field) },
      };
    }
    const mod = moduleFor(key);
    const existing = target.get(key) ?? null;
    if (!existing) {
      warnings.push(`${key}: already gone from the target`);
      return { key, type: mod.type, action: 'gone', existing: null, children: [], usedBy: [], notes: [], restore: null, hash: null };
    }
    const children = childrenOf(key, target).map((k) => ({ key: k, type: moduleFor(k)?.type ?? 'unknown', existing: target.get(k) }));
    const hash = removalHash(existing, children);
    const recorded = state[key];
    const why = expected !== undefined ? reviewed(key, hash)
      : driftedSince(recorded, mod, existing.data, config, key) && !(overwriteDrift || resolutions[key] === 'overwrite') ? 'changed in the target since it was last promoted' : null;
    const changed = Boolean(why);
    const notes = NOTES[mod.type] ? [NOTES[mod.type]] : [];
    if (changed) warnings.push(`${key}: ${why}; it is not removed`);
    return { key, type: mod.type, action: changed ? 'skip-drift' : 'delete', existing, children, usedBy: [], notes, restore: restoreNote(mod.type), hash };
  });

  // What still uses each removed item once the plan is applied: the target as
  // it will be (creates and updates from the source over it), minus every
  // item that goes.
  const gone = new Set(removals.filter((r) => r.action === 'delete').flatMap((r) => [r.key, ...r.children.map((c) => c.key)]));
  if (gone.size) {
    const world = new Map([...target].map(([k, a]) => [k, a.data]));
    for (const i of items) if (i.action === 'create' || i.action === 'update') world.set(i.key, i.desired);
    const rel = buildRelationships([...world].map(([key, data]) => ({ key, data })));
    const promoted = (k) => items.some((i) => i.key === k && (i.action === 'create' || i.action === 'update'));
    const user = (e) => ({ key: e.key, kind: e.kind, reason: e.reason, onlyTarget: target.has(e.key) && !exported.has(e.key) && !promoted(e.key) });
    for (const r of removals) {
      if (r.action !== 'delete') continue;
      const seen = new Map();
      if (r.entry) {
        for (const e of entryUsers(world, r.entry.itemKey, r.entry.field, r.entry.name)) if (!gone.has(e.key)) seen.set(e.key, user(e));
      }
      for (const e of namedUsers(world, r)) if (!gone.has(e.key) && !seen.has(e.key)) seen.set(e.key, user(e));
      for (const k of [r.key, ...r.children.map((c) => c.key)]) {
        for (const e of rel.usedBy.get(k) ?? []) {
          if (gone.has(e.key) || seen.has(e.key)) continue;
          seen.set(e.key, user(e));
        }
      }
      r.usedBy = [...seen.values()].sort((a, b) => compareText(a.key, b.key));
      if (r.usedBy.length) {
        warnings.push(`${r.key}: still used by ${r.usedBy.map((u) => u.key).join(', ')}; removing it may break them`);
      }
    }
  }
  return { removals, errors, warnings };
}

