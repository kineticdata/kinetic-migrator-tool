// What an export left out, and why. Connections and operations come from the
// Integrator API, which needs its own sign-in; when that sign-in is not
// available (see IntegratorAuthUnavailable in http.mjs) an export keeps
// everything else and records the omission in its tree's marker. A plan or
// comparison where either side left a type out leaves that type out
// entirely: a missing connection is never "new", "only in the target" or a
// removal.
export const INTEGRATOR_TYPES = Object.freeze(['connections', 'operations']);
const INTEGRATOR_KEY = /^connections\//;

// The omission an IntegratorAuthUnavailable error stands for.
export function omissionFrom(err) {
  return {
    types: [...INTEGRATOR_TYPES],
    reason: 'integrator-auth',
    status: err?.status ?? null,
    version: err?.version ?? null,
    message: String(err?.message ?? 'The Integrator could not be signed in to.'),
  };
}

export const isOmittable = (err, type) => err?.name === 'IntegratorAuthUnavailable' && INTEGRATOR_TYPES.includes(type);

// The warning an export shows for an omission.
export const omissionWarning = (o) => `Connections and operations were left out: ${o.message}`;

// ---- Marker lines ----------------------------------------------------------
// One `omitted: <json>` line per omission, after the marker's layout line.

export const markerLines = (omitted = []) => omitted.map((o) => `omitted: ${JSON.stringify(o)}\n`).join('');

export function markerOmitted(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/^omitted: (.*)$/gm)) {
    try {
      const o = JSON.parse(m[1]);
      if (Array.isArray(o?.types) && o.types.every((t) => typeof t === 'string')) {
        out.push({ ...o, message: String(o.message ?? '') });
      }
    } catch { /* an unreadable line records nothing */ }
  }
  return out;
}

// ---- Plans and comparisons -------------------------------------------------

// sides: [{ name, omitted }]. The types any side left out, and one note per
// side that left something out.
export function omittedBetween(sides) {
  const types = new Set();
  const notes = [];
  for (const { name, omitted } of sides) {
    for (const o of omitted ?? []) {
      o.types.forEach((t) => types.add(t));
      notes.push(`Connections and operations are left out of this comparison: ${name ?? 'one side'} has none recorded. ${o.message} They are not compared, created or removed.`);
    }
  }
  return { types, notes };
}

// `typeOf(key)`: the item's artifact type. Keys under connections/ always
// count as Integrator items, whatever their module.
export function isOmittedKey(key, types, typeOf = () => undefined) {
  if (!types.size) return false;
  if (INTEGRATOR_TYPES.some((t) => types.has(t)) && INTEGRATOR_KEY.test(key)) return true;
  return types.has(typeOf(key));
}

// A copy of `map` without the omitted types' keys.
export function withoutOmitted(map, types, typeOf) {
  if (!types.size) return map;
  const out = new Map([...map].filter(([k]) => !isOmittedKey(k, types, typeOf)));
  for (const p of ['layout', 'rekeyed', 'unresolved', 'omitted']) {
    if (map[p] !== undefined) Object.defineProperty(out, p, { value: map[p] });
  }
  return out;
}
