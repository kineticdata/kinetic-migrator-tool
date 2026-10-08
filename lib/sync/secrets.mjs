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
