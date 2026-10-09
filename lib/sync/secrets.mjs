// One definition of "looks like a secret", shared by connections (auth
// fields), handlers (properties) and HTTP error redaction. Names are compared
// squashed (lower-cased, every non-alphanumeric removed), so "Private Key",
// private-key, private_key and privateKey are the same name.
export const squash = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

// Written for squashed text.
export const SECRET_NAME = /(password|passwd|passphrase|passcode|secret|token|apikey|privatekey|credential|authorization)/;

// Identity and URL fields that match SECRET_NAME but are not secrets.
const NOT_SECRET = new Set(['authType', 'tokenUrl', 'tokenType', 'accessTokenUrl', 'refreshTokenUrl', 'username', 'clientId'].map(squash));

export const isSecretName = (name) => {
  const s = squash(name);
  return !NOT_SECRET.has(s) && SECRET_NAME.test(s);
};

// A handler property is secret when its type says encrypted or its name looks secret.
export const isSecretProperty = (p) => /encrypt/i.test(p?.type ?? '') || isSecretName(p?.name ?? '');

// The secret auth field of each Integrator connection auth type (the export
// strips it, so a new connection asks for it). Checked against the documented
// connection schema: basic {username, password}; raw_bearer_token {header,
// prefix, token}; client_credentials {tokenUrl, clientId, clientSecret,
// clientAuth, scope}; http_bearer_token fetches its token through an operation
// and holds none. For any other type, secret-named fields still present are
// asked for, and the import's "missing field" answer is the last resort.
export const AUTH_SECRET_FIELDS = Object.freeze({
  basic: Object.freeze(['password']),
  raw_bearer_token: Object.freeze(['token']),
  client_credentials: Object.freeze(['clientSecret']),
});

// Config keys that hold a credential outside config.auth, by connection
// config type. Documented: postgres and mssql connections keep their database
// password at config.password ({host, port, username, password, database,
// poolSize, caCert}); other SQL types are taken to do the same. Any other
// secret-named key anywhere in a connection's config is stripped as well.
export const CONFIG_SECRET_FIELDS = Object.freeze({
  postgres: Object.freeze(['password']),
  mssql: Object.freeze(['password']),
  mysql: Object.freeze(['password']),
  oracle: Object.freeze(['password']),
});

// The secret field name of a config path (["ssl", "keyPassword"] →
// "sslKeyPassword"): camelCase, so it round-trips through its env var
// (KINETIC_<ENV>_SECRET_<CONNECTION>__SSL_KEY_PASSWORD).
export const configSecretField = (path) => [].concat(path).join('_')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  .replace(/[^a-z0-9]+([a-z0-9])/g, (m, c) => c.toUpperCase())
  .replace(/[^a-zA-Z0-9]/g, '');
