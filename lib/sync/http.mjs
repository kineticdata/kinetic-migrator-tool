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

// ---- Platform error bodies -------------------------------------------------
//
// The platform answers a refused write with a JSON body such as
// {"message":"Unable to save task handler","errors":["x may not be empty"]}.
// Those texts name fields, not values, so they are worth showing; they are
// still redacted again, stripped of control characters and capped. Nothing
// else of the body (and never the request) is used. A body cut short (an
// HttpError message keeps only its first 500 characters) is read as far as
// it goes.
const MAX_PART = 200;
const MAX_ERRORS = 8;
const MAX_DETAIL = 600;
const STRING = /"((?:[^"\\]|\\.)*)"/g;

const clean = (s) => {
  const t = redact(String(s)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > MAX_PART ? `${t.slice(0, MAX_PART - 1)}…` : t;
};

function readBody(body) {
  const text = String(body ?? '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      message: typeof parsed.message === 'string' ? parsed.message : null,
      errors: Array.isArray(parsed.errors) ? parsed.errors.filter((e) => typeof e === 'string') : [],
    };
  } catch {
    // Cut short: take "message" and the complete strings of "errors" so far.
    const message = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
    const list = /"errors"\s*:\s*\[([\s\S]*)/.exec(text)?.[1]?.split(']')[0] ?? '';
    const unquote = (q) => { try { return JSON.parse(q); } catch { return null; } };
    return {
      message: message ? unquote(message) : null,
      errors: [...list.matchAll(STRING)].map((m) => unquote(m[0])).filter((e) => typeof e === 'string'),
    };
  }
}

// { message, errors } from a platform error body (cleaned), or null when the
// body has neither.
export function platformErrorDetail(body) {
  const read = readBody(body);
  if (!read) return null;
  const message = read.message ? clean(read.message) : '';
  const errors = read.errors.map(clean).filter(Boolean);
  if (!message && !errors.length) return null;
  return { message, errors };
}

// A platform failure in plain words: "The Kinetic Platform rejected the
// change (400): Unable to save task handler — a may not be empty; b may not
// be empty", or, with nothing to show from the body, "The Kinetic Platform
// returned an error (400)." Reads are never "changes".
export function describePlatformError({ status, method, body } = {}) {
  const code = status ?? 'unknown';
  const d = platformErrorDetail(body);
  if (!d) return `The Kinetic Platform returned an error (${code}).`;
  const write = method && method !== 'GET' && Number(status) >= 400 && Number(status) < 500;
  const shown = d.errors.slice(0, MAX_ERRORS);
  const more = d.errors.length - shown.length;
  const list = shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
  let detail = [d.message, list].filter(Boolean).join(' — ');
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL - 1)}…`;
  return `The Kinetic Platform ${write ? 'rejected the change' : 'returned an error'} (${code}): ${detail}`;
}

const FAILURE = /^([A-Z]+) \S+ failed with (\d{3}): ([\s\S]*)$/;

// The same from an HttpError's message ("PUT /x failed with 400: <body>"),
// for callers that only kept the message; null when it is not one.
export function describeFailureMessage(message) {
  const m = FAILURE.exec(String(message ?? ''));
  if (!m) return null;
  return describePlatformError({ method: m[1], status: Number(m[2]), body: m[3] });
}

// Names the platform says may not be empty ("<name> may not be empty"), when
// every error in the body says that; otherwise null.
export function emptyRequiredNames(body) {
  const read = readBody(body);
  if (!read?.errors.length) return null;
  const names = read.errors.map((e) => /^(.+?) may not be empty\.?$/.exec(e.trim())?.[1]);
  return names.every(Boolean) ? names : null;
}

export function parseTokenFromLocation(location) {
  const params = new URLSearchParams(String(location).split('#')[1] ?? '');
  const token = params.get('access_token');
  if (!token) throw new Error('OAuth authorize response had no access_token (check the username and password)');
  return { token, expiresIn: Number(params.get('expires_in') ?? 43200) };
}

const RETRY_5XX = new Set(['GET', 'PUT', 'DELETE']);

export function createClient({ env, mode, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
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

  async function integratorToken() {
    if (token && now() < token.expiresAt - 30_000) return token.value;
    const url = `${env.url}/app/oauth/authorize?grant_type=implicit&response_type=token&client_id=system`;
    const res = await fetchImpl(url, { method: 'GET', headers: { Authorization: basic }, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) {
      throw new HttpError({ method: 'GET', url: '/app/oauth/authorize', status: res.status, body: 'no redirect Location (check the username and password)' });
    }
    const { token: value, expiresIn } = parseTokenFromLocation(location);
    token = { value, expiresAt: now() + expiresIn * 1000 };
    return value;
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
