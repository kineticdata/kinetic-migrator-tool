// Which Kinetic Platform version an environment runs, and what follows from
// it. Both version endpoints answer on 6.1.7 and 7.0.0-rc3 (verified live):
// - GET /app/integrator/api/version (no auth) → {version:{version:"7.0.0-rc3", …}}
// - GET /app/api/v1/version (Basic auth; 7.x also answers without)
//   → {version:{version, buildDate, buildNumber, timestamp}}
// The Integrator's is asked first (it needs no credentials), then Core's.
// Nothing here throws: an unreachable or unreadable answer is `major: null`.

const VERSION = /^\d+(?:\.\d+)*(?:[-+][\w.+-]*)?$/;

// { version, major, minor } from a version string ("7.0.0-rc3", "06.01.07"),
// or null when it does not read as one.
export function parseVersion(text) {
  const v = typeof text === 'string' ? text.trim() : '';
  if (!v || v.length > 40 || !VERSION.test(v)) return null;
  const [major, minor = 0] = v.split(/[-+]/)[0].split('.').map(Number);
  if (!Number.isInteger(major)) return null;
  return { version: v, major, minor: Number.isInteger(minor) ? minor : 0 };
}

export const UNKNOWN_PLATFORM = Object.freeze({ version: null, major: null, minor: null, source: null });

const SOURCES = [
  { source: 'integrator', path: '/app/integrator/api/version', auth: false },
  { source: 'core', path: '/app/api/v1/version', auth: true },
];

async function readVersion(url, headers, fetchImpl) {
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual' });
    if (!res.ok) return null;
    const body = await res.json();
    return parseVersion(body?.version?.version ?? body?.version);
  } catch {
    return null;
  }
}

// The platform `env` runs: { version, major, minor, source } (source: which
// endpoint answered), or UNKNOWN_PLATFORM. `basic` is the Authorization
// header for Core's endpoint (left out when not given).
export async function detectPlatform(env, { fetchImpl = globalThis.fetch, basic } = {}) {
  for (const s of SOURCES) {
    const headers = { Accept: 'application/json', ...(s.auth && basic ? { Authorization: basic } : {}) };
    const v = await readVersion(`${env.url}${s.path}`, headers, fetchImpl);
    if (v) return Object.freeze({ ...v, source: s.source });
  }
  return UNKNOWN_PLATFORM;
}

// ---- Version-dependent behaviour ----------------------------------------
//
// The one place that says what differs by platform version. Only what has
// been verified against a live space belongs here.
// - integratorAuth: how to get an Integrator bearer token.
//   'implicit' — 6.x: GET /app/oauth/authorize (implicit grant, Basic auth).
//   'pkce'     — 7.x: sign in through /app/login.do, then the authorization
//                code flow with PKCE (/app/oauth2/authorize + /app/oauth2/token).
//   'unknown'  — version not known: implicit first, then pkce on a 404.
export function capabilities(platform) {
  const major = platform?.major;
  if (!Number.isInteger(major)) return Object.freeze({ integratorAuth: 'unknown' });
  return Object.freeze({ integratorAuth: major >= 7 ? 'pkce' : 'implicit' });
}

// Plain words for a platform: "Kinetic Platform 7.0.0-rc3".
export const platformLabel = (p) => (p?.version ? `Kinetic Platform ${p.version}` : 'Kinetic Platform (version unknown)');

// The warning shown when two environments run different major versions, or
// null. `a` and `b`: { name, platform }.
export function crossVersionWarning(a, b) {
  const pa = a?.platform;
  const pb = b?.platform;
  if (!Number.isInteger(pa?.major) || !Number.isInteger(pb?.major) || pa.major === pb.major) return null;
  return `${a.name} runs ${pa.version} and ${b.name} runs ${pb.version} — review differences carefully.`;
}
