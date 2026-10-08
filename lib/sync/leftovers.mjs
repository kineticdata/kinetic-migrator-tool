// lib/sync/leftovers.mjs
// Pure: find exported strings that still contain the source space's host and
// are not rewritten by a target environment's overrides.
import { ENV_BOUND_FIELDS } from './normalize.mjs';
import { replaceStrings } from './overrides.mjs';

const esc = (s) => String(s).replace(/\./g, '\\.');
const join = (path, seg) => (path ? `${path}.${seg}` : seg);

function walk(value, path, visit) {
  if (typeof value === 'string') { visit(path, value); return; }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, join(path, v && typeof v === 'object' && 'name' in v ? esc(v.name) : i), visit));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, join(path, esc(k)), visit);
  }
}

export function findSourceHostStrings(artifacts, sourceUrl, scopeOf) {
  const host = new URL(sourceUrl).host;
  const hits = [];
  for (const { key, data } of artifacts) {
    const bound = ENV_BOUND_FIELDS[scopeOf(key)] ?? [];
    walk(data, '', (path, value) => {
      if (value.includes(host) && !bound.includes(path.split('.')[0])) hits.push({ key, path, value });
    });
  }
  return hits;
}

export function uncoveredFor(hits, overrides, sourceUrl) {
  const host = new URL(sourceUrl).host;
  return hits.filter((h) => {
    const paths = Object.keys(overrides.artifacts?.[h.key] ?? {});
    if (paths.some((p) => h.path === p || h.path.startsWith(`${p}.`))) return false;
    return replaceStrings(h.value, overrides.replace ?? []).includes(host);
  });
}
