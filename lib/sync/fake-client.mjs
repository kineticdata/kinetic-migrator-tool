// Test double for http.mjs clients. Routes are "METHOD api/path" keys. A
// getBinary route's value is a Buffer; a multipart request records its form
// field names (not the bytes) in `form`.
export const TEST_CONFIG = Object.freeze({
  data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {},
});

export function fakeClient(routes = {}, { mode = 'write', calls = [] } = {}) {
  async function request(api, method, path, { query, body, form } = {}) {
    if (mode === 'read' && method !== 'GET') throw new Error(`read-only fake got ${method} ${path}`);
    calls.push({ api, method, path, query, body, ...(form ? { form: [...form.keys()] } : {}) });
    const route = routes[`${method} ${api}${path}`];
    if (route === undefined) {
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
