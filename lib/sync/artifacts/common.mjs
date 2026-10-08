// Shared helpers for artifact modules.
import { isEqual } from '../normalize.mjs';

export { SECRET_NAME, isSecretName, isSecretProperty } from '../secrets.mjs';

export const enc = encodeURIComponent;

export async function listAll(client, api, path, field, query = {}) {
  const out = [];
  let pageToken;
  do {
    const res = await client.get(api, path, { limit: 1000, ...query, pageToken });
    out.push(...(res?.[field] ?? []));
    pageToken = res?.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

// One fetch per list context (one environment read), shared by modules.
export function cached(ctx, key, fn) {
  ctx.cache ??= new Map();
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key);
}

export const spaceExport = (client, ctx) => cached(ctx, 'space', async () => (
  await client.get('core', '/space', { export: 'true' })
).space);

export const kappExports = (client, ctx) => cached(ctx, 'kapps', async () => {
  const excluded = new Set(ctx.config.exclude.kapps);
  const out = [];
  for (const k of await listAll(client, 'core', '/kapps', 'kapps')) {
    if (excluded.has(k.slug)) continue;
    out.push((await client.get('core', `/kapps/${enc(k.slug)}`, { export: 'true' })).kapp);
  }
  return out;
});

export function isFormExcluded(ctx, kappSlug, formSlug) {
  return ctx.config.exclude.forms.includes(`${kappSlug}/${formSlug}`);
}

// Create-or-update each desired item by key. Target-only items are left alone.
export async function upsertByName(client, api, basePath, desired = [], existing = [], key = 'name') {
  for (const item of desired ?? []) {
    const cur = (existing ?? []).find((e) => e[key] === item[key]);
    if (cur && isEqual(cur, item)) continue;
    if (cur) await client.request(api, 'PUT', `${basePath}/${enc(item[key])}`, { body: item });
    else await client.request(api, 'POST', basePath, { body: item });
  }
}

export async function buildChangedIndexes(client, base, desired = [], existing = []) {
  const changed = (desired ?? [])
    .filter((d) => !isEqual(d, (existing ?? []).find((e) => e.name === d.name)))
    .map((d) => d.name);
  if (!changed.length) return;
  await client.request('core', 'POST', `${base}/backgroundJobs`, {
    body: { type: 'Build Index', content: { indexes: changed } },
  });
}

// Handlers that ship with the platform. Never exported or promoted. (A
// handler whose package download returns 404 is treated as built-in too.)
export const isBuiltInHandler = (id) => /^(utilities_|system_)/.test(String(id));

// Deletes one sub-collection entry (a removal of `<item>#<collection>/<name>`;
// see entries.mjs) through the module's own collection endpoint.
// (core unless the module names another API in `entryApi`).
export async function removeEntry(client, mod, removal) {
  const { itemKey, field, name } = removal.entry;
  await client.request(mod.entryApi ?? 'core', 'DELETE', `${mod.entryPath(itemKey, field, removal.entry)}/${enc(name)}`);
}
