// Pure: explicit removals of items that are only in the target. Each key
// asked for is checked (some items can never be removed), expanded to the
// items its delete takes with it (a kapp's forms, workflows, WebAPIs and
// reference data; a form's workflows and data; a connection's operations),
// and checked for what still uses it once the plan is applied. Use is a
// warning, never a block. A removal whose target item (or anything it takes
// with it) changed since it was reviewed is not deleted.
import { compareText, hashOf, withoutEnvBound } from './normalize.mjs';
import { keySegment } from './store.mjs';
import { isBuiltInHandler } from './artifacts/common.mjs';
import { buildRelationships } from './relationships.mjs';

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

const childrenOf = (key, target) => (CONTAINER.test(key)
  ? [...target.keys()].filter((k) => k !== key && k.startsWith(folderOf(key))).sort(compareText)
  : []);

// remove: keys asked for. expected: { key: removalHash } as reviewed; a key
// with no expectation falls back to drift state (as recorded after the last
// apply). items: the plan's items (creates and updates count as users).
export function planRemovals({ modules, exported, target, remove = [], expected = {}, state = {}, config = {}, items = [], overwriteDrift = false, resolutions = {} }) {
  const errors = [];
  const warnings = [];
  const moduleFor = (k) => modules.find((m) => m.owns(k));
  const asked = [...new Set(remove)].sort(compareText);
  const ok = [];
  for (const key of asked) {
    const why = notRemovable(key, moduleFor(key));
    if (why) { errors.push(why); continue; }
    if (exported.has(key)) { errors.push(`${key}: is in the source too; only items that are only in the target can be removed`); continue; }
    ok.push(key);
  }
  // A key inside another removal's folder goes with it.
  const containers = ok.filter((k) => CONTAINER.test(k) && target.has(k));
  const inside = (k) => containers.some((c) => c !== k && k.startsWith(folderOf(c)));
  const top = ok.filter((k) => !inside(k));

  const removals = top.map((key) => {
    const mod = moduleFor(key);
    const existing = target.get(key) ?? null;
    if (!existing) {
      warnings.push(`${key}: already gone from the target`);
      return { key, type: mod.type, action: 'gone', existing: null, children: [], usedBy: [], notes: [], restore: null, hash: null };
    }
    const children = childrenOf(key, target).map((k) => ({ key: k, type: moduleFor(k)?.type ?? 'unknown', existing: target.get(k) }));
    const hash = removalHash(existing, children);
    const recorded = state[key];
    const changed = key in expected
      ? expected[key] !== hash
      : Boolean(recorded) && recorded !== hashOf(withoutEnvBound(mod.scope, existing.data, config.envBoundAttributes ?? {}, key))
        && !(overwriteDrift || resolutions[key] === 'overwrite');
    const notes = NOTES[mod.type] ? [NOTES[mod.type]] : [];
    if (changed) warnings.push(`${key}: changed in the target since it was reviewed; it is not removed`);
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
    for (const r of removals) {
      if (r.action !== 'delete') continue;
      const seen = new Map();
      for (const k of [r.key, ...r.children.map((c) => c.key)]) {
        for (const e of rel.usedBy.get(k) ?? []) {
          if (gone.has(e.key) || seen.has(e.key)) continue;
          const promoted = items.some((i) => i.key === e.key && (i.action === 'create' || i.action === 'update'));
          seen.set(e.key, { key: e.key, kind: e.kind, reason: e.reason, onlyTarget: target.has(e.key) && !exported.has(e.key) && !promoted });
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

