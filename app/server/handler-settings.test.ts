// Handler settings the Task API requires: a new handler whose required
// properties would be empty is installed without the PUT that is bound to
// fail (done with attention, the run carries on and is partial), the plan asks
// for each one (a write-only secret or an environment value), and a re-plan
// after they are entered saves them. The secret never leaves the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- untyped engine module
import { fakeTaskHandlers } from '../../lib/sync/fake-client.mjs';
import type { PlanResult, RunRecord } from '../shared/sync-api.ts';
import { toApiError } from './errors.ts';
import { log, readTreeAt } from './repo.ts';
import { FALLBACK, PLANTED_RUN, assertNoSecret, devRoutes, harness, testRoutes, type Harness } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const ID = 'erp_oauth2_token_v2';
const KEY = `handlers/${ID}/handler`;
const ZIP = Buffer.from('PK\x03\x04 token handler');
const SECRET_ID = 'handler/ERP_OAUTH2_TOKEN_V2__PRIVATE_KEY_B64';
const REQUIRED = ['client_id', 'private_key_b64', 'account_id', 'certificate_id'];
const PROPS = [
  ...REQUIRED.map((name) => ({ name, type: 'Plaintext', required: true, description: '' })),
  { name: 'scope', type: 'Plaintext', required: false, description: '' },
];

// The source has the handler with its required settings empty (as seen live).
const dev = () => ({
  ...devRoutes(),
  'GET task/handlers': { handlers: [{ definitionId: ID, name: 'ERP OAuth2 Token', properties: PROPS.map((p) => ({ ...p, value: null })) }] },
  [`GET task/handlers/${ID}/zip`]: ZIP,
});

function withTarget(h: Harness) {
  const task = fakeTaskHandlers({ [ID]: { handler: { definitionId: ID, name: 'ERP OAuth2 Token', properties: PROPS }, zip: ZIP } });
  const { 'GET task/handlers': _, ...rest } = testRoutes();
  h.spaces.dev = dev;
  h.spaces.test = () => ({ ...rest, [FALLBACK]: task.handle });
  return task;
}

async function plan(h: Harness, body: unknown): Promise<PlanResult> {
  const job = await h.job('POST', `${P}/plans`, body);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  return job.result as PlanResult;
}

const runs = (h: Harness) => readdirSync(path.join(h.dir, 'runs')).sort().map((f) => JSON.parse(readFileSync(path.join(h.dir, 'runs', f), 'utf8')) as RunRecord);

test('live scenario: a new handler with empty required settings is installed, asked for each setting, and the run carries on as partial', async (t) => {
  const h = await harness(t);
  const task = withTarget(h);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: [KEY] });
  assert.deepEqual(p.secretsNeeded.map((s) => [s.id, s.scope, s.has]), [[SECRET_ID, 'handler', false]]);
  const settings = p.needsAttention.filter((n) => n.kind === 'handler-settings');
  assert.deepEqual(settings.map((n) => [n.id, n.valueId]), [
    [`handler-settings:${KEY}#account_id`, `${KEY}#properties.account_id.value`],
    [`handler-settings:${KEY}#certificate_id`, `${KEY}#properties.certificate_id.value`],
    [`handler-settings:${KEY}#client_id`, `${KEY}#properties.client_id.value`],
    [`handler-settings:${KEY}#private_key_b64`, SECRET_ID],
  ]);
  assert.equal(settings[3].message, 'ERP OAuth2 Token needs private_key_b64 before its settings can be saved in Test.');
  // Plaintext ones are environment values; the secret-named one never is.
  assert.deepEqual(p.environmentValues.map((v) => v.label).sort(), ['account_id', 'certificate_id', 'client_id', 'scope']);

  const apply = (body: Record<string, unknown>) => h.call('POST', `${P}/plans/${p.planId}/apply`, { confirm: 'test', ...body });
  const refused = await apply({ acknowledgements: [`handler:${KEY}`] });
  assert.equal(refused.json.error.code, 'acknowledgement_required');
  assert.deepEqual(refused.json.error.detail.missing, settings.map((n) => n.id));

  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { confirm: 'test', acknowledgements: p.needsAttention.map((n) => n.id) });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.result.status, 'partial');
  assert.match(job.result.error, /^1 handler is installed without required settings/);
  assert.deepEqual(h.writes('test'), ['POST /handlers'], 'the PUT bound to fail is not sent');
  assert.ok(task.handlers.has(ID));
  const [run] = runs(h);
  assert.equal(run.status, 'partial');
  assert.deepEqual(run.items.find((i) => i.key === KEY), {
    key: KEY, status: 'done',
    message: "Installed; set account_id, certificate_id, client_id, private_key_b64 in Test's Task console (or enter them under Environment values and apply again).",
    attention: true,
  });
  assert.ok((await log(h.dir, { limit: 3 })).some((e) => /^Partly applied '1 item from Dev' to Test\n/.test(e.message)));

  // Re-plan: the handler still needs its settings written (not "unchanged"),
  // and asks for the secret again.
  const again = await plan(h, { to: 'test', from: 'dev', selected: [KEY] });
  assert.deepEqual(again.items.map((i) => [i.key, i.action]), [[KEY, 'update']]);
  assert.deepEqual(again.items[0].diff.map((d) => d.path), REQUIRED.map((n) => `properties[${n}].value`).sort());
  assert.deepEqual(again.secretsNeeded.map((s) => [s.id, s.has]), [[SECRET_ID, false]]);
  assert.equal(again.needsAttention.filter((n) => n.kind === 'handler-settings').length, 4);

  // Entered: values and the secret take care of the settings entries (only the
  // handler upgrade is ticked), one PUT saves them, and the run is applied.
  const values = { [KEY]: { 'properties.client_id.value': 'cid', 'properties.account_id.value': 'acct', 'properties.certificate_id.value': 'cert' } };
  const done = await h.job('POST', `${P}/plans/${again.planId}/apply`, {
    confirm: 'test', acknowledgements: [`handler:${KEY}`], values, secrets: { [SECRET_ID]: PLANTED_RUN },
  });
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.result.status, 'applied', done.result.error);
  assert.deepEqual(h.writes('test'), ['POST /handlers', `PUT /handlers/${ID}`]);
  const put = h.calls.find((c) => c.method === 'PUT' && c.env === 'test')!;
  assert.deepEqual((put.body as any).properties, { account_id: 'acct', certificate_id: 'cert', client_id: 'cid', private_key_b64: PLANTED_RUN });
  assert.equal(task.values(ID).private_key_b64, PLANTED_RUN, 'the secret reached the target');
  const clean = await plan(h, { to: 'test', from: 'dev', selected: [KEY] });
  assert.deepEqual(clean.items.map((i) => i.action), ['unchanged']);
  assert.deepEqual(clean.secretsNeeded, []);

  // The secret is in no API response, job event, run record or commit.
  assertNoSecret(h, [job.events, done.events]);
  for (const r of runs(h)) assert.ok(!JSON.stringify(r).includes(PLANTED_RUN));
  const head = (await log(h.dir, { limit: 1 }))[0];
  const tree = await readTreeAt(h.dir, head.oid, '');
  const repo = JSON.stringify([...tree]) + (await log(h.dir, { limit: 1000 })).map((e) => e.message).join('\n');
  assert.ok(!repo.includes(PLANTED_RUN), 'no secret in the repository');
});

test('a write the platform refuses for another reason stops the run with the platform message; a supplied secret is never echoed', async (t) => {
  const h = await harness(t);
  withTarget(h);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: [KEY] });
  const original = h.spaces.test;
  const body = JSON.stringify({ message: 'Unable to save task handler', errors: ['account_id is not valid', `echo ${PLANTED_RUN}`] });
  h.spaces.test = () => ({
    ...original(),
    [`PUT task/handlers/${ID}`]: () => { throw Object.assign(new Error(`PUT /handlers/${ID} failed with 400: ${body}`), { name: 'HttpError', status: 400, method: 'PUT', body }); },
  });
  const values = { [KEY]: { 'properties.client_id.value': 'cid', 'properties.account_id.value': 'acct', 'properties.certificate_id.value': 'cert' } };
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { confirm: 'test', acknowledgements: [`handler:${KEY}`], values, secrets: { [SECRET_ID]: PLANTED_RUN } });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.result.status, 'failed');
  const expected = 'The Kinetic Platform rejected the change (400): Unable to save task handler — account_id is not valid; echo ••••';
  assert.equal(job.result.error, `${KEY}: ${expected}`);
  const [run] = runs(h);
  assert.deepEqual(run.items.find((i) => i.key === KEY), { key: KEY, status: 'failed', message: expected });
  assert.ok(!JSON.stringify(run).includes(PLANTED_RUN));
  assertNoSecret(h, [job.events]);
});

test('API errors carry the platform message and error list (names only, capped); other bodies stay hidden', () => {
  const http = (status: number, body: string, method = 'PUT') => Object.assign(new Error(`${method} /x failed with ${status}: ${body}`), { name: 'HttpError', status, method, body });
  const refused = toApiError(http(400, JSON.stringify({ message: 'Unable to save task handler', errors: ['a may not be empty', 'b may not be empty'] })));
  assert.deepEqual([refused.status, refused.code, refused.message], [502, 'upstream_error', 'The Kinetic Platform rejected the change (400): Unable to save task handler — a may not be empty; b may not be empty']);
  assert.equal(toApiError(http(500, '<html>stack trace with secrets</html>')).message, 'The Kinetic Platform returned an error (500).');
  assert.equal(toApiError(http(400, JSON.stringify({ message: 'x', password: 'hunter2' }))).message, 'The Kinetic Platform rejected the change (400): x');
  assert.ok(toApiError(http(400, JSON.stringify({ message: 'm'.repeat(9000), errors: Array(50).fill('e'.repeat(300)) }))).message.length < 700);
});

// ---- a required Encrypted property (never read back) ----

const VID = 'vault_call_v1';
const VKEY = `handlers/${VID}/handler`;
const VZIP = Buffer.from('PK\x03\x04 vault');
const VSECRET = 'handler/VAULT_CALL_V1__VAULT_PASSWORD';
const VPROPS = [
  { name: 'host', type: 'Plaintext', required: true, description: '' },
  { name: 'vault_password', type: 'Encrypted', required: true, description: '' },
];

function withVault(h: Harness, installed: unknown[] = []) {
  const task = fakeTaskHandlers({ [VID]: { handler: { definitionId: VID, name: 'Vault Call', properties: VPROPS }, zip: VZIP } }, installed);
  const { 'GET task/handlers': _, ...rest } = testRoutes();
  h.spaces.dev = () => ({
    ...devRoutes(),
    'GET task/handlers': { handlers: [{ definitionId: VID, name: 'Vault Call', properties: VPROPS.map((p) => (p.type === 'Encrypted' ? p : { ...p, value: null })) }] },
    [`GET task/handlers/${VID}/zip`]: VZIP,
  });
  h.spaces.test = () => ({ ...rest, [FALLBACK]: task.handle });
  return task;
}

const memoryText = (h: Harness) => { try { return readFileSync(path.join(h.dir, 'plans', 'handler-settings-test.json'), 'utf8'); } catch { return ''; } };

test('Encrypted, create then re-apply: a kept secret entered while a setting was missing is sent with the next settings write, once', async (t) => {
  const h = await harness(t);
  const task = withVault(h);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: [VKEY] });
  assert.deepEqual(p.secretsNeeded.map((s) => [s.id, s.has, s.hint]), [[VSECRET, false, undefined]]);
  assert.deepEqual(p.needsAttention.filter((n) => n.kind === 'handler-settings').map((n) => n.valueId), [`${VKEY}#properties.host.value`, VSECRET]);

  // The secret is entered and kept; host is not: the PUT is skipped, the secret is held.
  const first = await h.job('POST', `${P}/plans/${p.planId}/apply`, {
    confirm: 'test', acknowledgements: p.needsAttention.map((n) => n.id), secrets: { [VSECRET]: PLANTED_RUN }, remember: true,
  });
  assert.equal(first.result.status, 'partial', first.result.error);
  assert.deepEqual(h.writes('test'), ['POST /handlers']);
  assert.equal(runs(h)[0].items.find((i) => i.key === VKEY)!.message,
    "Installed; set host in Test's Task console (or enter them under Environment values and apply again). vault_password was entered but not saved yet (kept for the next apply).");
  assert.deepEqual(JSON.parse(memoryText(h)), { pending: ['VAULT_CALL_V1__VAULT_PASSWORD'], empty: { [VID]: ['host'] } });

  // Re-plan: an update; the secret is offered again (stored, not readable in Test); only host is asked for.
  const again = await plan(h, { to: 'test', from: 'dev', selected: [VKEY] });
  assert.deepEqual(again.items.map((i) => i.action), ['update']);
  assert.deepEqual(again.secretsNeeded.map((s) => [s.id, s.has, s.hint]), [[VSECRET, true, "Not readable in Test — leave blank to keep Test's value."]]);
  assert.deepEqual(again.needsAttention.filter((n) => n.kind === 'handler-settings').map((n) => n.id), [`handler-settings:${VKEY}#host`]);
  const done = await h.job('POST', `${P}/plans/${again.planId}/apply`, {
    confirm: 'test', acknowledgements: [`handler:${VKEY}`], values: { [VKEY]: { 'properties.host.value': 'vault.example.com' } },
  });
  assert.equal(done.result.status, 'applied', done.result.error);
  const put = h.calls.find((c) => c.method === 'PUT' && c.env === 'test')!;
  assert.deepEqual((put.body as any).properties, { host: 'vault.example.com', vault_password: PLANTED_RUN });
  assert.equal(task.values(VID).vault_password, PLANTED_RUN);
  assert.deepEqual(JSON.parse(memoryText(h)), { pending: [], empty: {} }, 'accepted: nothing pending');

  // Once accepted it is not resent: the next plan has nothing to do.
  const clean = await plan(h, { to: 'test', from: 'dev', selected: [VKEY] });
  assert.deepEqual(clean.items.map((i) => i.action), ['unchanged']);
  assertNoSecret(h, [first.events, done.events, memoryText(h)]);
  for (const r of runs(h)) assert.ok(!JSON.stringify(r).includes(PLANTED_RUN));
});

test('Encrypted, update then Resume: the platform names the empty encrypted property, the plan offers it, and a value entered on Resume is sent', async (t) => {
  const h = await harness(t);
  const task = withVault(h, [{ definitionId: VID, values: { host: 'old.example.com' } }]);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  mkdirSync(path.join(h.dir, 'overrides'), { recursive: true });
  writeFileSync(path.join(h.dir, 'overrides', 'test.json'), JSON.stringify({ artifacts: { [VKEY]: { 'properties.host': { value: 'new.example.com' } } } }));
  const p = await plan(h, { to: 'test', from: 'dev', selected: [VKEY] });
  assert.deepEqual(p.items.map((i) => i.action), ['update']);
  // Required and encrypted: always offered for a handler in the target, never readable.
  assert.deepEqual(p.secretsNeeded.map((s) => [s.id, s.has, s.hint]), [[VSECRET, false, "Not readable in Test — leave blank to keep Test's value."]]);
  assert.deepEqual(p.needsAttention.filter((n) => n.kind === 'handler-settings'), [], 'not known to be empty yet');

  const body = { confirm: 'test', acknowledgements: [`handler:${VKEY}`] };
  const first = await h.job('POST', `${P}/plans/${p.planId}/apply`, body);
  assert.equal(first.result.status, 'partial', first.result.error);
  const item = runs(h)[0].items.find((i) => i.key === VKEY)!;
  assert.deepEqual([item.status, item.attention, item.message], ['done', true,
    "Settings not saved; set vault_password in Test's Task console (or enter them here and apply again)."]);
  assert.deepEqual(JSON.parse(memoryText(h)).empty, { [VID]: ['vault_password'] });

  // A re-plan knows it is empty now.
  const replan = await plan(h, { to: 'test', from: 'dev', selected: [VKEY] });
  assert.equal(replan.secretsNeeded[0].hint, "Empty in Test; needed before the handler's settings can be saved.");
  assert.deepEqual(replan.needsAttention.filter((n) => n.kind === 'handler-settings').map((n) => n.valueId), [VSECRET]);

  // Resume of the first plan with the value (for this run only): sent, saved, forgotten.
  const resumed = await h.job('POST', `${P}/plans/${p.planId}/apply`, { ...body, secrets: { [VSECRET]: PLANTED_RUN } });
  assert.equal(resumed.result.status, 'applied', resumed.result.error);
  const puts = h.calls.filter((c) => c.method === 'PUT' && c.env === 'test');
  assert.deepEqual((puts.at(-1)!.body as any).properties, { host: 'new.example.com', vault_password: PLANTED_RUN });
  assert.equal(task.values(VID).vault_password, PLANTED_RUN);
  assert.deepEqual(JSON.parse(memoryText(h)), { pending: [], empty: {} });
  const sid = JSON.parse(readFileSync(path.join(h.dir, 'kinetic-migrate.json'), 'utf8')).secretsId;
  assert.equal(await h.store.has(`${sid}/test/handler/VAULT_CALL_V1__VAULT_PASSWORD`), false, 'one run only: not kept');
  assertNoSecret(h, [first.events, resumed.events, memoryText(h)]);
  for (const r of runs(h)) assert.ok(!JSON.stringify(r).includes(PLANTED_RUN));
});
