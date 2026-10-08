// Pure: per-environment overrides applied to exported artifacts at plan time.
import { withoutEnvBound, carryEnvBound, withoutSecretValues } from './normalize.mjs';

export function parsePath(path) {
  const segs = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '\\' && path[i + 1] === '.') { cur += '.'; i++; }
    else if (path[i] === '.') { segs.push(cur); cur = ''; }
    else cur += path[i];
  }
  segs.push(cur);
  if (segs.some((s) => s === '')) throw new Error(`Invalid override path "${path}"`);
  for (const seg of segs) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
      throw new Error(`Invalid override path "${path}": segment "${seg}" is not allowed`);
    }
  }
  return segs;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Arrays are addressed by element `name`. Setting a non-object on a named
// element sets its `values` (the attribute convention); missing elements are
// created. A missing `attributes` container is created as an array.
export function setPath(obj, path, value) {
  const root = structuredClone(obj ?? {});
  const segs = parsePath(path);
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (Array.isArray(cur)) {
      let el = cur.find((e) => e?.name === seg);
      if (last) {
        if (isPlainObject(value)) {
          if (el) Object.assign(el, value);
          else cur.push({ name: seg, ...value });
        } else if (el) el.values = value;
        else cur.push({ name: seg, values: value });
        return root;
      }
      if (!el) { el = { name: seg }; cur.push(el); }
      cur = el;
    } else {
      if (last) { cur[seg] = value; return root; }
      if (!Object.hasOwn(cur, seg) || cur[seg] === undefined || cur[seg] === null) cur[seg] = seg === 'attributes' ? [] : {};
      cur = cur[seg];
    }
  }
  return root;
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

export function replaceStrings(value, rules = []) {
  if (!rules.length) return value;
  for (const rule of rules) {
    if (typeof rule.from !== 'string' || rule.from === '' || typeof rule.to !== 'string') {
      throw new Error(`Invalid replace rule ${JSON.stringify(rule)}: needs a non-empty "from" and a string "to"`);
    }
  }
  return mapStrings(value, (s) => rules.reduce((acc, r) => acc.split(r.from).join(r.to), s));
}

export function resolveTemplates(value, vars = {}) {
  return mapStrings(value, (s) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)));
}

export function applyOverrides(key, data, overrides = {}, vars = {}) {
  let out = data;
  for (const [path, value] of Object.entries(overrides.artifacts?.[key] ?? {})) {
    out = setPath(out, path, resolveTemplates(value, vars));
  }
  return replaceStrings(out, overrides.replace);
}

export function prepareDesired({ key, scope, exported, existing, overrides, vars, envBoundAttributes }) {
  const portable = withoutEnvBound(scope, exported, envBoundAttributes, key);
  const carried = carryEnvBound(scope, portable, existing, envBoundAttributes, exported, key);
  return withoutSecretValues(scope, applyOverrides(key, carried, overrides, vars));
}
