// Fake mode: with KINETIC_MIGRATE_FAKE=1 the server talks to synthetic,
// in-memory Dev and Test spaces instead of live Kinetic servers (demos and the
// end-to-end smoke test). Writes change the fake space they target, so a
// re-plan after an apply has nothing to do. Secrets live in session memory.
// Never enabled unless the variable is set to exactly "1".
// @ts-expect-error -- untyped engine module
import { fakeClient } from '../../lib/sync/fake-client.mjs';
import type { ClientFactory, EngineClient } from './engine.ts';
import { MemoryStore } from './secrets.ts';

export interface FakeMode {
  secrets: MemoryStore;
  clientFactory: ClientFactory;
}

export function fakeMode(env: Record<string, string | undefined>): FakeMode | undefined {
  if (env.KINETIC_MIGRATE_FAKE !== '1') return undefined;
  return { secrets: new MemoryStore(), clientFactory: fakeSpacesFactory() };
}

type Obj = Record<string, any>;

interface Workflow { id: string; scope: string; name: string; event: string; filter: string; status: string; notes: string; treeJson: Obj }

interface FakeSpace {
  space: Obj;
  teams: Obj[];
  kapps: Obj[];
  workflows: Workflow[];
  connections: Obj[];
  handlers: Array<{ handler: Obj; zip: Buffer }>;
  // Global routines (Task trees), keyed by title (= name).
  routines: Obj[];
}

// Shared by both spaces so an installed handler's package compares equal.
const MAIL_ZIP = Buffer.from('PK\x03\x04 synthetic mail handler package');

const field = (name: string) => ({ type: 'field', name, label: name, renderType: 'text', dataType: 'string', required: false });
const form = (slug: string, name: string, fields: string[], extra: Obj = {}) => ({
  slug, name, description: '', status: 'Active', type: 'Service', attributes: [],
  pages: [{ name: 'Page 1', type: 'page', renderType: 'submittable', elements: fields.map(field) }],
  ...extra,
});
const tree = (nodes: string[]) => ({ nodes: nodes.map((n, i) => ({ id: `node_${i + 1}`, name: n, definitionId: 'system_noop_v1' })) });
const routine = (name: string, definitionId: string, nodes: string[]) => ({
  name, title: name, type: 'Global Routine', definitionId, status: 'Active', notes: '', versionId: '0',
  inputs: [{ name: 'Submission Id', required: true }], outputs: [{ name: 'Sent' }],
  treeJson: { nodes: nodes.map((n, i) => ({ id: `node_${i + 1}`, name: n, definitionId: 'system_noop_v1' })), connectors: [] },
});
const team = (name: string, description: string) => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-'), description, attributes: [] });

function devSpace(): FakeSpace {
  return {
    space: { name: 'Dev Space', slug: 'dev', displayType: 'Display Page', webApis: [], models: [] },
    teams: [team('Operations', 'Runs the service desk'), team('Facilities', 'Buildings and rooms'), team('Security', 'Access reviews')],
    kapps: [
      {
        slug: 'services', name: 'Services', webApis: [],
        forms: [
          form('it-request', 'IT Request', ['Summary', 'Priority', 'Asset Tag', 'Needed By'], {
            integrations: [{ name: 'Create Ticket', connectionId: 'c-ticketing', operationId: 'o-create-ticket' }],
            indexDefinitions: [{ name: 'values[Priority]', parts: ['values[Priority]'], unique: false }],
          }),
          form('leave', 'Leave Request', ['Start', 'End', 'Reason']),
          form('access-request', 'Access Request', ['System', 'Justification']),
        ],
      },
      {
        slug: 'facilities', name: 'Facilities', webApis: [],
        forms: [form('room-booking', 'Room Booking', ['Room', 'Date', 'Attendees']), form('maintenance', 'Maintenance', ['Location', 'Issue'])],
      },
    ],
    workflows: [
      {
        id: 'w-dev-1', scope: 'form:services/it-request', name: 'Create Ticket', event: 'Submission Submitted', filter: '', status: 'Active', notes: '',
        treeJson: { nodes: [...tree(['Start', 'Create Ticket']).nodes, { id: 'node_3', name: 'Notify Requester', definitionId: 'routine_notify_requester_v1' }] },
      },
      { id: 'w-dev-2', scope: 'form:services/leave', name: 'Manager Approval', event: 'Submission Submitted', filter: '', status: 'Active', notes: '', treeJson: tree(['Start', 'Ask Manager', 'Close']) },
      { id: 'w-dev-3', scope: 'kapp:facilities', name: 'Notify Facilities', event: 'Submission Created', filter: '', status: 'Active', notes: '', treeJson: tree(['Start', 'Email Team']) },
    ],
    connections: [
      {
        id: 'c-ticketing', name: 'Ticketing', type: 'http',
        config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc-ticketing' } },
        operations: [
          { id: 'o-create-ticket', name: 'Create Ticket', connectionId: 'c-ticketing', config: { method: 'POST', path: '/tickets' } },
          { id: 'o-get-ticket', name: 'Get Ticket', connectionId: 'c-ticketing', config: { method: 'GET', path: '/tickets/{{id}}' } },
        ],
      },
      {
        id: 'c-directory', name: 'Directory', type: 'http',
        config: { baseUrl: 'https://directory.example.com', auth: { authType: 'none' } },
        operations: [{ id: 'o-find-person', name: 'Find Person', connectionId: 'c-directory', config: { method: 'GET', path: '/people' } }],
      },
    ],
    handlers: [{
      zip: MAIL_ZIP,
      handler: {
        definitionId: 'mail_send_v1', definitionName: 'mail_send', definitionVersion: '1', name: 'Mail Send', description: 'Sends email',
        status: 'Active', deferrable: false, visible: true, categories: [{ name: 'Notifications' }],
        properties: [{ name: 'Server', type: 'Plaintext', value: 'smtp.dev.example.com' }, { name: 'Password', type: 'Encrypted' }],
      },
    }],
    routines: [routine('Notify Requester', 'routine_notify_requester_v1', ['Start', 'Find Requester', 'Send Email'])],
  };
}

function testSpace(): FakeSpace {
  const dev = devSpace();
  const [services, facilities] = dev.kapps;
  return {
    space: { ...dev.space, name: 'Test Space', slug: 'test' },
    // Contractors is only in Test (something to remove).
    teams: [team('Operations', 'Service desk'), team('Facilities', 'Buildings and rooms'), team('Contractors', 'Former contractor access')],
    kapps: [
      { ...services, forms: [form('it-request', 'IT Request', ['Summary', 'Priority']), services.forms[1], services.forms[2]] },
      { ...facilities, forms: [facilities.forms[0], form('maintenance', 'Maintenance', ['Location', 'Issue', 'Urgency'])] },
    ],
    workflows: [
      { ...dev.workflows[0], id: 'w-test-1', treeJson: tree(['Start', 'Notify Requester']) },
      { ...dev.workflows[2], id: 'w-test-3' },
    ],
    connections: [dev.connections[1]],
    handlers: [],
    routines: [],
  };
}

let seq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const clone = <T>(v: T): T => structuredClone(v);

const scopeOf = (path: string): string | undefined => {
  if (path === '/workflows') return 'space';
  let m = /^\/kapps\/([^/]+)\/workflows$/.exec(path);
  if (m) return `kapp:${decodeURIComponent(m[1])}`;
  m = /^\/kapps\/([^/]+)\/forms\/([^/]+)\/workflows$/.exec(path);
  return m ? `form:${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : undefined;
};
const itemType = (scope: string) => (scope === 'space' ? 'Space' : scope.startsWith('kapp:') ? 'Kapp' : 'Form');
const enc = encodeURIComponent;

// GET routes for the engine's fake client, built from the current state.
function routes(s: FakeSpace): Obj {
  const r: Obj = {
    'GET core/me': { username: 'admin', spaceAdmin: true },
    'GET core/space': { space: s.space },
    'GET core/teams': { teams: s.teams },
    'GET core/fileResources': { fileResources: [] },
    'GET core/kapps': { kapps: s.kapps.map((k) => ({ slug: k.slug, name: k.name })) },
    'GET integrator/connections': s.connections.map((c) => ({ id: c.id, name: c.name })),
    'GET task/trees': ({ query }: { query?: Obj }) => {
      const trees = s.routines.filter((t) => !query?.type || t.type === query.type).map(clone);
      const offset = Number(query?.offset ?? 0);
      const limit = Number(query?.limit ?? 100);
      return { trees: trees.slice(offset, offset + limit), count: trees.length };
    },
    'GET task/handlers': { handlers: s.handlers.map((h) => h.handler), count: s.handlers.length },
  };
  for (const k of s.kapps) r[`GET core/kapps/${enc(k.slug)}`] = { kapp: k };
  const wfBase = (scope: string) => (scope === 'space' ? 'core/workflows'
    : scope.startsWith('kapp:') ? `core/kapps/${enc(scope.slice(5))}/workflows`
      : `core/kapps/${scope.slice(5).split('/').map(enc).join('/forms/')}/workflows`);
  const scopes = ['space', ...s.kapps.flatMap((k) => [`kapp:${k.slug}`, ...(k.forms ?? []).map((f: Obj) => `form:${k.slug}/${f.slug}`)])];
  for (const scope of scopes) {
    const list = s.workflows.filter((w) => w.scope === scope).map(({ scope: sc, ...w }) => ({ ...w, platformItemType: itemType(sc) }));
    r[`GET ${wfBase(scope)}`] = { workflows: list };
    for (const w of list) r[`GET ${wfBase(scope)}/${enc(w.id)}`] = { workflow: w };
  }
  for (const c of s.connections) {
    r[`GET integrator/export/connections/${enc(c.id)}`] = { connection: c };
    for (const op of c.operations) r[`GET integrator/connections/${enc(c.id)}/operations/${enc(op.id)}`] = { operation: op };
  }
  for (const t of s.routines) r[`GET task/trees/${enc(t.title)}`] = clone(t);
  for (const h of s.handlers) {
    r[`GET task/handlers/${enc(h.handler.definitionId)}`] = { handler: h.handler };
    r[`GET task/handlers/${enc(h.handler.definitionId)}/zip`] = h.zip;
  }
  return r;
}

const upsert = (list: Obj[], match: (x: Obj) => boolean, value: Obj) => {
  const i = list.findIndex(match);
  if (i >= 0) list[i] = value; else list.push(value);
};

// Applies a write to the state. Unknown writes are accepted and ignored.
function write(s: FakeSpace, catalog: FakeSpace, api: string, method: string, path: string, body: any, form?: FormData): unknown {
  const dec = decodeURIComponent;
  let m: RegExpExecArray | null;
  if (api === 'core') {
    if (method === 'PUT' && path === '/space') { Object.assign(s.space, clone(body)); return {}; }
    if (method === 'POST' && path === '/teams') { s.teams.push({ ...clone(body), slug: body.slug ?? team(body.name, '').slug }); return {}; }
    if ((m = /^\/teams\/([^/]+)$/.exec(path))) {
      const slug = dec(m[1]);
      if (method === 'PUT') upsert(s.teams, (t) => t.slug === slug, { ...clone(body), slug });
      if (method === 'DELETE') s.teams = s.teams.filter((t) => t.slug !== slug);
      return {};
    }
    if (method === 'POST' && path === '/kapps') { s.kapps.push({ ...clone(body), webApis: [], forms: [] }); return {}; }
    if ((m = /^\/kapps\/([^/]+)$/.exec(path))) {
      const kapp = s.kapps.find((k) => k.slug === dec(m![1]));
      if (method === 'PUT' && kapp) Object.assign(kapp, clone(body), { forms: kapp.forms, webApis: kapp.webApis });
      if (method === 'DELETE') s.kapps = s.kapps.filter((k) => k !== kapp);
      return {};
    }
    if ((m = /^\/kapps\/([^/]+)\/forms(?:\/([^/]+))?$/.exec(path))) {
      const kapp = s.kapps.find((k) => k.slug === dec(m![1]));
      if (!kapp) throw Object.assign(new Error(`404 ${api}${path}`), { status: 404 });
      const slug = m[2] ? dec(m[2]) : body?.slug;
      if (method === 'DELETE') kapp.forms = kapp.forms.filter((f: Obj) => f.slug !== slug);
      else upsert(kapp.forms, (f) => f.slug === slug, clone(body));
      return {};
    }
    const scope = scopeOf(path);
    if (scope && method === 'POST') {
      const created: Workflow = { filter: '', status: 'Active', notes: '', ...clone(body), id: newId('w'), scope, treeJson: { nodes: [] } };
      s.workflows.push(created);
      return { workflow: created };
    }
    if ((m = /^(.*)\/([^/]+)$/.exec(path)) && scopeOf(m[1])) {
      const id = dec(m[2]);
      const cur = s.workflows.find((w) => w.id === id);
      if (method === 'PUT' && cur) Object.assign(cur, clone(body), { id, scope: cur.scope });
      if (method === 'DELETE') s.workflows = s.workflows.filter((w) => w.id !== id);
      return {};
    }
    return {};
  }
  if (api === 'integrator') {
    if (method === 'POST' && path === '/import/connections') {
      const { auth, ...config } = body.config ?? {};
      // Auth secrets are accepted and dropped: the export never returns them.
      const kept = Object.fromEntries(Object.entries(auth ?? {}).filter(([k]) => !/password|secret|token/i.test(k)));
      s.connections.push({ ...clone(body), id: body.id ?? newId('c'), config: { ...clone(config), ...(auth ? { auth: kept } : {}) }, operations: [] });
      return {};
    }
    if ((m = /^\/import\/connections\/([^/]+)\/operations$/.exec(path)) && method === 'POST') {
      const conn = s.connections.find((c) => c.id === dec(m![1]));
      for (const op of body ?? []) conn?.operations.push({ ...clone(op), id: op.id ?? newId('o'), connectionId: conn.id });
      return {};
    }
    if ((m = /^\/connections\/([^/]+)(?:\/operations\/([^/]+))?$/.exec(path))) {
      const conn = s.connections.find((c) => c.id === dec(m![1]));
      if (m[2] && conn) {
        const id = dec(m[2]);
        if (method === 'PUT') upsert(conn.operations, (o) => o.id === id, { ...clone(body), id, connectionId: conn.id });
        if (method === 'DELETE') conn.operations = conn.operations.filter((o: Obj) => o.id !== id);
      } else if (method === 'DELETE') s.connections = s.connections.filter((c) => c !== conn);
      return {};
    }
    return {};
  }
  if (api === 'task') {
    if (method === 'POST' && path === '/trees') {
      const { sourceName, sourceGroup, ...tree } = clone(body ?? {});
      if (s.routines.some((t) => t.title === tree.name)) throw Object.assign(new Error(`400 a tree named ${tree.name} exists`), { status: 400 });
      const created = { ...tree, title: tree.name, versionId: '0' };
      s.routines.push(created);
      return { tree: created };
    }
    if ((m = /^\/trees\/([^/]+)$/.exec(path))) {
      const title = dec(m[1]);
      const cur = s.routines.find((t) => t.title === title);
      if (method === 'PUT') {
        if (!cur) throw Object.assign(new Error(`404 task${path}`), { status: 404 });
        if (String(body?.versionId) !== String(cur.versionId)) throw Object.assign(new Error('400 stale_record'), { status: 400 });
        const { versionId, ...changes } = clone(body);
        Object.assign(cur, changes, { versionId: String(Number(versionId) + 1) });
        return { tree: cur };
      }
      if (method === 'DELETE') s.routines = s.routines.filter((t) => t !== cur);
      return {};
    }
    if (method === 'POST' && path === '/handlers') {
      const file = form?.get('package') as File | null;
      const id = file?.name?.replace(/\.zip$/, '');
      const source = catalog.handlers.find((h) => h.handler.definitionId === id);
      if (source) {
        const installed = clone(source.handler);
        installed.properties = installed.properties.map((p: Obj) => ({ name: p.name, type: p.type }));
        upsert(s.handlers as unknown as Obj[], (h) => h.handler.definitionId === id, { handler: installed, zip: source.zip });
      }
      return {};
    }
    if ((m = /^\/handlers\/([^/]+)$/.exec(path))) {
      const id = dec(m[1]);
      const h = s.handlers.find((x) => x.handler.definitionId === id);
      if (method === 'PUT' && h) {
        for (const [name, value] of Object.entries(body?.properties ?? {})) {
          const p = h.handler.properties.find((x: Obj) => x.name === name);
          // Encrypted values are stored but never read back.
          if (p && p.type !== 'Encrypted') p.value = value;
        }
      }
      if (method === 'DELETE') s.handlers = s.handlers.filter((x) => x !== h);
    }
    return {};
  }
  return {};
}

// One fake space per environment name: "dev" is the Dev space, any other name
// gets its own copy of the Test space. State lasts as long as the server.
export function fakeSpacesFactory(): ClientFactory {
  const catalog = devSpace();
  const spaces = new Map<string, FakeSpace>();
  return ({ env, mode }) => {
    if (mode === 'write' && env.readOnly) {
      const e = new Error(`${env.name} is read-only`);
      e.name = 'ReadOnlyError';
      throw e;
    }
    let s = spaces.get(env.name);
    if (!s) spaces.set(env.name, (s = env.name === 'dev' ? devSpace() : testSpace()));
    const space = s;
    const request = async (api: string, method: string, path: string, opts: { query?: Obj; body?: unknown; form?: FormData } = {}) => {
      if (method === 'GET') return fakeClient(routes(space), { mode }).request(api, method, path, opts);
      if (mode === 'read') throw new Error(`read-only client got ${method} ${path}`);
      return write(space, catalog, api, method, path, opts.body, opts.form);
    };
    const client: EngineClient & { getBinary: EngineClient['get'] } = {
      mode,
      request,
      get: (api, path, query) => request(api, 'GET', path, { query }),
      getBinary: (api, path, query) => request(api, 'GET', path, { query }),
    };
    return client;
  };
}
