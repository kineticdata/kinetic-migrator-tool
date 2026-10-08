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

  // Install: only the supplied secrets plus the plaintext id; a warning per
  // unset optional secret. A required one unset means no settings write.
  const c = fakeClient({});
  const warnings = [];
  const ctx = { exportDir: dir, warn: (m) => warnings.push(m), handlerSecrets: () => ({ API_TOKEN: 'from-env', PROD_PRIVATE_KEY_B64: 'key-from-env' }) };
  const desired = prepareDesired({ key, scope: 'handler', exported, existing: null, overrides: {}, vars: {} });
  await handlers.apply(c, { key, desired, existing: null }, ctx);
  assert.deepEqual(c.calls[1].body, { properties: { api_token: 'from-env', prod_client_id: 'client-123', prod_private_key_b64: 'key-from-env' } });
  assert.deepEqual(warnings, [`${key}: secret property "client_secret" is not set; set it in the target console`]);
  const unsupplied = fakeClient({});
  const r = await handlers.apply(unsupplied, { key, desired, existing: null }, { ...ctx, handlerSecrets: () => ({ API_TOKEN: 'from-env' }), targetLabel: 'prod' });
  assert.deepEqual(unsupplied.calls.map((x) => `${x.method} ${x.path}`), ['POST /handlers']);
  assert.match(r.attention, /^Installed; set prod_private_key_b64 in prod's Task console \(/);

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

test("a handler's categories are promoted as workflow categories, so the target's are never a difference of the handler", async () => {
  const { mergeHandler } = await import('./handlers.mjs');
  assert.deepEqual(mergeHandler({ definitionId: 'x', categories: ['A'] }, { definitionId: 'x', categories: ['B'] }), { definitionId: 'x', categories: ['B'] });
  assert.deepEqual(mergeHandler({ definitionId: 'x', categories: ['A'] }, null), { definitionId: 'x', categories: ['A'] });
});

// ---- required settings (the Task API refuses any settings write while one is empty) ----

import { fakeTaskHandlers } from '../fake-client.mjs';
import { HttpError, describePlatformError } from '../http.mjs';
import { missingRequired, unsetRequired, unsetSettingsDiff, REQUIRED_UNSET } from './handlers.mjs';

const TOKEN_ID = 'erp_oauth2_token_v2';
const TOKEN_KEY = `handlers/${TOKEN_ID}/handler`;
const TOKEN_ZIP = Buffer.from('PK\x03\x04 token handler');
// As seen live: four required properties (one secret-named) empty in the
// source, plus optional ones, one of them null.
const tokenRaw = (values = {}) => raw(TOKEN_ID, { name: 'ERP OAuth2 Token', categories: [], properties: [
  { name: 'client_id', type: 'Plaintext', required: true, description: '', value: values.client_id ?? null },
  { name: 'private_key_b64', type: 'Plaintext', required: true, description: '', value: values.private_key_b64 ?? null },
  { name: 'account_id', type: 'Plaintext', required: true, description: '', value: values.account_id ?? null },
  { name: 'certificate_id', type: 'Plaintext', required: true, description: '', value: values.certificate_id ?? null },
  { name: 'scope', type: 'Plaintext', required: false, description: '', value: null },
  { name: 'audience', type: 'Plaintext', required: false, description: '', value: 'https://erp.example.com' },
] });
// The package as installed: definitions only, no values.
const tokenCatalog = () => ({ [TOKEN_ID]: { handler: { ...tokenRaw(), properties: tokenRaw().properties.map(({ value, ...p }) => p) }, zip: TOKEN_ZIP } });

function tokenExport() {
  const dir = join(mkdtempSync(join(tmpdir(), 'ksync-handlers-')), 'export');
  const data = normalizeHandler(tokenRaw(), TOKEN_ZIP);
  writeTree(dir, [{ key: TOKEN_KEY, data, files: { 'package.zip': TOKEN_ZIP } }]);
  return { dir, data };
}

const fakeTarget = (installed = []) => {
  const task = fakeTaskHandlers(tokenCatalog(), installed);
  const calls = [];
  return { task, calls, client: fakeClient({}, { calls, fallback: task.handle }) };
};

const tokenItem = (data, existing, overrides = {}) => ({
  key: TOKEN_KEY, type: 'handlers', action: existing ? 'update' : 'create', existing,
  desired: prepareDesired({ key: TOKEN_KEY, scope: 'handler', exported: data, existing: existing?.data, overrides, vars: {} }),
});

test('the fake Task API refuses a settings write while any required property is empty, naming each one (as seen live)', async () => {
  const { client } = fakeTarget([{ definitionId: TOKEN_ID }]);
  const err = await client.request('task', 'PUT', `/handlers/${TOKEN_ID}`, { body: { properties: { audience: 'x' } } }).catch((e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 400);
  assert.deepEqual(JSON.parse(err.body), {
    message: 'Unable to save task handler',
    errors: ['client_id may not be empty', 'private_key_b64 may not be empty', 'account_id may not be empty', 'certificate_id may not be empty'],
  });
  assert.equal(describePlatformError(err), 'The Kinetic Platform rejected the change (400): Unable to save task handler — client_id may not be empty; private_key_b64 may not be empty; account_id may not be empty; certificate_id may not be empty');
});

test('live scenario: a new handler whose required settings are empty is installed, the doomed PUT is not sent, and the item asks for them', async () => {
  const { dir, data } = tokenExport();
  const { client, calls, task } = fakeTarget();
  const { ctx, warnings } = ctxFor(dir, {});
  const result = await handlers.apply(client, tokenItem(data, null), { ...ctx, targetLabel: 'Test', settingsHint: 'or enter them here and apply again' });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), ['POST /handlers']);
  assert.ok(task.handlers.has(TOKEN_ID), 'the package is installed');
  assert.deepEqual(result, {
    attention: "Installed; set account_id, certificate_id, client_id, private_key_b64 in Test's Task console (or enter them here and apply again).",
    settings: { saved: false, sent: [], empty: ['account_id', 'certificate_id', 'client_id', 'private_key_b64'] },
  });
  assert.deepEqual(warnings, []);
});

test('a new handler with every required setting supplied saves them in one PUT, and null values are never sent', async () => {
  const { dir, data } = tokenExport();
  const { client, calls, task } = fakeTarget();
  const overrides = { artifacts: { [TOKEN_KEY]: {
    'properties.client_id': { value: 'cid' }, 'properties.account_id': { value: 'acct' }, 'properties.certificate_id': { value: 'cert' },
  } } };
  const { ctx } = ctxFor(dir, { PRIVATE_KEY_B64: 'pem-from-secret' });
  assert.deepEqual(await handlers.apply(client, tokenItem(data, null, overrides), ctx), { settings: { saved: true, sent: ['private_key_b64'], empty: [] } });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), ['POST /handlers', `PUT /handlers/${TOKEN_ID}`]);
  assert.deepEqual(calls[1].body, { properties: {
    account_id: 'acct', audience: 'https://erp.example.com', certificate_id: 'cert', client_id: 'cid', private_key_b64: 'pem-from-secret',
  } });
  assert.ok(!('scope' in calls[1].body.properties), 'a null value is omitted, not sent as null');
  assert.equal(task.values(TOKEN_ID).private_key_b64, 'pem-from-secret');
});

test('the target export records required properties it has empty (meta only, never in the data)', async () => {
  const { client } = fakeTarget([{ definitionId: TOKEN_ID, values: { client_id: 'cid' } }]);
  const [a] = await handlers.list(client, { collected: [] });
  assert.deepEqual(a.meta, { definitionId: TOKEN_ID, unsetRequired: ['account_id', 'certificate_id', 'private_key_b64'] });
  assert.ok(!('unsetRequired' in a.data));
  assert.deepEqual(unsetRequired({ properties: [{ name: 'p', type: 'Encrypted', required: true }, { name: 'q', type: 'Plaintext', required: true, value: '  ' }] }), ['q'],
    'encrypted values are never read back, so their emptiness is not known');
});

test('re-apply after the secret is entered: required settings empty in the target are a needed update, and the PUT now saves them', async () => {
  const { dir, data } = tokenExport();
  const { client, calls, task } = fakeTarget([{ definitionId: TOKEN_ID }]);
  const [existing] = await handlers.list(fakeClient({}, { mode: 'read', fallback: task.handle }), { collected: [] });
  assert.equal(existing.data.packageSha256, data.packageSha256, 'same package: nothing to re-upload');
  const overrides = { artifacts: { [TOKEN_KEY]: {
    'properties.client_id': { value: 'cid' }, 'properties.account_id': { value: 'acct' }, 'properties.certificate_id': { value: 'cert' },
  } } };
  const item = tokenItem(data, existing, overrides);
  assert.deepEqual(unsetSettingsDiff(item.desired, existing).map((d) => [d.path, d.to]), [['properties[private_key_b64].value', REQUIRED_UNSET]]);
  // Still missing without the secret: nothing is sent.
  const { ctx } = ctxFor(dir, {});
  assert.deepEqual(missingRequired(item.desired, existing, () => false), ['private_key_b64']);
  const first = await handlers.apply(client, item, { ...ctx, targetLabel: 'Test' });
  assert.match(first.attention, /^Settings not saved; set private_key_b64 in Test's Task console/);
  assert.deepEqual(calls, []);
  // With it: one PUT with the overrides and the secret.
  const withSecret = ctxFor(dir, { PRIVATE_KEY_B64: 'pem' });
  assert.deepEqual(await handlers.apply(client, item, withSecret.ctx), { settings: { saved: true, sent: ['private_key_b64'], empty: [] } });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), [`PUT /handlers/${TOKEN_ID}`]);
  assert.deepEqual(calls[0].body, { properties: { account_id: 'acct', certificate_id: 'cert', client_id: 'cid', private_key_b64: 'pem' } });
  assert.equal(task.values(TOKEN_ID).private_key_b64, 'pem');
  const [after] = await handlers.list(fakeClient({}, { mode: 'read', fallback: task.handle }), { collected: [] });
  assert.equal(after.meta.unsetRequired, undefined);
  assert.deepEqual(unsetSettingsDiff(tokenItem(data, after).desired, after), []);
});

test('a PUT refused only for empty required properties (e.g. an encrypted one) asks for them; any other refusal stops the run', async () => {
  const { dir, data } = tokenExport();
  const overrides = { artifacts: { [TOKEN_KEY]: { 'properties.audience': { value: 'https://other.example.com' } } } };
  const existing = { key: TOKEN_KEY, data: normalizeHandler(tokenRaw({ client_id: 'c', private_key_b64: 'k', account_id: 'a', certificate_id: 'x' }), TOKEN_ZIP), meta: { definitionId: TOKEN_ID } };
  const empty = new HttpError({ method: 'PUT', url: '/x', status: 400, body: JSON.stringify({ message: 'Unable to save task handler', errors: ['vault_password may not be empty'] }) });
  const refusing = (e) => fakeClient({ [`PUT task/handlers/${TOKEN_ID}`]: () => { throw e; } });
  const { ctx } = ctxFor(dir, {});
  const r = await handlers.apply(refusing(empty), tokenItem(data, existing, overrides), { ...ctx, targetLabel: 'Test' });
  assert.match(r.attention, /^Settings not saved; set vault_password in Test's Task console/);
  const other = new HttpError({ method: 'PUT', url: '/x', status: 400, body: JSON.stringify({ message: 'Unable to save task handler', errors: ['audience is not a URL'] }) });
  await assert.rejects(handlers.apply(refusing(other), tokenItem(data, existing, overrides), ctx), (e) => e === other);
});

// ---- required Encrypted properties (never read back) ----

import { NEW_SECRET } from './handlers.mjs';

const VAULT_ID = 'vault_call_v1';
const VAULT_KEY = `handlers/${VAULT_ID}/handler`;
const VAULT_ZIP = Buffer.from('PK\x03\x04 vault');
const vaultProps = [
  { name: 'host', type: 'Plaintext', required: true, description: '' },
  { name: 'vault_password', type: 'Encrypted', required: true, description: '' },
];
function vaultFixture(installed = []) {
  const task = fakeTaskHandlers({ [VAULT_ID]: { handler: { ...raw(VAULT_ID), categories: [], properties: vaultProps }, zip: VAULT_ZIP } }, installed);
  const calls = [];
  const client = fakeClient({}, { calls, fallback: task.handle });
  const reader = () => fakeClient({}, { mode: 'read', fallback: task.handle });
  const dir = join(mkdtempSync(join(tmpdir(), 'ksync-handlers-')), 'export');
  const data = normalizeHandler({ ...raw(VAULT_ID), categories: [], properties: vaultProps.map((p) => ({ ...p, value: null })) }, VAULT_ZIP);
  writeTree(dir, [{ key: VAULT_KEY, data, files: { 'package.zip': VAULT_ZIP } }]);
  const item = (existing, overrides = {}) => ({
    key: VAULT_KEY, type: 'handlers', action: existing ? 'update' : 'create', existing,
    desired: prepareDesired({ key: VAULT_KEY, scope: 'handler', exported: data, existing: existing?.data, overrides, vars: {} }),
  });
  const ctx = (secrets = {}, hints) => ({ ...ctxFor(dir, secrets).ctx, targetLabel: 'Test', ...(hints ? { hints: { handlers: hints } } : {}) });
  return { task, calls, client, reader, item, ctx };
}
const HOST = { artifacts: { [VAULT_KEY]: { 'properties.host': { value: 'vault.example.com' } } } };

test('Encrypted, create: a supplied secret is held (not dropped) when the PUT is skipped for a blank setting, and the message says so', async () => {
  const f = vaultFixture();
  const r = await handlers.apply(f.client, f.item(null), { ...f.ctx({ VAULT_PASSWORD: 'pw-1' }), heldHint: 'kept for the next apply' });
  assert.deepEqual(f.calls.map((x) => `${x.method} ${x.path}`), ['POST /handlers']);
  assert.equal(r.attention, "Installed; set host in Test's Task console (or supply them and apply again: secrets as KINETIC_<ENV>_HANDLER_<DEFINITION_ID>__<PROPERTY> variables, other settings as overrides). vault_password was entered but not saved yet (kept for the next apply).");
  assert.deepEqual(r.settings, { saved: false, sent: [], empty: ['host'] });
  // Without the secret too, both are named.
  const g = vaultFixture();
  const r2 = await handlers.apply(g.client, g.item(null), g.ctx());
  assert.match(r2.attention, /^Installed; set host, vault_password in Test's Task console/);
});

test('Encrypted, update and re-apply: a secret entered since the last write is sent with the setting; without that hint the platform names it and it is remembered as empty', async () => {
  const f = vaultFixture([{ definitionId: VAULT_ID }]);
  const [existing] = await handlers.list(f.reader(), { collected: [] });
  assert.deepEqual(existing.meta.unsetRequired, ['host'], 'the encrypted one is not readable');

  // Old behaviour: only host is sent, and the platform refuses for vault_password.
  const refused = await handlers.apply(f.client, f.item(existing, HOST), f.ctx({ VAULT_PASSWORD: 'pw-1' }));
  assert.deepEqual(f.calls.map((x) => x.body), [{ properties: { host: 'vault.example.com' } }]);
  assert.match(refused.attention, /^Settings not saved; set vault_password in Test's Task console/);
  assert.deepEqual(refused.settings, { saved: false, sent: [], empty: ['vault_password'] });

  // Remembered as empty (or entered since the last write): sent with the setting, and saved.
  for (const hints of [{ empty: () => ['vault_password'] }, { pending: (id, p) => id === VAULT_ID && p === 'vault_password' }]) {
    const g = vaultFixture([{ definitionId: VAULT_ID }]);
    const ok = await handlers.apply(g.client, g.item(existing, HOST), g.ctx({ VAULT_PASSWORD: 'pw-2' }, hints));
    assert.deepEqual(g.calls.map((x) => x.body), [{ properties: { host: 'vault.example.com', vault_password: 'pw-2' } }]);
    assert.deepEqual(ok, { settings: { saved: true, sent: ['vault_password'], empty: [] } });
    assert.equal(g.task.values(VAULT_ID).vault_password, 'pw-2');
  }
});

test('Encrypted, nothing else changed: a pending secret is a needed update and is sent alone; once accepted it is not resent', async () => {
  const f = vaultFixture([{ definitionId: VAULT_ID, values: { host: 'h', vault_password: 'old' } }]);
  const [existing] = await handlers.list(f.reader(), { collected: [] });
  assert.equal(existing.meta.unsetRequired, undefined);
  const pending = { pending: (id, p) => p === 'vault_password' };
  const it = f.item(existing);
  assert.deepEqual(unsetSettingsDiff(it.desired, existing, pending), [{ path: 'properties[vault_password].value', from: null, to: NEW_SECRET }]);
  assert.deepEqual(unsetSettingsDiff(it.desired, existing), [], 'not pending: no write needed, the stored secret is not resent');
  const r = await handlers.apply(f.client, it, f.ctx({ VAULT_PASSWORD: 'new' }, pending));
  assert.deepEqual(f.calls.map((x) => x.body), [{ properties: { vault_password: 'new' } }]);
  assert.deepEqual(r.settings, { saved: true, sent: ['vault_password'], empty: [] });
  assert.equal(f.task.values(VAULT_ID).vault_password, 'new');
});

test('a required property a re-installed package adds (absent from the target) counts as empty', () => {
  const f = vaultFixture();
  const existing = { key: VAULT_KEY, data: { ...normalizeHandler({ ...raw(VAULT_ID), categories: [], properties: [{ name: 'host', type: 'Plaintext', required: true, value: 'h' }] }, VAULT_ZIP) }, meta: { definitionId: VAULT_ID } };
  assert.deepEqual(missingRequired(f.item(existing).desired, existing, () => false), ['vault_password']);
  assert.deepEqual(missingRequired(f.item(existing).desired, existing, () => true), []);
});

test('a name remembered empty never skips the write: with nothing else to send the PUT probes the target, which settles it', async () => {
  const remembered = { empty: () => ['vault_password'] };
  // Set in the console since: the probe is accepted and the memory can be cleared.
  const f = vaultFixture([{ definitionId: VAULT_ID, values: { host: 'h', vault_password: 'set-in-console' } }]);
  const [existing] = await handlers.list(f.reader(), { collected: [] });
  assert.deepEqual(missingRequired(f.item(existing).desired, existing, () => false, remembered), ['vault_password'], 'still asked for in the plan');
  const ok = await handlers.apply(f.client, f.item(existing), f.ctx({}, remembered));
  assert.deepEqual(f.calls.map((x) => [`${x.method} ${x.path}`, x.body]), [[`PUT /handlers/${VAULT_ID}`, { properties: {} }]]);
  assert.deepEqual(ok, { settings: { saved: true, sent: [], empty: [] } });
  // Still empty: refused, so it is named and remembered again.
  const g = vaultFixture([{ definitionId: VAULT_ID, values: { host: 'h' } }]);
  const [still] = await handlers.list(g.reader(), { collected: [] });
  const no = await handlers.apply(g.client, g.item(still), g.ctx({}, remembered));
  assert.equal(g.calls.length, 1);
  assert.match(no.attention, /^Settings not saved; set vault_password in Test's Task console/);
  assert.deepEqual(no.settings, { saved: false, sent: [], empty: ['vault_password'] });
});
