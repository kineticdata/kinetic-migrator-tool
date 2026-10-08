// Test double for a Kinetic Platform space at the HTTP level: a `fetch` that
// answers the version endpoints and the Integrator sign-in the way 6.1.7 and
// 7.0.0-rc3 do (verified live), and hands every other API call to `handle`.
//
// 6.x  GET /app/oauth/authorize?grant_type=implicit&response_type=token&client_id=system
//      with Basic auth → 302 Location <url>/app/#access_token=…&expires_in=43200.
//      /app/oauth2/* do not exist (404).
// 7.x  /app/oauth/authorize does not exist (404, {"statusCode":404,"error":"No endpoint …"}).
//      1. GET /app/api/v1/meta/spa → 400 unauthenticated, but sets XSRF-TOKEN
//         (and a load balancer cookie).
//      2. POST /app/login.do {j_username, j_password} with X-XSRF-TOKEN equal
//         to the XSRF-TOKEN cookie (else 403) → 200, JSESSIONID cookie, and a
//         body that carries the JSESSIONID value. Wrong password → 401.
//      3. GET /app/oauth2/authorize (code + S256 PKCE) with the session cookie
//         → 302 <url>/app/oauth/callback?code=…; no or ended session → 302
//         <url>/app/login.
//      4. POST /app/oauth2/token (form) checks the code (single use), the
//         redirect_uri and the verifier → {access_token, token_type, expires_in: 299}.
// Both: the Integrator API wants a live bearer token (401 once expired); Core
// and Task accept Basic auth. Version endpoints: the Integrator's needs no
// auth; Core's needs Basic on 6.x (7.x answers without); Task's needs Basic.
// `sso`: 'refuse' — login.do answers 401 to every password (Core's Basic auth
// still works); 'redirect' — login.do sends the browser to an identity provider.
// `handle({ api, method, path, query, body })` (Core `/me` is built in) → a JSON value (200), a
// { status, body, headers } object (when `raw`), or undefined (404).
import { createHash, randomBytes } from 'node:crypto';

const rand = (n = 12) => randomBytes(n).toString('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const json = (body, status = 200, headers = []) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: [['content-type', 'application/json'], ...headers],
});
const redirect = (location, headers = []) => new Response(null, { status: 302, headers: [['location', location], ...headers] });

function cookiesOf(init) {
  const raw = headerOf(init, 'cookie') ?? '';
  return Object.fromEntries(raw.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)];
  }));
}

function headerOf(init, name) {
  const h = init?.headers ?? {};
  if (typeof h.get === 'function') return h.get(name);
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : h[k];
}

export function fakePlatform({
  version = '7.0.0-rc3', url = 'https://your-space.kinops.io', username = 'u', password = 'p',
  sso = null, tokenTtl, sessionTtl = 30 * 60, now = Date.now, handle = () => undefined, versionEndpoints = true,
} = {}) {
  const major = Number(String(version).split('.')[0]);
  const v7 = major >= 7;
  const ttl = tokenTtl ?? (v7 ? 299 : 43200);
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const tokens = new Map(); // token → expiresAt (ms)
  const sessions = new Map(); // JSESSIONID → expiresAt (ms)
  const codes = new Map(); // code → { challenge, redirectUri }
  const xsrf = new Set();
  const calls = [];
  const counts = { login: 0, authorize: 0, token: 0, implicit: 0 };

  const basicOk = (init) => headerOf(init, 'authorization') === basic;
  const bearerOk = (init) => {
    const m = /^Bearer (.+)$/.exec(headerOf(init, 'authorization') ?? '');
    const exp = m && tokens.get(m[1]);
    return Boolean(exp && now() < exp);
  };
  const issue = () => {
    const t = `tok-${rand()}`;
    tokens.set(t, now() + ttl * 1000);
    return t;
  };

  async function fetchImpl(input, init = {}) {
    const u = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ url: u.href, method, headers: { ...(init.headers ?? {}) }, body: init.body, redirect: init.redirect });
    if (u.origin !== new URL(url).origin) throw new TypeError('fetch failed');
    const p = u.pathname;

    if (p === '/app/integrator/api/version') {
      return versionEndpoints ? json({ version: { version, buildDate: '2026-01-01', buildNumber: '1' } }) : json({ error: 'nope' }, 404);
    }
    if (p === '/app/api/v1/version') {
      if (!versionEndpoints) return json({ error: 'nope' }, 404);
      if (!v7 && !basicOk(init)) return json({ error: 'Unauthorized' }, 401);
      return json({ version: { version, buildDate: '2026-01-01', buildNumber: '1', timestamp: 0 } });
    }
    if (p === '/app/components/task/app/api/v2/version') {
      if (!basicOk(init)) return json({ error: 'Unauthorized' }, 401);
      const [a, b, c] = String(version).split(/[-+]/)[0].split('.');
      return json({ api: 'v2', version: [a, b, c].map((x) => String(x ?? 0).padStart(2, '0')).join('.') });
    }

    // ---- 6.x implicit grant
    if (p === '/app/oauth/authorize') {
      if (v7) return json({ statusCode: 404, error: `No endpoint GET ${u.pathname}.` }, 404);
      counts.implicit++;
      if (!basicOk(init)) return json({ error: 'Unauthorized' }, 401);
      return redirect(`${url}/app/#access_token=${issue()}&expires_in=${ttl}&token_type=bearer`);
    }

    // ---- 7.x sign-in and code + PKCE
    if (p === '/app/api/v1/meta/spa') {
      const x = rand();
      xsrf.add(x);
      return json({ error: 'not signed in' }, 400, [
        ['set-cookie', `XSRF-TOKEN=${x}; Path=/`], ['set-cookie', `AWSALB=lb-${rand(6)}; Path=/`],
      ]);
    }
    if (p === '/app/login.do' && v7 && method === 'POST') {
      counts.login++;
      const c = cookiesOf(init);
      if (!c['XSRF-TOKEN'] || !xsrf.has(c['XSRF-TOKEN']) || headerOf(init, 'x-xsrf-token') !== c['XSRF-TOKEN']) return json({ error: 'Forbidden' }, 403);
      if (sso === 'redirect') return redirect('https://idp.example.com/saml2/sso?SAMLRequest=abc');
      let creds = {};
      try { creds = JSON.parse(String(init.body)); } catch { /* none */ }
      if (sso === 'refuse' || creds.j_username !== username || creds.j_password !== password) return json({ error: 'Bad credentials' }, 401);
      const sid = `sid-${rand()}`;
      sessions.set(sid, now() + sessionTtl * 1000);
      // As the platform: the body carries the session id.
      return json({ JSESSIONID: sid, username }, 200, [['set-cookie', `JSESSIONID=${sid}; Path=/; HttpOnly`]]);
    }
    if (p.startsWith('/app/oauth2/')) {
      if (!v7) return json({ error: 'not found' }, 404);
      if (p === '/app/oauth2/authorize') {
        counts.authorize++;
        const sid = cookiesOf(init).JSESSIONID;
        const alive = sid && sessions.has(sid) && now() < sessions.get(sid);
        if (!alive) return redirect(`${url}/app/login`);
        const q = u.searchParams;
        if (q.get('response_type') !== 'code' || q.get('client_id') !== 'system' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
          return json({ error: 'invalid_request' }, 400);
        }
        const code = `code-${rand()}`;
        codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
        return redirect(`${url}/app/oauth/callback?code=${code}`);
      }
      if (p === '/app/oauth2/token' && method === 'POST') {
        counts.token++;
        const f = new URLSearchParams(String(init.body ?? ''));
        const entry = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        const verifier = f.get('code_verifier') ?? '';
        const okVerifier = entry && b64url(createHash('sha256').update(verifier).digest()) === entry.challenge;
        if (f.get('grant_type') !== 'authorization_code' || f.get('client_id') !== 'system' || !okVerifier || entry.redirectUri !== f.get('redirect_uri')) {
          return json({ error: 'invalid_grant' }, 400);
        }
        return json({ access_token: issue(), token_type: 'Bearer', expires_in: ttl });
      }
      return json({ error: 'not found' }, 404);
    }

    // ---- APIs
    const apis = [['integrator', '/app/integrator/api'], ['task', '/app/components/task/app/api/v2'], ['core', '/app/api/v1']];
    const hit = apis.find(([, base]) => p === base || p.startsWith(`${base}/`));
    if (!hit) return json({ error: 'not found' }, 404);
    const [api, base] = hit;
    if (api === 'integrator' ? !bearerOk(init) : !basicOk(init)) return json({ error: 'Unauthorized' }, 401);
    const path = decodeURI(p.slice(base.length)) || '/';
    let body;
    try { body = init.body === undefined ? undefined : JSON.parse(String(init.body)); } catch { body = init.body; }
    let r = await handle({ api, method, path, query: Object.fromEntries(u.searchParams), body, headers: init.headers ?? {} });
    if (r === undefined && api === 'core' && method === 'GET' && path === '/me') r = { username, spaceAdmin: true };
    if (r === undefined) return json({ error: `No route ${method} ${api}${path}` }, 404);
    if (r && r.raw) return new Response(r.body === undefined ? null : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), { status: r.status ?? 200, headers: r.headers ?? [] });
    return json(r);
  }

  return {
    fetch: fetchImpl, calls, counts, url,
    // The session ends (as after the platform's session timeout).
    endSessions: () => sessions.clear(),
    // Every issued token stops working (as when revoked, or clocks differ).
    revokeTokens: () => tokens.clear(),
    env: (extra = {}) => ({ name: 'dev', url, readOnly: false, username, password, vars: {}, ...extra }),
  };
}
