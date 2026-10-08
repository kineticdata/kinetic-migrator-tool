// Secret names, and the secret auth field of each Integrator auth type. The
// map is checked against the documented connection schema: basic {username,
// password}; raw_bearer_token {header, prefix, token}; client_credentials
// {tokenUrl, clientId, clientSecret, clientAuth, scope}. http_bearer_token
// fetches its token through an operation and holds no secret field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_SECRET_FIELDS, isSecretName } from './secrets.mjs';
import { connectionSecrets, secretFieldKey } from './env.mjs';
import { normalizeConnection } from './artifacts/connections.mjs';

const DOCUMENTED = {
  basic: { secret: ['password'], plain: ['username'] },
  raw_bearer_token: { secret: ['token'], plain: ['header', 'prefix'] },
  client_credentials: { secret: ['clientSecret'], plain: ['tokenUrl', 'clientId', 'clientAuth', 'scope'] },
};

test('the auth-type secret fields are exactly the documented ones', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(AUTH_SECRET_FIELDS).map(([k, v]) => [k, [...v]])),
    Object.fromEntries(Object.entries(DOCUMENTED).map(([k, v]) => [k, v.secret])),
  );
});

test('each secret field is stripped at export, its plain fields kept, and its env var maps back to the field', () => {
  for (const [authType, { secret, plain }] of Object.entries(DOCUMENTED)) {
    for (const f of secret) assert.equal(isSecretName(f), true, `${authType}.${f} is a secret`);
    for (const f of plain) assert.equal(isSecretName(f), false, `${authType}.${f} is not a secret`);
    const auth = Object.fromEntries([...secret, ...plain].map((f) => [f, `v-${f}`]));
    const out = normalizeConnection({ id: 'c', name: 'C', type: 'http', config: { baseUrl: 'https://x', auth: { authType, ...auth } } });
    assert.deepEqual(Object.keys(out.config.auth).sort(), ['authType', ...plain].sort(), authType);
    for (const f of secret) {
      const env = { name: 'test', vars: { [`KINETIC_TEST_SECRET_C__${secretFieldKey(f)}`]: 'x' } };
      assert.deepEqual(connectionSecrets(env, 'C'), { [f]: 'x' }, `${authType}.${f} round-trips through its env var`);
    }
  }
});
