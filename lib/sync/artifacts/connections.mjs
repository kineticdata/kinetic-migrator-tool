// Integrator connections and operations. Ids are kept identical across
// environments because forms and workflows reference them by UUID.
// Existing connections are never written: a PUT/PATCH carrying masked secrets
// would permanently wipe the target's credentials.
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { cached, enc, isSecretName } from './common.mjs';
import { AUTH_SECRET_FIELDS, CONFIG_SECRET_FIELDS, configSecretField } from '../secrets.mjs';

export function stripSecrets(auth) {
  if (!auth) return auth;
  return Object.fromEntries(Object.entries(auth).filter(([k]) => !isSecretName(k)));
}

// Header names that carry credentials: the whole name or its last
// `-`/`_`-separated part (Authorization, X-Api-Key, X-Auth-Token), but not
// names that merely contain one (X-Token-Expiry).
const SECRET_HEADER = /(^|[-_])(authorization|api[-_]?key|token|secret|password)$/i;
const isLiteralSecretHeader = ([k, v]) => SECRET_HEADER.test(k) && typeof v === 'string' && !v.includes('{{');

export function stripSecretHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(Object.entries(headers).filter((e) => !isLiteralSecretHeader(e)));
}

// Config paths (["auth", "token"], ["password"]) from an Integrator 400
// "Missing field" schema error.
export function missingConfigFields(err) {
  if (err?.status !== 400 || typeof err.body !== 'string') return [];
  let parsed;
  try { parsed = JSON.parse(err.body); } catch { return []; }
  return (parsed?.validationErrors ?? [])
    .filter((v) => /^Missing field/.test(v?.error ?? ''))
    .map((v) => /^\/config((?:\/[A-Za-z0-9_]+)+)$/.exec(v?.path ?? '')?.[1].split('/').slice(1))
    .filter(Boolean);
}

// Auth field names from an Integrator 400 "Missing field" schema error.
export const missingAuthFields = (err) => missingConfigFields(err)
  .filter((p) => p.length === 2 && p[0] === 'auth').map((p) => p[1]);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Removes secret-named keys anywhere in a connection's config outside auth
// (stripped by stripSecrets) and headers (stripSecretHeaders): SQL
// connections keep their password at config.password. Returns the config
// and the dotted paths removed.
// A connection string with a password in it (scheme://user:password@host).
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s:]*:[^/?#@\s]+@/i;

function stripConfigSecrets(config) {
  const stripped = [];
  const value = (v, at) => (isObject(v) ? walk(v, at) : Array.isArray(v) ? v.map((x, i) => value(x, [...at, String(i)])) : v);
  const walk = (obj, path) => Object.fromEntries(Object.entries(obj).flatMap(([k, v]) => {
    const at = [...path, k];
    if (!path.length && (k === 'auth' || k === 'headers')) return [[k, v]];
    // Masked (null) or not, a credential's key is dropped and named, so an
    // old snapshot holding the value and a new one reading null agree. A
    // secret-named list of values goes whole.
    const secretValue = isSecretName(k) && !isObject(v) && !(Array.isArray(v) && v.some(isObject));
    if (secretValue || (typeof v === 'string' && URL_WITH_PASSWORD.test(v))) { if (v !== undefined) stripped.push(at.join('.')); return []; }
    return [[k, value(v, at)]];
  }));
  return { config: walk(config, []), stripped };
}

// The config paths of a connection's credentials outside config.auth: the
// ones its export stripped (recorded in `strippedSecrets`) and its type's
// documented ones.
export function configSecretPaths(d) {
  const type = String(d?.config?.configType ?? d?.type ?? '');
  return [...new Set([...(CONFIG_SECRET_FIELDS[type] ?? []), ...(Array.isArray(d?.strippedSecrets) ? d.strippedSecrets : [])])].sort();
}

// The secret field names a new connection needs in the target: the auth
// type's secret field, any secret-named auth field still present, and each
// credential outside auth (by configSecretField of its path).
export function connectionSecretFields(d) {
  const auth = isObject(d?.config?.auth) ? d.config.auth : null;
  const fields = new Set(AUTH_SECRET_FIELDS[String(auth?.authType ?? '')] ?? []);
  for (const k of Object.keys(auth ?? {})) if (isSecretName(k)) fields.add(k);
  for (const p of configSecretPaths(d)) fields.add(configSecretField(p.split('.')));
  return [...fields].sort();
}

// Idempotent: also run on content read back from older snapshots, so a
// credential captured before it was stripped is never compared or shown.
export function normalizeConnection(raw) {
  const c = stripMeta(omit(raw, ['status', 'secrets', 'operations']));
  if (c.config?.auth) c.config = { ...c.config, auth: stripSecrets(c.config.auth) };
  if (c.config?.headers) c.config = { ...c.config, headers: stripSecretHeaders(c.config.headers) };
  if (isObject(c.config)) {
    const { config, stripped } = stripConfigSecrets(c.config);
    c.config = config;
    const all = [...new Set([...(Array.isArray(c.strippedSecrets) ? c.strippedSecrets : []), ...stripped])].sort();
    if (all.length) c.strippedSecrets = all;
  }
  return c;
}

const setPath = (obj, path, value) => {
  let o = obj;
  for (const k of path.slice(0, -1)) o = (o[k] = isObject(o[k]) ? { ...o[k] } : Array.isArray(o[k]) ? [...o[k]] : {});
  o[path[path.length - 1]] = value;
};

// Records the names (never the values) of stripped headers so apply can keep
// the target's own values for them.
export function normalizeOperation(raw) {
  const op = stripMeta(omit(raw, ['status']));
  const headers = op.config?.headers;
  if (headers && typeof headers === 'object') {
    const stripped = Object.entries(headers).filter(isLiteralSecretHeader).map(([k]) => k).sort();
    op.config = { ...op.config, headers: stripSecretHeaders(headers) };
    if (stripped.length) op.strippedHeaders = stripped;
  }
  return op;
}

const exports = (client, ctx) => cached(ctx, 'connections', async () => {
  const out = [];
  for (const c of sortBy(await client.get('integrator', '/connections'))) {
    const r = await client.get('integrator', `/export/connections/${enc(c.id)}`);
    out.push(r?.connection ?? r);
  }
  return out;
});

const connections = {
  type: 'connections',
  scope: null,
  updatable: false,
  owns: (key) => /^connections\/[^/]+\/connection$/.test(key),
  // What compare and plan diffs see: never a credential, even from a
  // snapshot taken before it was stripped.
  // strippedSecrets (names only) is bookkeeping for create, never a difference.
  redact: (d) => omit(normalizeConnection(d), ['strippedSecrets']),

  async list(client, ctx) {
    return (await exports(client, ctx)).map((c) => ({
      key: keyFor('connections', c.name, 'connection'), data: normalizeConnection(c), meta: { id: c.id },
    }));
  },

  async apply(client, item, ctx) {
    if (item.existing) throw new Error(`${item.key}: connections are never updated automatically`);
    const { strippedSecrets, ...d } = item.desired;
    const secrets = { ...ctx.connectionSecrets(d.name) };
    const config = isObject(d.config) ? { ...d.config } : d.config;
    // Credentials outside auth (a SQL connection's password) go back to their
    // own path; the rest are auth fields. A connection with no credential
    // outside auth always gets an auth object, as before.
    if (isObject(config)) {
      const paths = configSecretPaths(item.desired);
      for (const p of paths) {
        const field = configSecretField(p.split('.'));
        if (!(field in secrets)) continue;
        setPath(config, p.split('.'), secrets[field]);
        delete secrets[field];
      }
      if (!paths.length || isObject(config.auth)) config.auth = { ...config.auth, ...secrets };
    }
    // The import schema requires some secret fields (e.g. `token` for
    // raw_bearer_token, `password` for a SQL connection). When no secret was
    // supplied, send an empty value for each field the server reports
    // missing, so the connection exists and the credential can be set in the
    // target afterwards.
    for (let attempt = 0; ; attempt++) {
      try {
        await client.request('integrator', 'POST', '/import/connections', { body: { ...d, config, operations: [] } });
        return;
      } catch (err) {
        const has = (path) => path.reduce((o, k) => (isObject(o) && k in o ? o[k] : undefined), config) !== undefined;
        // Only credentials (any auth field, or a secret-named field elsewhere):
        // a missing plain setting is a real error.
        const credential = (p) => (p[0] === 'auth' && p.length === 2) || isSecretName(p[p.length - 1]);
        const missing = isObject(config) ? missingConfigFields(err).filter((p) => credential(p) && !has(p)) : [];
        if (!missing.length || attempt >= 5) throw err;
        for (const p of missing) {
          setPath(config, p, '');
          ctx.warn?.(p[0] === 'auth' && p.length === 2
            ? `${item.key}: created with an empty auth "${p[1]}"; set it in the target`
            : `${item.key}: created with an empty "${p.join('.')}"; set it in the target`);
        }
      }
    }
  },

  async prune(client, existing) {
    await client.request('integrator', 'DELETE', `/connections/${enc(existing.meta.id)}`);
  },
};

const operations = {
  type: 'operations',
  scope: null,
  owns: (key) => /^connections\/[^/]+\/operations\/[^/]+$/.test(key),

  async list(client, ctx) {
    const out = [];
    for (const c of await exports(client, ctx)) {
      for (const op of sortBy(c.operations)) {
        out.push({
          key: keyFor('connections', c.name, 'operations', op.name),
          data: normalizeOperation(op),
          meta: { id: op.id, connectionId: c.id },
        });
      }
    }
    return out;
  },

  async apply(client, item, ctx) {
    const { strippedHeaders = [], ...op } = item.desired;
    const cid = enc(op.connectionId);
    if (item.existing) {
      const path = `/connections/${cid}/operations/${enc(item.existing.meta.id)}`;
      // Keep the target's own credential headers, which were never exported.
      if (strippedHeaders.length) {
        const r = await client.get('integrator', path);
        const current = (r?.operation ?? r)?.config?.headers ?? {};
        const kept = Object.fromEntries(strippedHeaders.filter((n) => n in current).map((n) => [n, current[n]]));
        op.config = { ...op.config, headers: { ...op.config?.headers, ...kept } };
      }
      await client.request('integrator', 'PUT', path, { body: op });
      return;
    }
    for (const name of strippedHeaders) {
      ctx.warn?.(`${item.key}: header "${name}" held a credential and was not exported; add it by hand in the target`);
    }
    // The operations import endpoint takes an array of operations.
    await client.request('integrator', 'POST', `/import/connections/${cid}/operations`, { body: [op] });
  },

  async prune(client, existing) {
    await client.request('integrator', 'DELETE', `/connections/${enc(existing.meta.connectionId)}/operations/${enc(existing.meta.id)}`);
  },
};

export default [connections, operations];
