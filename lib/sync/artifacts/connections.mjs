// Integrator connections and operations. Ids are kept identical across
// environments because forms and workflows reference them by UUID.
// Existing connections are never written: a PUT/PATCH carrying masked secrets
// would permanently wipe the target's credentials.
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { cached, enc, isSecretName } from './common.mjs';

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

// Auth field names from an Integrator 400 "Missing field" schema error.
export function missingAuthFields(err) {
  if (err?.status !== 400 || typeof err.body !== 'string') return [];
  let parsed;
  try { parsed = JSON.parse(err.body); } catch { return []; }
  return (parsed?.validationErrors ?? [])
    .filter((v) => /^Missing field/.test(v?.error ?? ''))
    .map((v) => /^\/config\/auth\/([A-Za-z0-9_]+)$/.exec(v?.path ?? '')?.[1])
    .filter(Boolean);
}

export function normalizeConnection(raw) {
  const c = stripMeta(omit(raw, ['status', 'secrets', 'operations']));
  if (c.config?.auth) c.config = { ...c.config, auth: stripSecrets(c.config.auth) };
  if (c.config?.headers) c.config = { ...c.config, headers: stripSecretHeaders(c.config.headers) };
  return c;
}

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

  async list(client, ctx) {
    return (await exports(client, ctx)).map((c) => ({
      key: keyFor('connections', c.name, 'connection'), data: normalizeConnection(c), meta: { id: c.id },
    }));
  },

  async apply(client, item, ctx) {
    if (item.existing) throw new Error(`${item.key}: connections are never updated automatically`);
    const d = item.desired;
    const secrets = ctx.connectionSecrets(d.name);
    const auth = d.config ? { ...d.config.auth, ...secrets } : undefined;
    // The import schema requires some secret fields per authType (e.g. `token`
    // for raw_bearer_token). When no secret was supplied, send an empty value
    // for each field the server reports missing, so the connection exists and
    // the credential can be set in the target afterwards.
    for (let attempt = 0; ; attempt++) {
      const config = d.config ? { ...d.config, auth } : d.config;
      try {
        await client.request('integrator', 'POST', '/import/connections', { body: { ...d, config, operations: [] } });
        return;
      } catch (err) {
        const missing = auth ? missingAuthFields(err).filter((f) => !(f in auth)) : [];
        if (!missing.length || attempt >= 5) throw err;
        for (const f of missing) {
          auth[f] = '';
          ctx.warn?.(`${item.key}: created with an empty auth "${f}"; set it in the target`);
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
