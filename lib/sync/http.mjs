// Minimal HTTP client for the Core, Task and Integrator APIs. Read mode
// refuses every non-GET before it is sent; that is the tool's main safety net.
import { isSecretName } from './secrets.mjs';

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const KEY_VALUE = new RegExp(`(${JSON_STRING})(\\s*:\\s*)${JSON_STRING}`, 'g');
const NAME_FIELD = new RegExp(`"name"\\s*:\\s*(${JSON_STRING})`);
const VALUE_FIELD = new RegExp(`("value"\\s*:\\s*)${JSON_STRING}`, 'g');
const unquote = (s) => { try { return JSON.parse(s); } catch { return s; } };

export class HttpError extends Error {
  constructor({ method, url, status, body }) {
    super(`${method} ${url} failed with ${status}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
    Object.assign(this, { method, url, status, body });
  }
}

export class ReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyError';
  }
}

export function redact(text) {
  return String(text)
    .replace(/\b(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [REDACTED]')
    // {"name":"<secret-looking>", ..., "value":"..."} (handler properties)
    .replace(/\{[^{}]*\}/g, (obj) => {
      const name = NAME_FIELD.exec(obj)?.[1];
      return name && isSecretName(unquote(name)) ? obj.replace(VALUE_FIELD, '$1"[REDACTED]"') : obj;
    })
    // "<secret-looking key>": "..."
    .replace(KEY_VALUE, (m, key, sep) => (isSecretName(unquote(key)) ? `${key}${sep}"[REDACTED]"` : m));
}

// The Integrator API needs a bearer token, and how to get one depends on the
// platform version. Thrown when no sign-in strategy yields a token (the
// platform does not offer it, or refused it): callers that can do without
// the Integrator (export, test connection) leave connections out instead of
// failing. `status` is the sign-in endpoint's answer, `version` the
// platform version when it was cheaply known, `host` the space's host.
export class IntegratorAuthUnavailable extends Error {
  constructor({ status = null, version = null, host = null, unsupported = status === 404 || status === 405 } = {}) {
    super(integratorAuthText({ status, version, host, unsupported }));
    this.name = 'IntegratorAuthUnavailable';
    Object.assign(this, { status, version, host, unsupported });
  }
}

// Plain words for why the Integrator could not be signed in to.
export function integratorAuthText({ status, version, host, unsupported }) {
  const where = host ?? 'the space';
  if (unsupported) {
    return version
      ? `${where} runs Kinetic Platform ${version}, which doesn't offer the sign-in this tool uses for the Integrator yet.`
      : `${where} doesn't offer the sign-in this tool uses for the Integrator (it answered ${status ?? 'unknown'}).`;
  }
  return `The Integrator sign-in on ${where} did not return a token (${status ?? 'unknown'}); check that this user can use the Integrator.`;
}

export function parseTokenFromLocation(location) {
  const params = new URLSearchParams(String(location).split('#')[1] ?? '');
  const token = params.get('access_token');
  if (!token) throw new Error('OAuth authorize response had no access_token (check the username and password)');
  return { token, expiresIn: Number(params.get('expires_in') ?? 43200) };
}

// Integrator sign-in strategies, tried in order until one yields a token; the
// one that worked is kept for the client's lifetime. Each gets
// { env, basic, fetchImpl } and returns { token, expiresIn }, or
// { unsupported: status } when the platform does not offer it (the next one
// is tried). Any other failure is { failed: status }. A platform version
// needing another flow adds its strategy here.
export async function implicitGrant({ env, basic, fetchImpl }) {
  const url = `${env.url}/app/oauth/authorize?grant_type=implicit&response_type=token&client_id=system`;
  const res = await fetchImpl(url, { method: 'GET', headers: { Authorization: basic }, redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status === 404 || res.status === 405) return { unsupported: res.status };
  if (!location) return { failed: res.status };
  try {
    return parseTokenFromLocation(location);
  } catch {
    return { failed: res.status };
  }
}

export const INTEGRATOR_AUTH = Object.freeze([implicitGrant]);

// The platform version, best effort (the Integrator's /version is open).
async function platformVersion(env, fetchImpl) {
  try {
    const res = await fetchImpl(`${env.url}/app/integrator/api/version`, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    const v = body?.version?.version ?? body?.version;
    return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

const RETRY_5XX = new Set(['GET', 'PUT', 'DELETE']);

export function createClient({ env, mode, integratorAuth = INTEGRATOR_AUTH, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  if (mode !== 'read' && mode !== 'write') throw new Error(`Unknown client mode "${mode}"`);
  if (mode === 'write' && env.readOnly) {
    throw new ReadOnlyError(`Environment "${env.name}" is readOnly; refusing to open it for writing`);
  }
  const bases = {
    core: `${env.url}/app/api/v1`,
    task: `${env.url}/app/components/task/app/api/v2`,
    integrator: `${env.url}/app/integrator/api`,
  };
  const basic = `Basic ${Buffer.from(`${env.username}:${env.password}`).toString('base64')}`;
  let token = null;

  let strategy = null;
  let unavailable = null;

  async function integratorToken() {
    if (token && now() < token.expiresAt - 30_000) return token.value;
    if (unavailable) throw unavailable;
    let last = null;
    for (const s of strategy ? [strategy] : integratorAuth) {
      const r = await s({ env, basic, fetchImpl });
      if (r?.token) {
        strategy = s;
        token = { value: r.token, expiresAt: now() + (r.expiresIn ?? 43200) * 1000 };
        return token.value;
      }
      last = r ?? {};
      if (last.failed !== undefined) break;
    }
    const status = last?.unsupported ?? last?.failed ?? null;
    const unsupported = last?.unsupported !== undefined;
    let host = null;
    try { host = new URL(env.url).host; } catch { /* left out of the message */ }
    unavailable = new IntegratorAuthUnavailable({ status, unsupported, host, version: unsupported ? await platformVersion(env, fetchImpl) : null });
    throw unavailable;
  }

  // `form` (a FormData) is sent as multipart; fetch sets the boundary.
  // `binary` returns the body as a Buffer instead of parsed JSON.
  async function send(api, method, path, { query, body, form, binary = false } = {}) {
    if (mode === 'read' && method !== 'GET') {
      throw new ReadOnlyError(`${method} ${path} blocked: this client is read-only`);
    }
    if (!bases[api]) throw new Error(`Unknown api "${api}"`);
    const url = new URL(bases[api] + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const headers = {
        Authorization: api === 'integrator' ? `Bearer ${await integratorToken()}` : basic,
        Accept: binary ? '*/*' : 'application/json',
      };
      if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
      const payload = form ?? (body === undefined ? undefined : JSON.stringify(body));
      const res = await fetchImpl(url, { method, headers, body: payload });
      if (res.status === 401 && api === 'integrator' && !refreshed) {
        refreshed = true;
        token = null;
        attempt--;
        continue;
      }
      const retryable = res.status === 429 || (res.status >= 500 && RETRY_5XX.has(method));
      if (retryable && attempt < 3) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (binary && res.ok) return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      if (!res.ok) throw new HttpError({ method, url: url.pathname + url.search, status: res.status, body: redact(text) });
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError({ method, url: url.pathname + url.search, status: res.status, body: redact(`expected JSON, got: ${text.slice(0, 200)}`) });
      }
    }
  }

  const request = (api, method, path, { query, body, form } = {}) => send(api, method, path, { query, body, form });
  return {
    mode, env, request,
    get: (api, path, query) => request(api, 'GET', path, { query }),
    getBinary: (api, path, query) => send(api, 'GET', path, { query, binary: true }),
  };
}
