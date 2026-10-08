// Test fixtures for the snapshot / explore / compare / plan / apply tests:
// synthetic Dev and Test spaces served by the engine's fake client, a started
// test server with a project and credentials, and a call helper that keeps
// every response body (JSON and SSE) for the planted-secret check.
// @ts-expect-error -- untyped engine module
import { fakeClient, integratorAuthUnavailable } from '../../lib/sync/fake-client.mjs';
import type { ClientFactory, EngineEnv } from './engine.ts';
import type { Logger } from './log.ts';
import { formatError } from './log.ts';
import { MemoryStore } from './secrets.ts';
import { startTestServer, type RawResponse, type TestServer } from './test-helpers.ts';

export const PLANTED = 'Planted-Secret-x7Qv93';
export const PLANTED_RUN = 'Run-Only-Secret-k2Lp55';
// Secrets inside the fake spaces' own data (connection auth, headers,
// signing keys): distinct from the credential password, so the checks prove
// the export strips them rather than the server scrubbing a known value.
export const PLANTED_CONN = 'Conn-Auth-Secret-m4Rt08';
export const ZIP = Buffer.from('PK\x03\x04 mail handler');

const form = (slug: string, name: string, fields: string[], extra: Record<string, unknown> = {}) => ({
  slug, name, status: 'Active', type: 'Service',
  pages: [{ name: 'Page 1', elements: fields.map((f) => ({ type: 'field', name: f, renderType: 'text', dataType: 'string' })) }],
  ...extra,
});

export interface Space {
  routes: Record<string, unknown>;
}

// Dev: a new connection + operation, a form that calls it, a changed team, a
// handler with an encrypted property. Test: the older form, the old team.
export function devRoutes(): Record<string, unknown> {
  const itRequest = form('it-request', 'IT Request', ['Summary', 'Priority', 'Asset Tag'], {
    integrations: [{ name: 'Create Ticket', connectionId: 'c-1', operationId: 'o-1' }],
    indexDefinitions: [{ name: 'values[Priority]', parts: ['values[Priority]'], unique: false }],
  });
  return {
    'GET core/space': { space: { name: 'Dev Space', slug: 'dev', displayType: 'Display Page', webApis: [], models: [], oauthSigningKey: PLANTED_CONN } },
    'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'Operations (dev)' }] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [{ id: 'c-1', name: 'Ticketing' }],
    'GET integrator/export/connections/c-1': {
      connection: {
        id: 'c-1', name: 'Ticketing', type: 'http',
        config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc', password: PLANTED_CONN } },
        operations: [{ id: 'o-1', name: 'Create Ticket', connectionId: 'c-1', config: { method: 'POST', path: '/tickets', headers: { Authorization: `Bearer ${PLANTED_CONN}` } } }],
      },
    },
    'GET core/kapps': { kapps: [{ slug: 'services' }] },
    'GET core/kapps/services': {
      kapp: { slug: 'services', name: 'Services', webApis: [], forms: [itRequest, form('leave', 'Leave Request', ['Start', 'End'])] },
    },
    'GET core/workflows': { workflows: [] },
    'GET core/kapps/services/workflows': { workflows: [] },
    'GET core/kapps/services/forms/it-request/workflows': { workflows: [] },
    'GET core/kapps/services/forms/leave/workflows': { workflows: [] },
    'GET task/trees': { trees: [] },
    'GET task/handlers': {
      handlers: [{
        definitionId: 'mail_send_v1', name: 'Mail Send',
        properties: [{ name: 'Server', type: 'Plaintext', value: 'smtp.dev.example.com' }, { name: 'Password', type: 'Encrypted' }],
      }],
    },
    'GET task/handlers/mail_send_v1/zip': ZIP,
  };
}

export function testRoutes(): Record<string, unknown> {
  return {
    'GET core/space': { space: { name: 'Test Space', slug: 'test', displayType: 'Display Page', webApis: [], models: [] } },
    'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'Operations' }] },
    'GET core/fileResources': { fileResources: [] },
    'GET integrator/connections': [],
    'GET core/kapps': { kapps: [{ slug: 'services' }] },
    'GET core/kapps/services': {
      kapp: { slug: 'services', name: 'Services', webApis: [], forms: [form('it-request', 'IT Request', ['Summary', 'Priority']), form('leave', 'Leave Request', ['Start', 'End'])] },
    },
    'GET core/workflows': { workflows: [] },
    'GET core/kapps/services/workflows': { workflows: [] },
    'GET core/kapps/services/forms/it-request/workflows': { workflows: [] },
    'GET core/kapps/services/forms/leave/workflows': { workflows: [] },
    'GET task/trees': { trees: [] },
    'GET task/handlers': { handlers: [] },
  };
}

export interface Call { env: string; method: string; path: string; body?: unknown; api: string }

// A space's routes may carry a stateful handler for what no route matches
// (for example the engine's fakeTaskHandlers().handle) under this key.
export const FALLBACK = Symbol('fallback');

// Environments named in `integratorDown` answer the Integrator sign-in with
// 404, as Kinetic Platform 7.0.0-rc3 does; `integratorErrors` gives an
// environment's Integrator calls any other error (a refused sign-in).
export function fakeFactory(spaces: Record<string, () => Record<string, unknown>>, calls: Call[], envs: EngineEnv[] = [], integratorDown: Set<string> = new Set(), integratorErrors: Map<string, Error> = new Map()): ClientFactory {
  return ({ env, mode }) => {
    envs.push(env);
    if (mode === 'write' && env.readOnly) {
      const e = new Error('readOnly');
      e.name = 'ReadOnlyError';
      throw e;
    }
    const routes = spaces[env.name];
    if (!routes) throw new Error(`no fake space for ${env.name}`);
    const recorded: Array<Omit<Call, 'env'>> = [];
    const { [FALLBACK]: fallback, ...table } = routes() as Record<string | symbol, unknown>;
    const integratorAuth = integratorErrors.get(env.name) ?? (integratorDown.has(env.name) ? integratorAuthUnavailable({ host: new URL(env.url).host }) : undefined);
    const client = fakeClient(table, { mode, calls: recorded, fallback, integratorAuth });
    const push = recorded.push.bind(recorded);
    recorded.push = (...items: Array<Omit<Call, 'env'>>) => {
      for (const c of items) calls.push({ ...c, env: env.name });
      return push(...items);
    };
    return client;
  };
}

export interface Harness {
  server: TestServer;
  store: MemoryStore;
  calls: Call[];
  // The fake spaces by environment; tests may swap one to simulate changes.
  spaces: Record<string, () => Record<string, unknown>>;
  // Every environment a client was opened with (the engine env, vars included).
  envs: EngineEnv[];
  // Environments whose Integrator sign-in answers 404 (add or remove any time).
  integratorDown: Set<string>;
  // Environments whose Integrator calls throw the given error.
  integratorErrors: Map<string, Error>;
  // Text the server logged.
  logged: string[];
  bodies: string[];
  dir: string;
  call: (method: string, pathname: string, body?: unknown) => Promise<RawResponse & { json: any }>;
  // Starts a job via `method pathname body`, waits, returns the job info (and
  // reads its SSE replay into `bodies`).
  job: (method: string, pathname: string, body?: unknown) => Promise<{ status: string; result?: any; error?: any; events: string }>;
  writes: (env?: string) => string[];
}

export async function harness(t: { after: (fn: () => Promise<void> | void) => void }, envs = { dev: true, test: false, prod: true }, opts: { workspace?: string; logger?: Logger } = {}): Promise<Harness> {
  const store = new MemoryStore();
  const calls: Call[] = [];
  const spaces: Record<string, () => Record<string, unknown>> = { dev: devRoutes, test: testRoutes, prod: testRoutes };
  const seen: EngineEnv[] = [];
  const logged: string[] = [];
  const logger: Logger = { error: (context, err) => logged.push(formatError(context, err)) };
  const integratorDown = new Set<string>();
  const integratorErrors = new Map<string, Error>();
  const server = await startTestServer({ secrets: store, clientFactory: fakeFactory(spaces, calls, seen, integratorDown, integratorErrors), logger, ...opts });
  t.after(() => server.cleanup());
  const bodies: string[] = [];
  const call = async (method: string, pathname: string, body?: unknown) => {
    const res = await server.api(pathname, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    bodies.push(res.body);
    let json: any;
    try { json = res.body ? JSON.parse(res.body) : undefined; } catch { json = undefined; }
    return { ...res, json };
  };
  const job = async (method: string, pathname: string, body?: unknown) => {
    const started = await call(method, pathname, body);
    if (started.status !== 202) throw new Error(`job did not start: ${started.status} ${started.body}`);
    const id = started.json.jobId as string;
    await server.jobs.wait(id);
    const info = (await call('GET', `/api/jobs/${id}`)).json;
    const events = (await call('GET', `/api/jobs/${id}/events`)).body;
    return { ...info, events };
  };
  const created = await call('POST', '/api/projects', { name: 'Sync Test' });
  if (created.status !== 201) throw new Error(created.body);
  const dir = created.json.path as string;
  let position = 0;
  for (const [name, readOnly] of Object.entries(envs)) {
    await call('PUT', `/api/projects/sync-test/environments/${name}`, { url: `https://${name}.example.com`, readOnly, position: position++ });
    await call('PUT', `/api/projects/sync-test/environments/${name}/credentials`, { username: 'admin', password: PLANTED });
  }
  const writes = (env?: string) => calls.filter((c) => c.method !== 'GET' && (!env || c.env === env)).map((c) => `${c.method} ${c.path}`);
  return { server, store, calls, spaces, envs: seen, integratorDown, integratorErrors, logged, bodies, dir, call, job, writes };
}

export function assertNoSecret(h: Harness, extra: string[] = []): void {
  for (const b of [...h.bodies, ...extra]) {
    for (const s of [PLANTED, PLANTED_RUN, PLANTED_CONN]) {
      if (b.includes(s)) throw new Error(`a response leaked a secret: ${b.slice(Math.max(0, b.indexOf(s) - 200), b.indexOf(s) + 50)}`);
    }
  }
}
