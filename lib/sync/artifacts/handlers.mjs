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

const plaintext = (props) => (props ?? []).filter((p) => !isSecretProperty(p) && p.value !== undefined);
const setting = (p) => ({ name: p.name, value: p.value });
// The Task API takes handler properties as a name-to-value map; an array of
// { name, value } fails with a 500 (ArrayList cannot be cast to Map).
const propertyMap = (props) => Object.fromEntries(sortBy(props).map((p) => [p.name, p.value]));

// A handler's categories are promoted as workflow categories (task-categories.mjs),
// so the target's stand here: they are never a difference of the handler.
export const mergeHandler = (desired, existing) => (existing && desired && existing.categories !== undefined
  ? { ...desired, categories: existing.categories } : desired);

export default {
  type: 'handlers',
  scope: 'handler',
  owns: (key) => /^handlers\/[^/]+\/handler$/.test(key),
  mergeTargetOnly: mergeHandler,

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
      out.push({
        key: keyFor('handlers', h.definitionId, 'handler'),
        data: normalizeHandler(h, zip),
        meta: { definitionId: h.definitionId },
        files: { [PACKAGE]: zip },
      });
    }
    return out;
  },

  async apply(client, item, ctx) {
    const d = item.desired;
    const id = d.definitionId;
    const path = `/handlers/${enc(id)}`;

    if (!item.existing) {
      await client.request('task', 'POST', '/handlers', { form: packageForm(id, readPackage(ctx, item)) });
      const secrets = ctx.handlerSecrets?.(id) ?? {};
      const props = [];
      for (const p of sortBy(d.properties)) {
        if (!isSecretProperty(p)) {
          if (p.value !== undefined) props.push(setting(p));
        } else if (secrets[envKey(p.name)] !== undefined) {
          props.push({ name: p.name, value: secrets[envKey(p.name)] });
        } else {
          ctx.warn(`${item.key}: secret property "${p.name}" is not set; set it in the target console`);
        }
      }
      if (props.length) await client.request('task', 'PUT', path, { body: { properties: propertyMap(props) } });
      return;
    }

    // Updates never send secret values from the export: the target keeps its
    // own (only variables are re-sent after a re-install).
    const current = item.existing.data;
    const repackaged = d.packageSha256 !== current.packageSha256;
    if (repackaged) {
      await client.request('task', 'POST', '/handlers', { query: { force: 'true' }, form: packageForm(id, readPackage(ctx, item)) });
    }
    // After a re-upload, re-assert every plaintext value in case the new
    // package reset them, and re-send secrets that have a variable set;
    // otherwise send only the plaintext values that differ.
    const props = plaintext(sortBy(d.properties)).filter((p) => repackaged
      || !isEqual(p.value, current.properties?.find((c) => c.name === p.name)?.value)).map(setting);
    if (repackaged) {
      const secrets = ctx.handlerSecrets?.(id) ?? {};
      for (const p of sortBy(d.properties).filter(isSecretProperty)) {
        const v = secrets[envKey(p.name)];
        if (v !== undefined) props.push({ name: p.name, value: v });
        else ctx.warn(`${item.key}: package re-installed; check secret property "${p.name}" in the target console`);
      }
      props.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    if (props.length) await client.request('task', 'PUT', path, { body: { properties: propertyMap(props) } });
    if (repackaged || props.length) return;

    const fields = [...new Set((item.diff?.length ? item.diff.map((x) => x.path.split(/[.[]/)[0])
      : Object.keys({ ...d, ...current }).filter((k) => !isEqual(d[k], current[k]))))].sort();
    ctx.warn(`${item.key}: ${fields.join(', ')} differ but come from the package or the console; change them in the target by hand`);
    return { skipped: true };
  },

  async prune(client, existing) {
    await client.request('task', 'DELETE', `/handlers/${enc(existing.data.definitionId)}`);
  },
};
