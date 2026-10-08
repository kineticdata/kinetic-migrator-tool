import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import { stripSecrets, stripSecretHeaders, normalizeConnection, normalizeOperation, missingAuthFields } from './connections.mjs';
import { HttpError } from '../http.mjs';
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

test('stripSecrets drops private_key, passphrase, passcode, authorization and keeps tokenType/accessTokenUrl/username/clientId', () => {
  assert.deepEqual(stripSecrets({
    authType: 'oauth2', clientId: 'id', privateKey: 'k', passphrase: 'p', passcode: 'code', secret: 's', authorization: 'Bearer x', tokenType: 'Bearer', accessTokenUrl: 'https://a', username: 'u',
  }), { authType: 'oauth2', clientId: 'id', tokenType: 'Bearer', accessTokenUrl: 'https://a', username: 'u' });
});

test('stripSecretHeaders drops literal Authorization and Api-Key but keeps templated and non-secret headers', () => {
  assert.deepEqual(stripSecretHeaders({
    Authorization: 'Basic abc', 'X-Api-Key': 'k', 'Authorization': 'Bearer {{Token}}', Accept: 'application/json',
  }), { 'Authorization': 'Bearer {{Token}}', Accept: 'application/json' });
});

test('stripSecretHeaders returns non-objects unchanged', () => {
  assert.equal(stripSecretHeaders(null), null);
  assert.equal(stripSecretHeaders(undefined), undefined);
});

test('normalizeConnection drops status (which can hold credentials), secrets, metadata and operations', () => {
  assert.deepEqual(normalizeConnection(EXPORTED), {
    id: 'c-1', name: 'My API', type: 'http',
    config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc' } },
  });
});

test('normalizeOperation drops a literal Authorization header in config.headers', () => {
  assert.deepEqual(normalizeOperation({
    id: 'o-1', connectionId: 'c-1', name: 'Op', config: { method: 'POST', headers: { Authorization: 'Basic x', Accept: 'application/json' } },
  }), {
    id: 'o-1', connectionId: 'c-1', name: 'Op', config: { method: 'POST', headers: { Accept: 'application/json' } }, strippedHeaders: ['Authorization'],
  });
});

test('connections and operations list from the Integrator export, keyed by name, ids kept', async () => {
  const c = fakeClient({
    'GET integrator/connections': [{ id: 'c-1', name: 'My API' }],
    'GET integrator/export/connections/c-1': EXPORTED,
  }, { mode: 'read' });
  const ctx = { config: TEST_CONFIG };
  const [conn] = await connections.list(c, ctx);
  assert.equal(conn.key, 'connections/My API/connection');
  assert.deepEqual(conn.meta, { id: 'c-1' });
  const ops = await operations.list(c, ctx);
  assert.deepEqual(ops.map((o) => o.key), ['connections/My API/operations/Alpha', 'connections/My API/operations/Zeta']);
  assert.deepEqual(ops[1].data, { id: 'o-2', connectionId: 'c-1', name: 'Zeta', config: { method: 'GET', path: '/z' } });
  assert.equal(c.calls.filter((x) => x.path.startsWith('/export')).length, 1, 'export fetched once per context');
});

test('a new connection is imported with its id, supplied secrets and no operations', async () => {
  const c = fakeClient();
  const desired = normalizeConnection(EXPORTED);
  await connections.apply(c, { key: 'connections/My API/connection', desired, existing: null }, { connectionSecrets: () => ({ password: 'pw' }) });
  assert.equal(c.calls[0].path, '/import/connections');
  assert.equal(c.calls[0].body.id, 'c-1');
  assert.deepEqual(c.calls[0].body.config.auth, { authType: 'basic', username: 'svc', password: 'pw' });
  assert.deepEqual(c.calls[0].body.operations, []);
});

test('an existing connection is never written', async () => {
  assert.equal(connections.updatable, false);
  const c = fakeClient();
  await assert.rejects(
    connections.apply(c, { key: 'k', desired: {}, existing: { data: {}, meta: { id: 'c-1' } } }, {}),
    /never updated automatically/,
  );
  assert.equal(c.calls.length, 0);
});

test('operations: import new with id, PUT existing, prune by id', async () => {
  const c = fakeClient();
  const op = { id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: {} };
  await operations.apply(c, { key: 'x', desired: op, existing: null }, {});
  await operations.apply(c, { key: 'x', desired: op, existing: { data: op, meta: { id: 'o-1', connectionId: 'c-1' } } }, {});
  await operations.prune(c, { key: 'x', data: op, meta: { id: 'o-1', connectionId: 'c-1' } });
  assert.deepEqual(c.calls[0].body, [op], 'the import endpoint takes an array');
  assert.deepEqual(c.calls[1].body, op);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    'POST /import/connections/c-1/operations', 'PUT /connections/c-1/operations/o-1', 'DELETE /connections/c-1/operations/o-1',
  ]);
});

const missingBody = (fields) => JSON.stringify({
  error: 'Request does not match the API schema', errorKey: 'invalid_request',
  validationErrors: fields.map((f) => ({ error: `Missing field: ${f}`, path: `/config/auth/${f}` })),
});

test('missingAuthFields reads Missing field errors under /config/auth only', () => {
  const err = new HttpError({ method: 'POST', url: '/import/connections', status: 400, body: JSON.stringify({
    validationErrors: [
      { error: 'Missing field: token', path: '/config/auth/token' },
      { error: 'Missing field: baseUrl', path: '/config/baseUrl' },
      { error: 'Invalid value', path: '/config/auth/header' },
    ],
  }) });
  assert.deepEqual(missingAuthFields(err), ['token']);
  assert.deepEqual(missingAuthFields(new HttpError({ method: 'POST', url: '/x', status: 500, body: missingBody(['token']) })), []);
  assert.deepEqual(missingAuthFields(new HttpError({ method: 'POST', url: '/x', status: 400, body: 'not json' })), []);
});

test('a new connection without a supplied secret is retried with an empty required auth field', async () => {
  const calls = [];
  const client = {
    async request(api, method, path, { body }) {
      calls.push(structuredClone(body));
      if (!('token' in body.config.auth)) {
        throw new HttpError({ method, url: path, status: 400, body: missingBody(['token']) });
      }
      return {};
    },
  };
  const warnings = [];
  const desired = { id: 'c-9', name: 'Bearer API', type: 'http', config: { baseUrl: 'https://api.example.com', auth: { authType: 'raw_bearer_token', header: 'Authorization', prefix: 'Bearer' } } };
  await connections.apply(client, { key: 'connections/Bearer API/connection', desired, existing: null }, { connectionSecrets: () => ({}), warn: (m) => warnings.push(m) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].config.auth, { authType: 'raw_bearer_token', header: 'Authorization', prefix: 'Bearer', token: '' });
  assert.equal(calls[1].id, 'c-9');
  assert.match(warnings[0], /empty auth "token"/);
});

test('a connection import error that is not a missing auth field is not retried', async () => {
  let n = 0;
  const client = { async request(api, method, path) { n++; throw new HttpError({ method, url: path, status: 400, body: missingBody([]) }); } };
  const desired = { id: 'c-9', name: 'X', config: { auth: { authType: 'basic' } } };
  await assert.rejects(connections.apply(client, { key: 'k', desired, existing: null }, { connectionSecrets: () => ({}) }), /400/);
  assert.equal(n, 1);
});

test('stripSecretHeaders matches credential header names by their last segment only', () => {
  assert.deepEqual(stripSecretHeaders({
    Authorization: 'Basic abc', 'X-Api-Key': 'k', 'X-Auth-Token': 't', api_key: 'k2', 'Client-Secret': 's',
    'X-Token-Expiry': '3600', 'X-Password-Policy': 'strict', Accept: 'application/json',
  }), { 'X-Token-Expiry': '3600', 'X-Password-Policy': 'strict', Accept: 'application/json' });
});

test('normalizeOperation records the sorted names of stripped headers, never their values', () => {
  const op = normalizeOperation({
    id: 'o-1', connectionId: 'c-1', name: 'Op',
    config: { headers: { 'X-Auth-Token': 'secret-1', Authorization: 'Basic x', 'X-Templated-Token': '{{Token}}', Accept: 'a' } },
  });
  assert.deepEqual(op.strippedHeaders, ['Authorization', 'X-Auth-Token']);
  assert.deepEqual(op.config.headers, { 'X-Templated-Token': '{{Token}}', Accept: 'a' });
  assert.equal(JSON.stringify(op).includes('secret-1'), false);
  assert.equal('strippedHeaders' in normalizeOperation({ id: 'o', config: { headers: { Accept: 'a' } } }), false);
});

test('an existing operation keeps the target values of stripped headers and the PUT omits strippedHeaders', async () => {
  const c = fakeClient({
    'GET integrator/connections/c-1/operations/o-1': {
      operation: { id: 'o-1', config: { headers: { Authorization: 'Bearer target-value', Accept: 'old' } } },
    },
  });
  const desired = { id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: { method: 'GET', headers: { Accept: 'application/json' } }, strippedHeaders: ['Authorization', 'X-Api-Key'] };
  await operations.apply(c, { key: 'connections/My API/operations/Alpha', desired, existing: { data: desired, meta: { id: 'o-1', connectionId: 'c-1' } } }, {});
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['GET /connections/c-1/operations/o-1', 'PUT /connections/c-1/operations/o-1']);
  assert.deepEqual(c.calls[1].body, {
    id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer target-value' } },
  });
});

test('a new operation with stripped headers is imported without them and warns once per name', async () => {
  const c = fakeClient();
  const warnings = [];
  const desired = { id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: { headers: {} }, strippedHeaders: ['Authorization', 'X-Api-Key'] };
  await operations.apply(c, { key: 'connections/My API/operations/Alpha', desired, existing: null }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(c.calls[0].body, [{ id: 'o-1', connectionId: 'c-1', name: 'Alpha', config: { headers: {} } }]);
  assert.deepEqual(warnings, [
    'connections/My API/operations/Alpha: header "Authorization" held a credential and was not exported; add it by hand in the target',
    'connections/My API/operations/Alpha: header "X-Api-Key" held a credential and was not exported; add it by hand in the target',
  ]);
});

test('normalizeConnection uses the same anchored header match', () => {
  const c = normalizeConnection({ id: 'c', name: 'C', config: { headers: { 'X-Auth-Token': 'x', 'X-Token-Expiry': '60' } } });
  assert.deepEqual(c.config.headers, { 'X-Token-Expiry': '60' });
});
