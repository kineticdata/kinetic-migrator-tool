import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import { writeTree } from '../store.mjs';
import { prepareDesired } from '../overrides.mjs';
import handlers, { normalizeHandler, assertNoSecretValues, listHandlers } from './handlers.mjs';


const sha = (b) => createHash('sha256').update(b).digest('hex');
const ZIP = Buffer.from('PK\x03\x04 mail package v1');
const ZIP2 = Buffer.from('PK\x03\x04 mail package v2');

const raw = (definitionId, extra = {}) => ({
  id: 'x', createdAt: '2026-01-01', updatedAt: '2026-01-02',
  definitionId, definitionName: definitionId.replace(/_v\d+$/, ''), definitionVersion: '1',
  name: 'Mail Send', description: 'Sends mail', status: 'Active', deferrable: false, visible: true,
  selectionCriterion: null,
  categories: [{ name: 'Mail' }, { name: 'Alerts' }],
  properties: [
    { name: 'server', type: 'Plaintext', required: true, description: 'Host', value: 'smtp.dev.example.com' },
    { name: 'password', type: 'Encrypted', required: true, description: 'Secret', value: 'hunter2' },
    { name: 'port', type: 'Plaintext', required: false, description: 'Port', value: '25' },
  ],
  ...extra,
});

const INC = { include: 'details,properties,categories' };

test('normalizeHandler keeps the portable fields, sorts, never keeps an Encrypted value and records the package hash', () => {
  const d = normalizeHandler(raw('mail_send_v1'), ZIP);
  assert.deepEqual(d, {
    definitionId: 'mail_send_v1', definitionName: 'mail_send', definitionVersion: '1',
    name: 'Mail Send', description: 'Sends mail', status: 'Active', deferrable: false, visible: true,
    categories: ['Alerts', 'Mail'],
    properties: [
      { name: 'password', type: 'Encrypted', required: true, description: 'Secret' },
      { name: 'port', type: 'Plaintext', required: false, description: 'Port', value: '25' },
      { name: 'server', type: 'Plaintext', required: true, description: 'Host', value: 'smtp.dev.example.com' },
    ],
    packageSha256: sha(ZIP),
  });
  assert.doesNotMatch(JSON.stringify(d), /hunter2/);
});

test('list exports installed handlers with their package, skipping built-ins and zip-404 handlers', async () => {
  const c = fakeClient({
    'GET task/handlers': { handlers: [raw('utilities_echo_v1'), raw('system_x_v1'), raw('mail_send_v1'), raw('vendor_builtin_v1')] },
    'GET task/handlers/mail_send_v1/zip': ZIP,
    'GET task/handlers/uncategorized_v1': { handler: raw('uncategorized_v1', { categories: [] }) },
    'GET task/handlers/uncategorized_v1/zip': ZIP2,
  }, { mode: 'read' });
  const ctx = { config: TEST_CONFIG, collected: [
    { key: 'routines/R', data: { definitionId: 'routine_r_v1' } },
    { key: 'kapps/k/forms/f/workflows/E/N', data: { treeJson: { nodes: [
      { definitionId: 'system_start_v1' }, { definitionId: 'utilities_echo_v1' }, { definitionId: 'routine_r_v1' },
      { definitionId: 'mail_send_v1' }, { definitionId: 'uncategorized_v1' }, { definitionId: 'not_installed_v1' },
    ] } } },
  ] };
  const out = await handlers.list(c, ctx);
  assert.deepEqual(out.map((a) => a.key), ['handlers/mail_send_v1/handler', 'handlers/uncategorized_v1/handler']);
  assert.deepEqual(c.calls[0].query, { ...INC, limit: 100, offset: 0 });
  assert.deepEqual(c.calls.find((x) => x.path === '/handlers/uncategorized_v1').query, INC);
  const fetched = c.calls.map((x) => x.path);
  for (const p of ['/handlers/utilities_echo_v1/zip', '/handlers/system_x_v1/zip', '/handlers/routine_r_v1', '/handlers/utilities_echo_v1']) {
    assert.ok(!fetched.includes(p), p);
  }
  assert.ok(fetched.includes('/handlers/vendor_builtin_v1/zip'));
  assert.deepEqual(out[0].files, { 'package.zip': ZIP });
  assert.equal(out[1].data.packageSha256, sha(ZIP2));
  assert.equal(out[0].scope ?? handlers.scope, 'handler');
  for (const a of out) assert.doesNotMatch(JSON.stringify(a.data), /hunter2/);
});

test('encrypted-looking types lose their values; the safety net refuses any secret property that keeps one', () => {
  for (const type of ['encrypted', 'EncryptedText']) {
    const d = normalizeHandler(raw('h_v1', { properties: [{ name: 'p', type, value: 'v' }] }), ZIP);
    assert.equal(d.properties[0].value, undefined, type);
  }
  assert.throws(() => assertNoSecretValues('h_v1', [{ name: 'p', type: 'EncryptedText', value: 'v' }]), /h_v1.*"p".*secret/i);
  assert.throws(() => assertNoSecretValues('h_v1', [{ name: 'prod_private_key_b64', type: 'Plaintext', value: 'v' }]), /prod_private_key_b64/);
  assert.doesNotThrow(() => assertNoSecretValues('h_v1', [{ name: 'prod_client_id', type: 'Plaintext', value: 'v' }, { name: 'api_token', type: 'Plaintext' }]));
});

test('owns only handler definitions', () => {
  assert.ok(handlers.owns('handlers/mail_send_v1/handler'));
  assert.ok(!handlers.owns('handlers/mail_send_v1/package'));
  assert.ok(!handlers.owns('handlers/mail_send_v1'));
});

// ---- apply ----

function exportWith(zip = ZIP) {
  const dir = join(mkdtempSync(join(tmpdir(), 'ksync-handlers-')), 'export');
  writeTree(dir, [{ key: 'handlers/mail_send_v1/handler', data: normalizeHandler(raw('mail_send_v1'), zip), files: { 'package.zip': zip } }]);
  return dir;
}

function item({ exported, existing, overrides = {} }) {
  const key = 'handlers/mail_send_v1/handler';
  const desired = prepareDesired({ key, scope: 'handler', exported, existing: existing?.data, overrides, vars: {} });
  return { key, type: 'handlers', desired, existing, action: existing ? 'update' : 'create' };
}

const ctxFor = (exportDir, secrets = {}) => {
  const warnings = [];
  return { warnings, ctx: { exportDir, warn: (m) => warnings.push(m), handlerSecrets: () => secrets } };
};

test('install uploads the package, then sets plaintext and supplied encrypted properties; warns for unset encrypted ones', async () => {
  const exportDir = exportWith();
  const exported = normalizeHandler(raw('mail_send_v1', { properties: [
    ...raw('mail_send_v1').properties, { name: 'API Key', type: 'Encrypted', required: false, description: '' },
  ] }), ZIP);
  const c = fakeClient({});
  const { ctx, warnings } = ctxFor(exportDir, { PASSWORD: 's3cret' });
  await handlers.apply(c, item({ exported }), ctx);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['POST /handlers', 'PUT /handlers/mail_send_v1']);
  assert.deepEqual(c.calls[0].form, ['package']);
  assert.equal(c.calls[0].query, undefined);
  assert.deepEqual(c.calls[1].body, { properties: { password: 's3cret', port: '25', server: 'smtp.dev.example.com' } });
  assert.deepEqual(warnings, ['handlers/mail_send_v1/handler: secret property "API Key" is not set; set it in the target console']);
});

test('install refuses a package.zip that does not match handler.json', async () => {
  const exportDir = exportWith(ZIP2);
  const c = fakeClient({});
  const { ctx } = ctxFor(exportDir);
  await assert.rejects(handlers.apply(c, item({ exported: normalizeHandler(raw('mail_send_v1'), ZIP) }), ctx), /package\.zip/);
  assert.deepEqual(c.calls, []);
});

test('a changed package is force re-uploaded, plaintext values re-asserted, supplied secrets re-sent and unset ones flagged', async () => {
  const exportDir = exportWith(ZIP2);
  const exported = normalizeHandler(raw('mail_send_v1'), ZIP2);
  const existing = { key: 'handlers/mail_send_v1/handler', data: normalizeHandler(raw('mail_send_v1', { properties: [
    { name: 'server', type: 'Plaintext', required: true, description: 'Host', value: 'smtp.test.example.com' },
    { name: 'password', type: 'Encrypted', required: true, description: 'Secret' },
    { name: 'port', type: 'Plaintext', required: false, description: 'Port', value: '587' },
  ] }), ZIP) };
  const c = fakeClient({});
  const { ctx, warnings } = ctxFor(exportDir, { PASSWORD: 'from-env' });
  await handlers.apply(c, item({ exported, existing }), ctx);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['POST /handlers', 'PUT /handlers/mail_send_v1']);
  assert.deepEqual(c.calls[0].query, { force: 'true' });
  assert.deepEqual(c.calls[1].body, { properties: { password: 'from-env', port: '587', server: 'smtp.test.example.com' } });
  assert.deepEqual(warnings, []);

  const d = fakeClient({});
  const quiet = ctxFor(exportDir, {});
  await handlers.apply(d, item({ exported, existing }), quiet.ctx);
  assert.deepEqual(d.calls[1].body, { properties: { port: '587', server: 'smtp.test.example.com' } });
  assert.deepEqual(quiet.warnings, ['handlers/mail_send_v1/handler: package re-installed; check secret property "password" in the target console']);
});

test('listHandlers pages GET /handlers with limit/offset until count is reached', async () => {
  const all = ['a_v1', 'b_v1', 'c_v1'].map((id) => raw(id));
  const c = fakeClient({
    'GET task/handlers': ({ query }) => ({ handlers: all.slice(query.offset, query.offset + 2), count: all.length, limit: 2, offset: query.offset }),
  }, { mode: 'read' });
  assert.deepEqual((await listHandlers(c, 2)).map((h) => h.definitionId), ['a_v1', 'b_v1', 'c_v1']);
  const pages = c.calls.filter((x) => x.path === '/handlers');
  assert.deepEqual(pages.map((x) => x.query.offset), [0, 2]);
  assert.equal(pages[0].query.include, 'details,properties,categories');
});

test('an override changes only that plaintext property; nothing is uploaded and Encrypted is never sent', async () => {
  const exportDir = exportWith();
  const exported = normalizeHandler(raw('mail_send_v1'), ZIP);
  const existing = { key: 'handlers/mail_send_v1/handler', data: normalizeHandler(raw('mail_send_v1', { properties: [
    { name: 'server', type: 'Plaintext', required: true, description: 'Host', value: 'smtp.test.example.com' },
    { name: 'password', type: 'Encrypted', required: true, description: 'Secret' },
    { name: 'port', type: 'Plaintext', required: false, description: 'Port', value: '587' },
  ] }), ZIP) };
  const overrides = { artifacts: { 'handlers/mail_send_v1/handler': { 'properties.server': { value: 'smtp.prod.example.com' }, 'properties.password': { value: 'leak' } } } };
  const c = fakeClient({});
  const { ctx } = ctxFor(exportDir, { PASSWORD: 'never' });
  await handlers.apply(c, item({ exported, existing, overrides }), ctx);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['PUT /handlers/mail_send_v1']);
  assert.deepEqual(c.calls[0].body, { properties: { server: 'smtp.prod.example.com' } });
});

test('without an override the target keeps its own property values: nothing to apply', () => {
  const exported = normalizeHandler(raw('mail_send_v1'), ZIP);
  const target = normalizeHandler(raw('mail_send_v1', { properties: [{ name: 'server', type: 'Plaintext', required: true, description: 'Host', value: 'smtp.test.example.com' }, { name: 'password', type: 'Encrypted', required: true, description: 'Secret' }, { name: 'port', type: 'Plaintext', required: false, description: 'Port', value: '587' }] }), ZIP);
  assert.deepEqual(item({ exported, existing: { data: target } }).desired, target);
});

test('a difference the tool cannot write is skipped with a warning', async () => {
  const exported = normalizeHandler(raw('mail_send_v1'), ZIP);
  const existing = { key: 'handlers/mail_send_v1/handler', data: { ...exported, categories: ['Other'] } };
  const c = fakeClient({});
  const { ctx, warnings } = ctxFor(exportWith());
  assert.deepEqual(await handlers.apply(c, item({ exported, existing }), ctx), { skipped: true });
  assert.deepEqual(c.calls, []);
  assert.match(warnings[0], /categories/);
});

test('prune deletes the handler', async () => {
  const c = fakeClient({});
  await handlers.prune(c, { key: 'handlers/mail_send_v1/handler', data: { definitionId: 'mail_send_v1' } });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['DELETE /handlers/mail_send_v1']);
});

// ---- secret-named properties ----

import { isSecretName, isSecretProperty } from './common.mjs';

test('isSecretName shares the connection secret pattern, with the identity/URL allowlist in any case or underscore form', () => {
  for (const n of ['prod_private_key_b64', 'sb2_private_key_b64', 'api_token', 'client_secret', 'Password', 'token_url_override',
    'Private Key', 'private-key', 'API Key', 'Api-Key', 'x-api-key', 'Pass Phrase']) {
    assert.ok(isSecretName(n), n);
  }
  for (const n of ['prod_client_id', 'server', 'port', 'token_url', 'TokenUrl', 'Token URL', 'client_id', 'Client-Id', 'username', 'access_token_url', 'Key Name']) {
    assert.ok(!isSecretName(n), n);
  }
  assert.ok(isSecretProperty({ name: 'x', type: 'Encrypted' }));
  assert.ok(isSecretProperty({ name: 'api_token', type: 'Plaintext' }));
  assert.ok(!isSecretProperty({ name: 'prod_client_id', type: 'Plaintext' }));
});

const secretRaw = () => raw('vault_sign_v1', { properties: [
  { name: 'prod_private_key_b64', type: 'Plaintext', required: true, description: '', value: 'LEAKED-KEY' },
  { name: 'api_token', type: 'Plaintext', required: false, description: '', value: 'LEAKED-TOKEN' },
  { name: 'client_secret', type: 'Plaintext', required: false, description: '', value: 'LEAKED-SECRET' },
  { name: 'prod_client_id', type: 'Plaintext', required: true, description: '', value: 'client-123' },
] });

test('secret-named Plaintext properties are exported without their values', () => {
  const d = normalizeHandler(secretRaw(), ZIP);
  assert.doesNotMatch(JSON.stringify(d), /LEAKED/);
  assert.deepEqual(d.properties.map((p) => [p.name, p.value]), [
    ['api_token', undefined], ['client_secret', undefined], ['prod_client_id', 'client-123'], ['prod_private_key_b64', undefined],
  ]);
});

test('secret-named properties are never diffed, never sent on update, and set on install only from handlerSecrets', async () => {
  const key = 'handlers/vault_sign_v1/handler';
  const exported = normalizeHandler(secretRaw(), ZIP);
  const dir = join(mkdtempSync(join(tmpdir(), 'ksync-handlers-')), 'export');
  writeTree(dir, [{ key, data: exported, files: { 'package.zip': ZIP } }]);

  // Install: only the supplied secret plus the plaintext id; a warning per unset secret.
  const c = fakeClient({});
  const warnings = [];
  const ctx = { exportDir: dir, warn: (m) => warnings.push(m), handlerSecrets: () => ({ API_TOKEN: 'from-env' }) };
  const desired = prepareDesired({ key, scope: 'handler', exported, existing: null, overrides: {}, vars: {} });
  await handlers.apply(c, { key, desired, existing: null }, ctx);
  assert.deepEqual(c.calls[1].body, { properties: { api_token: 'from-env', prod_client_id: 'client-123' } });
  assert.deepEqual(warnings, [
    `${key}: secret property "client_secret" is not set; set it in the target console`,
    `${key}: secret property "prod_private_key_b64" is not set; set it in the target console`,
  ]);

  // Update: the target's (equally value-less) secrets never diff and are never sent, even when overridden.
  const target = normalizeHandler(secretRaw(), ZIP);
  const overrides = { artifacts: { [key]: { 'properties.api_token': { value: 'override' }, 'properties.prod_client_id': { value: 'client-999' } } } };
  const upd = prepareDesired({ key, scope: 'handler', exported, existing: target, overrides, vars: {} });
  assert.equal(upd.properties.find((p) => p.name === 'api_token').value, undefined);
  const u = fakeClient({});
  await handlers.apply(u, { key, desired: upd, existing: { key, data: target } }, ctx);
  assert.deepEqual(u.calls.map((x) => x.body), [{ properties: { prod_client_id: 'client-999' } }]);
  const same = prepareDesired({ key, scope: 'handler', exported, existing: target, overrides: {}, vars: {} });
  assert.deepEqual(same, target);
});

test("a handler's categories are promoted as Task categories, so the target's are never a difference of the handler", async () => {
  const { mergeHandler } = await import('./handlers.mjs');
  assert.deepEqual(mergeHandler({ definitionId: 'x', categories: ['A'] }, { definitionId: 'x', categories: ['B'] }), { definitionId: 'x', categories: ['B'] });
  assert.deepEqual(mergeHandler({ definitionId: 'x', categories: ['A'] }, null), { definitionId: 'x', categories: ['A'] });
});
