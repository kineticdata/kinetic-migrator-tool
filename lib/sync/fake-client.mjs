// Test double for http.mjs clients. Routes are "METHOD api/path" keys. A
// getBinary route's value is a Buffer; a multipart request records its form
// field names (not the bytes) in `form`. `fallback(api, method, path, opts)`,
// when given, answers what no route matches (undefined: not handled).
// `integratorAuth` (an error, e.g. integratorAuthUnavailable()) is thrown by
// every Integrator call, as when the platform offers no Integrator sign-in.
import { IntegratorAuthUnavailable } from './http.mjs';

export const TEST_CONFIG = Object.freeze({
  data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {},
});

export function fakeClient(routes = {}, { mode = 'write', calls = [], fallback, integratorAuth } = {}) {
  async function request(api, method, path, { query, body, form } = {}) {
    if (mode === 'read' && method !== 'GET') throw new Error(`read-only fake got ${method} ${path}`);
    if (api === 'integrator' && integratorAuth) throw integratorAuth;
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

// The error a real client throws when the Integrator sign-in answers 404
// (Kinetic Platform 7.0.0-rc3, verified live).
export const integratorAuthUnavailable = ({ host = 'your-space.kinops.io', version = '7.0.0-rc3', status = 404 } = {}) => (
  new IntegratorAuthUnavailable({ status, version, host })
);

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
