// Task handlers: the installed package (zip, stored beside the JSON) plus its
// settings. Built-in handlers are never exported or promoted. Secret
// property values (encrypted type or secret-looking name) are never exported; plaintext values are environment-bound
// (see normalize.mjs) and only seed a first install.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pick, sortBy, isEqual } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { envKey } from '../env.mjs';
import { enc, isBuiltInHandler, isSecretProperty } from './common.mjs';
import { emptyRequiredNames } from '../http.mjs';
import { referencedDefinitionIds } from './task-refs.mjs';

const INCLUDE = { include: 'details,properties,categories' };
const PACKAGE = 'package.zip';
const FIELDS = ['definitionId', 'definitionName', 'definitionVersion', 'name', 'description', 'status', 'deferrable', 'visible'];

// A handler's package downloads byte-identical across environments (verified
// live), so comparing packageSha256 between source and target is sound.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unwrap = (r) => r?.handler ?? r;

export function normalizeHandler(raw, zip) {
  const data = {
    ...pick(raw, FIELDS),
    categories: (raw.categories ?? []).map((c) => c?.name ?? c).sort(),
    properties: sortBy(raw.properties).map((p) => {
      const out = pick(p, ['name', 'type', 'required', 'description']);
      if (!isSecretProperty(p) && p.value !== undefined) out.value = p.value;
      return out;
    }),
    packageSha256: sha256(zip),
  };
  assertNoSecretValues(raw.definitionId, data.properties);
  return data;
}

// Safety net, run on every exported handler: a secret (encrypted type or
// secret-looking name) must never reach the export with its value.
export function assertNoSecretValues(definitionId, properties) {
  for (const p of properties ?? []) {
    if (isSecretProperty(p) && p.value !== undefined) {
      throw new Error(`Handler ${definitionId}: property "${p.name}" (${p.type}) is secret (encrypted type or secret-looking name) but would be exported with its value; refusing`);
    }
  }
}

// GET /handlers is paged: { handlers, count, limit, offset }.
export async function listHandlers(client, limit = 100) {
  const out = [];
  for (let offset = 0; ; ) {
    const res = await client.get('task', '/handlers', { ...INCLUDE, limit, offset });
    const page = res?.handlers ?? [];
    out.push(...page);
    offset += page.length;
    if (page.length < limit || (typeof res?.count === 'number' && offset >= res.count)) return out;
  }
}

async function fetchPackage(client, id) {
  try {
    return await client.getBinary('task', `/handlers/${enc(id)}/zip`);
  } catch (e) {
    if (e.status === 404) return null; // built into the platform: no package
    throw e;
  }
}

function readPackage(ctx, item) {
  const file = join(ctx.exportDir, dirname(item.key), PACKAGE);
  if (!existsSync(file)) throw new Error(`${item.key}: ${file} is missing; re-run export`);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== item.desired.packageSha256) {
    throw new Error(`${item.key}: ${PACKAGE} does not match packageSha256 in handler.json; re-run export`);
  }
  return bytes;
}

function packageForm(id, bytes) {
  const form = new FormData();
  form.append('package', new Blob([bytes], { type: 'application/zip' }), `${id}.zip`);
  return form;
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const isEncryptedType = (p) => /encrypt/i.test(p?.type ?? '');
// Plaintext settings to send: never a null or missing value (the target keeps
// its own); a required one that is empty is reported by missingRequired.
const plaintext = (props) => (props ?? []).filter((p) => !isSecretProperty(p) && p.value !== undefined && p.value !== null);
const setting = (p) => ({ name: p.name, value: p.value });
// The Task API takes handler properties as a name-to-value map; an array of
// { name, value } fails with a 500 (ArrayList cannot be cast to Map).
const propertyMap = (props) => Object.fromEntries(sortBy(props).map((p) => [p.name, p.value]));

// Required properties of a target's handler that have no value, by name (kept
// in the item's meta, never in its data). The Task API refuses every settings
// write (400, "<name> may not be empty") while any required property is
// empty, even a write of other properties. Encrypted values are never read
// back, so an encrypted property's emptiness is not known here.
export function unsetRequired(raw) {
  return sortBy(raw?.properties).filter((p) => p?.name && p.required && !isEncryptedType(p) && isBlank(p.value)).map((p) => p.name);
}

// What a caller knows about a target's handlers beyond its export (the app
// keeps this per environment): `pending(definitionId, property)`, a secret
// value entered since the last accepted settings write (to send, even when
// nothing else changed); `empty(definitionId)`, required properties the
// platform last said were empty (encrypted ones are never read back).
const hintsOf = (h) => ({ pending: h?.pending ?? (() => false), empty: h?.empty ?? (() => []) });

// Required properties of the desired handler that are (or may be) empty in
// the target: read empty from it, named empty by the platform last time, or
// not in the target's copy at all (a re-installed package that adds one).
function emptyInTarget(desired, existing, hints) {
  const out = new Set(existing?.meta?.unsetRequired ?? []);
  for (const n of hintsOf(hints).empty(desired?.definitionId)) out.add(n);
  const there = new Set((existing?.data?.properties ?? []).map((p) => p?.name));
  for (const p of desired?.properties ?? []) if (p?.required && !there.has(p.name)) out.add(p.name);
  return out;
}

// Required properties that would still be empty after apply: for a new
// handler, each required one with no value to send (a secret: `has(name)`
// says whether one is supplied); for one in the target, each of those the
// target has (or may have) empty too. Sorted by name.
export function missingRequired(desired, existing, has = () => false, hints) {
  const empty = existing ? emptyInTarget(desired, existing, hints) : null;
  return sortBy(desired?.properties).filter((p) => p?.required
    && (isSecretProperty(p) ? !has(p.name) : isBlank(p.value))
    && (!existing || empty.has(p.name))).map((p) => p.name);
}

// What the plan shows when a settings write is still needed that the data
// cannot show: a required property empty in the target and in the desired
// state, or a secret value entered and not yet accepted by the target.
export const REQUIRED_UNSET = '(required, not set)';
export const NEW_SECRET = '(new value entered)';
export function unsetSettingsDiff(desired, existing, hints) {
  const there = new Set((existing?.data?.properties ?? []).map((p) => p?.name));
  const empty = emptyInTarget(desired, existing, hints);
  const { pending } = hintsOf(hints);
  const out = [];
  for (const p of sortBy(desired?.properties)) {
    if (!p?.name || !there.has(p.name)) continue; // a new property already differs
    const path = `properties[${p.name}].value`;
    if (isSecretProperty(p) && pending(desired.definitionId, p.name)) out.push({ path, from: null, to: NEW_SECRET });
    else if (p.required && empty.has(p.name) && (isSecretProperty(p) || isBlank(p.value))) out.push({ path, from: null, to: REQUIRED_UNSET });
  }
  return out;
}

// Sends the settings, unless a required one would be empty: the PUT is then
// bound to fail, so the item is reported for attention instead (the package
// is in place). A PUT the platform refuses only for empty required
// properties is reported the same way; any other failure stops the run.
// `sent` names the secret properties in `props`. Returns { settings } for
// the caller's records: whether the target accepted a write, the secrets it
// took, and the required properties still empty.
async function saveSettings(client, item, ctx, props, missing, done, sent) {
  const d = item.desired;
  const attention = (names) => {
    const To = ctx.targetLabel ?? 'the target';
    const known = new Map((d.properties ?? []).map((p) => [p.name, p]));
    const parts = {
      key: item.key, definitionId: d.definitionId,
      secrets: names.filter((n) => known.has(n) && isSecretProperty(known.get(n))),
      settings: names.filter((n) => known.has(n) && !isSecretProperty(known.get(n))),
      unknown: names.filter((n) => !known.has(n)),
    };
    const hint = typeof ctx.settingsHint === 'function' ? ctx.settingsHint(parts)
      : ctx.settingsHint ?? (parts.unknown.length ? null
        : 'or supply them and apply again: secrets as KINETIC_<ENV>_HANDLER_<DEFINITION_ID>__<PROPERTY> variables, other settings as overrides');
    const held = sent.filter((n) => !names.includes(n));
    const heldText = held.length
      ? ` ${held.join(', ')} ${held.length === 1 ? 'was' : 'were'} entered but not saved yet${ctx.heldHint ? ` (${ctx.heldHint})` : ''}.` : '';
    return {
      attention: `${done}; set ${names.join(', ')} in ${To}'s Task console${hint ? ` (${hint})` : ''}.${heldText}`,
      settings: { saved: false, sent: [], empty: [...names].sort() },
    };
  };
  if (missing.length) return attention(missing);
  if (!props.length) return { settings: { saved: false, sent: [], empty: null } };
  try {
    await client.request('task', 'PUT', `/handlers/${enc(d.definitionId)}`, { body: { properties: propertyMap(props) } });
  } catch (e) {
    const names = e?.status === 400 ? emptyRequiredNames(e.body) : null;
    if (!names) throw e;
    return attention(names);
  }
  // Accepted: the platform checked every required property.
  return { settings: { saved: true, sent: [...sent].sort(), empty: [] } };
}

// A handler's categories are promoted as workflow categories (task-categories.mjs),
// so the target's stand here: they are never a difference of the handler.
export const mergeHandler = (desired, existing) => (existing && desired && existing.categories !== undefined
  ? { ...desired, categories: existing.categories } : desired);

export default {
  type: 'handlers',
  scope: 'handler',
  owns: (key) => /^handlers\/[^/]+\/handler$/.test(key),
  mergeTargetOnly: mergeHandler,
  // Required settings empty in the target, and secrets entered since the
  // last accepted write, are a needed update (settings only).
  pendingDiff: unsetSettingsDiff,

  // Lists after workflows, WebAPIs and routines: handlers they reference that
  // are in no category are invisible to GET /handlers and fetched one by one.
  async list(client, ctx) {
    const collected = ctx.collected ?? [];
    const found = new Map((await listHandlers(client)).map((h) => [h.definitionId, h]));
    const routineIds = new Set(collected.filter((a) => a.key.startsWith('routines/')).map((a) => a.data?.definitionId));
    for (const id of [...referencedDefinitionIds(collected)].sort()) {
      if (found.has(id) || isBuiltInHandler(id) || id.startsWith('routine_') || routineIds.has(id)) continue;
      try {
        found.set(id, unwrap(await client.get('task', `/handlers/${enc(id)}`, INCLUDE)));
      } catch (e) {
        if (e.status !== 404) throw e; // not installed in this environment
      }
    }
    const out = [];
    for (const h of sortBy([...found.values()], 'definitionId')) {
      if (isBuiltInHandler(h.definitionId)) continue;
      const zip = await fetchPackage(client, h.definitionId);
      if (!zip) continue;
      const unset = unsetRequired(h);
      out.push({
        key: keyFor('handlers', h.definitionId, 'handler'),
        data: normalizeHandler(h, zip),
        meta: { definitionId: h.definitionId, ...(unset.length ? { unsetRequired: unset } : {}) },
        files: { [PACKAGE]: zip },
      });
    }
    return out;
  },

  // Returns { attention, settings } when the package is in place but required
  // settings are still empty, { settings } after a settings write or none
  // (see saveSettings), { skipped } when nothing could be sent.
  async apply(client, item, ctx) {
    const d = item.desired;
    const id = d.definitionId;
    const hints = ctx.hints?.handlers;
    const secrets = ctx.handlerSecrets?.(id) ?? {};
    const secretOf = (name) => (isBlank(secrets[envKey(name)]) ? undefined : secrets[envKey(name)]);
    const missing = missingRequired(d, item.existing, (name) => secretOf(name) !== undefined, hints);
    const sent = [];

    if (!item.existing) {
      await client.request('task', 'POST', '/handlers', { form: packageForm(id, readPackage(ctx, item)) });
      const props = plaintext(sortBy(d.properties)).map(setting);
      for (const p of sortBy(d.properties).filter(isSecretProperty)) {
        const v = secretOf(p.name);
        if (v !== undefined) { props.push({ name: p.name, value: v }); sent.push(p.name); }
        else if (!p.required) ctx.warn(`${item.key}: secret property "${p.name}" is not set; set it in the target console`);
      }
      return saveSettings(client, item, ctx, props, missing, 'Installed', sent);
    }

    // Updates never send secret values from the export: the target keeps its
    // own. A secret variable is sent after a re-install, for a required
    // property the target has (or may have) empty, and when it was entered
    // since the last accepted write (hints.pending).
    const current = item.existing.data;
    const empty = emptyInTarget(d, item.existing, hints);
    const { pending } = hintsOf(hints);
    const repackaged = d.packageSha256 !== current.packageSha256;
    if (repackaged) {
      await client.request('task', 'POST', '/handlers', { query: { force: 'true' }, form: packageForm(id, readPackage(ctx, item)) });
    }
    // After a re-upload, re-assert every plaintext value in case the new
    // package reset them; otherwise send only the plaintext values that differ.
    const props = plaintext(sortBy(d.properties)).filter((p) => repackaged
      || !isEqual(p.value, current.properties?.find((c) => c.name === p.name)?.value)).map(setting);
    for (const p of sortBy(d.properties).filter(isSecretProperty)) {
      if (!repackaged && !empty.has(p.name) && !pending(id, p.name)) continue;
      const v = secretOf(p.name);
      if (v !== undefined) { props.push({ name: p.name, value: v }); sent.push(p.name); }
      else if (repackaged && !missing.includes(p.name)) ctx.warn(`${item.key}: package re-installed; check secret property "${p.name}" in the target console`);
    }
    if (repackaged || props.length || missing.length) {
      return saveSettings(client, item, ctx, props, missing, repackaged ? 'Package installed' : 'Settings not saved', sent);
    }

    const fields = [...new Set((item.diff?.length ? item.diff.map((x) => x.path.split(/[.[]/)[0])
      : Object.keys({ ...d, ...current }).filter((k) => !isEqual(d[k], current[k]))))].sort();
    ctx.warn(`${item.key}: ${fields.join(', ')} differ but come from the package or the console; change them in the target by hand`);
    return { skipped: true };
  },

  async prune(client, existing) {
    await client.request('task', 'DELETE', `/handlers/${enc(existing.data.definitionId)}`);
  },
};
