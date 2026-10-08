import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  envKey, parseDotEnv, secretFieldKey, connectionSecrets, handlerSecrets, loadEnvironment, loadOverrides, loadConfig, listOverrideEnvs,
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

test('connectionSecrets collects KINETIC_<ENV>_SECRET_<CONN>__<FIELD> into camelCase fields', () => {
  const env = { name: 'prod', vars: {
    KINETIC_PROD_SECRET_MY_API__PASSWORD: 'p',
    KINETIC_PROD_SECRET_MY_API__CLIENT_SECRET: 's',
    KINETIC_PROD_SECRET_OTHER__PASSWORD: 'no',
    KINETIC_PROD_SECRET_API_V2__PASSWORD: 'v2pass',
  } };
  assert.deepEqual(connectionSecrets(env, 'My API'), { password: 'p', clientSecret: 's' });
  assert.deepEqual(connectionSecrets(env, 'API'), {});
  assert.deepEqual(connectionSecrets(env, 'Missing'), {});
});

test('handlerSecrets collects KINETIC_<ENV>_HANDLER_<ID>__<PROPERTY> keyed by the property env key', () => {
  const env = { name: 'prod', vars: {
    KINETIC_PROD_HANDLER_MAIL_SEND_V1__SMTP_PASSWORD: 'p',
    KINETIC_PROD_HANDLER_MAIL_SEND_V1__API_KEY: '',
    KINETIC_PROD_HANDLER_MAIL_SEND_V1_EXTRA__SMTP_PASSWORD: 'no',
    KINETIC_PROD_SECRET_MAIL_SEND_V1__SMTP_PASSWORD: 'no',
  } };
  assert.deepEqual(handlerSecrets(env, 'mail_send_v1'), { SMTP_PASSWORD: 'p' });
  assert.deepEqual(handlerSecrets(env, 'mail_send'), {});
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

test('readJson wraps malformed JSON with a helpful error', () => {
  const dir = project({ 'environments/prod.json': 'not valid json' });
  assert.throws(() => loadEnvironment(dir, 'prod', { KINETIC_PROD_USERNAME: 'u', KINETIC_PROD_PASSWORD: 'p' }), /Invalid JSON in.*environments\/prod\.json.*Unexpected token/);
});

test('loadEnvironment rejects unknown keys in environment file', () => {
  const dir = project({ 'environments/prod.json': { url: 'https://your-space.kinops.io', readonly: true } });
  assert.throws(() => loadEnvironment(dir, 'prod', { KINETIC_PROD_USERNAME: 'u', KINETIC_PROD_PASSWORD: 'p' }), /unknown key "readonly"/);
});

test('loadEnvironment rejects non-boolean readOnly', () => {
  const dir = project({ 'environments/prod.json': { url: 'https://your-space.kinops.io', readOnly: 'true' } });
  assert.throws(() => loadEnvironment(dir, 'prod', { KINETIC_PROD_USERNAME: 'u', KINETIC_PROD_PASSWORD: 'p' }), /"readOnly" must be true or false/);
});

test('loadEnvironment rejects invalid environment names', () => {
  const dir = project({ 'environments/prod.json': { url: 'https://your-space.kinops.io' } });
  assert.throws(() => loadEnvironment(dir, '../x', {}), /Invalid environment name/);
});

test('loadOverrides rejects invalid environment names', () => {
  const dir = project({});
  assert.throws(() => loadOverrides(dir, '../x'), /Invalid environment name/);
});

test('env.vars filters to only KINETIC_ prefixed variables', () => {
  const dir = project({
    'environments/prod.json': { url: 'https://your-space.kinops.io/' },
    '.env.prod': 'KINETIC_PROD_USERNAME=user\nKINETIC_PROD_PASSWORD=pass\nOTHER_VAR=value\n',
  });
  const env = loadEnvironment(dir, 'prod', { MY_VAR: 'x' });
  assert.equal(env.vars.KINETIC_PROD_USERNAME, 'user');
  assert.equal(env.vars.KINETIC_PROD_PASSWORD, 'pass');
  assert.equal(env.vars.MY_VAR, undefined);
  assert.equal(env.vars.OTHER_VAR, undefined);
});
