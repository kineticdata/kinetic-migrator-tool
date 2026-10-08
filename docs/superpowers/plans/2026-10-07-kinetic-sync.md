# kinetic-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node CLI (`kinetic-sync.mjs`) that exports a Kinetic Platform space's configuration into a git-friendly project directory and promotes it into another environment through a read-only `plan` and a guarded, non-destructive `apply`.

**Architecture:** Pure modules (normalize, overrides, plan, report, leftovers) carry all decision logic and are unit-tested with synthetic fixtures. One module per artifact type implements `list` (used for both export and target fetch) and `apply`/`prune` against a small HTTP client that enforces GET-only mode. Customer data (environments, overrides, state, export) lives in a project directory passed with `--project`, never in this repository.

**Tech Stack:** Node.js ≥ 20 built-ins only (`fetch`, `node:test`, `node:util` `parseArgs`, `node:crypto`, `node:fs`, `node:readline/promises`).

**Spec:** `docs/superpowers/specs/2026-10-07-kinetic-sync-design.md`

## Global Constraints

- Node 20+; **no npm dependencies** in the tool (repo root has no package.json; keep it that way).
- **No customer, space name, customer URL or customer-specific artifact** anywhere in code, tests, fixtures, docs or examples. Use `dev`/`test`/`prod`, `https://your-space.kinops.io`, `https://api.example.com`.
- Test files are `*.test.mjs` next to the module; run all with `node --test lib/sync/*.test.mjs lib/sync/artifacts/*.test.mjs`.
- Style matches `setup.mjs` / `lib/setup-core.mjs`: ES modules, 2-space indent, single quotes, semicolons, short header comment per file.
- Never modify connection auth credentials on an existing connection.
- `read` clients must never send a non-GET request; a `readOnly` environment can never get a `write` client.
- Never retry a POST on 5xx.
- Commit after every task; end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Re-exporting an unchanged space must produce zero `git diff`.** Any nondeterministic ordering or volatile field (timestamps, versionIds, health status) makes every PR noisy and drift detection useless. Pinned by the stable-ordering tests in Task 1 and the double-export check in Task 14.
2. **Names that differ only by case, or collide after file-name sanitization** (`A/B` vs `A_B`), must be a hard export error, not a silent overwrite on macOS/Windows file systems. Pinned in Task 5.
3. **A POST must never be retried after a 5xx**, or a slow create becomes a duplicate team/workflow/submission. Pinned in Task 4.
4. **Reference-data rows sharing a `createdAt` across a page boundary** must be neither skipped nor duplicated. Pinned in Task 12.
5. **Promoting reference data fires the target's submission workflows** (e.g. a workflow that mirrors rows to an external system). The plan must warn by name. Pinned in Task 15.

---

## File Map

| File | Responsibility |
|---|---|
| `kinetic-sync.mjs` | CLI: argument parsing, dispatch to commands, exit codes |
| `lib/sync/normalize.mjs` | Pure: strip metadata, stable stringify/hash, env-bound fields & attributes |
| `lib/sync/overrides.mjs` | Pure: dot-path setter, replace rules, templates, `prepareDesired` |
| `lib/sync/env.mjs` | Load project config, environments, credentials, overrides, connection secrets |
| `lib/sync/http.mjs` | HTTP client: auth, Integrator token, retries, redaction, GET-only guard |
| `lib/sync/store.mjs` | Safe names, keys, write/read export tree |
| `lib/sync/state.mjs` | Load/save drift hashes |
| `lib/sync/fake-client.mjs` | Test double for the HTTP client |
| `lib/sync/artifacts/common.mjs` | `listAll`, per-context caching, `upsertByName`, index builds |
| `lib/sync/artifacts/space.mjs` | Space settings, attribute definitions, security policies |
| `lib/sync/artifacts/teams.mjs` / `models.mjs` / `file-resources.mjs` | Those artifact types |
| `lib/sync/artifacts/connections.mjs` | Connections + operations (two modules) |
| `lib/sync/artifacts/kapps.mjs` / `forms.mjs` | Kapps (with sub-collections) and forms |
| `lib/sync/artifacts/webapis.mjs` / `workflows.mjs` | WebAPIs and Core workflows |
| `lib/sync/artifacts/routines.mjs` / `task-refs.mjs` | Task API references (non-applyable) |
| `lib/sync/artifacts/data.mjs` | Allowlisted reference-data submissions |
| `lib/sync/artifacts/index.mjs` | Module registry in apply order |
| `lib/sync/plan.mjs` | Pure: diff, classify, drift, preflight |
| `lib/sync/report.mjs` | Pure: plan → text |
| `lib/sync/leftovers.mjs` | Pure: find source-host strings not covered by overrides |
| `lib/sync/commands.mjs` | `runInit`, `runExport`, `computePlan`, `runPlan`, `runApply` |
| `docs/PROMOTING.md` | User walkthrough |

### Shared shapes (used across tasks)

- **Artifact:** `{ key: string, data: object, meta: object }`. `key` is the export-relative path without `.json`, `/`-separated, each segment passed through `safeName`.
- **Environment:** `{ name, url, readOnly, username, password, vars }` (`vars` = merged `.env.<env>` + `process.env`).
- **Config:** `{ data: [{ kapp, form, key: string[] }], exclude: { kapps: string[], forms: string[] /* "kapp/form" */ }, envBoundAttributes: { space?, kapp?, form?, team?, category?: string[] } }`.
- **Client:** `{ mode, env, request(api, method, path, { query, body }) → Promise<json|null>, get(api, path, query) }` where `api ∈ 'core' | 'task' | 'integrator'`. Errors are `HttpError` with `.status`.
- **Module:** `{ type, scope|null, owns(key), list(client, ctx), apply(client, item, ctx), prune?(client, existing, ctx), namedCollections?, mergeTargetOnly?(desired, existingData), preflight?(client, exportedMap), applyable?, updatable? }`.
- **List ctx:** `{ config, collected: Artifact[], cache?: Map }`.
- **Plan item:** `{ key, type, action: 'create'|'update'|'unchanged'|'manual'|'skip-drift', source, desired, existing: Artifact|null, diff: [{ path, from, to }], drift: boolean }`. `source` = exported data after overrides; `desired` = `source` plus target-only sub-items.
- **Apply ctx:** `{ config, prune: Set<string>, connectionSecrets(name) → object, warn(msg) }`.

---

### Task 1: Normalization primitives

**Files:**
- Create: `lib/sync/normalize.mjs`
- Test: `lib/sync/normalize.test.mjs`

**Interfaces:**
- Produces: `META_KEYS`, `ENV_BOUND_FIELDS`, `stripMeta(value)`, `omit(obj, keys)`, `pick(obj, keys)`, `sortBy(arr, key = 'name')` (key may be a function), `stableStringify(value)`, `isEqual(a, b)`, `hashOf(value)`, `withoutEnvBound(scope, data, envBoundAttributes)`, `carryEnvBound(scope, data, existing, envBoundAttributes)`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMeta, omit, pick, sortBy, stableStringify, isEqual, hashOf,
  withoutEnvBound, carryEnvBound, ENV_BOUND_FIELDS,
} from './normalize.mjs';

test('stripMeta removes audit fields at every depth but keeps status', () => {
  const raw = {
    name: 'Form', status: 'Active', createdAt: 'x', updatedBy: 'y', lockVersion: 3,
    pages: [{ name: 'Page 1', insertedAt: 'z', elements: [{ name: 'F', createdBy: 'q' }] }],
  };
  assert.deepEqual(stripMeta(raw), {
    name: 'Form', status: 'Active', pages: [{ name: 'Page 1', elements: [{ name: 'F' }] }],
  });
});

test('omit and pick copy without mutating', () => {
  const o = { a: 1, b: 2, c: 3 };
  assert.deepEqual(omit(o, ['b']), { a: 1, c: 3 });
  assert.deepEqual(pick(o, ['a', 'z']), { a: 1 });
  assert.deepEqual(o, { a: 1, b: 2, c: 3 });
});

test('sortBy orders by name, by a named key, or by a function, and tolerates null', () => {
  assert.deepEqual(sortBy([{ name: 'b' }, { name: 'a' }]).map((x) => x.name), ['a', 'b']);
  assert.deepEqual(sortBy([{ slug: 'z' }, { slug: 'm' }], 'slug').map((x) => x.slug), ['m', 'z']);
  assert.deepEqual(sortBy([{ c: { s: 'b' } }, { c: { s: 'a' } }], (x) => x.c.s).map((x) => x.c.s), ['a', 'b']);
  assert.deepEqual(sortBy(undefined), []);
});

test('stableStringify is independent of key insertion order and ends with a newline', () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
  assert.equal(a.split('\n')[1], '  "a": {');
});

test('stableStringify keeps array order (arrays can be semantically ordered)', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('isEqual and hashOf agree with stableStringify', () => {
  assert.equal(isEqual({ a: 1, b: [1] }, { b: [1], a: 1 }), true);
  assert.equal(isEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(isEqual(undefined, null), true);
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.match(hashOf({}), /^[0-9a-f]{64}$/);
});

test('ENV_BOUND_FIELDS covers space identity and locations, and kapp bundlePath', () => {
  assert.deepEqual(ENV_BOUND_FIELDS.space, ['name', 'slug', 'platformComponents', 'bundlePath', 'sharedBundleBase']);
  assert.deepEqual(ENV_BOUND_FIELDS.kapp, ['bundlePath']);
});

test('withoutEnvBound drops env-bound fields and listed attributes, including category attributes on kapps', () => {
  const kapp = {
    slug: 'k', bundlePath: 'ui',
    attributes: [{ name: 'Region', values: ['eu'] }, { name: 'Icon', values: ['x'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Env', values: ['dev'] }, { name: 'Icon', values: ['y'] }] }],
  };
  const eba = { kapp: ['Region'], category: ['Env'] };
  assert.deepEqual(withoutEnvBound('kapp', kapp, eba), {
    slug: 'k',
    attributes: [{ name: 'Icon', values: ['x'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Icon', values: ['y'] }] }],
  });
  assert.equal(withoutEnvBound(null, kapp, eba), kapp);
});

test('carryEnvBound copies the target values back in, sorted, and adds nothing when target lacks them', () => {
  const desired = { slug: 'k', attributes: [{ name: 'Icon', values: ['x'] }], categories: [{ slug: 'c1', attributes: [] }] };
  const existing = {
    slug: 'k', bundlePath: 'prod-ui',
    attributes: [{ name: 'Region', values: ['us'] }, { name: 'Icon', values: ['old'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Env', values: ['prod'] }] }],
  };
  const eba = { kapp: ['Region'], category: ['Env'] };
  assert.deepEqual(carryEnvBound('kapp', desired, existing, eba), {
    slug: 'k', bundlePath: 'prod-ui',
    attributes: [{ name: 'Icon', values: ['x'] }, { name: 'Region', values: ['us'] }],
    categories: [{ slug: 'c1', attributes: [{ name: 'Env', values: ['prod'] }] }],
  });
  assert.deepEqual(carryEnvBound('kapp', desired, null, eba), desired);
  assert.deepEqual(carryEnvBound('kapp', { slug: 'k' }, { slug: 'k' }, eba), { slug: 'k' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/normalize.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/sync/normalize.mjs'`.

- [ ] **Step 3: Implement**

```js
// lib/sync/normalize.mjs
// Pure helpers that turn platform responses into canonical, comparable JSON.
import { createHash } from 'node:crypto';

// Server-managed audit fields. Never meaningful when comparing environments.
export const META_KEYS = new Set([
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'insertedAt', 'lockVersion',
]);

// Fields that describe where an environment lives, not what it is configured
// to do. Never copied from the source; the target keeps its own values.
export const ENV_BOUND_FIELDS = {
  space: ['name', 'slug', 'platformComponents', 'bundlePath', 'sharedBundleBase'],
  kapp: ['bundlePath'],
};

// Collections inside an artifact whose items carry their own attributes.
const NESTED_ATTRIBUTE_SCOPES = {
  kapp: [{ field: 'categories', key: 'slug', scope: 'category' }],
};

export function stripMeta(value) {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!META_KEYS.has(k)) out[k] = stripMeta(v);
    return out;
  }
  return value;
}

export function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

export function sortBy(arr, key = 'name') {
  const get = typeof key === 'function' ? key : (x) => x?.[key];
  return [...(arr ?? [])].sort((a, b) => String(get(a)).localeCompare(String(get(b))));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function isEqual(a, b) {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

export function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function dropAttributes(attrs, names) {
  return Array.isArray(attrs) ? attrs.filter((a) => !names.has(a.name)) : attrs;
}

function carryAttributes(attrs, from, names) {
  if (!names.size || !Array.isArray(from)) return attrs;
  const kept = from.filter((a) => names.has(a.name));
  return kept.length ? sortBy([...(attrs ?? []), ...kept]) : attrs;
}

export function withoutEnvBound(scope, data, envBoundAttributes = {}) {
  if (!scope || !data) return data;
  const out = omit(data, ENV_BOUND_FIELDS[scope] ?? []);
  const own = new Set(envBoundAttributes[scope] ?? []);
  if (own.size && out.attributes) out.attributes = dropAttributes(out.attributes, own);
  for (const n of NESTED_ATTRIBUTE_SCOPES[scope] ?? []) {
    const names = new Set(envBoundAttributes[n.scope] ?? []);
    if (!names.size || !Array.isArray(out[n.field])) continue;
    out[n.field] = out[n.field].map((item) => ({ ...item, attributes: dropAttributes(item.attributes, names) }));
  }
  return out;
}

// `data` must already have had withoutEnvBound applied.
export function carryEnvBound(scope, data, existing, envBoundAttributes = {}) {
  if (!scope || !existing) return data;
  const out = { ...data };
  for (const f of ENV_BOUND_FIELDS[scope] ?? []) if (f in existing) out[f] = existing[f];
  const attrs = carryAttributes(out.attributes, existing.attributes, new Set(envBoundAttributes[scope] ?? []));
  if (attrs === undefined) delete out.attributes;
  else out.attributes = attrs;
  for (const n of NESTED_ATTRIBUTE_SCOPES[scope] ?? []) {
    const names = new Set(envBoundAttributes[n.scope] ?? []);
    if (!names.size || !Array.isArray(out[n.field])) continue;
    out[n.field] = out[n.field].map((item) => {
      const match = existing[n.field]?.find((e) => e[n.key] === item[n.key]);
      return match ? { ...item, attributes: carryAttributes(item.attributes, match.attributes, names) } : item;
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/normalize.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/normalize.mjs lib/sync/normalize.test.mjs
git commit -m "feat(sync): normalization primitives and env-bound field handling"
```

---

### Task 2: Overrides

**Files:**
- Create: `lib/sync/overrides.mjs`
- Test: `lib/sync/overrides.test.mjs`

**Interfaces:**
- Consumes: `withoutEnvBound`, `carryEnvBound` from Task 1.
- Produces: `parsePath(path) → string[]`, `setPath(obj, path, value) → newObj`, `replaceStrings(value, rules)`, `resolveTemplates(value, vars)`, `applyOverrides(key, data, overrides, vars)`, `prepareDesired({ key, scope, exported, existing, overrides, vars, envBoundAttributes })`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/overrides.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePath, setPath, replaceStrings, resolveTemplates, applyOverrides, prepareDesired,
} from './overrides.mjs';

test('parsePath splits on dots and honours \\. escapes', () => {
  assert.deepEqual(parsePath('config.baseUrl'), ['config', 'baseUrl']);
  assert.deepEqual(parsePath('attributes.api\\.example\\.com'), ['attributes', 'api.example.com']);
  assert.throws(() => parsePath('a..b'), /Invalid override path/);
});

test('setPath sets nested object values and creates missing objects', () => {
  const src = { config: { baseUrl: 'https://dev' } };
  assert.deepEqual(setPath(src, 'config.baseUrl', 'https://prod'), { config: { baseUrl: 'https://prod' } });
  assert.deepEqual(setPath({}, 'platformComponents.app.location', 'https://ui'), {
    platformComponents: { app: { location: 'https://ui' } },
  });
  assert.equal(src.config.baseUrl, 'https://dev', 'input is not mutated');
});

test('setPath addresses array elements by name and sets attribute values', () => {
  const space = { attributes: [{ name: 'Environment', values: ['dev'] }] };
  assert.deepEqual(setPath(space, 'attributes.Environment', ['prod']), {
    attributes: [{ name: 'Environment', values: ['prod'] }],
  });
  assert.deepEqual(setPath({ attributes: [] }, 'attributes.Region', ['eu']), {
    attributes: [{ name: 'Region', values: ['eu'] }],
  });
  assert.deepEqual(setPath({}, 'attributes.Region', ['eu']), { attributes: [{ name: 'Region', values: ['eu'] }] });
  assert.deepEqual(
    setPath({ items: [{ name: 'a', x: 1 }] }, 'items.a', { x: 2 }),
    { items: [{ name: 'a', x: 2 }] },
  );
});

test('replaceStrings rewrites every string, deeply, and leaves non-strings alone', () => {
  const data = { body: 'SELECT * FROM DEV_DB.T', n: 3, list: ['DEV_DB', { k: 'DEV_DB' }] };
  assert.deepEqual(replaceStrings(data, [{ from: 'DEV_DB', to: 'PROD_DB' }]), {
    body: 'SELECT * FROM PROD_DB.T', n: 3, list: ['PROD_DB', { k: 'PROD_DB' }],
  });
  assert.equal(replaceStrings(data, []), data);
});

test('resolveTemplates fills known variables and leaves unknown mustache tokens alone', () => {
  assert.equal(resolveTemplates('{{targetUrl}}/app', { targetUrl: 'https://t' }), 'https://t/app');
  assert.equal(resolveTemplates('{{Query Param}} {{other}}', { targetUrl: 'x' }), '{{Query Param}} {{other}}');
});

test('applyOverrides applies artifact paths then replace rules', () => {
  const overrides = {
    artifacts: { 'connections/My API': { 'config.baseUrl': '{{targetUrl}}/api' } },
    replace: [{ from: 'dev-tenant', to: 'prod-tenant' }],
  };
  const out = applyOverrides('connections/My API', { config: { baseUrl: 'x', path: '/dev-tenant' } }, overrides, { targetUrl: 'https://t' });
  assert.deepEqual(out, { config: { baseUrl: 'https://t/api', path: '/prod-tenant' } });
  assert.deepEqual(applyOverrides('other', { a: 'dev-tenant' }, overrides, {}), { a: 'prod-tenant' });
});

test('prepareDesired keeps the target env-bound values unless an override sets them', () => {
  const exported = { name: 'Dev Space', bundlePath: null, attributes: [{ name: 'Environment', values: ['dev'] }, { name: 'Theme', values: ['blue'] }] };
  const existing = { name: 'Prod Space', bundlePath: 'prod', attributes: [{ name: 'Environment', values: ['prod'] }] };
  const eba = { space: ['Environment'] };
  const plain = prepareDesired({ key: 'space', scope: 'space', exported, existing, overrides: {}, vars: {}, envBoundAttributes: eba });
  assert.deepEqual(plain, {
    name: 'Prod Space', bundlePath: 'prod',
    attributes: [{ name: 'Environment', values: ['prod'] }, { name: 'Theme', values: ['blue'] }],
  });
  const overridden = prepareDesired({
    key: 'space', scope: 'space', exported, existing,
    overrides: { artifacts: { space: { 'attributes.Environment': ['production'] } } }, vars: {}, envBoundAttributes: eba,
  });
  assert.deepEqual(overridden.attributes[0], { name: 'Environment', values: ['production'] });
});

test('prepareDesired for a new artifact drops env-bound values entirely', () => {
  const out = prepareDesired({ key: 'kapps/k/kapp', scope: 'kapp', exported: { slug: 'k', bundlePath: 'dev-ui' }, existing: null, overrides: {}, vars: {}, envBoundAttributes: {} });
  assert.deepEqual(out, { slug: 'k' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/overrides.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/overrides.mjs
// Pure: per-environment overrides applied to exported artifacts at plan time.
import { withoutEnvBound, carryEnvBound } from './normalize.mjs';

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
      if (cur[seg] === undefined || cur[seg] === null) cur[seg] = seg === 'attributes' ? [] : {};
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
  const portable = withoutEnvBound(scope, exported, envBoundAttributes);
  const carried = carryEnvBound(scope, portable, existing, envBoundAttributes);
  return applyOverrides(key, carried, overrides, vars);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/overrides.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/overrides.mjs lib/sync/overrides.test.mjs
git commit -m "feat(sync): per-environment overrides with name-addressed paths"
```

---

### Task 3: Project and environment loading

**Files:**
- Create: `lib/sync/env.mjs`
- Test: `lib/sync/env.test.mjs`

**Interfaces:**
- Produces: `envKey(name)`, `parseDotEnv(text)`, `secretFieldKey(field)`, `connectionSecrets(env, connectionName) → object`, `loadEnvironment(projectDir, name, processEnv = process.env) → Environment`, `loadOverrides(projectDir, name)`, `loadConfig(projectDir) → Config`, `listOverrideEnvs(projectDir) → string[]`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  envKey, parseDotEnv, secretFieldKey, connectionSecrets, loadEnvironment, loadOverrides, loadConfig, listOverrideEnvs,
} from './env.mjs';

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('envKey upper-snakes environment and connection names', () => {
  assert.equal(envKey('prod'), 'PROD');
  assert.equal(envKey('my-dev.space'), 'MY_DEV_SPACE');
  assert.equal(envKey('My API (v2)'), 'MY_API_V2');
});

test('parseDotEnv reads KEY=VALUE, strips quotes, skips comments and blanks', () => {
  assert.deepEqual(parseDotEnv("# c\nA=1\n\nB='two words'\nC=\"x=y\"\n bad line\n"), { A: '1', B: 'two words', C: 'x=y' });
});

test('secretFieldKey maps camelCase auth fields to UPPER_SNAKE', () => {
  assert.equal(secretFieldKey('password'), 'PASSWORD');
  assert.equal(secretFieldKey('clientSecret'), 'CLIENT_SECRET');
});

test('connectionSecrets collects KINETIC_<ENV>_SECRET_<CONN>_<FIELD> into camelCase fields', () => {
  const env = { name: 'prod', vars: {
    KINETIC_PROD_SECRET_MY_API_PASSWORD: 'p',
    KINETIC_PROD_SECRET_MY_API_CLIENT_SECRET: 's',
    KINETIC_PROD_SECRET_OTHER_PASSWORD: 'no',
  } };
  assert.deepEqual(connectionSecrets(env, 'My API'), { password: 'p', clientSecret: 's' });
  assert.deepEqual(connectionSecrets(env, 'Missing'), {});
});

test('loadEnvironment merges .env file and process env (process wins) and strips trailing slash', () => {
  const dir = project({
    'environments/prod.json': { url: 'https://your-space.kinops.io/', readOnly: false },
    '.env.prod': 'KINETIC_PROD_USERNAME=file-user\nKINETIC_PROD_PASSWORD=file-pass\n',
  });
  const env = loadEnvironment(dir, 'prod', { KINETIC_PROD_PASSWORD: 'shell-pass' });
  assert.equal(env.url, 'https://your-space.kinops.io');
  assert.equal(env.username, 'file-user');
  assert.equal(env.password, 'shell-pass');
  assert.equal(env.readOnly, false);
});

test('loadEnvironment explains what is missing', () => {
  const dir = project({ 'environments/dev.json': { url: 'https://your-space.kinops.io', readOnly: true } });
  assert.throws(() => loadEnvironment(dir, 'nope', {}), /environments\/nope\.json/);
  assert.throws(() => loadEnvironment(dir, 'dev', {}), /KINETIC_DEV_USERNAME.*KINETIC_DEV_PASSWORD.*\.env\.dev/s);
});

test('loadOverrides and loadConfig default sensibly and validate data entries', () => {
  const dir = project({ 'kinetic-sync.config.json': { data: [{ kapp: 'k', form: 'f', key: ['Code'] }] } });
  assert.deepEqual(loadOverrides(dir, 'prod'), { artifacts: {}, replace: [] });
  assert.deepEqual(loadConfig(dir), {
    data: [{ kapp: 'k', form: 'f', key: ['Code'] }], exclude: { kapps: [], forms: [] }, envBoundAttributes: {},
  });
  const bad = project({ 'kinetic-sync.config.json': { data: [{ kapp: 'k', form: 'f' }] } });
  assert.throws(() => loadConfig(bad), /non-empty key/);
});

test('listOverrideEnvs lists environments that have override files', () => {
  const dir = project({ 'overrides/test.json': {}, 'overrides/prod.json': {} });
  assert.deepEqual(listOverrideEnvs(dir), ['prod', 'test']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/env.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/env.mjs
// Loads a kinetic-sync project directory: config, environments, credentials,
// overrides and connection secrets.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function envKey(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || /\s/.test(line.slice(0, eq).trim())) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function secretFieldKey(field) {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

const camel = (snake) => snake.toLowerCase().replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase());

export function connectionSecrets(env, connectionName) {
  const prefix = `KINETIC_${envKey(env.name)}_SECRET_${envKey(connectionName)}_`;
  const out = {};
  for (const [k, v] of Object.entries(env.vars ?? {})) {
    if (k.startsWith(prefix) && v !== '') out[camel(k.slice(prefix.length))] = v;
  }
  return out;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function loadEnvironment(projectDir, name, processEnv = process.env) {
  const file = join(projectDir, 'environments', `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Unknown environment "${name}": create environments/${name}.json in the project with {"url": "https://your-space.kinops.io"}`);
  }
  const def = readJson(file);
  if (!def.url) throw new Error(`environments/${name}.json has no "url"`);
  const dotenv = join(projectDir, `.env.${name}`);
  const vars = { ...(existsSync(dotenv) ? parseDotEnv(readFileSync(dotenv, 'utf8')) : {}), ...processEnv };
  const k = envKey(name);
  const username = vars[`KINETIC_${k}_USERNAME`];
  const password = vars[`KINETIC_${k}_PASSWORD`];
  if (!username || !password) {
    throw new Error(`No credentials for "${name}": set KINETIC_${k}_USERNAME and KINETIC_${k}_PASSWORD, or put them in .env.${name} in the project`);
  }
  return { name, url: def.url.replace(/\/+$/, ''), readOnly: def.readOnly === true, username, password, vars };
}

export function loadOverrides(projectDir, name) {
  const file = join(projectDir, 'overrides', `${name}.json`);
  const raw = existsSync(file) ? readJson(file) : {};
  return { artifacts: raw.artifacts ?? {}, replace: raw.replace ?? [] };
}

export function listOverrideEnvs(projectDir) {
  const dir = join(projectDir, 'overrides');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadConfig(projectDir) {
  const file = join(projectDir, 'kinetic-sync.config.json');
  const user = existsSync(file) ? readJson(file) : {};
  const config = {
    data: user.data ?? [],
    exclude: { kapps: [], forms: [], ...user.exclude },
    envBoundAttributes: user.envBoundAttributes ?? {},
  };
  for (const d of config.data) {
    if (!d.kapp || !d.form || !Array.isArray(d.key) || !d.key.length) {
      throw new Error(`kinetic-sync.config.json: data entry ${JSON.stringify(d)} needs kapp, form and a non-empty key array`);
    }
  }
  return config;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/env.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/env.mjs lib/sync/env.test.mjs
git commit -m "feat(sync): project, environment and credential loading"
```

---

### Task 4: HTTP client with read-only guard and Integrator token

**Files:**
- Create: `lib/sync/http.mjs`
- Test: `lib/sync/http.test.mjs`

**Interfaces:**
- Consumes: Environment shape from Task 3.
- Produces: `HttpError` (`.status`, `.method`, `.url`, `.body`), `ReadOnlyError`, `redact(text)`, `parseTokenFromLocation(location) → { token, expiresIn }`, `createClient({ env, mode, fetchImpl, sleep, now }) → Client`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, parseTokenFromLocation, redact, ReadOnlyError, HttpError } from './http.mjs';

const env = { name: 'dev', url: 'https://your-space.kinops.io', readOnly: false, username: 'u', password: 'p' };

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), ...init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected request ${url}`);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};

test('parseTokenFromLocation reads the fragment', () => {
  assert.deepEqual(
    parseTokenFromLocation('https://x/app#access_token=abc&expires_in=600&token_type=bearer'),
    { token: 'abc', expiresIn: 600 },
  );
  assert.throws(() => parseTokenFromLocation('https://x/app?error=denied'), /access_token/);
});

test('redact hides auth headers and secret-looking JSON values', () => {
  const out = redact('Authorization: Basic dXNlcjpwYXNz {"password":"hunter2","name":"ok"} Bearer eyJ.abc');
  assert.doesNotMatch(out, /dXNlcjpwYXNz|hunter2|eyJ\.abc/);
  assert.match(out, /"name":"ok"/);
});

test('core GET uses Basic auth, the v1 base and query params', async () => {
  const f = fakeFetch([{ body: { space: { name: 'S' } } }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await c.get('core', '/space', { export: 'true', skip: undefined }), { space: { name: 'S' } });
  assert.equal(f.calls[0].url, 'https://your-space.kinops.io/app/api/v1/space?export=true');
  assert.equal(f.calls[0].headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
});

test('read mode blocks every non-GET before any request is sent', async () => {
  const f = fakeFetch([]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(c.request('core', m, '/teams', { body: {} }), ReadOnlyError);
  }
  assert.equal(f.calls.length, 0);
});

test('a readOnly environment cannot get a write client', () => {
  assert.throws(() => createClient({ env: { ...env, readOnly: true }, mode: 'write' }), ReadOnlyError);
});

test('integrator calls fetch a token once via manual redirect, cache it, and refresh on 401', async () => {
  const loc = (t) => ({ status: 302, headers: { location: `https://x/#access_token=${t}&expires_in=43200` } });
  const f = fakeFetch([loc('t1'), { body: [] }, { body: [] }, { status: 401, body: {} }, loc('t2'), { body: [{ id: 'c' }] }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  await c.get('integrator', '/connections');
  await c.get('integrator', '/connections');
  assert.deepEqual(await c.get('integrator', '/connections'), [{ id: 'c' }]);
  const authorize = f.calls.filter((x) => x.url.includes('/app/oauth/authorize'));
  assert.equal(authorize.length, 2);
  assert.equal(authorize[0].redirect, 'manual');
  assert.match(authorize[0].url, /grant_type=implicit&response_type=token&client_id=system/);
  assert.equal(f.calls[1].url, 'https://your-space.kinops.io/app/integrator/api/connections');
  assert.equal(f.calls[1].headers.Authorization, 'Bearer t1');
  assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer t2');
});

test('GET retries 5xx then succeeds; errors carry status and a redacted body', async () => {
  const f = fakeFetch([{ status: 502 }, { status: 503 }, { body: { ok: true } }]);
  const c = createClient({ env, mode: 'read', fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await c.get('core', '/kapps'), { ok: true });

  const g = fakeFetch([{ status: 400, body: { error: 'bad', password: 'secret1' } }]);
  const c2 = createClient({ env, mode: 'read', fetchImpl: g, sleep: noSleep });
  await assert.rejects(c2.get('core', '/kapps'), (e) => e instanceof HttpError && e.status === 400 && !e.body.includes('secret1'));
});

test('POST is never retried on 5xx (would duplicate creates) but is retried on 429', async () => {
  const f = fakeFetch([{ status: 500, body: {} }]);
  const c = createClient({ env, mode: 'write', fetchImpl: f, sleep: noSleep });
  await assert.rejects(c.request('core', 'POST', '/teams', { body: { name: 'T' } }), (e) => e.status === 500);
  assert.equal(f.calls.length, 1);

  const g = fakeFetch([{ status: 429 }, { body: { team: {} } }]);
  const c2 = createClient({ env, mode: 'write', fetchImpl: g, sleep: noSleep });
  await c2.request('core', 'POST', '/teams', { body: { name: 'T' } });
  assert.equal(g.calls.length, 2);
  assert.equal(g.calls[0].body, JSON.stringify({ name: 'T' }));
});

test('empty responses return null', async () => {
  const f = fakeFetch([{ status: 204 }]);
  const c = createClient({ env, mode: 'write', fetchImpl: f, sleep: noSleep });
  assert.equal(await c.request('core', 'DELETE', '/teams/x'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/http.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/http.mjs
// Minimal HTTP client for the Core, Task and Integrator APIs. Read mode
// refuses every non-GET before it is sent; that is the tool's main safety net.

export class HttpError extends Error {
  constructor({ method, url, status, body }) {
    super(`${method} ${url} failed with ${status}: ${body.slice(0, 500)}`);
    Object.assign(this, { method, url, status, body });
  }
}

export class ReadOnlyError extends Error {}

export function redact(text) {
  return String(text)
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/g, '$1 [REDACTED]')
    .replace(/("(?:password|clientSecret|secret|token|access_token|apiKey)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
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

  async function request(api, method, path, { query, body } = {}) {
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
        Accept: 'application/json',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
      const text = await res.text();
      if (!res.ok) throw new HttpError({ method, url: url.pathname + url.search, status: res.status, body: redact(text) });
      return text ? JSON.parse(text) : null;
    }
  }

  return { mode, env, request, get: (api, path, query) => request(api, 'GET', path, { query }) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/http.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/http.mjs lib/sync/http.test.mjs
git commit -m "feat(sync): HTTP client with GET-only guard and Integrator token"
```

---

### Task 5: Export store and drift state

**Files:**
- Create: `lib/sync/store.mjs`, `lib/sync/state.mjs`
- Test: `lib/sync/store.test.mjs`

**Interfaces:**
- Consumes: `stableStringify` (Task 1).
- Produces: `safeName(name)`, `keyFor(...segments)`, `MARKER`, `assertUniqueKeys(artifacts)`, `writeTree(dir, artifacts)`, `readTree(dir) → Map<key, data>`; `loadState(projectDir, env) → object`, `saveState(projectDir, env, state)`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeName, keyFor, writeTree, readTree, assertUniqueKeys, MARKER } from './store.mjs';
import { loadState, saveState } from './state.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ksync-store-'));

test('safeName replaces path and reserved characters', () => {
  assert.equal(safeName('Departments::IT'), 'Departments__IT');
  assert.equal(safeName('a/b\\c*?"<>|'), 'a_b_c______');
  assert.equal(safeName('..hidden'), '_.hidden');
  assert.equal(safeName('  '), '_');
  assert.equal(keyFor('kapps', 'k', 'forms', 'a/b'), 'kapps/k/forms/a_b');
});

test('assertUniqueKeys rejects exact and case-only collisions', () => {
  assert.throws(() => assertUniqueKeys([{ key: 'teams/A_B' }, { key: 'teams/A_B' }]), /teams\/A_B/);
  assert.throws(() => assertUniqueKeys([{ key: 'teams/Ops' }, { key: 'teams/ops' }]), /case/);
  assert.doesNotThrow(() => assertUniqueKeys([{ key: 'teams/a' }, { key: 'teams/b' }]));
});

test('writeTree writes stable JSON plus a marker, and readTree reads it back', () => {
  const dir = join(tmp(), 'export');
  writeTree(dir, [{ key: 'space', data: { b: 1, a: 2 } }, { key: 'kapps/k/forms/f', data: { slug: 'f' } }]);
  assert.ok(existsSync(join(dir, MARKER)));
  assert.equal(readFileSync(join(dir, 'space.json'), 'utf8'), '{\n  "a": 2,\n  "b": 1\n}\n');
  const tree = readTree(dir);
  assert.deepEqual([...tree.keys()].sort(), ['kapps/k/forms/f', 'space']);
  assert.deepEqual(tree.get('kapps/k/forms/f'), { slug: 'f' });
});

test('writeTree replaces a previous export so deleted artifacts disappear', () => {
  const dir = join(tmp(), 'export');
  writeTree(dir, [{ key: 'teams/Old', data: {} }]);
  writeTree(dir, [{ key: 'teams/New', data: {} }]);
  assert.deepEqual([...readTree(dir).keys()], ['teams/New']);
});

test('writeTree refuses to clear a non-empty directory that is not an export', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'important.txt'), 'keep me');
  assert.throws(() => writeTree(dir, []), /not a kinetic-sync export/);
  assert.equal(readFileSync(join(dir, 'important.txt'), 'utf8'), 'keep me');
});

test('readTree on a missing directory explains how to create it', () => {
  assert.throws(() => readTree(join(tmp(), 'nope')), /run export first/);
});

test('state round-trips and defaults to empty', () => {
  const dir = tmp();
  assert.deepEqual(loadState(dir, 'prod'), {});
  saveState(dir, 'prod', { b: 'h2', a: 'h1' });
  assert.deepEqual(loadState(dir, 'prod'), { a: 'h1', b: 'h2' });
  assert.equal(readFileSync(join(dir, 'state', 'prod.json'), 'utf8').split('\n')[1], '  "a": "h1",');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/store.mjs
// The export tree on disk: one stable JSON file per artifact, keyed by path.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { stableStringify } from './normalize.mjs';

export const MARKER = '.kinetic-sync-export';

export function safeName(name) {
  const cleaned = String(name).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/^\./, '_').trim();
  return cleaned || '_';
}

export function keyFor(...segments) {
  return segments.map(safeName).join('/');
}

export function assertUniqueKeys(artifacts) {
  const seen = new Map();
  for (const { key } of artifacts) {
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      const other = seen.get(lower);
      throw new Error(other === key
        ? `Two artifacts map to the same file: ${key} (rename one of them in the source space)`
        : `Artifacts ${other} and ${key} differ only by case and would collide on case-insensitive file systems`);
    }
    seen.set(lower, key);
  }
}

export function writeTree(dir, artifacts) {
  assertUniqueKeys(artifacts);
  if (existsSync(dir)) {
    if (readdirSync(dir).length && !existsSync(join(dir, MARKER))) {
      throw new Error(`${dir} is not empty and is not a kinetic-sync export (no ${MARKER}); refusing to overwrite it`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARKER), 'Generated by kinetic-sync. Do not edit by hand; re-run export.\n');
  for (const { key, data } of artifacts) {
    const file = join(dir, ...key.split('/')) + '.json';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stableStringify(data));
  }
}

export function readTree(dir) {
  if (!existsSync(dir)) throw new Error(`No export found at ${dir}; run export first`);
  const out = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    const key = relative(dir, file).slice(0, -'.json'.length).split(sep).join('/');
    out.set(key, JSON.parse(readFileSync(file, 'utf8')));
  }
  return out;
}
```

```js
// lib/sync/state.mjs
// Hashes of each artifact as last seen after an apply, for drift detection.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from './normalize.mjs';

const stateFile = (projectDir, env) => join(projectDir, 'state', `${env}.json`);

export function loadState(projectDir, env) {
  const file = stateFile(projectDir, env);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function saveState(projectDir, env, state) {
  mkdirSync(join(projectDir, 'state'), { recursive: true });
  writeFileSync(stateFile(projectDir, env), stableStringify(state));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/store.test.mjs`
Expected: PASS, 7 tests. (`readdirSync({ recursive: true })` needs Node ≥ 20.1; `entry.parentPath ?? entry.path` covers 20.x and newer.)

- [ ] **Step 5: Commit**

```bash
git add lib/sync/store.mjs lib/sync/state.mjs lib/sync/store.test.mjs
git commit -m "feat(sync): export tree store with collision checks, and drift state"
```

---
### Task 6: Artifact plumbing and the space module

**Files:**
- Create: `lib/sync/fake-client.mjs`, `lib/sync/artifacts/common.mjs`, `lib/sync/artifacts/space.mjs`
- Test: `lib/sync/artifacts/space.test.mjs`

**Interfaces:**
- Consumes: `stripMeta`, `omit`, `sortBy`, `isEqual` (Task 1).
- Produces:
  - `fakeClient(routes, { mode, calls }) → Client & { calls }` — routes keyed `"METHOD api/path"` (query ignored; pass a shared `calls` array to log several clients together), value = JSON or `({ query, body }) => JSON`; unrouted GET throws an error with `.status = 404`; unrouted writes return `{}`. Also exports `TEST_CONFIG`.
  - `common.mjs`: `enc`, `listAll(client, api, path, field, query)`, `cached(ctx, key, fn)`, `spaceExport(client, ctx)`, `kappExports(client, ctx)`, `isFormExcluded(ctx, kapp, form)`, `upsertByName(client, api, basePath, desired, existing, key = 'name')`, `buildChangedIndexes(client, base, desired, existing)`.
  - `space.mjs` default export: Module `{ type: 'space', scope: 'space', ... }`.

- [ ] **Step 1: Write the test double**

```js
// lib/sync/fake-client.mjs
// Test double for http.mjs clients. Routes are "METHOD api/path" keys.
export const TEST_CONFIG = Object.freeze({
  data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {},
});

export function fakeClient(routes = {}, { mode = 'write', calls = [] } = {}) {
  async function request(api, method, path, { query, body } = {}) {
    if (mode === 'read' && method !== 'GET') throw new Error(`read-only fake got ${method} ${path}`);
    calls.push({ api, method, path, query, body });
    const route = routes[`${method} ${api}${path}`];
    if (route === undefined) {
      if (method !== 'GET') return {};
      const e = new Error(`404 ${api}${path}`);
      e.status = 404;
      throw e;
    }
    return typeof route === 'function' ? route({ query, body }) : structuredClone(route);
  }
  return { mode, calls, request, get: (api, path, query) => request(api, 'GET', path, { query }) };
}
```

- [ ] **Step 2: Write the failing tests**

```js
// lib/sync/artifacts/space.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import { listAll, upsertByName, buildChangedIndexes } from './common.mjs';
import space from './space.mjs';

test('listAll follows nextPageToken', async () => {
  const pages = [{ teams: [{ name: 'a' }], nextPageToken: 't1' }, { teams: [{ name: 'b' }] }];
  const c = fakeClient({ 'GET core/teams': () => pages.shift() });
  assert.deepEqual((await listAll(c, 'core', '/teams', 'teams')).map((t) => t.name), ['a', 'b']);
  assert.equal(c.calls[1].query.pageToken, 't1');
});

test('upsertByName PUTs changed, POSTs missing, skips equal, never deletes', async () => {
  const c = fakeClient();
  await upsertByName(c, 'core', '/spaceAttributeDefinitions',
    [{ name: 'a', d: 1 }, { name: 'b', d: 2 }, { name: 'c', d: 3 }],
    [{ name: 'a', d: 1 }, { name: 'b', d: 0 }, { name: 'z', d: 9 }]);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'PUT /spaceAttributeDefinitions/b', 'POST /spaceAttributeDefinitions',
  ]);
});

test('buildChangedIndexes starts one Build Index job for new or changed definitions only', async () => {
  const c = fakeClient();
  await buildChangedIndexes(c, '/kapps/k/forms/f',
    [{ name: 'values[A]', parts: ['values[A]'] }, { name: 'values[B]', parts: ['values[B]'] }],
    [{ name: 'values[A]', parts: ['values[A]'] }]);
  assert.deepEqual(c.calls, [{
    api: 'core', method: 'POST', path: '/kapps/k/forms/f/backgroundJobs', query: undefined,
    body: { type: 'Build Index', content: { indexes: ['values[B]'] } },
  }]);
  const d = fakeClient();
  await buildChangedIndexes(d, '/x', [{ name: 'a' }], [{ name: 'a' }]);
  assert.equal(d.calls.length, 0);
});

const RAW_SPACE = {
  name: 'Dev Space', slug: 'dev', oauthSigningKey: 'SIGNING-KEY', createdAt: 't', updatedBy: 'u',
  kapps: [{ slug: 'k' }], teams: [{}], models: [{}], webApis: [{}], webhooks: [],
  displayType: 'Display Page',
  spaceAttributeDefinitions: [{ name: 'b' }, { name: 'a' }],
  securityPolicyDefinitions: [{ name: 'Z', rule: 'true' }, { name: 'A', rule: 'false' }],
  securityPolicies: [{ endpoint: 'Team Access', name: 'Z' }, { endpoint: 'Discussion Creation', name: 'A' }],
  attributes: [{ name: 'Theme', values: ['x'] }, { name: 'Alpha', values: [] }],
  platformComponents: { task: { url: 'https://your-space.kinops.io/kinetic-task' } },
};

test('space list strips the signing key, nested collections and metadata, and sorts named lists', async () => {
  const c = fakeClient({ 'GET core/space': { space: RAW_SPACE } }, { mode: 'read' });
  const [a] = await space.list(c, { config: TEST_CONFIG });
  assert.equal(a.key, 'space');
  for (const k of ['oauthSigningKey', 'kapps', 'teams', 'models', 'webApis', 'webhooks', 'createdAt', 'updatedBy']) {
    assert.equal(k in a.data, false, k);
  }
  assert.deepEqual(a.data.spaceAttributeDefinitions.map((d) => d.name), ['a', 'b']);
  assert.deepEqual(a.data.securityPolicies.map((p) => p.endpoint), ['Discussion Creation', 'Team Access']);
  assert.deepEqual(a.data.attributes.map((p) => p.name), ['Alpha', 'Theme']);
  assert.deepEqual(c.calls[0].query, { export: 'true' });
});

test('space apply upserts definitions and PUTs settings only when changed, leaving unchanged platformComponents out', async () => {
  const existing = {
    name: 'Prod', slug: 'prod', displayType: 'Display Page',
    platformComponents: { task: { url: 'https://prod/kinetic-task' } },
    spaceAttributeDefinitions: [{ name: 'a', description: 'old' }],
  };
  const desired = { ...existing, displayType: 'Redirect', spaceAttributeDefinitions: [{ name: 'a', description: 'new' }, { name: 'b' }] };
  const c = fakeClient();
  await space.apply(c, { key: 'space', desired, source: desired, existing: { key: 'space', data: existing, meta: {} } }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'PUT /spaceAttributeDefinitions/a', 'POST /spaceAttributeDefinitions', 'PUT /space',
  ]);
  const body = c.calls.at(-1).body;
  assert.equal(body.displayType, 'Redirect');
  assert.equal('platformComponents' in body, false);
  assert.equal('slug' in body, false);
  assert.equal('spaceAttributeDefinitions' in body, false);

  const d = fakeClient();
  await space.apply(d, { key: 'space', desired: existing, source: existing, existing: { key: 'space', data: existing, meta: {} } }, {});
  assert.equal(d.calls.length, 0);
});

test('space apply sends platformComponents when an override changed it', async () => {
  const existing = { name: 'Prod', platformComponents: { app: { location: 'https://old' } } };
  const desired = { name: 'Prod', platformComponents: { app: { location: 'https://new' } } };
  const c = fakeClient();
  await space.apply(c, { key: 'space', desired, source: desired, existing: { key: 'space', data: existing, meta: {} } }, {});
  assert.deepEqual(c.calls.at(-1).body.platformComponents, { app: { location: 'https://new' } });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/space.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `common.mjs`**

```js
// lib/sync/artifacts/common.mjs
// Shared helpers for artifact modules.
import { isEqual } from '../normalize.mjs';

export const enc = encodeURIComponent;

export async function listAll(client, api, path, field, query = {}) {
  const out = [];
  let pageToken;
  do {
    const res = await client.get(api, path, { limit: 1000, ...query, pageToken });
    out.push(...(res?.[field] ?? []));
    pageToken = res?.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

// One fetch per list context (one environment read), shared by modules.
export function cached(ctx, key, fn) {
  ctx.cache ??= new Map();
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key);
}

export const spaceExport = (client, ctx) => cached(ctx, 'space', async () => (
  await client.get('core', '/space', { export: 'true' })
).space);

export const kappExports = (client, ctx) => cached(ctx, 'kapps', async () => {
  const excluded = new Set(ctx.config.exclude.kapps);
  const out = [];
  for (const k of await listAll(client, 'core', '/kapps', 'kapps')) {
    if (excluded.has(k.slug)) continue;
    out.push((await client.get('core', `/kapps/${enc(k.slug)}`, { export: 'true' })).kapp);
  }
  return out;
});

export function isFormExcluded(ctx, kappSlug, formSlug) {
  return ctx.config.exclude.forms.includes(`${kappSlug}/${formSlug}`);
}

// Create-or-update each desired item by key. Target-only items are left alone.
export async function upsertByName(client, api, basePath, desired = [], existing = [], key = 'name') {
  for (const item of desired ?? []) {
    const cur = (existing ?? []).find((e) => e[key] === item[key]);
    if (cur && isEqual(cur, item)) continue;
    if (cur) await client.request(api, 'PUT', `${basePath}/${enc(item[key])}`, { body: item });
    else await client.request(api, 'POST', basePath, { body: item });
  }
}

export async function buildChangedIndexes(client, base, desired = [], existing = []) {
  const changed = (desired ?? [])
    .filter((d) => !isEqual(d, (existing ?? []).find((e) => e.name === d.name)))
    .map((d) => d.name);
  if (!changed.length) return;
  await client.request('core', 'POST', `${base}/backgroundJobs`, {
    body: { type: 'Build Index', content: { indexes: changed } },
  });
}
```

- [ ] **Step 5: Implement `space.mjs`**

```js
// lib/sync/artifacts/space.mjs
// Space settings, attribute definitions and security policy definitions.
import { stripMeta, omit, sortBy, isEqual } from '../normalize.mjs';
import { spaceExport, upsertByName } from './common.mjs';

const DEFINITIONS = [
  'spaceAttributeDefinitions', 'teamAttributeDefinitions',
  'userAttributeDefinitions', 'userProfileAttributeDefinitions',
];
const NAMED = [...DEFINITIONS, 'securityPolicyDefinitions', 'attributes'];
// Exported as their own artifacts, or out of scope.
const NESTED = ['kapps', 'teams', 'models', 'webApis', 'webhooks'];
const NOT_SETTINGS = [...DEFINITIONS, 'securityPolicyDefinitions', 'slug'];

export default {
  type: 'space',
  scope: 'space',
  owns: (key) => key === 'space',
  namedCollections: [
    ...NAMED.map((field) => ({ field, key: 'name' })),
    { field: 'securityPolicies', key: 'endpoint' },
  ],

  async list(client, ctx) {
    const raw = await spaceExport(client, ctx);
    const data = stripMeta(omit(raw, ['oauthSigningKey', ...NESTED]));
    for (const f of NAMED) if (data[f]) data[f] = sortBy(data[f]);
    if (data.securityPolicies) data.securityPolicies = sortBy(data.securityPolicies, 'endpoint');
    return [{ key: 'space', data, meta: {} }];
  },

  async apply(client, item) {
    const d = item.desired;
    const cur = item.existing?.data ?? {};
    for (const f of DEFINITIONS) await upsertByName(client, 'core', `/${f}`, d[f], cur[f]);
    await upsertByName(client, 'core', '/securityPolicyDefinitions', d.securityPolicyDefinitions, cur.securityPolicyDefinitions);
    const settings = omit(d, NOT_SETTINGS);
    if (isEqual(settings, omit(cur, NOT_SETTINGS))) return;
    if (isEqual(settings.platformComponents, cur.platformComponents)) delete settings.platformComponents;
    await client.request('core', 'PUT', '/space', { body: settings });
  },
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/space.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add lib/sync/fake-client.mjs lib/sync/artifacts/common.mjs lib/sync/artifacts/space.mjs lib/sync/artifacts/space.test.mjs
git commit -m "feat(sync): artifact plumbing and space module"
```

---

### Task 7: Teams, models and file resources

**Files:**
- Create: `lib/sync/artifacts/teams.mjs`, `lib/sync/artifacts/models.mjs`, `lib/sync/artifacts/file-resources.mjs`
- Test: `lib/sync/artifacts/simple.test.mjs`

**Interfaces:**
- Consumes: `listAll`, `spaceExport`, `enc` (Task 6); `keyFor` (Task 5); `stripMeta`, `omit`, `sortBy` (Task 1).
- Produces: three Modules — `teams` (scope `team`, prunable), `models`, `file-resources`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/simple.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import teams from './teams.mjs';
import models from './models.mjs';
import fileResources from './file-resources.mjs';

const ctx = () => ({ config: TEST_CONFIG });

test('teams list keys by safe name, drops slug and memberships, keeps the slug in meta', async () => {
  const c = fakeClient({ 'GET core/teams': { teams: [
    { name: 'Departments::IT', slug: 'abc', description: 'd', memberships: [{ user: {} }], createdAt: 'x',
      attributes: [{ name: 'Z', values: [] }, { name: 'A', values: [] }] },
  ] } }, { mode: 'read' });
  const [t] = await teams.list(c, ctx());
  assert.equal(t.key, 'teams/Departments__IT');
  assert.deepEqual(t.data, { name: 'Departments::IT', description: 'd', attributes: [{ name: 'A', values: [] }, { name: 'Z', values: [] }] });
  assert.deepEqual(t.meta, { slug: 'abc' });
  assert.equal(c.calls[0].query.include, 'attributes');
});

test('teams apply PUTs by the target slug, POSTs new teams, prunes by slug', async () => {
  const c = fakeClient();
  const desired = { name: 'Ops', description: 'new' };
  await teams.apply(c, { key: 'teams/Ops', desired, existing: { data: { name: 'Ops' }, meta: { slug: 's1' } } }, {});
  await teams.apply(c, { key: 'teams/New', desired: { name: 'New' }, existing: null }, {});
  await teams.prune(c, { key: 'teams/Old', data: {}, meta: { slug: 's2' } });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['PUT /teams/s1', 'POST /teams', 'DELETE /teams/s2']);
  assert.deepEqual(c.calls[0].body, desired);
});

test('models come from the space export; new models are created minimally then fully PUT', async () => {
  const c = fakeClient({ 'GET core/space': { space: { models: [
    { name: 'People', status: 'Active', attributes: [{ name: 'b' }, { name: 'a' }], mappings: [], qualifications: [] },
  ] } } });
  const [m] = await models.list(c, ctx());
  assert.equal(m.key, 'models/People');
  assert.deepEqual(m.data.attributes.map((a) => a.name), ['a', 'b']);
  const w = fakeClient();
  await models.apply(w, { key: m.key, desired: m.data, existing: null }, {});
  assert.deepEqual(w.calls.map((x) => `${x.method} ${x.path}`), ['POST /models', 'PUT /models/People']);
  assert.deepEqual(w.calls[0].body, { name: 'People', status: 'Active' });
});

test('file resources list and upsert by name', async () => {
  const c = fakeClient({ 'GET core/fileResources': { fileResources: [{ name: 'docs', agentSlug: 'system', updatedAt: 'x' }] } });
  const [f] = await fileResources.list(c, ctx());
  assert.deepEqual(f, { key: 'file-resources/docs', data: { name: 'docs', agentSlug: 'system' }, meta: {} });
  const w = fakeClient();
  await fileResources.apply(w, { key: f.key, desired: f.data, existing: f }, {});
  await fileResources.apply(w, { key: f.key, desired: f.data, existing: null }, {});
  assert.deepEqual(w.calls.map((x) => `${x.method} ${x.path}`), ['PUT /fileResources/docs', 'POST /fileResources']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/simple.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/artifacts/teams.mjs
// Teams (without memberships: users are not promoted).
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { listAll, enc } from './common.mjs';

export default {
  type: 'teams',
  scope: 'team',
  owns: (key) => /^teams\/[^/]+$/.test(key),
  namedCollections: [{ field: 'attributes', key: 'name' }],

  async list(client) {
    const teams = await listAll(client, 'core', '/teams', 'teams', { include: 'attributes' });
    return sortBy(teams).map((t) => {
      const data = stripMeta(omit(t, ['slug', 'memberships']));
      if (data.attributes) data.attributes = sortBy(data.attributes);
      return { key: keyFor('teams', t.name), data, meta: { slug: t.slug } };
    });
  },

  async apply(client, item) {
    if (item.existing) await client.request('core', 'PUT', `/teams/${enc(item.existing.meta.slug)}`, { body: item.desired });
    else await client.request('core', 'POST', '/teams', { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/teams/${enc(existing.meta.slug)}`);
  },
};
```

```js
// lib/sync/artifacts/models.mjs
// Bridge models. PUT is a full replace, so the whole definition is sent.
import { stripMeta, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { spaceExport, enc } from './common.mjs';

export default {
  type: 'models',
  scope: null,
  owns: (key) => /^models\/[^/]+$/.test(key),

  async list(client, ctx) {
    const space = await spaceExport(client, ctx);
    return sortBy(space.models).map((m) => {
      const data = stripMeta(m);
      for (const f of ['attributes', 'qualifications', 'mappings']) if (data[f]) data[f] = sortBy(data[f]);
      return { key: keyFor('models', m.name), data, meta: {} };
    });
  },

  async apply(client, item) {
    const { name, status } = item.desired;
    if (!item.existing) await client.request('core', 'POST', '/models', { body: { name, status } });
    await client.request('core', 'PUT', `/models/${enc(name)}`, { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/models/${enc(existing.data.name)}`);
  },
};
```

```js
// lib/sync/artifacts/file-resources.mjs
// File resources (external file read paths).
import { stripMeta, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { enc } from './common.mjs';

export default {
  type: 'file-resources',
  scope: null,
  owns: (key) => /^file-resources\/[^/]+$/.test(key),

  async list(client) {
    const res = await client.get('core', '/fileResources');
    return sortBy(res?.fileResources).map((f) => ({ key: keyFor('file-resources', f.name), data: stripMeta(f), meta: {} }));
  },

  async apply(client, item) {
    if (item.existing) await client.request('core', 'PUT', `/fileResources/${enc(item.desired.name)}`, { body: item.desired });
    else await client.request('core', 'POST', '/fileResources', { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/fileResources/${enc(existing.data.name)}`);
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/simple.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/artifacts/teams.mjs lib/sync/artifacts/models.mjs lib/sync/artifacts/file-resources.mjs lib/sync/artifacts/simple.test.mjs
git commit -m "feat(sync): teams, models and file resources modules"
```

---

### Task 8: Connections and operations

**Files:**
- Create: `lib/sync/artifacts/connections.mjs`
- Test: `lib/sync/artifacts/connections.test.mjs`

**Interfaces:**
- Consumes: `cached`, `enc` (Task 6); `keyFor` (Task 5); `stripMeta`, `omit`, `sortBy` (Task 1).
- Produces: `stripSecrets(auth)`, `normalizeConnection(raw)`, `normalizeOperation(raw)`, default export `[connections, operations]` (two Modules). `connections.updatable === false`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/connections.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import { stripSecrets, normalizeConnection } from './connections.mjs';
import modules from './connections.mjs';

const [connections, operations] = modules;

const EXPORTED = {
  id: 'c-1', name: 'My API', type: 'http', lockVersion: 4, insertedAt: 'x', updatedAt: 'y',
  status: { healthy: false, events: [{ reason: 'Authorization: Basic c2VjcmV0' }] },
  secrets: {},
  config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc', password: null } },
  operations: [
    { id: 'o-2', connectionId: 'c-1', name: 'Zeta', config: { method: 'GET', path: '/z' }, lockVersion: 1 },
    { id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: { method: 'GET', path: '/a' } },
  ],
};

test('stripSecrets removes secret-looking fields but keeps identity and token URLs', () => {
  assert.deepEqual(stripSecrets({
    authType: 'client_credentials', clientId: 'id', clientSecret: null, tokenUrl: 'https://t', token: 'x', apiKey: 'k', username: 'u', password: 'p',
  }), { authType: 'client_credentials', clientId: 'id', tokenUrl: 'https://t', username: 'u' });
});

test('normalizeConnection drops status (which can hold credentials), secrets, metadata and operations', () => {
  assert.deepEqual(normalizeConnection(EXPORTED), {
    id: 'c-1', name: 'My API', type: 'http',
    config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc' } },
  });
});

test('connections and operations list from the Integrator export, keyed by name, ids kept', async () => {
  const c = fakeClient({
    'GET integrator/connections': [{ id: 'c-1', name: 'My API' }],
    'GET integrator/export/connections/c-1': EXPORTED,
  }, { mode: 'read' });
  const ctx = { config: TEST_CONFIG };
  const [conn] = await connections.list(c, ctx);
  assert.equal(conn.key, 'connections/My API');
  assert.deepEqual(conn.meta, { id: 'c-1' });
  const ops = await operations.list(c, ctx);
  assert.deepEqual(ops.map((o) => o.key), ['connections/My API/operations/Alpha', 'connections/My API/operations/Zeta']);
  assert.deepEqual(ops[1].data, { id: 'o-2', connectionId: 'c-1', name: 'Zeta', config: { method: 'GET', path: '/z' } });
  assert.equal(c.calls.filter((x) => x.path.startsWith('/export')).length, 1, 'export fetched once per context');
});

test('a new connection is imported with its id, supplied secrets and no operations', async () => {
  const c = fakeClient();
  const desired = normalizeConnection(EXPORTED);
  await connections.apply(c, { key: 'connections/My API', desired, existing: null }, { connectionSecrets: () => ({ password: 'pw' }) });
  assert.equal(c.calls[0].path, '/import/connections');
  assert.equal(c.calls[0].body.id, 'c-1');
  assert.deepEqual(c.calls[0].body.config.auth, { authType: 'basic', username: 'svc', password: 'pw' });
  assert.deepEqual(c.calls[0].body.operations, []);
});

test('an existing connection is never written', async () => {
  assert.equal(connections.updatable, false);
  await assert.rejects(
    connections.apply(fakeClient(), { key: 'k', desired: {}, existing: { data: {}, meta: { id: 'c-1' } } }, {}),
    /never updated automatically/,
  );
});

test('operations: import new with id, PUT existing, prune by id', async () => {
  const c = fakeClient();
  const op = { id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: {} };
  await operations.apply(c, { key: 'x', desired: op, existing: null }, {});
  await operations.apply(c, { key: 'x', desired: op, existing: { data: op, meta: { id: 'o-1', connectionId: 'c-1' } } }, {});
  await operations.prune(c, { key: 'x', data: op, meta: { id: 'o-1', connectionId: 'c-1' } });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /import/connections/c-1/operations', 'PUT /connections/c-1/operations/o-1', 'DELETE /connections/c-1/operations/o-1',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/connections.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/artifacts/connections.mjs
// Integrator connections and operations. Ids are kept identical across
// environments because forms and workflows reference them by UUID.
// Existing connections are never written: a PUT/PATCH carrying masked secrets
// would permanently wipe the target's credentials.
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { cached, enc } from './common.mjs';

const SECRET_FIELD = /(password|secret|token|apikey|api_key|privatekey|credential)/i;
const NOT_SECRET = new Set(['authType', 'tokenUrl']);

export function stripSecrets(auth) {
  if (!auth) return auth;
  return Object.fromEntries(Object.entries(auth).filter(([k]) => NOT_SECRET.has(k) || !SECRET_FIELD.test(k)));
}

export function normalizeConnection(raw) {
  const c = stripMeta(omit(raw, ['status', 'secrets', 'operations']));
  if (c.config?.auth) c.config = { ...c.config, auth: stripSecrets(c.config.auth) };
  return c;
}

export function normalizeOperation(raw) {
  return stripMeta(omit(raw, ['status']));
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
  owns: (key) => /^connections\/[^/]+$/.test(key),

  async list(client, ctx) {
    return (await exports(client, ctx)).map((c) => ({
      key: keyFor('connections', c.name), data: normalizeConnection(c), meta: { id: c.id },
    }));
  },

  async apply(client, item, ctx) {
    if (item.existing) throw new Error(`${item.key}: connections are never updated automatically`);
    const d = item.desired;
    const secrets = ctx.connectionSecrets(d.name);
    const config = d.config ? { ...d.config, auth: { ...d.config.auth, ...secrets } } : d.config;
    await client.request('integrator', 'POST', '/import/connections', { body: { ...d, config, operations: [] } });
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

  async apply(client, item) {
    const op = item.desired;
    const cid = enc(op.connectionId);
    if (item.existing) await client.request('integrator', 'PUT', `/connections/${cid}/operations/${enc(item.existing.meta.id)}`, { body: op });
    else await client.request('integrator', 'POST', `/import/connections/${cid}/operations`, { body: op });
  },

  async prune(client, existing) {
    await client.request('integrator', 'DELETE', `/connections/${enc(existing.meta.connectionId)}/operations/${enc(existing.meta.id)}`);
  },
};

export default [connections, operations];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/connections.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/artifacts/connections.mjs lib/sync/artifacts/connections.test.mjs
git commit -m "feat(sync): connections and operations with id retention and secret stripping"
```

---

### Task 9: Kapps and forms

**Files:**
- Create: `lib/sync/artifacts/kapps.mjs`, `lib/sync/artifacts/forms.mjs`
- Test: `lib/sync/artifacts/kapps-forms.test.mjs`

**Interfaces:**
- Consumes: `kappExports`, `isFormExcluded`, `upsertByName`, `buildChangedIndexes`, `enc` (Task 6); `keyFor` (Task 5); `stripMeta`, `omit`, `sortBy`, `isEqual` (Task 1).
- Produces: `normalizeKapp(raw)`, `normalizeForm(raw)`, default-export Modules `kapps` (scope `kapp`) and `forms` (scope `form`).

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/kapps-forms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import kapps, { normalizeKapp } from './kapps.mjs';
import forms, { normalizeForm } from './forms.mjs';

const RAW_KAPP = {
  slug: 'services', name: 'Services', createdAt: 'x', bundlePath: null,
  forms: [{ slug: 'b-form', name: 'B' }, { slug: 'a-form', name: 'A', status: 'Active', updatedAt: 'y' }],
  webApis: [{ slug: 'w' }], webhooks: [],
  categories: [{ slug: 'z', name: 'Z' }, { slug: 'a', name: 'A' }],
  formTypes: [{ name: 'Service' }],
  integrations: [{ name: 'Lookup', connectionId: 'c-1', operationId: 'o-1' }],
  indexDefinitions: [{ name: 'values[B]', status: 'Built', parts: ['values[B]'] }],
  securityPolicies: [{ endpoint: 'Kapp Display', name: 'Everyone' }],
};

test('normalizeKapp drops nested forms/webApis/webhooks, metadata and index status; sorts collections', () => {
  const k = normalizeKapp(RAW_KAPP);
  for (const f of ['forms', 'webApis', 'webhooks', 'createdAt']) assert.equal(f in k, false, f);
  assert.deepEqual(k.categories.map((c) => c.slug), ['a', 'z']);
  assert.deepEqual(k.indexDefinitions, [{ name: 'values[B]', parts: ['values[B]'] }]);
});

test('kapps and forms list from one kapp export per kapp and honour exclusions', async () => {
  const c = fakeClient({
    'GET core/kapps': { kapps: [{ slug: 'services' }, { slug: 'skipme' }] },
    'GET core/kapps/services': { kapp: RAW_KAPP },
  }, { mode: 'read' });
  const ctx = { config: { ...TEST_CONFIG, exclude: { kapps: ['skipme'], forms: ['services/b-form'] } } };
  const [k] = await kapps.list(c, ctx);
  assert.equal(k.key, 'kapps/services/kapp');
  const fs = await forms.list(c, ctx);
  assert.deepEqual(fs.map((f) => f.key), ['kapps/services/forms/a-form']);
  assert.deepEqual(fs[0].data, { slug: 'a-form', name: 'A', status: 'Active' });
  assert.equal(c.calls.filter((x) => x.path === '/kapps/services').length, 1);
  assert.deepEqual(c.calls.find((x) => x.path === '/kapps/services').query, { export: 'true' });
});

test('a new kapp is created, then its sub-collections upserted, then its settings PUT, then indexes built', async () => {
  const c = fakeClient();
  const desired = normalizeKapp(RAW_KAPP);
  await kapps.apply(c, { key: 'kapps/services/kapp', desired, existing: null }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /kapps',
    'POST /kapps/services/formTypes',
    'POST /kapps/services/categories',
    'POST /kapps/services/categories',
    'POST /kapps/services/integrations',
    'PUT /kapps/services',
    'POST /kapps/services/backgroundJobs',
  ]);
  assert.deepEqual(c.calls[0].body, { slug: 'services', name: 'Services' });
  const settings = c.calls[5].body;
  for (const f of ['categories', 'formTypes', 'integrations']) assert.equal(f in settings, false, f);
  assert.ok('indexDefinitions' in settings);
});

test('an unchanged kapp makes no calls', async () => {
  const c = fakeClient();
  const data = normalizeKapp(RAW_KAPP);
  await kapps.apply(c, { key: 'kapps/services/kapp', desired: data, existing: { data, meta: {} } }, {});
  assert.equal(c.calls.length, 0);
});

test('normalizeForm sorts named lists and strips index status', () => {
  const f = normalizeForm({
    slug: 'f', createdBy: 'x', attributes: [{ name: 'b' }, { name: 'a' }],
    indexDefinitions: [{ name: 'values[A]', status: 'New', parts: ['values[A]'] }],
    securityPolicies: [{ endpoint: 'Submission Access', name: 'X' }, { endpoint: 'Display', name: 'Y' }],
    categorizations: [{ category: { slug: 'z' } }, { category: { slug: 'a' } }],
    pages: [{ name: 'P2' }, { name: 'P1' }],
  });
  assert.deepEqual(f.attributes.map((a) => a.name), ['a', 'b']);
  assert.deepEqual(f.indexDefinitions, [{ name: 'values[A]', parts: ['values[A]'] }]);
  assert.deepEqual(f.securityPolicies.map((p) => p.endpoint), ['Display', 'Submission Access']);
  assert.deepEqual(f.categorizations.map((x) => x.category.slug), ['a', 'z']);
  assert.deepEqual(f.pages.map((p) => p.name), ['P2', 'P1'], 'page order is meaningful and kept');
});

test('forms: POST new, PUT existing, build changed indexes, prune', async () => {
  const c = fakeClient();
  const desired = { slug: 'f', indexDefinitions: [{ name: 'values[A]', parts: ['values[A]'] }] };
  await forms.apply(c, { key: 'kapps/k/forms/f', desired, existing: null }, {});
  await forms.apply(c, { key: 'kapps/k/forms/f', desired, existing: { data: desired, meta: {} } }, {});
  await forms.prune(c, { key: 'kapps/k/forms/f', data: desired, meta: {} });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /kapps/k/forms', 'POST /kapps/k/forms/f/backgroundJobs',
    'PUT /kapps/k/forms/f',
    'DELETE /kapps/k/forms/f',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/kapps-forms.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/artifacts/kapps.mjs
// Kapp settings plus the kapp-scoped collections the Core API manages
// through their own endpoints.
import { stripMeta, omit, sortBy, isEqual } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { kappExports, upsertByName, buildChangedIndexes, enc } from './common.mjs';

// Sub-collections with their own endpoints, in creation order, and their keys.
const SUB = [
  ['kappAttributeDefinitions', 'name'],
  ['formAttributeDefinitions', 'name'],
  ['categoryAttributeDefinitions', 'name'],
  ['securityPolicyDefinitions', 'name'],
  ['formTypes', 'name'],
  ['categories', 'slug'],
  ['integrations', 'name'],
];
const SUB_FIELDS = SUB.map(([f]) => f);
const NESTED = ['forms', 'webApis', 'webhooks'];

export function normalizeKapp(raw) {
  const k = stripMeta(omit(raw, NESTED));
  for (const [f, key] of SUB) if (k[f]) k[f] = sortBy(k[f], key);
  for (const f of ['attributes', 'fields']) if (k[f]) k[f] = sortBy(k[f]);
  if (k.indexDefinitions) k.indexDefinitions = sortBy(k.indexDefinitions.map((d) => omit(d, ['status'])));
  if (k.securityPolicies) k.securityPolicies = sortBy(k.securityPolicies, 'endpoint');
  return k;
}

export default {
  type: 'kapps',
  scope: 'kapp',
  owns: (key) => /^kapps\/[^/]+\/kapp$/.test(key),
  namedCollections: [
    ...SUB.map(([field, key]) => ({ field, key })),
    { field: 'attributes', key: 'name' },
    { field: 'fields', key: 'name' },
    { field: 'indexDefinitions', key: 'name' },
    { field: 'securityPolicies', key: 'endpoint' },
  ],

  async list(client, ctx) {
    return (await kappExports(client, ctx)).map((k) => ({
      key: keyFor('kapps', k.slug, 'kapp'), data: normalizeKapp(k), meta: {},
    }));
  },

  async apply(client, item) {
    const d = item.desired;
    const cur = item.existing?.data ?? {};
    const base = `/kapps/${enc(d.slug)}`;
    if (!item.existing) await client.request('core', 'POST', '/kapps', { body: { slug: d.slug, name: d.name } });
    for (const [f, key] of SUB) await upsertByName(client, 'core', `${base}/${f}`, d[f], cur[f], key);
    const settings = omit(d, SUB_FIELDS);
    if (!item.existing || !isEqual(settings, omit(cur, SUB_FIELDS))) {
      await client.request('core', 'PUT', base, { body: settings });
    }
    await buildChangedIndexes(client, base, d.indexDefinitions, cur.indexDefinitions);
  },

  // Deleting a kapp deletes its forms and submissions. Only via --prune kapps.
  async prune(client, existing) {
    await client.request('core', 'DELETE', `/kapps/${enc(existing.data.slug)}`);
  },
};
```

```js
// lib/sync/artifacts/forms.mjs
// Form definitions (pages, fields, integrations, index definitions, policies).
import { stripMeta, omit, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { kappExports, isFormExcluded, buildChangedIndexes, enc } from './common.mjs';

export function normalizeForm(raw) {
  const f = stripMeta(raw);
  for (const k of ['attributes', 'bridgedResources', 'integrations']) if (f[k]) f[k] = sortBy(f[k]);
  if (f.indexDefinitions) f.indexDefinitions = sortBy(f.indexDefinitions.map((d) => omit(d, ['status'])));
  if (f.securityPolicies) f.securityPolicies = sortBy(f.securityPolicies, 'endpoint');
  if (f.categorizations) f.categorizations = sortBy(f.categorizations, (c) => c.category?.slug);
  return f;
}

const kappSlugOf = (key) => key.split('/')[1];

export default {
  type: 'forms',
  scope: 'form',
  owns: (key) => /^kapps\/[^/]+\/forms\/[^/]+$/.test(key),
  namedCollections: [
    { field: 'attributes', key: 'name' },
    { field: 'bridgedResources', key: 'name' },
    { field: 'integrations', key: 'name' },
    { field: 'indexDefinitions', key: 'name' },
    { field: 'securityPolicies', key: 'endpoint' },
  ],

  async list(client, ctx) {
    const out = [];
    for (const kapp of await kappExports(client, ctx)) {
      for (const form of sortBy(kapp.forms, 'slug')) {
        if (isFormExcluded(ctx, kapp.slug, form.slug)) continue;
        out.push({ key: keyFor('kapps', kapp.slug, 'forms', form.slug), data: normalizeForm(form), meta: { kappSlug: kapp.slug } });
      }
    }
    return out;
  },

  async apply(client, item) {
    const base = `/kapps/${enc(kappSlugOf(item.key))}/forms`;
    const path = `${base}/${enc(item.desired.slug)}`;
    if (item.existing) await client.request('core', 'PUT', path, { body: item.desired });
    else await client.request('core', 'POST', base, { body: item.desired });
    await buildChangedIndexes(client, path, item.desired.indexDefinitions, item.existing?.data.indexDefinitions);
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `/kapps/${enc(kappSlugOf(existing.key))}/forms/${enc(existing.data.slug)}`);
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/kapps-forms.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/artifacts/kapps.mjs lib/sync/artifacts/forms.mjs lib/sync/artifacts/kapps-forms.test.mjs
git commit -m "feat(sync): kapps and forms modules with index builds"
```

---

### Task 10: Workflows and WebAPIs

**Files:**
- Create: `lib/sync/artifacts/workflows.mjs`, `lib/sync/artifacts/webapis.mjs`
- Test: `lib/sync/artifacts/workflows-webapis.test.mjs`

**Interfaces:**
- Consumes: `kappExports`, `spaceExport`, `isFormExcluded`, `enc` (Task 6); `keyFor` (Task 5); `stripMeta`, `pick`, `sortBy` (Task 1).
- Produces: `normalizeWorkflow(raw)`, `workflowBase(key)`; Modules `workflows` and `webapis`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/workflows-webapis.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import workflows, { normalizeWorkflow, workflowBase } from './workflows.mjs';
import webapis from './webapis.mjs';

const tree = { nodes: [{ id: 'start', definitionId: 'system_start_v1' }], connectors: [] };
const wf = (over) => ({
  id: 'w-1', name: 'Notify', event: 'Submission Submitted', filter: '', status: 'Active', versionId: 7,
  platformItemId: 'uuid', platformItemType: 'Form', createdAt: 'x', treeJson: tree, ...over,
});

test('normalizeWorkflow keeps only portable fields and requires treeJson', () => {
  assert.deepEqual(normalizeWorkflow({ workflow: wf() }), {
    name: 'Notify', event: 'Submission Submitted', filter: '', status: 'Active', treeJson: tree,
  });
  assert.throws(() => normalizeWorkflow(wf({ treeJson: undefined })), /without treeJson/);
});

test('workflowBase maps keys to the right scope endpoint', () => {
  assert.equal(workflowBase('workflows/space/User Created/Welcome'), '/workflows');
  assert.equal(workflowBase('kapps/k/workflows/Submission Created/Audit'), '/kapps/k/workflows');
  assert.equal(workflowBase('kapps/k/forms/f/workflows/Submission Submitted/Notify'), '/kapps/k/forms/f/workflows');
});

test('workflows list space, kapp and form workflows, keyed by event and name, id in meta', async () => {
  const c = fakeClient({
    'GET core/workflows': { workflows: [wf({ id: 's1', name: 'Welcome', event: 'User Created', platformItemType: 'Space' })] },
    'GET core/kapps': { kapps: [{ slug: 'k' }] },
    'GET core/kapps/k': { kapp: { slug: 'k', forms: [{ slug: 'f' }] } },
    'GET core/kapps/k/workflows': { workflows: [wf({ id: 'k1', name: 'Audit', event: 'Submission Created', platformItemType: 'Kapp' })] },
    'GET core/kapps/k/forms/f/workflows': { workflows: [{ id: 'w-1', name: 'Notify' }] },
    'GET core/kapps/k/forms/f/workflows/w-1': { workflow: wf() },
  }, { mode: 'read' });
  const list = await workflows.list(c, { config: TEST_CONFIG });
  assert.deepEqual(list.map((w) => [w.key, w.meta.id]), [
    ['workflows/space/User Created/Welcome', 's1'],
    ['kapps/k/workflows/Submission Created/Audit', 'k1'],
    ['kapps/k/forms/f/workflows/Submission Submitted/Notify', 'w-1'],
  ]);
  assert.equal(c.calls.find((x) => x.path === '/workflows').query.include, 'treeJson');
});

test('new workflows are created then given their tree; existing ones are PUT on the scoped path', async () => {
  const c = fakeClient({ 'POST core/kapps/k/forms/f/workflows': { workflow: { id: 'new-id' } } });
  const desired = normalizeWorkflow(wf());
  const key = 'kapps/k/forms/f/workflows/Submission Submitted/Notify';
  await workflows.apply(c, { key, desired, existing: null }, {});
  await workflows.apply(c, { key, desired, existing: { data: desired, meta: { id: 'old-id' } } }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /kapps/k/forms/f/workflows', 'PUT /kapps/k/forms/f/workflows/new-id', 'PUT /kapps/k/forms/f/workflows/old-id',
  ]);
  assert.equal('treeJson' in c.calls[0].body, false);
  assert.deepEqual(c.calls[1].body, desired);
});

test('webapis export space and kapp WebAPIs via /export and import with force', async () => {
  const c = fakeClient({
    'GET core/space': { space: { webApis: [{ slug: 'token' }] } },
    'GET core/webApis/token/export': { webApi: { slug: 'token', method: 'POST', treeXml: '<tree/>', updatedAt: 'x' } },
    'GET core/kapps': { kapps: [{ slug: 'k' }] },
    'GET core/kapps/k': { kapp: { slug: 'k', webApis: [{ slug: 'lookup' }] } },
    'GET core/kapps/k/webApis/lookup/export': { webApi: { slug: 'lookup', method: 'GET', treeXml: '<tree/>' } },
  }, { mode: 'read' });
  const list = await webapis.list(c, { config: TEST_CONFIG });
  assert.deepEqual(list.map((w) => w.key), ['webapis/token', 'kapps/k/webapis/lookup']);
  assert.deepEqual(list[0].data, { slug: 'token', method: 'POST', treeXml: '<tree/>' });

  const w = fakeClient();
  await webapis.apply(w, { key: 'kapps/k/webapis/lookup', desired: list[1].data, existing: null }, {});
  assert.deepEqual([w.calls[0].method, w.calls[0].path, w.calls[0].query], ['POST', '/kapps/k/webApiImport', { force: 'true' }]);
});

test('a space WebAPI whose import endpoint is missing becomes a warning, not a failure', async () => {
  const c = {
    async request() { const e = new Error('404'); e.status = 404; throw e; },
  };
  const warnings = [];
  await webapis.apply(c, { key: 'webapis/token', desired: { slug: 'token' }, existing: null }, { warn: (m) => warnings.push(m) });
  assert.match(warnings[0], /webapis\/token.*by hand/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/workflows-webapis.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/artifacts/workflows.mjs
// Core workflows at space, kapp and form scope. Matched across environments by
// scope + event + name; never by UUID (platformItemId differs per environment).
import { stripMeta, pick, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { kappExports, isFormExcluded, enc } from './common.mjs';

const PORTABLE = ['name', 'event', 'filter', 'status', 'notes', 'ownerEmail', 'treeJson'];

export function normalizeWorkflow(raw) {
  const w = raw?.workflow ?? raw;
  if (!w.treeJson) throw new Error(`Workflow "${w.name}" (${w.event}) came back without treeJson`);
  return stripMeta(pick(w, PORTABLE));
}

export function workflowBase(key) {
  const p = key.split('/');
  if (p[0] === 'workflows') return '/workflows';
  if (p[2] === 'workflows') return `/kapps/${enc(p[1])}/workflows`;
  return `/kapps/${enc(p[1])}/forms/${enc(p[3])}/workflows`;
}

const ofType = (type) => (w) => w.platformItemType === undefined || w.platformItemType === type;
const sorted = (list) => sortBy(list, (w) => `${w.event}\u0000${w.name}`);

export default {
  type: 'workflows',
  scope: null,
  owns: (key) => /^(workflows\/space|kapps\/[^/]+\/workflows|kapps\/[^/]+\/forms\/[^/]+\/workflows)\/[^/]+\/[^/]+$/.test(key),

  async list(client, ctx) {
    const out = [];
    const add = (prefix, w, id) => out.push({ key: keyFor(...prefix, w.event, w.name), data: normalizeWorkflow(w), meta: { id } });
    const space = await client.get('core', '/workflows', { include: 'treeJson' });
    for (const w of sorted(space?.workflows).filter(ofType('Space'))) add(['workflows', 'space'], w, w.id);
    for (const kapp of await kappExports(client, ctx)) {
      const k = enc(kapp.slug);
      const kw = await client.get('core', `/kapps/${k}/workflows`, { include: 'treeJson' });
      for (const w of sorted(kw?.workflows).filter(ofType('Kapp'))) add(['kapps', kapp.slug, 'workflows'], w, w.id);
      for (const form of sortBy(kapp.forms, 'slug')) {
        if (isFormExcluded(ctx, kapp.slug, form.slug)) continue;
        const base = `/kapps/${k}/forms/${enc(form.slug)}/workflows`;
        // The form-level list ignores include=treeJson; fetch each one.
        for (const summary of sorted((await client.get('core', base))?.workflows)) {
          const full = await client.get('core', `${base}/${enc(summary.id)}`);
          add(['kapps', kapp.slug, 'forms', form.slug, 'workflows'], full.workflow ?? full, summary.id);
        }
      }
    }
    return out;
  },

  async apply(client, item) {
    const base = workflowBase(item.key);
    let id = item.existing?.meta.id;
    if (!id) {
      const { treeJson, ...props } = item.desired;
      const created = await client.request('core', 'POST', base, { body: props });
      id = (created?.workflow ?? created).id;
    }
    // Always the scoped path: the flat /workflows/{id} PUT ignores `filter`.
    await client.request('core', 'PUT', `${base}/${enc(id)}`, { body: item.desired });
  },

  async prune(client, existing) {
    await client.request('core', 'DELETE', `${workflowBase(existing.key)}/${enc(existing.meta.id)}`);
  },
};
```

```js
// lib/sync/artifacts/webapis.mjs
// WebAPIs (definition + tree) at space and kapp scope, via export/import.
import { stripMeta, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { spaceExport, kappExports, enc } from './common.mjs';

const kappOf = (key) => (key.startsWith('kapps/') ? key.split('/')[1] : null);
const unwrap = (r) => stripMeta(r?.webApi ?? r);

export default {
  type: 'webapis',
  scope: null,
  owns: (key) => /^(kapps\/[^/]+\/)?webapis\/[^/]+$/.test(key),

  async list(client, ctx) {
    const out = [];
    for (const w of sortBy((await spaceExport(client, ctx)).webApis, 'slug')) {
      out.push({ key: keyFor('webapis', w.slug), data: unwrap(await client.get('core', `/webApis/${enc(w.slug)}/export`)), meta: {} });
    }
    for (const kapp of await kappExports(client, ctx)) {
      for (const w of sortBy(kapp.webApis, 'slug')) {
        const r = await client.get('core', `/kapps/${enc(kapp.slug)}/webApis/${enc(w.slug)}/export`);
        out.push({ key: keyFor('kapps', kapp.slug, 'webapis', w.slug), data: unwrap(r), meta: {} });
      }
    }
    return out;
  },

  async apply(client, item, ctx) {
    const kapp = kappOf(item.key);
    const path = kapp ? `/kapps/${enc(kapp)}/webApiImport` : '/webApiImport';
    try {
      await client.request('core', 'POST', path, { query: { force: 'true' }, body: item.desired });
    } catch (e) {
      if (kapp || e.status !== 404) throw e;
      ctx.warn(`${item.key}: this server has no space WebAPI import endpoint; recreate it by hand from the export file`);
    }
  },

  async prune(client, existing) {
    const kapp = kappOf(existing.key);
    const path = kapp ? `/kapps/${enc(kapp)}/webApis/${enc(existing.data.slug)}` : `/webApis/${enc(existing.data.slug)}`;
    await client.request('core', 'DELETE', path);
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/workflows-webapis.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/artifacts/workflows.mjs lib/sync/artifacts/webapis.mjs lib/sync/artifacts/workflows-webapis.test.mjs
git commit -m "feat(sync): workflows and WebAPIs modules"
```

---

### Task 11: Task API references (routines and handlers)

**Files:**
- Create: `lib/sync/artifacts/routines.mjs`, `lib/sync/artifacts/task-refs.mjs`
- Test: `lib/sync/artifacts/task-refs.test.mjs`

**Interfaces:**
- Consumes: `enc` (Task 6); `keyFor` (Task 5); `stripMeta`, `pick`, `sortBy` (Task 1).
- Produces: `listTrees(client, type) → tree[]` (Task API offset pagination); Module `routines` (`applyable: false`); `referencedDefinitionIds(artifacts) → Set`, `classifyRefs(ids, routineIds) → { handlers, routines }`; Module `task-refs` (`applyable: false`, `list` reads `ctx.collected`, `preflight(client, exportedMap)`).

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/task-refs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import routines, { listTrees } from './routines.mjs';
import taskRefs, { referencedDefinitionIds, classifyRefs } from './task-refs.mjs';

test('listTrees pages with limit/offset until a short page', async () => {
  const page = (n, start) => ({ trees: Array.from({ length: n }, (_, i) => ({ name: `r${start + i}`, definitionId: `routine_${start + i}` })) });
  const c = fakeClient({ 'GET task/trees': ({ query }) => (query.offset === 0 ? page(100, 0) : page(3, 100)) });
  assert.equal((await listTrees(c, 'Global Routine')).length, 103);
  assert.deepEqual(c.calls.map((x) => x.query.offset), [0, 100]);
  assert.equal(c.calls[0].query.type, 'Global Routine');
});

test('routines are exported for reference and are not applyable', async () => {
  const c = fakeClient({ 'GET task/trees': { trees: [{ name: 'Send Email', definitionId: 'routine_send_email_v1', treeJson: {}, versionId: 3, updatedAt: 'x' }] } });
  const [r] = await routines.list(c, { config: TEST_CONFIG });
  assert.deepEqual(r, { key: 'routines/Send Email', data: { name: 'Send Email', definitionId: 'routine_send_email_v1', treeJson: {} }, meta: {} });
  assert.equal(routines.applyable, false);
});

test('referencedDefinitionIds reads workflow treeJson and WebAPI treeXml', () => {
  const ids = referencedDefinitionIds([
    { key: 'a', data: { treeJson: { nodes: [{ definitionId: 'system_start_v1' }, { definitionId: 'smtp_email_send_v1' }] } } },
    { key: 'b', data: { treeXml: '<task definition_id="routine_send_email_v1"/><task definition_id="utilities_echo_v1"/>' } },
    { key: 'c', data: { name: 'no tree' } },
  ]);
  assert.deepEqual([...ids].sort(), ['routine_send_email_v1', 'smtp_email_send_v1', 'system_start_v1', 'utilities_echo_v1']);
});

test('classifyRefs drops system nodes and separates routines from handlers', () => {
  assert.deepEqual(
    classifyRefs(new Set(['system_start_v1', 'smtp_email_send_v1', 'routine_send_email_v1']), new Set(['routine_send_email_v1'])),
    { handlers: ['smtp_email_send_v1'], routines: ['routine_send_email_v1'] },
  );
});

test('task-refs list summarises what the collected artifacts use', async () => {
  const ctx = { config: TEST_CONFIG, collected: [
    { key: 'routines/Send Email', data: { definitionId: 'routine_send_email_v1' } },
    { key: 'kapps/k/forms/f/workflows/E/N', data: { treeJson: { nodes: [{ definitionId: 'routine_send_email_v1' }, { definitionId: 'smtp_email_send_v1' }] } } },
  ] };
  assert.deepEqual(await taskRefs.list(null, ctx), [{
    key: 'task-refs', data: { handlers: ['smtp_email_send_v1'], routines: ['routine_send_email_v1'] }, meta: {},
  }]);
});

test('task-refs preflight reports handlers and routines missing in the target', async () => {
  const c = fakeClient({
    'GET task/handlers/present_v1': { handler: {} },
    'GET task/trees': { trees: [{ definitionId: 'routine_here_v1' }] },
  }, { mode: 'read' });
  const exported = new Map([['task-refs', { handlers: ['present_v1', 'missing_v1'], routines: ['routine_here_v1', 'routine_gone_v1'] }]]);
  const { errors } = await taskRefs.preflight(c, exported);
  assert.deepEqual(errors, [
    'Handler missing_v1 is used by exported workflows but is not installed in the target',
    'Routine routine_gone_v1 is used by exported workflows but does not exist in the target',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/task-refs.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/artifacts/routines.mjs
// Global routines from the Task API. Exported for reference and checked for
// presence in the target; not created by apply.
import { stripMeta, pick, sortBy } from '../normalize.mjs';
import { keyFor } from '../store.mjs';

const PAGE = 100;

export async function listTrees(client, type) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await client.get('task', '/trees', { type, include: 'treeJson,details', limit: PAGE, offset });
    const trees = res?.trees ?? [];
    out.push(...trees);
    if (trees.length < PAGE) return out;
  }
}

export default {
  type: 'routines',
  scope: null,
  applyable: false,
  owns: (key) => /^routines\/[^/]+$/.test(key),

  async list(client) {
    return sortBy(await listTrees(client, 'Global Routine')).map((t) => ({
      key: keyFor('routines', t.name),
      data: stripMeta(pick(t, ['name', 'definitionId', 'notes', 'status', 'inputs', 'outputs', 'treeJson'])),
      meta: {},
    }));
  },
};
```

```js
// lib/sync/artifacts/task-refs.mjs
// Which handlers and routines the exported workflows/WebAPIs depend on, so the
// plan can fail early when a target is missing one.
import { enc } from './common.mjs';
import { listTrees } from './routines.mjs';

export function referencedDefinitionIds(artifacts) {
  const ids = new Set();
  for (const { data } of artifacts) {
    for (const n of data?.treeJson?.nodes ?? []) if (n.definitionId) ids.add(n.definitionId);
    if (typeof data?.treeXml === 'string') {
      for (const m of data.treeXml.matchAll(/definition_id="([^"]+)"/g)) ids.add(m[1]);
    }
  }
  return ids;
}

export function classifyRefs(ids, routineIds) {
  const handlers = [];
  const routines = [];
  for (const id of [...ids].sort()) {
    if (id.startsWith('system_')) continue;
    (routineIds.has(id) ? routines : handlers).push(id);
  }
  return { handlers, routines };
}

export default {
  type: 'task-refs',
  scope: null,
  applyable: false,
  owns: (key) => key === 'task-refs',

  // Must run after every other module: it reads what they collected.
  async list(client, ctx) {
    const collected = ctx.collected ?? [];
    const routineIds = new Set(collected.filter((a) => a.key.startsWith('routines/')).map((a) => a.data.definitionId));
    return [{ key: 'task-refs', data: classifyRefs(referencedDefinitionIds(collected), routineIds), meta: {} }];
  },

  async preflight(client, exported) {
    const refs = exported.get('task-refs');
    const errors = [];
    if (!refs) return { errors, warnings: [] };
    for (const id of refs.handlers) {
      try {
        await client.get('task', `/handlers/${enc(id)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        errors.push(`Handler ${id} is used by exported workflows but is not installed in the target`);
      }
    }
    const present = new Set((await listTrees(client, 'Global Routine')).map((t) => t.definitionId));
    for (const id of refs.routines) {
      if (!present.has(id)) errors.push(`Routine ${id} is used by exported workflows but does not exist in the target`);
    }
    return { errors, warnings: [] };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/task-refs.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/artifacts/routines.mjs lib/sync/artifacts/task-refs.mjs lib/sync/artifacts/task-refs.test.mjs
git commit -m "feat(sync): routine export and handler/routine presence checks"
```

---

### Task 12: Reference data

**Files:**
- Create: `lib/sync/artifacts/data.mjs`
- Test: `lib/sync/artifacts/data.test.mjs`

**Interfaces:**
- Consumes: `enc` (Task 6); `keyFor` (Task 5); `isEqual` (Task 1).
- Produces: `rowKey(values, keyFields) → string`, `walkSubmissions(client, kapp, form) → submission[]`, Module `data` with `mergeTargetOnly(desired, existingData)`; `apply` honours `ctx.prune.has('data')`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import data, { rowKey, walkSubmissions } from './data.mjs';

const sub = (id, createdAt, values) => ({ id, createdAt, values });
const route = 'GET core/kapps/ref/forms/codes/submissions';

test('rowKey is a stable tuple of the key fields', () => {
  assert.equal(rowKey({ A: '1', B: 'x', C: 'ignored' }, ['A', 'B']), '["1","x"]');
  assert.equal(rowKey({}, ['A']), '[null]');
});

test('walkSubmissions pages by createdAt and keeps rows that share a timestamp across the page boundary', async () => {
  // 25 rows on page one; the last two share createdAt T; page two (<= T) returns those two again plus three older.
  const first = Array.from({ length: 23 }, (_, i) => sub(`s${i}`, `2026-01-01T00:00:${String(59 - i).padStart(2, '0')}Z`, {}));
  const T = '2026-01-01T00:00:10Z';
  first.push(sub('t1', T, {}), sub('t2', T, {}));
  const second = [sub('t1', T, {}), sub('t2', T, {}), sub('t3', T, {}), sub('o1', '2026-01-01T00:00:05Z', {}), sub('o2', '2026-01-01T00:00:01Z', {})];
  const c = fakeClient({ [route]: ({ query }) => ({ submissions: query.q ? second : first }) }, { mode: 'read' });
  const all = await walkSubmissions(c, 'ref', 'codes');
  assert.equal(all.length, 28);
  assert.equal(new Set(all.map((s) => s.id)).size, 28);
  assert.equal(c.calls[1].query.q, `createdAt <= "${T}"`);
  assert.equal(c.calls[0].query.limit, 25);
});

test('walkSubmissions refuses to loop forever when a full page shares one timestamp', async () => {
  const same = Array.from({ length: 25 }, (_, i) => sub(`s${i}`, '2026-01-01T00:00:00Z', {}));
  const c = fakeClient({ [route]: () => ({ submissions: same }) }, { mode: 'read' });
  await assert.rejects(walkSubmissions(c, 'ref', 'codes'), /share createdAt/);
});

const config = { ...TEST_CONFIG, data: [{ kapp: 'ref', form: 'codes', key: ['Code'] }] };

test('data list keys rows, sorts them, and rejects duplicate or empty keys', async () => {
  const ok = fakeClient({ [route]: { submissions: [sub('2', 't2', { Code: 'B', Label: 'b' }), sub('1', 't1', { Code: 'A', Label: 'a' })] } });
  const [a] = await data.list(ok, { config });
  assert.equal(a.key, 'kapps/ref/forms/codes/data');
  assert.deepEqual(a.data, { key: ['Code'], rows: [{ Code: 'A', Label: 'a' }, { Code: 'B', Label: 'b' }] });
  assert.deepEqual(a.meta.ids, { '["A"]': '1', '["B"]': '2' });

  const dup = fakeClient({ [route]: { submissions: [sub('1', 't', { Code: 'A' }), sub('2', 't', { Code: 'A' })] } });
  await assert.rejects(data.list(dup, { config }), /duplicate key \["A"\]/);
  const empty = fakeClient({ [route]: { submissions: [sub('1', 't', { Code: '' })] } });
  await assert.rejects(data.list(empty, { config }), /empty key field/);
});

test('data list skips a form that does not exist in this environment', async () => {
  assert.deepEqual(await data.list(fakeClient({}), { config }), []);
});

test('mergeTargetOnly keeps target-only rows so they do not show as a perpetual diff', () => {
  const merged = data.mergeTargetOnly({ key: ['Code'], rows: [{ Code: 'A' }] }, { key: ['Code'], rows: [{ Code: 'Z' }, { Code: 'A', x: 1 }] });
  assert.deepEqual(merged.rows, [{ Code: 'A' }, { Code: 'Z' }]);
});

test('data apply creates missing rows, updates changed rows, leaves equal rows, prunes only when asked', async () => {
  const existing = {
    data: { key: ['Code'], rows: [{ Code: 'A', Label: 'old' }, { Code: 'B', Label: 'same' }, { Code: 'Z', Label: 'extra' }] },
    meta: { ids: { '["A"]': 'id-a', '["B"]': 'id-b', '["Z"]': 'id-z' } },
  };
  const source = { key: ['Code'], rows: [{ Code: 'A', Label: 'new' }, { Code: 'B', Label: 'same' }, { Code: 'C', Label: 'c' }] };
  const item = { key: 'kapps/ref/forms/codes/data', source, desired: source, existing };
  const c = fakeClient();
  await data.apply(c, item, { prune: new Set() });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['PUT /submissions/id-a', 'POST /kapps/ref/forms/codes/submissions']);
  assert.deepEqual(c.calls[0].body, { values: { Code: 'A', Label: 'new' } });

  const p = fakeClient();
  await data.apply(p, item, { prune: new Set(['data']) });
  assert.equal(p.calls.at(-1).method, 'DELETE');
  assert.equal(p.calls.at(-1).path, '/submissions/id-z');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/data.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/sync/artifacts/data.mjs
// Reference-data submissions for forms allowlisted in kinetic-sync.config.json,
// matched across environments by their configured key fields.
import { isEqual } from '../normalize.mjs';
import { keyFor } from '../store.mjs';
import { enc } from './common.mjs';

const PAGE = 25;

export function rowKey(values, keyFields) {
  return JSON.stringify(keyFields.map((f) => values?.[f] ?? null));
}

// Submissions come newest first. Cursor with `<=` on the last createdAt and
// de-duplicate by id so rows sharing a timestamp across pages are kept.
export async function walkSubmissions(client, kapp, form) {
  const seen = new Map();
  let last = null;
  for (;;) {
    const q = last ? `createdAt <= "${last}"` : undefined;
    const res = await client.get('core', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { include: 'details,values', limit: PAGE, q });
    const page = res?.submissions ?? [];
    let fresh = 0;
    for (const s of page) if (!seen.has(s.id)) { seen.set(s.id, s); fresh++; }
    if (page.length < PAGE) break;
    if (fresh === 0) throw new Error(`${kapp}/${form}: more than ${PAGE} submissions share createdAt ${last}; cannot page reliably`);
    last = page[page.length - 1].createdAt;
  }
  return [...seen.values()];
}

const sortRows = (rows, keyFields) => [...rows].sort((a, b) => rowKey(a, keyFields).localeCompare(rowKey(b, keyFields)));
const formOf = (key) => { const p = key.split('/'); return { kapp: p[1], form: p[3] }; };

export default {
  type: 'data',
  scope: null,
  owns: (key) => /^kapps\/[^/]+\/forms\/[^/]+\/data$/.test(key),

  async list(client, ctx) {
    const out = [];
    for (const { kapp, form, key } of ctx.config.data) {
      let subs;
      try {
        subs = await walkSubmissions(client, kapp, form);
      } catch (e) {
        if (e.status === 404) continue;
        throw e;
      }
      const rows = new Map();
      const ids = {};
      for (const s of subs) {
        if (key.some((f) => s.values?.[f] === undefined || s.values[f] === null || s.values[f] === '')) {
          throw new Error(`${kapp}/${form}: submission ${s.id} has an empty key field (${key.join(', ')})`);
        }
        const k = rowKey(s.values, key);
        if (rows.has(k)) throw new Error(`${kapp}/${form}: duplicate key ${k} (submissions ${ids[k]} and ${s.id})`);
        rows.set(k, s.values);
        ids[k] = s.id;
      }
      out.push({ key: keyFor('kapps', kapp, 'forms', form, 'data'), data: { key, rows: sortRows([...rows.values()], key) }, meta: { ids } });
    }
    return out;
  },

  mergeTargetOnly(desired, existing) {
    if (!existing) return desired;
    const have = new Set(desired.rows.map((r) => rowKey(r, desired.key)));
    const extra = existing.rows.filter((r) => !have.has(rowKey(r, desired.key)));
    return extra.length ? { ...desired, rows: sortRows([...desired.rows, ...extra], desired.key) } : desired;
  },

  async apply(client, item, ctx) {
    const { kapp, form } = formOf(item.key);
    const keyFields = item.source.key;
    const ids = item.existing?.meta.ids ?? {};
    const current = new Map((item.existing?.data.rows ?? []).map((v) => [rowKey(v, keyFields), v]));
    for (const values of item.source.rows) {
      const k = rowKey(values, keyFields);
      if (!ids[k]) await client.request('core', 'POST', `/kapps/${enc(kapp)}/forms/${enc(form)}/submissions`, { body: { values } });
      else if (!isEqual(current.get(k), values)) await client.request('core', 'PUT', `/submissions/${enc(ids[k])}`, { body: { values } });
    }
    if (ctx.prune.has('data')) {
      const wanted = new Set(item.source.rows.map((v) => rowKey(v, keyFields)));
      for (const [k, id] of Object.entries(ids)) {
        if (!wanted.has(k)) await client.request('core', 'DELETE', `/submissions/${enc(id)}`);
      }
    }
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/data.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/artifacts/data.mjs lib/sync/artifacts/data.test.mjs
git commit -m "feat(sync): reference data with key matching and tie-safe paging"
```

---
### Task 13: Registry, leftovers, `init` and `export` commands, CLI

**Files:**
- Create: `lib/sync/artifacts/index.mjs`, `lib/sync/leftovers.mjs`, `lib/sync/commands.mjs`, `kinetic-sync.mjs`
- Test: `lib/sync/artifacts/index.test.mjs`, `lib/sync/leftovers.test.mjs`, `lib/sync/commands.test.mjs`

**Interfaces:**
- Consumes: every module from Tasks 6–12; `createClient` (Task 4); loaders (Task 3); `writeTree` (Task 5); `ENV_BOUND_FIELDS` (Task 1); `replaceStrings` (Task 2).
- Produces:
  - `index.mjs`: `MODULES` (apply order), `moduleFor(key)`, `PRUNABLE` (type names).
  - `leftovers.mjs`: `findSourceHostStrings(artifacts, sourceUrl, scopeOf) → [{ key, path, value }]`, `uncoveredFor(hits, overrides, sourceUrl)`.
  - `commands.mjs`: `exportArtifacts(client, config) → Artifact[]`, `runInit({ projectDir, log })`, `runExport({ projectDir, envName, log, clientFactory = createClient })`. Every `run*` returns an exit code.
  - `kinetic-sync.mjs`: CLI.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/artifacts/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, moduleFor, PRUNABLE } from './index.mjs';

const SAMPLE_KEYS = {
  space: 'space',
  teams: 'teams/Ops',
  models: 'models/People',
  'file-resources': 'file-resources/docs',
  connections: 'connections/My API',
  operations: 'connections/My API/operations/Get Thing',
  kapps: 'kapps/services/kapp',
  forms: 'kapps/services/forms/data',
  webapis: 'kapps/services/webapis/lookup',
  workflows: 'kapps/services/forms/request/workflows/Submission Submitted/Notify',
  data: 'kapps/services/forms/codes/data',
  routines: 'routines/Send Email',
  'task-refs': 'task-refs',
};

test('every sample key is owned by exactly one module', () => {
  for (const [type, key] of Object.entries(SAMPLE_KEYS)) {
    const owners = MODULES.filter((m) => m.owns(key)).map((m) => m.type);
    assert.deepEqual(owners, [type], key);
  }
  assert.equal(moduleFor('webapis/token').type, 'webapis');
  assert.equal(moduleFor('workflows/space/User Created/Welcome').type, 'workflows');
  assert.equal(moduleFor('kapps/k/workflows/Submission Created/Audit').type, 'workflows');
  assert.equal(moduleFor('nonsense/thing'), undefined);
});

test('modules are in dependency order and task-refs runs last', () => {
  const order = MODULES.map((m) => m.type);
  const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  before('space', 'teams');
  before('connections', 'operations');
  before('operations', 'kapps');
  before('kapps', 'forms');
  before('forms', 'workflows');
  before('workflows', 'data');
  assert.equal(order.at(-1), 'task-refs');
  assert.ok(PRUNABLE.includes('data') && PRUNABLE.includes('teams') && !PRUNABLE.includes('space'));
});
```

```js
// lib/sync/leftovers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSourceHostStrings, uncoveredFor } from './leftovers.mjs';

const SRC = 'https://dev-space.kinops.io';
const artifacts = [
  { key: 'space', data: { platformComponents: { task: { url: `${SRC}/kinetic-task` } }, attributes: [{ name: 'Web Server Url', values: [SRC] }] } },
  { key: 'connections/Self', data: { config: { baseUrl: SRC, auth: { tokenUrl: `${SRC}/app/token` } } } },
  { key: 'teams/Ops', data: { description: 'no urls here' } },
];
const scopeOf = (k) => (k === 'space' ? 'space' : null);

test('findSourceHostStrings reports name-addressed paths and skips env-bound fields', () => {
  assert.deepEqual(findSourceHostStrings(artifacts, SRC, scopeOf).map((h) => `${h.key} ${h.path}`), [
    'space attributes.Web Server Url.values.0',
    'connections/Self config.baseUrl',
    'connections/Self config.auth.tokenUrl',
  ]);
});

test('uncoveredFor drops hits handled by an artifact override path or a replace rule', () => {
  const hits = findSourceHostStrings(artifacts, SRC, scopeOf);
  const overrides = {
    artifacts: { space: { 'attributes.Web Server Url': ['{{targetUrl}}'] }, 'connections/Self': { 'config.baseUrl': 'x' } },
    replace: [],
  };
  assert.deepEqual(uncoveredFor(hits, overrides, SRC).map((h) => h.path), ['config.auth.tokenUrl']);
  assert.deepEqual(uncoveredFor(hits, { artifacts: {}, replace: [{ from: 'dev-space.kinops.io', to: 'prod.kinops.io' }] }, SRC), []);
});
```

```js
// lib/sync/commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient } from './fake-client.mjs';
import { runInit, runExport } from './commands.mjs';
import { readTree } from './store.mjs';

export function emptySpaceRoutes(space = {}) {
  return {
    'GET core/space': { space: { name: 'Space', slug: 'space', ...space } },
    'GET core/teams': { teams: [] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [],
    'GET core/kapps': { kapps: [] },
    'GET core/workflows': { workflows: [] },
    'GET task/trees': { trees: [] },
  };
}

export function tempProject(envs = { dev: { url: 'https://dev.example.com', readOnly: true } }) {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-project-'));
  mkdirSync(join(dir, 'environments'));
  for (const [name, def] of Object.entries(envs)) {
    writeFileSync(join(dir, 'environments', `${name}.json`), JSON.stringify(def));
    const k = name.toUpperCase();
    writeFileSync(join(dir, `.env.${name}`), `KINETIC_${k}_USERNAME=u\nKINETIC_${k}_PASSWORD=p\n`);
  }
  return dir;
}

test('init scaffolds a project and never overwrites existing files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksync-init-'));
  const out = [];
  assert.equal(await runInit({ projectDir: dir, log: (m) => out.push(m) }), 0);
  for (const f of ['kinetic-sync.config.json', 'environments/dev.json', '.gitignore']) assert.ok(existsSync(join(dir, f)), f);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\.env\.\*/);
  writeFileSync(join(dir, 'environments/dev.json'), '{"url":"https://mine"}');
  await runInit({ projectDir: dir, log: (m) => out.push(m) });
  assert.equal(readFileSync(join(dir, 'environments/dev.json'), 'utf8'), '{"url":"https://mine"}');
  assert.ok(out.some((m) => m.includes('exists')));
});

test('export reads with a read-only client and writes the export tree', async () => {
  const dir = tempProject();
  const modes = [];
  const clientFactory = ({ mode }) => { modes.push(mode); return fakeClient(emptySpaceRoutes({ oauthSigningKey: 'k' }), { mode }); };
  const out = [];
  assert.equal(await runExport({ projectDir: dir, envName: 'dev', log: (m) => out.push(m), clientFactory }), 0);
  assert.deepEqual(modes, ['read']);
  const tree = readTree(join(dir, 'export'));
  assert.deepEqual([...tree.keys()].sort(), ['space', 'task-refs']);
  assert.equal('oauthSigningKey' in tree.get('space'), false);
  assert.ok(out[0].startsWith('Exported 2 artifacts from dev'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/artifacts/index.test.mjs lib/sync/leftovers.test.mjs lib/sync/commands.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the registry**

```js
// lib/sync/artifacts/index.mjs
// Every artifact module, in apply (dependency) order. task-refs must be last:
// it summarises what the other modules collected.
import space from './space.mjs';
import teams from './teams.mjs';
import models from './models.mjs';
import fileResources from './file-resources.mjs';
import connectionModules from './connections.mjs';
import kapps from './kapps.mjs';
import forms from './forms.mjs';
import webapis from './webapis.mjs';
import workflows from './workflows.mjs';
import data from './data.mjs';
import routines from './routines.mjs';
import taskRefs from './task-refs.mjs';

export const MODULES = [
  space, teams, models, fileResources, ...connectionModules,
  kapps, forms, webapis, workflows, data, routines, taskRefs,
];

export const moduleFor = (key) => MODULES.find((m) => m.owns(key));

// `data` prunes rows inside its own apply step rather than whole artifacts.
export const PRUNABLE = [...MODULES.filter((m) => m.prune).map((m) => m.type), 'data'];
```

- [ ] **Step 4: Implement leftovers**

```js
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
```

- [ ] **Step 5: Implement `commands.mjs` (init + export; plan/apply arrive in Tasks 16–17)**

```js
// lib/sync/commands.mjs
// Orchestration for the CLI commands. Each run* returns a process exit code.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient } from './http.mjs';
import { loadEnvironment, loadConfig, loadOverrides, listOverrideEnvs } from './env.mjs';
import { writeTree } from './store.mjs';
import { stableStringify } from './normalize.mjs';
import { MODULES, moduleFor } from './artifacts/index.mjs';
import { findSourceHostStrings, uncoveredFor } from './leftovers.mjs';

export const exportDir = (projectDir) => join(projectDir, 'export');
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const strip = (artifacts) => artifacts.map(({ key, data }) => ({ key, data }));

export async function exportArtifacts(client, config) {
  const ctx = { config, collected: [] };
  for (const mod of MODULES) ctx.collected.push(...(await mod.list(client, ctx)));
  return ctx.collected;
}

const INIT_FILES = {
  'kinetic-sync.config.json': stableStringify({
    data: [],
    exclude: { kapps: [], forms: [] },
    envBoundAttributes: { space: [], kapp: [], form: [], team: [], category: [] },
  }),
  'environments/dev.json': stableStringify({ url: 'https://your-space.kinops.io', readOnly: true }),
  '.gitignore': '# Credentials, pre-apply backups and plan records stay on this machine.\n.env.*\nbackups/\nplans/\n',
};

export async function runInit({ projectDir, log }) {
  for (const [rel, content] of Object.entries(INIT_FILES)) {
    const file = join(projectDir, rel);
    if (existsSync(file)) { log(`  exists   ${rel}`); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    log(`  created  ${rel}`);
  }
  log(`\nNext: edit environments/dev.json, put credentials in .env.dev, then run export --env dev.`);
  return 0;
}

export async function runExport({ projectDir, envName, log, clientFactory = createClient }) {
  const env = loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const client = clientFactory({ env, mode: 'read' });
  const artifacts = await exportArtifacts(client, config);
  writeTree(exportDir(projectDir), strip(artifacts));
  log(`Exported ${artifacts.length} artifacts from ${env.name} to ${exportDir(projectDir)}`);
  const counts = new Map();
  for (const a of artifacts) counts.set(moduleFor(a.key).type, (counts.get(moduleFor(a.key).type) ?? 0) + 1);
  for (const [type, n] of counts) log(`  ${type.padEnd(16)} ${n}`);

  const hits = findSourceHostStrings(artifacts, env.url, (k) => moduleFor(k)?.scope);
  const host = new URL(env.url).host;
  const targets = listOverrideEnvs(projectDir).filter((t) => t !== envName);
  if (hits.length && !targets.length) {
    log(`\n${hits.length} value(s) contain ${host}. Add overrides/<env>.json for each target before promoting.`);
  }
  for (const target of targets) {
    const left = uncoveredFor(hits, loadOverrides(projectDir, target), env.url);
    if (!left.length) continue;
    log(`\n${left.length} value(s) still contain ${host} with no override for "${target}":`);
    for (const h of left.slice(0, 50)) log(`  ${h.key}  ${h.path}`);
    if (left.length > 50) log(`  ... and ${left.length - 50} more`);
  }
  return 0;
}
```

- [ ] **Step 6: Implement the CLI**

```js
#!/usr/bin/env node
// kinetic-sync: export a Kinetic Platform space into a project directory and
// promote it into another environment. See docs/PROMOTING.md.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runInit, runExport, runPlan, runApply } from './lib/sync/commands.mjs';
import { PRUNABLE } from './lib/sync/artifacts/index.mjs';

const USAGE = `Usage:
  node kinetic-sync.mjs init   [--project <dir>]
  node kinetic-sync.mjs export [--project <dir>] --env <name>
  node kinetic-sync.mjs plan   [--project <dir>] --to <name> [--overwrite-drift]
  node kinetic-sync.mjs apply  [--project <dir>] --to <name> [--yes] [--overwrite-drift] [--prune <type>]...

--project defaults to the current directory.
--prune types: ${PRUNABLE.join(', ')}`;

const OPTIONS = {
  project: { type: 'string' },
  env: { type: 'string' },
  to: { type: 'string' },
  yes: { type: 'boolean' },
  'overwrite-drift': { type: 'boolean' },
  prune: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
};

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  if (!command || command === 'help' || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const projectDir = resolve(values.project ?? process.cwd());
  const log = (m) => console.log(m);
  const need = (flag) => {
    if (!values[flag]) throw new Error(`${command} needs --${flag} <environment>\n\n${USAGE}`);
    return values[flag];
  };
  switch (command) {
    case 'init': return runInit({ projectDir, log });
    case 'export': return runExport({ projectDir, envName: need('env'), log });
    case 'plan': return runPlan({ projectDir, envName: need('to'), overwriteDrift: values['overwrite-drift'], log });
    case 'apply': return runApply({
      projectDir, envName: need('to'), yes: values.yes, prune: values.prune ?? [],
      overwriteDrift: values['overwrite-drift'], log,
    });
    default: throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(`kinetic-sync: ${e.message}`); process.exitCode = 1; },
);
```

Until Task 16/17 land, add these temporary stubs at the end of `commands.mjs` so the CLI imports resolve (Tasks 16 and 17 replace them):

```js
export async function runPlan() { throw new Error('plan is not implemented yet'); }
export async function runApply() { throw new Error('apply is not implemented yet'); }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test lib/sync/artifacts/index.test.mjs lib/sync/leftovers.test.mjs lib/sync/commands.test.mjs`
Expected: PASS, 6 tests.

Run: `node kinetic-sync.mjs --help; echo "exit=$?"`
Expected: usage text, `exit=0`. Run `node kinetic-sync.mjs; echo "exit=$?"` → usage, `exit=1`. Run `node kinetic-sync.mjs export; echo "exit=$?"` → `kinetic-sync: export needs --env <environment>` and `exit=1`.

- [ ] **Step 8: Run the whole suite**

Run: `node --test lib/sync/*.test.mjs lib/sync/artifacts/*.test.mjs`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add kinetic-sync.mjs lib/sync/commands.mjs lib/sync/commands.test.mjs lib/sync/leftovers.mjs lib/sync/leftovers.test.mjs lib/sync/artifacts/index.mjs lib/sync/artifacts/index.test.mjs
git commit -m "feat(sync): module registry, init and export commands, CLI"
```

---

### Task 14: Verify export against a real source space (read-only)

This task changes tool code only where the real API differs from what the modules assume. It never writes to the source space: `export` only opens a `read` client, and the environment is marked `readOnly`.

**Files:**
- Modify only if a check below fails: the relevant `lib/sync/artifacts/*.mjs` and its test.
- Project directory: **outside this repository** (e.g. a sibling directory the user names). Nothing from it is committed to this repo.

- [ ] **Step 1: Create a project directory for the source space**

Ask the user for the project directory path and the source environment's name and URL. Then:

```bash
node kinetic-sync.mjs init --project <project-dir>
```

Edit `<project-dir>/environments/<source-env>.json` to `{ "url": "<source-url>", "readOnly": true }` (rename `dev.json` if the source is not called `dev`), and write `<project-dir>/.env.<source-env>` with `KINETIC_<SOURCE_ENV>_USERNAME` / `KINETIC_<SOURCE_ENV>_PASSWORD`, then `chmod 600` it.

- [ ] **Step 2: Export**

Run: `node kinetic-sync.mjs export --project <project-dir> --env <source-env>`
Expected: `Exported N artifacts` with per-type counts. Compare counts with the space (kapps, forms, teams, connections, operations, workflows) — a type with 0 that the space clearly has means a list endpoint or response field name is wrong. Fix the module, adjust its unit test to the real response shape (synthetic values only), re-run.

- [ ] **Step 3: Confirm no secrets were exported**

Run:
```bash
grep -rEil '"(password|clientSecret|client_secret|apiKey|token|oauthSigningKey)"' <project-dir>/export; echo "exit=$?"
grep -rEl 'Basic [A-Za-z0-9+/=]{8,}|Bearer [A-Za-z0-9._-]{16,}' <project-dir>/export; echo "exit=$?"
```
Expected: no file names, `exit=1` both times. Any hit: extend `stripSecrets` / the module's normalizer and add a unit test reproducing the shape.

- [ ] **Step 4: Spot-check completeness**

Open one form, one kapp, one workflow, one connection and one operation file. Confirm:
- forms have `pages` with elements, `integrations`, `indexDefinitions`, `attributes`;
- workflows have `treeJson.nodes` and `treeJson.connectors`;
- the kapp has `categories`, `securityPolicyDefinitions`, `integrations`;
- the connection has `config.baseUrl` and `id`, no secrets;
- `task-refs.json` lists the handlers the space's workflows use.

If the kapp `?export=true` response lacks form detail (e.g. no `pages`), change `forms.list` to fetch each form with `GET /kapps/{kapp}/forms/{form}?export=true` and update its test.

- [ ] **Step 5: Prove the export is deterministic**

```bash
git -C <project-dir> init -q && git -C <project-dir> add -A && git -C <project-dir> commit -qm "first export"
node kinetic-sync.mjs export --project <project-dir> --env <source-env>
git -C <project-dir> status --porcelain export
```
Expected: no output. Any changed file: diff it, identify the volatile field or unstable ordering, add it to the right normalizer with a unit test, and repeat until two consecutive exports are identical.

- [ ] **Step 6: Run the suite and commit any fixes**

Run: `node --test lib/sync/*.test.mjs lib/sync/artifacts/*.test.mjs` → all PASS.
Run: `git grep -n -i -E "<source-space-name>|<source-host>"` in this repo → no output (no customer specifics leaked into fixes).

```bash
git add lib/sync
git commit -m "fix(sync): align artifact modules with real API responses"
```
(Skip the commit if nothing changed.)

---

### Task 15: Plan engine and report

**Files:**
- Create: `lib/sync/plan.mjs`, `lib/sync/report.mjs`
- Test: `lib/sync/plan.test.mjs`, `lib/sync/report.test.mjs`

**Interfaces:**
- Consumes: `isEqual`, `hashOf`, `withoutEnvBound`, `sortBy` (Task 1); `prepareDesired` (Task 2); Module shape.
- Produces:
  - `plan.mjs`: `diffValues(from, to) → [{ path, from, to }]`, `mergeTargetOnly(desired, existing, specs)`, `buildPlan({ modules, exported, target, state, overrides, vars, config, overwriteDrift }) → { items, targetOnly, errors, warnings }`, `integrationRefs(data) → [{ connectionId, operationId }]`, `preflightChecks({ plan, exported, target, config, hasSecrets }) → { errors, warnings }`. Plan items carry `scope`.
  - `report.mjs`: `show(value)`, `formatPlan(plan, envName, { prune })`, `planRecord(plan)`.

- [ ] **Step 1: Write the failing tests**

```js
// lib/sync/plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffValues, mergeTargetOnly, buildPlan, integrationRefs, preflightChecks } from './plan.mjs';
import { hashOf } from './normalize.mjs';

const mod = (type, re, extra = {}) => ({ type, scope: null, owns: (k) => re.test(k), ...extra });
const MODULES = [
  mod('space', /^space$/, { scope: 'space', namedCollections: [{ field: 'spaceAttributeDefinitions', key: 'name' }] }),
  mod('teams', /^teams\//, { scope: 'team' }),
  mod('connections', /^connections\/[^/]+$/, { updatable: false }),
  mod('operations', /^connections\/[^/]+\/operations\//),
  mod('forms', /^kapps\/[^/]+\/forms\/[^/]+$/, { scope: 'form' }),
  mod('workflows', /\/workflows\//),
  mod('data', /\/data$/),
  mod('task-refs', /^task-refs$/, { applyable: false }),
];
const CONFIG = { data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {} };
const art = (key, data, meta = {}) => [key, { key, data, meta }];
const plan = (exported, target, extra = {}) => buildPlan({
  modules: MODULES, exported: new Map(exported), target: new Map(target), state: {}, overrides: {}, vars: { targetUrl: 'https://t' }, config: CONFIG, ...extra,
});

test('diffValues reports leaf paths, matching named array items by name', () => {
  assert.deepEqual(diffValues({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 }), [
    { path: 'b.c', from: 2, to: 3 }, { path: 'd', from: undefined, to: 4 },
  ]);
  assert.deepEqual(diffValues({ attributes: [{ name: 'X', values: ['1'] }] }, { attributes: [{ name: 'X', values: ['2'] }] }), [
    { path: 'attributes[X].values.0', from: '1', to: '2' },
  ]);
  assert.deepEqual(diffValues({ l: [1, 2] }, { l: [1, 2, 3] }), [{ path: 'l', from: [1, 2], to: [1, 2, 3] }]);
  assert.deepEqual(diffValues(1, 2), [{ path: '(root)', from: 1, to: 2 }]);
  assert.deepEqual(diffValues({ a: 1 }, { a: 1 }), []);
});

test('mergeTargetOnly appends target-only named items in sorted order', () => {
  const out = mergeTargetOnly({ defs: [{ name: 'b' }] }, { defs: [{ name: 'a' }, { name: 'b', x: 1 }] }, [{ field: 'defs', key: 'name' }]);
  assert.deepEqual(out, { defs: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual(mergeTargetOnly({ defs: [] }, null, [{ field: 'defs', key: 'name' }]), { defs: [] });
});

test('buildPlan classifies create, update and unchanged, and lists target-only applyable artifacts', () => {
  const p = plan(
    [['teams/New', { name: 'New' }], ['teams/Same', { name: 'Same' }], ['teams/Changed', { name: 'Changed', description: 'new' }], ['task-refs', { handlers: [] }]],
    [art('teams/Same', { name: 'Same' }), art('teams/Changed', { name: 'Changed', description: 'old' }), art('teams/Extra', { name: 'Extra' }), art('task-refs', {})],
  );
  assert.deepEqual(p.items.map((i) => [i.key, i.action]), [['teams/Changed', 'update'], ['teams/New', 'create'], ['teams/Same', 'unchanged']]);
  assert.deepEqual(p.items[0].diff, [{ path: 'description', from: 'old', to: 'new' }]);
  assert.deepEqual(p.targetOnly.map((t) => t.key), ['teams/Extra']);
  assert.equal(p.items[0].scope, 'team');
});

test('env-bound fields never show as changes and target-only sub-items are kept', () => {
  const p = plan(
    [['space', { name: 'Dev', spaceAttributeDefinitions: [{ name: 'A' }] }]],
    [art('space', { name: 'Prod', spaceAttributeDefinitions: [{ name: 'A' }, { name: 'TargetOnly' }] })],
  );
  assert.equal(p.items[0].action, 'unchanged');
  assert.deepEqual(p.items[0].desired.spaceAttributeDefinitions.map((d) => d.name), ['A', 'TargetOnly']);
});

test('overrides apply, and an override for an unknown key is a warning', () => {
  const p = plan(
    [['connections/Api/operations/Get', { id: 'o', path: 'DEV/x' }]],
    [art('connections/Api/operations/Get', { id: 'o', path: 'PROD/x' })],
    { overrides: { artifacts: { 'connections/Typo': { a: 1 } }, replace: [{ from: 'DEV', to: 'PROD' }] } },
  );
  assert.equal(p.items[0].action, 'unchanged');
  assert.match(p.warnings[0], /connections\/Typo/);
});

test('drift: changed since last apply is skipped unless overwriteDrift; unrecorded is not drift', () => {
  const exported = [['teams/Ops', { name: 'Ops', description: 'from export' }]];
  const target = [art('teams/Ops', { name: 'Ops', description: 'edited in prod' })];
  const state = { 'teams/Ops': hashOf({ name: 'Ops', description: 'as last applied' }) };
  const skipped = plan(exported, target, { state });
  assert.equal(skipped.items[0].action, 'skip-drift');
  assert.equal(skipped.items[0].drift, true);
  assert.match(skipped.warnings[0], /teams\/Ops.*--overwrite-drift/);
  assert.equal(plan(exported, target, { state, overwriteDrift: true }).items[0].action, 'update');
  assert.equal(plan(exported, target).items[0].action, 'update');
});

test('a changed connection is manual, and an unknown export file is an error', () => {
  const p = plan(
    [['connections/Api', { id: 'c', config: { baseUrl: 'new' } }], ['bogus/file', {}]],
    [art('connections/Api', { id: 'c', config: { baseUrl: 'old' } })],
  );
  assert.equal(p.items[0].action, 'manual');
  assert.match(p.warnings.join('\n'), /connections\/Api.*by hand/);
  assert.deepEqual(p.errors, ['Unrecognized file in export: bogus/file']);
});

test('integrationRefs reads integrations and system_integration_v1 node parameters', () => {
  assert.deepEqual(integrationRefs({
    integrations: [{ connectionId: 'c1', operationId: 'o1' }],
    treeJson: { nodes: [
      { definitionId: 'system_integration_v1', parameters: [{ id: 'connection', value: 'c2' }, { id: 'operation', value: 'o2' }] },
      { definitionId: 'utilities_echo_v1', parameters: [{ id: 'connection', value: 'ignored' }] },
    ] },
  }), [{ connectionId: 'c1', operationId: 'o1' }, { connectionId: 'c2', operationId: 'o2' }]);
});

test('preflight: dangling ids, same-name-different-id, missing secrets, firing workflows, empty env-bound attributes', () => {
  const exported = new Map([
    ['connections/Api', { id: 'c1', name: 'Api' }],
    ['connections/Api/operations/Get', { id: 'o1' }],
    ['connections/New', { id: 'c9', name: 'New' }],
    ['kapps/k/forms/f', { integrations: [{ connectionId: 'c1', operationId: 'o-missing' }, { connectionId: '<%= @inputs["c"] %>', operationId: 'o1' }] }],
    ['kapps/k/forms/codes/data', { key: ['Code'], rows: [{ Code: 'A' }] }],
    ['kapps/k/forms/codes/workflows/Submission Submitted/Sync Rows', { name: 'Sync Rows', event: 'Submission Submitted', status: 'Active' }],
  ]);
  const target = new Map([art('connections/Api', { id: 'c-other', name: 'Api' })]);
  const p = buildPlan({
    modules: MODULES, exported, target, state: {}, overrides: {}, vars: {},
    config: { ...CONFIG, envBoundAttributes: { form: ['Environment'] } },
  });
  const { errors, warnings } = preflightChecks({ plan: p, exported, target, config: { ...CONFIG, envBoundAttributes: { form: ['Environment'] } }, hasSecrets: () => false });
  assert.deepEqual(errors, [
    'connections/Api: the target has one with the same name but id c-other (export has c1); reconcile by hand before promoting',
    'kapps/k/forms/f: references operation o-missing, which is neither exported nor in the target',
  ]);
  assert.ok(warnings.some((w) => /connections\/New: will be created without credentials/.test(w)));
  assert.ok(warnings.some((w) => /kapps\/k\/forms\/codes\/data: .*Sync Rows \(Submission Submitted\)/.test(w)));
  assert.ok(warnings.some((w) => /kapps\/k\/forms\/f: environment-bound attribute "Environment"/.test(w)));
});
```

```js
// lib/sync/report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPlan, planRecord, show } from './report.mjs';

const PLAN = {
  items: [
    { key: 'teams/New', type: 'teams', action: 'create', diff: [] },
    { key: 'teams/Ops', type: 'teams', action: 'update', diff: [{ path: 'description', from: 'a', to: 'b' }] },
    { key: 'space', type: 'space', action: 'unchanged', diff: [] },
  ],
  targetOnly: [{ key: 'teams/Old', type: 'teams' }],
  warnings: ['careful'],
  errors: [],
};

test('show truncates long values and marks absent ones', () => {
  assert.equal(show(undefined), '(none)');
  assert.equal(show('x'.repeat(200)).length, 80);
});

test('formatPlan summarises counts, changes, target-only items, warnings', () => {
  const text = formatPlan(PLAN, 'prod', { prune: ['teams'] });
  assert.match(text, /^Plan for prod/);
  assert.match(text, /create 1 {3}update 1 .*unchanged 1 {3}target-only 1/);
  assert.match(text, /\+ create\s+teams\s+teams\/New/);
  assert.match(text, /description: "a" → "b"/);
  assert.match(text, /- DELETE teams\s+teams\/Old/);
  assert.match(text, /WARN {2}careful/);
  assert.doesNotMatch(text, /space/);
});

test('planRecord keeps only changes and is serialisable', () => {
  const rec = planRecord(PLAN);
  assert.deepEqual(rec.items.map((i) => i.key), ['teams/New', 'teams/Ops']);
  assert.deepEqual(rec.targetOnly, ['teams/Old']);
  assert.doesNotThrow(() => JSON.stringify(rec));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/plan.test.mjs lib/sync/report.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `plan.mjs`**

```js
// lib/sync/plan.mjs
// Pure: compare the export (after overrides) with the target and decide what
// apply would do. No I/O.
import { isEqual, hashOf, withoutEnvBound, sortBy } from './normalize.mjs';
import { prepareDesired } from './overrides.mjs';

const isObj = (v) => v !== null && typeof v === 'object';
const join = (path, seg) => (path ? `${path}.${seg}` : String(seg));

export function diffValues(from, to, path = '') {
  if (isEqual(from, to)) return [];
  if (isObj(from) && isObj(to) && Array.isArray(from) === Array.isArray(to)) {
    if (Array.isArray(from)) {
      const named = [...from, ...to].every((x) => isObj(x) && 'name' in x);
      if (named) {
        const names = [...new Set([...from, ...to].map((x) => x.name))].sort();
        return names.flatMap((n) => diffValues(from.find((x) => x.name === n), to.find((x) => x.name === n), `${path}[${n}]`));
      }
      if (from.length !== to.length) return [{ path: path || '(root)', from, to }];
      return from.flatMap((v, i) => diffValues(v, to[i], join(path, i)));
    }
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
    return keys.flatMap((k) => diffValues(from[k], to[k], join(path, k)));
  }
  return [{ path: path || '(root)', from, to }];
}

export function mergeTargetOnly(desired, existing, specs = []) {
  if (!existing) return desired;
  const out = { ...desired };
  for (const { field, key } of specs) {
    if (!Array.isArray(existing[field])) continue;
    const have = new Set((out[field] ?? []).map((x) => x[key]));
    const extra = existing[field].filter((x) => !have.has(x[key]));
    if (extra.length) out[field] = sortBy([...(out[field] ?? []), ...extra], key);
  }
  return out;
}

const moduleFor = (modules, key) => modules.find((m) => m.owns(key));

export function buildPlan({ modules, exported, target, state = {}, overrides = {}, vars = {}, config, overwriteDrift = false }) {
  const eba = config.envBoundAttributes ?? {};
  const items = [];
  const errors = [];
  const warnings = [];
  for (const key of [...exported.keys()].sort()) {
    const mod = moduleFor(modules, key);
    if (!mod) { errors.push(`Unrecognized file in export: ${key}`); continue; }
    if (mod.applyable === false) continue;
    const existing = target.get(key) ?? null;
    const source = prepareDesired({ key, scope: mod.scope, exported: exported.get(key), existing: existing?.data, overrides, vars, envBoundAttributes: eba });
    const desired = mod.mergeTargetOnly
      ? mod.mergeTargetOnly(source, existing?.data)
      : mergeTargetOnly(source, existing?.data, mod.namedCollections);
    const diff = existing ? diffValues(existing.data, desired) : [];
    let action = !existing ? 'create' : diff.length ? 'update' : 'unchanged';
    const recorded = state[key];
    const drift = action === 'update' && Boolean(recorded) && recorded !== hashOf(withoutEnvBound(mod.scope, existing.data, eba));
    if (action === 'update' && mod.updatable === false) {
      action = 'manual';
      warnings.push(`${key}: differs from the target, but ${mod.type} are never updated automatically; apply the diff by hand`);
    } else if (drift) {
      if (!overwriteDrift) action = 'skip-drift';
      warnings.push(`${key}: changed in the target since the last promotion${overwriteDrift ? ' (will be overwritten)' : ' (skipped; use --overwrite-drift to replace it)'}`);
    }
    items.push({ key, type: mod.type, scope: mod.scope, action, source, desired, existing, diff, drift });
  }
  const targetOnly = [...target.keys()]
    .filter((k) => !exported.has(k))
    .map((k) => ({ key: k, mod: moduleFor(modules, k) }))
    .filter(({ mod }) => mod && mod.applyable !== false)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, mod }) => ({ key, type: mod.type, existing: target.get(key) }));
  for (const k of Object.keys(overrides.artifacts ?? {})) {
    if (!exported.has(k)) warnings.push(`Override for "${k}" matches nothing in the export (check the key against the export/ file paths)`);
  }
  return { items, targetOnly, errors, warnings };
}

export function integrationRefs(data) {
  const refs = [];
  for (const i of data?.integrations ?? []) refs.push({ connectionId: i.connectionId, operationId: i.operationId });
  for (const n of data?.treeJson?.nodes ?? []) {
    if (!String(n.definitionId).startsWith('system_integration_v1')) continue;
    const param = (id) => (n.parameters ?? []).find((p) => String(p.id ?? p.name).toLowerCase() === id)?.value;
    refs.push({ connectionId: param('connection'), operationId: param('operation') });
  }
  return refs;
}

const CONNECTION = /^connections\/[^/]+$/;
const OPERATION = /^connections\/[^/]+\/operations\/[^/]+$/;
const SUBMISSION_EVENT = /^Submission (Created|Submitted|Updated)$/;
const isDynamic = (v) => typeof v === 'string' && v.includes('<%');

export function preflightChecks({ plan, exported, target, config, hasSecrets }) {
  const errors = [];
  const warnings = [];
  const ids = { connection: new Set(), operation: new Set() };
  const collect = (k, d) => {
    if (CONNECTION.test(k)) ids.connection.add(d?.id);
    if (OPERATION.test(k)) ids.operation.add(d?.id);
  };
  for (const [k, d] of exported) collect(k, d);
  for (const [k, a] of target) collect(k, a.data);

  for (const [k, d] of exported) {
    if ((CONNECTION.test(k) || OPERATION.test(k)) && target.has(k) && target.get(k).data.id !== d.id) {
      errors.push(`${k}: the target has one with the same name but id ${target.get(k).data.id} (export has ${d.id}); reconcile by hand before promoting`);
    }
    for (const ref of integrationRefs(d)) {
      for (const kind of ['connection', 'operation']) {
        const id = ref[`${kind}Id`];
        if (id && !isDynamic(id) && !ids[kind].has(id)) {
          errors.push(`${k}: references ${kind} ${id}, which is neither exported nor in the target`);
        }
      }
    }
  }

  for (const i of plan.items) {
    if (i.type === 'connections' && i.action === 'create' && !hasSecrets(i.desired.name)) {
      warnings.push(`${i.key}: will be created without credentials (set KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD> to supply them)`);
    }
    if (i.type === 'data' && (i.action === 'create' || i.action === 'update')) {
      const prefix = i.key.replace(/data$/, 'workflows/');
      const fired = [...exported]
        .filter(([k, d]) => k.startsWith(prefix) && SUBMISSION_EVENT.test(d.event) && d.status !== 'Inactive')
        .map(([, d]) => `${d.name} (${d.event})`);
      if (fired.length) warnings.push(`${i.key}: creating/updating rows will run these workflows in the target: ${fired.join(', ')}`);
    }
    for (const name of config.envBoundAttributes?.[i.scope] ?? []) {
      const attr = i.desired?.attributes?.find((a) => a.name === name);
      if (!attr?.values?.length) {
        warnings.push(`${i.key}: environment-bound attribute "${name}" is empty in the target and no override sets it`);
      }
    }
  }
  return { errors, warnings };
}
```

- [ ] **Step 4: Implement `report.mjs`**

```js
// lib/sync/report.mjs
// Pure: render a plan for people (formatPlan) and for the plans/ record.
const ACTIONS = ['create', 'update', 'manual', 'skip-drift', 'unchanged'];
const SYMBOL = { create: '+', update: '~', manual: '!', 'skip-drift': '?' };
const MAX_DIFF = 20;

export function show(value) {
  if (value === undefined) return '(none)';
  const s = JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

export function formatPlan(plan, envName, { prune = [] } = {}) {
  const count = (a) => plan.items.filter((i) => i.action === a).length;
  const lines = [
    `Plan for ${envName}`,
    `  ${ACTIONS.map((a) => `${a} ${count(a)}`).join('   ')}   target-only ${plan.targetOnly.length}`,
  ];
  const changes = plan.items.filter((i) => i.action !== 'unchanged');
  if (changes.length) lines.push('', 'Changes:');
  for (const i of changes) {
    lines.push(`  ${SYMBOL[i.action]} ${i.action.padEnd(10)} ${i.type.padEnd(14)} ${i.key}`);
    for (const d of i.diff.slice(0, MAX_DIFF)) lines.push(`      ${d.path}: ${show(d.from)} → ${show(d.to)}`);
    if (i.diff.length > MAX_DIFF) lines.push(`      ... ${i.diff.length - MAX_DIFF} more difference(s)`);
  }
  if (plan.targetOnly.length) {
    lines.push('', 'Only in the target (kept unless pruned):');
    for (const t of plan.targetOnly) lines.push(`  - ${prune.includes(t.type) ? 'DELETE ' : ''}${t.type.padEnd(14)} ${t.key}`);
  }
  if (plan.warnings.length) lines.push('', 'Warnings:', ...plan.warnings.map((w) => `  WARN  ${w}`));
  if (plan.errors.length) lines.push('', 'Errors:', ...plan.errors.map((e) => `  ERROR ${e}`));
  return lines.join('\n');
}

export function planRecord(plan) {
  return {
    items: plan.items.filter((i) => i.action !== 'unchanged')
      .map(({ key, type, action, diff, drift }) => ({ key, type, action, diff, drift })),
    targetOnly: plan.targetOnly.map((t) => t.key),
    warnings: plan.warnings,
    errors: plan.errors,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/sync/plan.test.mjs lib/sync/report.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/sync/plan.mjs lib/sync/plan.test.mjs lib/sync/report.mjs lib/sync/report.test.mjs
git commit -m "feat(sync): plan engine with drift, preflight checks and report"
```

---

### Task 16: `plan` command

**Files:**
- Modify: `lib/sync/commands.mjs` (replace the `runPlan` stub; add `computePlan`)
- Test: `lib/sync/commands.test.mjs` (append)

**Interfaces:**
- Consumes: `buildPlan`, `preflightChecks` (Task 15); `formatPlan`, `planRecord` (Task 15); `readTree` (Task 5); `loadState` (Task 5); `connectionSecrets`, `loadOverrides` (Task 3).
- Produces: `computePlan({ projectDir, envName, overwriteDrift, clientFactory }) → { env, config, plan, targetList }`, `runPlan({ projectDir, envName, overwriteDrift, log, clientFactory })`.

- [ ] **Step 1: Write the failing test** (append to `lib/sync/commands.test.mjs`; also add `runPlan` to its import from `./commands.mjs`, and `writeTree` from `./store.mjs`)

```js
test('plan reads the target with a read-only client, prints the plan, records it, and exits 1 on errors', async () => {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' } });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'teams/Ops', data: { name: 'Ops' } },
  ]);
  const modes = [];
  const clientFactory = ({ mode }) => { modes.push(mode); return fakeClient(emptySpaceRoutes({ displayType: 'Display Page' }), { mode }); };
  const out = [];
  assert.equal(await runPlan({ projectDir: dir, envName: 'prod', log: (m) => out.push(m), clientFactory }), 0);
  assert.deepEqual(modes, ['read']);
  const text = out.join('\n');
  assert.match(text, /~ update\s+space\s+space/);
  assert.match(text, /displayType: "Display Page" → "Redirect"/);
  assert.match(text, /\+ create\s+teams\s+teams\/Ops/);
  assert.equal(readdirSync(join(dir, 'plans')).length, 1);

  writeTree(join(dir, 'export'), [{ key: 'bogus/thing', data: {} }]);
  assert.equal(await runPlan({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory }), 1);
});
```

Add `readdirSync` to the `node:fs` import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/sync/commands.test.mjs`
Expected: FAIL — `plan is not implemented yet`.

- [ ] **Step 3: Implement** — in `lib/sync/commands.mjs`, delete the `runPlan` stub, extend the imports, and add:

```js
// add to imports:
import { readTree } from './store.mjs';
import { loadState } from './state.mjs';
import { connectionSecrets } from './env.mjs';
import { buildPlan, preflightChecks } from './plan.mjs';
import { formatPlan, planRecord } from './report.mjs';
```

(Merge these into the existing `./store.mjs` and `./env.mjs` import lines rather than duplicating them.)

```js
export async function computePlan({ projectDir, envName, overwriteDrift = false, clientFactory = createClient }) {
  const env = loadEnvironment(projectDir, envName);
  const config = loadConfig(projectDir);
  const exported = readTree(exportDir(projectDir));
  const reader = clientFactory({ env, mode: 'read' });
  const targetList = await exportArtifacts(reader, config);
  const target = new Map(targetList.map((a) => [a.key, a]));
  const plan = buildPlan({
    modules: MODULES, exported, target, config, overwriteDrift,
    state: loadState(projectDir, envName),
    overrides: loadOverrides(projectDir, envName),
    vars: { targetUrl: env.url },
  });
  const checks = preflightChecks({
    plan, exported, target, config,
    hasSecrets: (name) => Object.keys(connectionSecrets(env, name)).length > 0,
  });
  for (const mod of MODULES) {
    if (!mod.preflight) continue;
    const r = await mod.preflight(reader, exported);
    checks.errors.push(...r.errors);
    checks.warnings.push(...r.warnings);
  }
  plan.errors.push(...checks.errors);
  plan.warnings.push(...checks.warnings);
  return { env, config, plan, targetList };
}

export async function runPlan({ projectDir, envName, overwriteDrift, log, clientFactory = createClient }) {
  const { env, plan } = await computePlan({ projectDir, envName, overwriteDrift, clientFactory });
  log(formatPlan(plan, env.name));
  const dir = join(projectDir, 'plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${env.name}-${stamp()}.json`), stableStringify(planRecord(plan)));
  return plan.errors.length ? 1 : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/commands.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/commands.mjs lib/sync/commands.test.mjs
git commit -m "feat(sync): plan command"
```

---

### Task 17: `apply` command

**Files:**
- Modify: `lib/sync/commands.mjs` (replace the `runApply` stub)
- Test: `lib/sync/commands.test.mjs` (append)

**Interfaces:**
- Consumes: `computePlan` (Task 16); `saveState`, `loadState`, `writeTree` (Task 5); `hashOf`, `withoutEnvBound` (Task 1); `ReadOnlyError` (Task 4); `PRUNABLE`, `moduleFor` (Task 13).
- Produces: `runApply({ projectDir, envName, yes, prune, overwriteDrift, log, clientFactory, confirm })`, `promptConfirm(envName)`, `recordState(projectDir, envName, config, plan, artifacts)`.

- [ ] **Step 1: Write the failing tests** (append; add `runApply` to the `./commands.mjs` import and `ReadOnlyError` from `./http.mjs`)

```js
function applyHarness(routes) {
  const calls = [];
  const modes = [];
  const clientFactory = ({ env, mode }) => {
    if (mode === 'write' && env.readOnly) throw new ReadOnlyError('readOnly');
    modes.push(mode);
    return fakeClient(routes, { mode, calls });
  };
  const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  return { clientFactory, writes, modes };
}

function promotable() {
  const dir = tempProject({ prod: { url: 'https://prod.example.com' }, dev: { url: 'https://dev.example.com', readOnly: true } });
  writeTree(join(dir, 'export'), [
    { key: 'space', data: { name: 'Dev', displayType: 'Redirect' } },
    { key: 'teams/Ops', data: { name: 'Ops' } },
  ]);
  return dir;
}

test('apply backs up, writes in dependency order, and records drift state', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const out = [];
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
  assert.deepEqual(h.writes(), ['PUT /space', 'POST /teams']);
  assert.deepEqual(h.modes, ['read', 'write', 'read']);
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  assert.ok(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space);
});

test('apply refuses a readOnly environment before reading or writing anything', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes());
  await assert.rejects(runApply({ projectDir: dir, envName: 'dev', yes: true, log: () => {}, clientFactory: h.clientFactory }), ReadOnlyError);
  assert.deepEqual(h.modes, []);
});

test('apply makes no writes when confirmation is declined or the plan has errors', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', log: () => {}, clientFactory: h.clientFactory, confirm: async () => false }), 1);
  writeTree(join(dir, 'export'), [{ key: 'bogus/thing', data: {} }]);
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: () => {}, clientFactory: h.clientFactory }), 1);
  assert.deepEqual(h.writes(), []);
});

test('apply with nothing to change records a drift baseline and writes nothing', async () => {
  const dir = promotable();
  writeTree(join(dir, 'export'), [{ key: 'space', data: { name: 'Dev', displayType: 'Display Page' } }]);
  const h = applyHarness(emptySpaceRoutes({ displayType: 'Display Page' }));
  const out = [];
  assert.equal(await runApply({ projectDir: dir, envName: 'prod', yes: true, log: (m) => out.push(m), clientFactory: h.clientFactory }), 0);
  assert.deepEqual(h.writes(), []);
  assert.ok(out.includes('Nothing to apply.'));
  assert.ok(JSON.parse(readFileSync(join(dir, 'state', 'prod.json'), 'utf8')).space);
});

test('apply rejects an unknown --prune type', async () => {
  const dir = promotable();
  const h = applyHarness(emptySpaceRoutes());
  await assert.rejects(runApply({ projectDir: dir, envName: 'prod', yes: true, prune: ['space'], log: () => {}, clientFactory: h.clientFactory }), /--prune space/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sync/commands.test.mjs`
Expected: FAIL — `apply is not implemented yet`.

- [ ] **Step 3: Implement** — in `lib/sync/commands.mjs`, delete the `runApply` stub and add (merging imports into the existing lines):

```js
// add to imports:
import { createInterface } from 'node:readline/promises';
import { createClient, ReadOnlyError } from './http.mjs';
import { saveState } from './state.mjs';
import { hashOf, withoutEnvBound } from './normalize.mjs';
import { PRUNABLE } from './artifacts/index.mjs';
```

```js
export async function promptConfirm(envName) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`\nType "${envName}" to apply these changes: `)).trim() === envName;
  } finally {
    rl.close();
  }
}

// Remember each promoted artifact's target state so the next plan can tell
// when someone changed it outside promotion. Drift-skipped and manual items
// keep their previous hash.
export function recordState(projectDir, envName, config, plan, artifacts, deleted = []) {
  const state = loadState(projectDir, envName);
  const keep = new Set(plan.items.filter((i) => i.action === 'skip-drift' || i.action === 'manual').map((i) => i.key));
  const promoted = new Set(plan.items.map((i) => i.key));
  for (const a of artifacts) {
    if (!promoted.has(a.key) || keep.has(a.key)) continue;
    state[a.key] = hashOf(withoutEnvBound(moduleFor(a.key).scope, a.data, config.envBoundAttributes));
  }
  for (const key of deleted) delete state[key];
  saveState(projectDir, envName, state);
}

export async function runApply({
  projectDir, envName, yes = false, prune = [], overwriteDrift = false, log,
  clientFactory = createClient, confirm = promptConfirm,
}) {
  const env = loadEnvironment(projectDir, envName);
  if (env.readOnly) throw new ReadOnlyError(`Environment "${env.name}" is readOnly; apply never writes to it`);
  for (const t of prune) {
    if (!PRUNABLE.includes(t)) throw new Error(`--prune ${t}: not a prunable type (one of ${PRUNABLE.join(', ')})`);
  }
  const { config, plan, targetList } = await computePlan({ projectDir, envName, overwriteDrift, clientFactory });
  log(formatPlan(plan, env.name, { prune }));
  if (plan.errors.length) { log('\nRefusing to apply: fix the errors above first.'); return 1; }

  const pruneSet = new Set(prune);
  const work = plan.items.filter((i) => i.action === 'create' || i.action === 'update'
    || (i.type === 'data' && pruneSet.has('data') && i.existing));
  const deletions = plan.targetOnly.filter((t) => pruneSet.has(t.type));
  if (!work.length && !deletions.length) {
    log('Nothing to apply.');
    recordState(projectDir, env.name, config, plan, targetList);
    return 0;
  }
  if (!yes && !(await confirm(env.name))) { log('Aborted; nothing was changed.'); return 1; }

  const backupDir = join(projectDir, 'backups', `${env.name}-${stamp()}`);
  writeTree(backupDir, strip(targetList));
  log(`\nBacked up ${env.name} to ${backupDir}`);

  const writer = clientFactory({ env, mode: 'write' });
  const ctx = {
    config, prune: pruneSet,
    connectionSecrets: (name) => connectionSecrets(env, name),
    warn: (m) => log(`  WARN  ${m}`),
  };
  let done = 0;
  try {
    for (const mod of MODULES) {
      for (const item of work.filter((i) => i.type === mod.type)) {
        await mod.apply(writer, item, ctx);
        done++;
        log(`  ${item.action.padEnd(8)} ${item.key}`);
      }
    }
    for (const mod of [...MODULES].reverse()) {
      for (const t of deletions.filter((d) => d.type === mod.type)) {
        await mod.prune(writer, t.existing, ctx);
        done++;
        log(`  delete   ${t.key}`);
      }
    }
  } catch (e) {
    log(`\nStopped after ${done} change(s). Nothing was rolled back; fix the cause and re-run apply. Backup: ${backupDir}`);
    throw e;
  }

  const after = await exportArtifacts(clientFactory({ env, mode: 'read' }), config);
  recordState(projectDir, env.name, config, plan, after, deletions.map((d) => d.key));
  log(`\nApplied ${done} change(s) to ${env.name}.`);
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sync/commands.test.mjs`
Expected: PASS, 8 tests.

Run the whole suite: `node --test lib/sync/*.test.mjs lib/sync/artifacts/*.test.mjs` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/commands.mjs lib/sync/commands.test.mjs
git commit -m "feat(sync): apply command with backup, confirmation, prune and drift state"
```

---

### Task 18: Round trip into a scratch space

Proves the write shapes the modules assume, and the success criterion "export → apply into an empty space → plan again shows zero changes". Needs a disposable scratch space from the user; the source environment stays `readOnly`.

**Files:**
- Modify only where a check fails: `lib/sync/artifacts/*.mjs` and their tests (synthetic fixtures only).
- Project directory: the one from Task 14 (outside this repo).

- [ ] **Step 1: Add the scratch environment**

Ask the user for the scratch space URL and credentials. Write `<project-dir>/environments/scratch.json` = `{ "url": "<scratch-url>", "readOnly": false }` and `<project-dir>/.env.scratch` (mode 600).

- [ ] **Step 2: Confirm the read-only guard on the source**

Run: `node kinetic-sync.mjs apply --project <project-dir> --to <source-env> --yes; echo "exit=$?"`
Expected: `kinetic-sync: Environment "<source-env>" is readOnly; apply never writes to it`, `exit=1`.

- [ ] **Step 3: Plan into scratch**

Run: `node kinetic-sync.mjs plan --project <project-dir> --to scratch`
Expected: mostly `create`. Errors for missing handlers/routines are expected in a blank space: install those handlers/routines in the scratch space by hand (the tool does not upload them), then re-plan until there are no errors.

- [ ] **Step 4: Apply**

Run: `node kinetic-sync.mjs apply --project <project-dir> --to scratch --yes`
Expected: `Applied N change(s)`. On a failure, read the HttpError (method, path, status, body), fix the module's request shape, add a unit test asserting the corrected call, and re-run apply (it resumes because every step is an upsert).

Write shapes to confirm along the way (each was assumed from docs; fix the module if the server disagrees):
- [ ] `POST /kapps` with `{ slug, name }` then `PUT /kapps/{slug}` with settings
- [ ] categories addressed by `slug` in `PUT /kapps/{kapp}/categories/{slug}`
- [ ] `POST {form|kapp}/backgroundJobs` with `{ type: 'Build Index', content: { indexes } }` starts an index build
- [ ] `PUT /teams/{slug}` without `memberships` leaves existing memberships intact
- [ ] `POST /import/connections` keeps the connection `id`; `POST /import/connections/{id}/operations` keeps operation `id`s
- [ ] workflows: `POST` without `treeJson` then scoped `PUT` with it produces the full tree, filter and status
- [ ] space WebAPI import (`POST /webApiImport?force=true`) — if it 404s, the warning appears and the WebAPI is recreated by hand
- [ ] `POST /models` then `PUT /models/{name}` creates mappings and qualifications
- [ ] reference-data `POST .../submissions` with `{ values }`

- [ ] **Step 5: Plan again — the round-trip check**

Run: `node kinetic-sync.mjs plan --project <project-dir> --to scratch`
Expected: `create 0   update 0`. `manual` connections are acceptable only where the diff is an override-free secret-adjacent field; investigate each. Every remaining `update` is either a platform default added on write (add it to the normalizer, with a test) or a write that did not take (fix the module). Repeat Steps 4–5 until clean.

- [ ] **Step 6: Drift and idempotency**

1. Run `apply --to scratch --yes` again → `Nothing to apply.`
2. In the scratch space UI, change one form's description. Run `plan --to scratch` → that form shows `skip-drift` with a warning. Run `apply --to scratch --yes` → the form is not touched (check the UI). Run `apply --to scratch --yes --overwrite-drift` → the description is restored.

- [ ] **Step 7: Run the suite, check for leaked specifics, commit fixes**

Run: `node --test lib/sync/*.test.mjs lib/sync/artifacts/*.test.mjs` → all PASS.
Run: `git grep -n -i -E "<source-space-name>|<source-host>|<scratch-host>"` → no output.

```bash
git add lib/sync
git commit -m "fix(sync): align write requests with the platform after round-trip testing"
```
(Skip if nothing changed.)

---

### Task 19: Documentation

**Files:**
- Create: `docs/PROMOTING.md`
- Modify: `ONBOARDING.md` (one short section before "## Optional AI track"), `README.md` (one line in its list of contents, matching its existing style)

- [ ] **Step 1: Write `docs/PROMOTING.md`**

````markdown
# Promoting a Kinetic space between environments

`kinetic-sync.mjs` exports a space's configuration into a project directory
you keep in git, shows exactly what promoting it would change in another
environment, and applies only those changes. It never deletes anything unless
you ask, and it never writes to an environment marked `readOnly`.

You need Node.js 20 or newer. Nothing else is installed.

## What is promoted

Space settings, attribute definitions and security policies; teams (without
memberships); bridge models; file resources; Integrator connections and
operations; kapps (settings, attribute definitions, policies, categories,
form types, integrations, index definitions); forms; WebAPIs; workflows; and
submissions on forms you allowlist as reference data.

Not promoted: users, team memberships, transactional submissions, handler
packages and global routines (both are checked for presence in the target),
and webhooks.

## 1. Create a project

Keep each customer's project in its own directory (ideally its own
repository), not inside this one.

```bash
node kinetic-sync.mjs init --project ../my-project
```

This creates `kinetic-sync.config.json`, `environments/dev.json` and a
`.gitignore` that keeps credentials, backups and plan records out of git.

## 2. Describe your environments

One file per environment in `environments/`:

```json
{ "url": "https://your-space.kinops.io", "readOnly": true }
```

Mark the space you export from as `readOnly: true`. Apply refuses to write to
it, and every export and plan reads with a client that cannot send anything
but GET requests.

Credentials go in `.env.<env>` in the project (git-ignored), or in your shell:

```
KINETIC_DEV_USERNAME=you@example.com
KINETIC_DEV_PASSWORD=...
```

`<ENV>` is the environment name upper-cased, with anything other than letters
and digits turned into `_`. The same credentials are used for the Core, Task
and Integrator APIs; the tool fetches the Integrator token itself.

## 3. Export

```bash
node kinetic-sync.mjs export --project ../my-project --env dev
```

This rewrites `export/` to match the space: one JSON file per artifact,
metadata and secrets removed, keys sorted. Commit it. Re-exporting an
unchanged space produces no diff, so a pull request shows exactly what
changed.

Export also lists values that still contain the source space's host name and
are not handled by a target's overrides. Fix those before promoting.

## 4. Per-environment values

Some values must differ per environment. There are three mechanisms.

**Environment-bound fields** are never copied: the space name and slug, its
platform component locations (UI location, task server URL), bundle paths,
and each kapp's bundle path. The target keeps its own values.

**Environment-bound attributes** are listed in `kinetic-sync.config.json` and
treated the same way:

```json
"envBoundAttributes": { "space": ["Environment"], "kapp": [], "form": [], "team": [], "category": [] }
```

**Overrides** in `overrides/<env>.json` set values for one target:

```json
{
  "artifacts": {
    "space": { "attributes.Environment": ["prod"] },
    "connections/My API": { "config.baseUrl": "https://api.example.com" },
    "kapps/services/kapp": { "bundlePath": "services" }
  },
  "replace": [{ "from": "DEV_DATABASE", "to": "PROD_DATABASE" }]
}
```

- Keys under `artifacts` are file paths under `export/` without `.json`.
- Paths are dot-separated. In a list, a segment matches the item with that
  `name`; setting a plain value on an attribute sets its `values`. Write a
  literal dot as `\.`.
- `replace` rewrites text everywhere in every artifact (operation bodies,
  workflow parameters, and so on).
- `{{targetUrl}}` in an override value becomes the target environment's URL.

## 5. Connection credentials

Secrets are never exported. When a connection is **created** in a target,
its secrets come from variables named
`KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD>`, for example:

```
KINETIC_PROD_SECRET_MY_API__PASSWORD=...
KINETIC_PROD_SECRET_MY_API__CLIENT_SECRET=...
```

Existing connections are never written, because sending a connection back
to the platform can wipe its stored credentials. If one differs, the plan
marks it `manual` and shows the difference so you can change it in the
console.

## 6. Reference data

To promote the rows of a lookup or configuration form, list it with the
field(s) that identify a row:

```json
"data": [{ "kapp": "services", "form": "categories", "key": ["Code"] }]
```

Rows are matched by that key in every environment. Creating or updating rows
runs the target form's submission workflows; the plan names them.

## 7. Plan

```bash
node kinetic-sync.mjs plan --project ../my-project --to test
```

Nothing is written. Each artifact is `create`, `update` (with field-level
differences), `unchanged`, `manual`, `skip-drift`, or only in the target.
Errors (a missing handler or routine, an integration pointing at a
connection that exists nowhere, a connection with the same name but a
different id) make the command exit non-zero. A record is saved under
`plans/`.

## 8. Apply

```bash
node kinetic-sync.mjs apply --project ../my-project --to test
```

Apply shows the plan, asks you to type the environment name (`--yes` skips
this for CI), saves a full export of the target under `backups/`, then
creates and updates in dependency order. If something fails it stops and
says how far it got; fix the cause and run it again, since every step is
safe to repeat.

Nothing is deleted unless you name the type: `--prune teams`,
`--prune forms`, `--prune data` (rows not in the export), and so on.

## Drift

After an apply, `state/<env>.json` records what each promoted artifact looked
like. If someone later changes one directly in that environment, the next
plan reports it as drift and apply leaves it alone. Bring the change back
into the source space and re-export, or pass `--overwrite-drift` to replace
it. Commit `state/`.

## Troubleshooting

- **`No credentials for "<env>"`**: set the two variables it names, or add
  them to `.env.<env>` in the project.
- **`is readOnly`**: you are applying to an export-only environment. Check
  `--to`.
- **`Handler … is not installed in the target`**: install that handler in the
  target, then plan again.
- **`… the same name but id …`**: the connection or operation was created in
  the target by hand. Delete or rename it there so the promoted one (with
  the id forms and workflows expect) can be created.
- **Plan shows changes right after an apply**: the platform added defaults
  on write. Report it; the tool's normalizer should ignore that field.
````

- [ ] **Step 2: Add the ONBOARDING pointer**

Insert before `## Optional AI track` in `ONBOARDING.md`:

```markdown
## Moving configuration between environments

To copy a space's kapps, forms, workflows, connections and other
configuration into another environment, see
[`docs/PROMOTING.md`](docs/PROMOTING.md). It uses `kinetic-sync.mjs` and needs
only Node.

---

```

- [ ] **Step 3: Add the README line**

Read `README.md`, then add one line linking `docs/PROMOTING.md` alongside its existing links, in the same style.

- [ ] **Step 4: Check docs for leaked specifics and broken commands**

Run: `git grep -n -i -E "<source-space-name>|<source-host>" -- docs README.md ONBOARDING.md` → no output.
Run each command shown in PROMOTING.md against the Task 14 project (except `apply` to a real target) and confirm it behaves as written.

- [ ] **Step 5: Commit**

```bash
git add docs/PROMOTING.md ONBOARDING.md README.md
git commit -m "docs: environment promotion with kinetic-sync"
```
