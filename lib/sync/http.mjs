// Minimal HTTP client for the Core, Task and Integrator APIs. Read mode
// refuses every non-GET before it is sent; that is the tool's main safety net.
import { createHash, randomBytes } from 'node:crypto';
import { isSecretName, squash } from './secrets.mjs';
import { capabilities, detectPlatform, UNKNOWN_PLATFORM } from './platform.mjs';

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

// Credentials go over https only. Plain http is accepted for this machine
// (localhost, 127.0.0.1, [::1], any port), where nothing crosses a network.
export const INSECURE_URL_MESSAGE = 'This address uses http://, which would send your password unencrypted. Change it to https://.';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopbackHost = (hostname) => LOOPBACK_HOSTS.has(String(hostname).toLowerCase().replace(/\.$/, ''));

// Why credentials must not be sent to this address, or null when they may.
export function insecureUrlReason(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'This address is not a valid URL. Start the address with https://'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname) ? null : INSECURE_URL_MESSAGE;
  return 'Start the address with https://';
}

export class InsecureUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsecureUrlError';
  }
}

// Sign-in material that is not secret-named but must never be shown: session
// and XSRF cookies (also load balancer ones), OAuth codes, PKCE verifiers.
const SESSION_KEYS = new Set(['jsessionid', 'xsrftoken', 'csrftoken', 'sessionid', 'session', 'codeverifier', 'awsalb', 'awsalbcors', 'awsalbtg', 'awsalbtgcors']);
// A Cookie or Set-Cookie header: its name=value pairs (attributes too).
const COOKIE_HEADER = /\b((?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^=;\s"'\\]+=[^;\s"'\\]*(?:;[ \t]*[^=;\s"'\\]+(?:=[^;\s"'\\]*)?)*;?/gi;
const COOKIE_PAIR = /\b(JSESSIONID|XSRF-TOKEN|CSRF-TOKEN|AWSALB\w*|SESSION\w*)=[^;,\s&"'#]+/gi;
const OAUTH_PARAM = /(^|[?&#\s"',;])((?:code|code_verifier|code_challenge|access_token|refresh_token|id_token|state)=)[^&\s"'#]+/gi;

export function redact(text) {
  return String(text)
    .replace(/\b(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [REDACTED]')
    .replace(COOKIE_HEADER, '$1$2[REDACTED]')
    .replace(COOKIE_PAIR, '$1=[REDACTED]')
    .replace(OAUTH_PARAM, '$1$2[REDACTED]')
    // {"name":"<secret-looking>", ..., "value":"..."} (handler properties)
    .replace(/\{[^{}]*\}/g, (obj) => {
      const name = NAME_FIELD.exec(obj)?.[1];
      return name && isSecretName(unquote(name)) ? obj.replace(VALUE_FIELD, '$1"[REDACTED]"') : obj;
    })
    // "<secret-looking key>": "..."
    .replace(KEY_VALUE, (m, key, sep) => {
      const name = unquote(key);
      return isSecretName(name) || SESSION_KEYS.has(squash(name)) ? `${key}${sep}"[REDACTED]"` : m;
    });
}

// The Integrator API needs a bearer token, and how to get one depends on the
// platform version. Thrown only when the platform does not offer the sign-in
// at all (the authorize endpoint answers 404, as Kinetic Platform 7.0.0-rc3
// does): callers that can do without the Integrator (export, test
// connection) then leave connections out instead of failing. `status` is the
// sign-in endpoint's answer, `version` the platform version when it was
// cheaply known, `host` the space's host. `unsupported` is always true.
export class IntegratorAuthUnavailable extends Error {
  constructor({ status = 404, version = null, host = null } = {}) {
    super(integratorAuthText({ status, version, host }));
    this.name = 'IntegratorAuthUnavailable';
    Object.assign(this, { status, version, host, unsupported: true });
  }
}

// Plain words for why the Integrator sign-in is not offered.
export function integratorAuthText({ status, version, host }) {
  const where = host ?? 'the space';
  return version
    ? `${where} runs Kinetic Platform ${version}, which doesn't offer the sign-in this tool uses for the Integrator yet.`
    : `${where} doesn't offer the sign-in this tool uses for the Integrator (it answered ${status ?? 'unknown'}).`;
}

// Thrown when the platform offers the Integrator sign-in but it did not yield
// a token: refused (401/403), a redirect without one (to a login page), a
// space that only signs people in with single sign-on (`sso`), or a server
// error. Never degrades: the export, plan or test fails with this.
// `refused`: the 7.x sign-in page refused the request (403: the account,
// or the space's sign-in settings, such as its XSRF check). `noSession`: it
// answered without starting a session. `attempts`: how many times a
// transient failure (5xx, 429) was tried. `host`: the space's host.
export class IntegratorSignInFailed extends Error {
  constructor({ status = null, redirected = false, sso = false, refused = false, noSession = false, attempts = 1, host = null } = {}) {
    super(integratorSignInText({ status, redirected, sso, refused, noSession, attempts, host }));
    this.name = 'IntegratorSignInFailed';
    Object.assign(this, { status, redirected, sso, refused, noSession, attempts, host });
  }
}

export function integratorSignInText({ status, redirected, sso, refused, noSession, attempts = 1, host }) {
  const code = status ?? 'unknown';
  if (sso) return 'This space signs in with single sign-on; Kinetic Migrator needs a local account with a password.';
  if (refused) return `${host ?? 'The space'} rejected the sign-in (${code}): check the username and password, or the space's sign-in settings.`;
  if (status === 401 || status === 403) return `The Integrator rejected the sign-in (${code}): check the username and password.`;
  if (redirected) return `The Integrator sign-in did not return a token (${code}, redirected without one): check the username and password.`;
  if (noSession) return `The sign-in did not start a session (${code}): check the username and password.`;
  return `The Integrator sign-in failed (${code})${attempts > 1 ? ` after ${attempts} attempts` : ''}; try again later.`;
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
  return names.every(Boolean) ? names.map(clean) : null;
}

export function parseTokenFromLocation(location) {
  const params = new URLSearchParams(String(location).split('#')[1] ?? '');
  const token = params.get('access_token');
  if (!token) throw new Error('OAuth authorize response had no access_token (check the username and password)');
  return { token, expiresIn: Number(params.get('expires_in') ?? 43200) };
}

// ---- Integrator sign-in ----------------------------------------------------
//
// Strategies, by name (see capabilities() in platform.mjs for which a
// platform version uses). Each gets { env, basic, fetchImpl, session } and
// returns { token, expiresIn }, or { unsupported: status } when the platform
// does not offer it (the next one is tried). Any other failure is
// { failed: status, redirected, sso } and stops the sign-in. A platform
// version needing another flow adds its strategy to INTEGRATOR_AUTH and its
// order to AUTH_ORDER.
//
// Nothing a sign-in handles (cookies, codes, verifiers, tokens, response
// bodies) is ever put in a result other than the token, an error or a log.

// 6.x: the implicit grant with Basic auth; the token is in the redirect's
// fragment.
export async function implicitGrant({ env, basic, fetchImpl }) {
  const url = `${env.url}/app/oauth/authorize?grant_type=implicit&response_type=token&client_id=system`;
  const res = await fetchImpl(url, { method: 'GET', headers: { Authorization: basic }, redirect: 'manual' });
  await discard(res);
  const location = res.headers.get('location');
  // Only a missing endpoint means "not offered" (7.0.0-rc3: {"statusCode":404,
  // "error":"No endpoint GET /<space>/app/oauth/authorize."}).
  if (res.status === 404) return { unsupported: 404 };
  if (!location) return failure(res, { redirected: false });
  try {
    return parseTokenFromLocation(location);
  } catch {
    return failure(res, { redirected: true });
  }
}

// A failed sign-in step: its status, and Retry-After when it says one.
const failure = (res, extra = {}) => ({ failed: res.status, retryAfter: res.headers.get('retry-after'), ...extra });
export const isTransient = (status) => status === 429 || (Number(status) >= 500 && Number(status) < 600);

// A response body nobody reads (login.do's carries the session id).
async function discard(res) {
  try { await res.body?.cancel?.(); } catch { /* already consumed or closed */ }
}

// The cookies of one sign-in session (JSESSIONID, XSRF-TOKEN, load balancer
// cookies), kept for re-authorizing while the session lasts.
export function cookieSession() {
  const jar = new Map();
  return {
    has: (name) => jar.has(name),
    get: (name) => jar.get(name),
    clear: () => jar.clear(),
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    update(res) {
      const h = res.headers;
      const list = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (h.get('set-cookie') ? [h.get('set-cookie')] : []);
      for (const line of list) {
        const [pair, ...attrs] = String(line).split(';');
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
        if (!value || expired) jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// PKCE (RFC 7636): a verifier of 32 random bytes and its S256 challenge.
export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

const LOGIN_PAGE = /\/app\/login(?:[/?#.]|$)/;

// 7.x: sign in through /app/login.do (form login, XSRF-protected), then the
// authorization code flow with PKCE. The access token lasts 5 minutes and
// comes with no refresh token; while the session lasts, a new one is got by
// authorizing again with its cookies, and when it has ended (authorize sends
// the browser to /app/login) by signing in again. Verified against
// 7.0.0-rc3; the steps are those of the Kinetic React SDK.
export async function pkceGrant({ env, basic, fetchImpl, session = cookieSession() }) {
  const base = env.url;
  const redirectUri = `${base}/app/oauth/callback`;

  async function signIn() {
    const spa = await fetchImpl(`${base}/app/api/v1/meta/spa`, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual' });
    // May answer 400 when not signed in: only the cookies matter.
    session.update(spa);
    await discard(spa);
    const xsrf = session.get('XSRF-TOKEN');
    const res = await fetchImpl(`${base}/app/login.do`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', Accept: 'application/json',
        ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}), cookie: session.header(),
      },
      body: JSON.stringify({ j_username: env.username, j_password: env.password }),
      redirect: 'manual',
    });
    session.update(res);
    // The body carries the session id: never read.
    await discard(res);
    if (res.status === 404) return { unsupported: 404 };
    if (res.status >= 300 && res.status < 400) {
      // Sent to an identity provider instead of signed in.
      const to = res.headers.get('location') ?? '';
      return LOGIN_PAGE.test(to) ? failure(res, { redirected: true }) : failure(res, { redirected: true, sso: true });
    }
    if (res.status === 401) {
      // The same credentials Core accepts but the sign-in page refuses: the
      // space only signs people in through single sign-on.
      return failure(res, { sso: await coreAccepts() });
    }
    // 403: the request itself was refused (the XSRF check, or the space's
    // sign-in settings), never read as single sign-on.
    if (res.status === 403) return failure(res, { refused: true });
    if (!res.ok) return failure(res);
    if (!session.has('JSESSIONID')) return failure(res, { noSession: true });
    return null;
  }

  async function coreAccepts() {
    try {
      const r = await fetchImpl(`${base}/app/api/v1/me`, { method: 'GET', headers: { Authorization: basic, Accept: 'application/json' }, redirect: 'manual' });
      await discard(r);
      return r.ok;
    } catch {
      return false;
    }
  }

  async function authorize() {
    const { verifier, challenge } = pkcePair();
    const q = new URLSearchParams({ response_type: 'code', client_id: 'system', redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' });
    const res = await fetchImpl(`${base}/app/oauth2/authorize?${q}`, { method: 'GET', headers: { cookie: session.header() }, redirect: 'manual' });
    session.update(res);
    await discard(res);
    if (res.status === 404) return { unsupported: 404 };
    const location = res.headers.get('location');
    if (!location) return failure(res, { redirected: false });
    let target;
    try { target = new URL(location, base); } catch { return failure(res, { redirected: true }); }
    const code = target.searchParams.get('code');
    if (!code) return LOGIN_PAGE.test(target.pathname) ? { login: true } : failure(res, { redirected: true });
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: 'system', code_verifier: verifier });
    const t = await fetchImpl(`${base}/app/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json', cookie: session.header() },
      body: body.toString(), redirect: 'manual',
    });
    session.update(t);
    if (!t.ok) { await discard(t); return failure(t); }
    let json;
    try { json = await t.json(); } catch { return failure(t); }
    if (typeof json?.access_token !== 'string' || !json.access_token) return failure(t);
    const expiresIn = Number(json.expires_in);
    return { token: json.access_token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 299 };
  }

  if (session.has('JSESSIONID')) {
    // Re-authorizing with the session; anything but a token, a missing
    // endpoint or a transient error (tried again by the client) means the
    // session no longer works: sign in afresh, once.
    const again = await authorize();
    if (again.token || again.unsupported !== undefined || isTransient(again.failed)) return again;
    session.clear();
  }
  const failed = await signIn();
  if (failed) return failed;
  const r = await authorize();
  return r.login ? { failed: 302, redirected: true } : r;
}

export const INTEGRATOR_AUTH = Object.freeze({ implicit: implicitGrant, pkce: pkceGrant });
// capabilities(platform).integratorAuth → the strategies to try, in order.
export const AUTH_ORDER = Object.freeze({ implicit: ['implicit'], pkce: ['pkce'], unknown: ['implicit', 'pkce'] });

export const strategiesFor = (platform) => (AUTH_ORDER[capabilities(platform).integratorAuth] ?? AUTH_ORDER.unknown).map((n) => INTEGRATOR_AUTH[n]);

const RETRY_5XX = new Set(['GET', 'PUT', 'DELETE']);

// Sign-in retries: attempts in all, and the longest wait between two.
export const SIGN_IN_ATTEMPTS = 3;
const MAX_WAIT = 10_000;
const backoff = (n) => 500 * 2 ** (n - 1);

// How long to wait before attempt n + 1: Retry-After (seconds or an HTTP
// date) when given, capped at MAX_WAIT; otherwise exponential backoff.
export function retryWait(retryAfter, n, now = Date.now) {
  const v = String(retryAfter ?? '').trim();
  let ms = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (v) {
    const at = Date.parse(v);
    if (!Number.isNaN(at)) ms = Math.max(0, at - now());
  }
  return Math.min(ms ?? backoff(n), MAX_WAIT);
}

// `integratorAuth`: the sign-in strategies to try, in order; by default they
// follow the platform version (strategiesFor). `client.platform()` detects
// the version once per client (see platform.mjs).
export function createClient({ env, mode, integratorAuth, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  if (mode !== 'read' && mode !== 'write') throw new Error(`Unknown client mode "${mode}"`);
  if (mode === 'write' && env.readOnly) {
    throw new ReadOnlyError(`Environment "${env.name}" is readOnly; refusing to open it for writing`);
  }
  // Last line of defence: no code path sends the password over plain http to
  // another machine, whatever loaded the environment.
  const insecure = insecureUrlReason(env.url);
  if (insecure) throw new InsecureUrlError(`Environment "${env.name}": ${insecure}`);
  const bases = {
    core: `${env.url}/app/api/v1`,
    task: `${env.url}/app/components/task/app/api/v2`,
    integrator: `${env.url}/app/integrator/api`,
  };
  const basic = `Basic ${Buffer.from(`${env.username}:${env.password}`).toString('base64')}`;
  const session = cookieSession();
  let token = null;
  let strategy = null;
  let unavailable = null;
  let detected = null;
  let signingIn = null;

  const platform = () => (detected ??= detectPlatform(env, { fetchImpl, basic }).catch(() => UNKNOWN_PLATFORM));

  let host = null;
  try { host = new URL(env.url).host; } catch { /* left out of messages */ }

  // One strategy, with transient failures (5xx, 429, network errors) tried
  // again up to SIGN_IN_ATTEMPTS times, waiting as Retry-After says (capped)
  // or backing off.
  async function attempt(s) {
    for (let n = 1; ; n++) {
      let r;
      try {
        r = await s({ env, basic, fetchImpl, session });
      } catch (err) {
        if (n < SIGN_IN_ATTEMPTS && err?.name === 'TypeError') { await sleep(backoff(n)); continue; }
        throw err;
      }
      if (!isTransient(r?.failed)) return { ...(r ?? {}), attempts: n };
      if (n >= SIGN_IN_ATTEMPTS) return { ...r, attempts: n };
      await sleep(retryWait(r.retryAfter, n, now));
    }
  }

  async function signIn() {
    // Given strategies need no version (it is asked only for the message).
    const p = integratorAuth ? null : await platform();
    let last = null;
    for (const s of strategy ? [strategy] : integratorAuth ?? strategiesFor(p)) {
      const r = await attempt(s);
      if (r.token) {
        strategy = s;
        const life = (r.expiresIn ?? 43200) * 1000;
        token = { value: r.token, expiresAt: now() + life, margin: Math.min(30_000, life / 2) };
        return token.value;
      }
      last = r;
      // A refusal or server error is not cached: the next call tries again.
      if (last.unsupported === undefined) {
        throw new IntegratorSignInFailed({
          status: last.failed ?? null, redirected: Boolean(last.redirected), sso: Boolean(last.sso), refused: Boolean(last.refused),
          noSession: Boolean(last.noSession), attempts: last.attempts ?? 1, host,
        });
      }
    }
    unavailable = new IntegratorAuthUnavailable({ status: last?.unsupported ?? 404, host, version: (p ?? await platform()).version });
    throw unavailable;
  }

  // A token valid for 30 seconds more (half its life, if shorter), or a new one. Concurrent callers share
  // one sign-in. `stale`: the token a 401 answered, dropped unless already
  // replaced.
  async function integratorToken(stale) {
    if (stale && token?.value === stale) token = null;
    if (token && now() < token.expiresAt - token.margin) return token.value;
    if (unavailable) throw unavailable;
    signingIn ??= signIn().finally(() => { signingIn = null; });
    return signingIn;
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
    let stale = null;
    for (let attempt = 1; ; attempt++) {
      const bearer = api === 'integrator' ? await integratorToken(stale) : null;
      const headers = {
        Authorization: bearer ? `Bearer ${bearer}` : basic,
        Accept: binary ? '*/*' : 'application/json',
      };
      if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
      const payload = form ?? (body === undefined ? undefined : JSON.stringify(body));
      const res = await fetchImpl(url, { method, headers, body: payload });
      // An expired or revoked token: sign in again once and retry.
      if (res.status === 401 && api === 'integrator' && !refreshed) {
        refreshed = true;
        stale = bearer;
        await discard(res);
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
    mode, env, request, platform,
    get: (api, path, query) => request(api, 'GET', path, { query }),
    getBinary: (api, path, query) => send(api, 'GET', path, { query, binary: true }),
  };
}
