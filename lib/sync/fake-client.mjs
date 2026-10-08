// Test double for http.mjs clients. Routes are "METHOD api/path" keys. A
// getBinary route's value is a Buffer; a multipart request records its form
// field names (not the bytes) in `form`. `fallback(api, method, path, opts)`,
// when given, answers what no route matches (undefined: not handled).
import { HttpError } from './http.mjs';

export const TEST_CONFIG = Object.freeze({
  data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {},
});

export function fakeClient(routes = {}, { mode = 'write', calls = [], fallback } = {}) {
  async function request(api, method, path, { query, body, form } = {}) {
    if (mode === 'read' && method !== 'GET') throw new Error(`read-only fake got ${method} ${path}`);
    calls.push({ api, method, path, query, body, ...(form ? { form: [...form.keys()] } : {}) });
    const route = routes[`${method} ${api}${path}`];
    if (route === undefined) {
      const handled = fallback?.(api, method, path, { query, body, form });
      if (handled !== undefined) return handled;
      if (method !== 'GET') return {};
      const e = new Error(`404 ${api}${path}`);
      e.status = 404;
      throw e;
    }
    if (Buffer.isBuffer(route)) return route;
    return typeof route === 'function' ? route({ query, body, form }) : structuredClone(route);
  }
  return {
    mode, calls, request,
    get: (api, path, query) => request(api, 'GET', path, { query }),
    getBinary: (api, path, query) => request(api, 'GET', path, { query }),
  };
}

const fail = (status, message) => Object.assign(new Error(`${status} ${message}`), { status });

// A stateful Task API categories endpoint, as verified live:
// - GET /categories?include=details,handlers,trees lists every category,
//   'Integrated' (built in) and 'Stored'; names are not unique across types.
//   A category's routines are listed under `trees` (by name; with
//   `treeDefinitionIds` each also carries its definitionId).
// - POST /categories creates one ({ name, description, type }); member lists
//   in the body are ignored.
// - POST /categories/{name}/handlers and /routines add a member
//   ({ definitionId }); /trees does not exist (404). DELETE
//   /categories/{name}/handlers/{id}, /routines/{id} and /categories/{name}.
// - PUT /categories/{name} changes the description; a `trees` list in the
//   body silently clears the category's routines, and objects in any member
//   list fail with a 500 (the real API's behaviour).
// Which category a by-name call resolves when a Stored and an Integrated one
// share the name is unverified, so the fake refuses any by-name write to such
// a name (409), and a create of one: a missing guard fails loudly.
// `routineName(definitionId)` names a routine added by definitionId.
export function fakeTaskCategories(initial = [], { treeDefinitionIds = true, routineName = (id) => id } = {}) {
  const categories = structuredClone(initial).map((c) => ({ type: 'Stored', description: '', handlers: [], trees: [], policyRules: [], ...c }));
  const builtIn = (name) => categories.some((c) => c.name === name && c.type === 'Integrated');
  const byName = (name) => categories.find((c) => c.name === name && c.type === 'Stored') ?? categories.find((c) => c.name === name);
  const need = (name, path, method) => {
    if (method !== 'GET' && builtIn(name)) throw fail(409, `task${path}: a built-in category is named ${name}`);
    return byName(name) ?? (() => { throw fail(404, `task${path}`); })();
  };
  const list = () => ({
    categories: categories.map((c) => ({
      ...structuredClone(c),
      trees: c.trees.map(({ definitionId, ...t }) => (treeDefinitionIds ? { ...t, definitionId } : t)),
    })),
  });
  function handle(api, method, path, { body } = {}) {
    if (api !== 'task' || !path.startsWith('/categories')) return undefined;
    const dec = decodeURIComponent;
    let m;
    if (path === '/categories') {
      if (method === 'GET') return list();
      if (method === 'POST') {
        if (!body?.name) throw fail(400, 'a category needs a name');
        if (builtIn(body.name)) throw fail(409, `a built-in category is named ${body.name}`);
        if (categories.some((c) => c.name === body.name && c.type === (body.type ?? 'Stored'))) throw fail(400, `category ${body.name} exists`);
        categories.push({ name: body.name, description: body.description ?? '', type: body.type ?? 'Stored', handlers: [], trees: [], policyRules: [] });
        return { category: { name: body.name } };
      }
    }
    if ((m = /^\/categories\/([^/]+)$/.exec(path))) {
      const cat = need(dec(m[1]), path, method);
      if (method === 'GET') return { category: structuredClone(cat) };
      if (method === 'PUT') {
        for (const f of ['handlers', 'trees', 'routines', 'policyRules']) {
          if (Array.isArray(body?.[f]) && body[f].some((x) => x && typeof x === 'object')) throw fail(500, 'java.util.LinkedHashMap cannot be cast');
        }
        if (Array.isArray(body?.trees)) cat.trees = [];
        if (body?.description !== undefined) cat.description = body.description;
        if (body?.name && body.name !== cat.name) cat.name = body.name;
        return { category: structuredClone(cat) };
      }
      if (method === 'DELETE') {
        categories.splice(categories.indexOf(cat), 1);
        return {};
      }
    }
    if ((m = /^\/categories\/([^/]+)\/(handlers|routines|trees)(?:\/([^/]+))?$/.exec(path))) {
      if (m[2] === 'trees') throw fail(404, `task${path}`);
      const cat = need(dec(m[1]), path, method);
      const members = m[2] === 'handlers' ? cat.handlers : cat.trees;
      if (method === 'POST' && !m[3]) {
        const id = body?.definitionId;
        if (!id) throw fail(400, 'definitionId is required');
        if (!members.some((x) => x.definitionId === id)) {
          members.push(m[2] === 'handlers' ? { definitionId: id } : { definitionId: id, name: routineName(id), title: routineName(id) });
        }
        return {};
      }
      if (method === 'DELETE' && m[3]) {
        const id = dec(m[3]);
        const i = members.findIndex((x) => x.definitionId === id);
        if (i < 0) throw fail(404, `task${path}`);
        members.splice(i, 1);
        return {};
      }
    }
    return undefined;
  }
  return { categories, handle };
}

// A stateful Task API handlers endpoint, enforcing what was seen live:
// - POST /handlers (multipart `package`, file <definitionId>.zip) installs
//   the package from `catalog` ({ [definitionId]: { handler, zip } }); its
//   properties start from the package (`value` there is the package default;
//   none: empty). With ?force=true it re-installs one already there, keeping
//   the stored values.
// - PUT /handlers/{id} with { properties: { name: value } } saves the values,
//   but only when, after the change, no required property is empty; otherwise
//   nothing is saved and it answers 400 with
//   {"message":"Unable to save task handler","errors":["<name> may not be empty", …]}
//   (property order), even when the PUT names none of the empty ones.
// - Encrypted values are stored but never read back.
// GET /handlers (paged), /handlers/{id} and /handlers/{id}/zip read them.
// `handlers` holds { handler, values } per installed definitionId.
export function fakeTaskHandlers(catalog = {}, installed = []) {
  const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  const encrypted = (p) => /encrypt/i.test(p?.type ?? '');
  const handlers = new Map();
  const install = (id, keep) => {
    const source = catalog[id];
    const values = Object.fromEntries((source.handler.properties ?? []).map((p) => [p.name, keep?.[p.name] ?? p.value ?? null]));
    handlers.set(id, { handler: structuredClone(source.handler), values });
  };
  for (const { definitionId, values } of installed) {
    install(definitionId);
    Object.assign(handlers.get(definitionId).values, values);
  }
  const view = ({ handler, values }) => ({
    ...structuredClone(handler),
    properties: (handler.properties ?? []).map((p) => {
      const { value, ...rest } = p;
      return encrypted(p) ? rest : { ...rest, value: values[p.name] ?? null };
    }),
  });
  const httpError = (method, path, status, body) => new HttpError({ method, url: `/app/components/task/app/api/v2${path}`, status, body: JSON.stringify(body) });
  function handle(api, method, path, { query, body, form } = {}) {
    if (api !== 'task' || !path.startsWith('/handlers')) return undefined;
    if (path === '/handlers' && method === 'GET') {
      const all = [...handlers.values()].map(view);
      const offset = Number(query?.offset ?? 0);
      const limit = Number(query?.limit ?? 100);
      return { handlers: all.slice(offset, offset + limit), count: all.length, limit, offset };
    }
    if (path === '/handlers' && method === 'POST') {
      const file = form?.get?.('package');
      const id = String(file?.name ?? '').replace(/\.zip$/, '');
      if (!catalog[id]) throw httpError(method, path, 400, { message: 'Invalid handler package' });
      const current = handlers.get(id);
      if (current && query?.force !== 'true') throw httpError(method, path, 400, { message: `Handler ${id} already exists` });
      install(id, current?.values);
      return { handler: view(handlers.get(id)) };
    }
    const m = /^\/handlers\/([^/]+)(\/zip)?$/.exec(path);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const h = handlers.get(id);
    if (!h) throw httpError(method, path, 404, { message: `Unable to find handler ${id}` });
    if (m[2]) {
      if (method === 'GET') return catalog[id].zip;
      return undefined;
    }
    if (method === 'GET') return { handler: view(h) };
    if (method === 'DELETE') { handlers.delete(id); return {}; }
    if (method === 'PUT') {
      const given = body?.properties ?? {};
      if (Array.isArray(given)) throw httpError(method, path, 500, { message: 'java.util.ArrayList cannot be cast to java.util.Map' });
      const next = { ...h.values, ...given };
      const errors = (h.handler.properties ?? []).filter((p) => p.required && blank(next[p.name])).map((p) => `${p.name} may not be empty`);
      if (errors.length) throw httpError(method, path, 400, { message: 'Unable to save task handler', errors });
      for (const p of h.handler.properties ?? []) if (p.name in given) h.values[p.name] = given[p.name];
      return { handler: view(h) };
    }
    return undefined;
  }
  // Stored values (encrypted ones too), for tests only.
  const values = (id) => ({ ...(handlers.get(id)?.values ?? {}) });
  return { handlers, handle, values };
}
