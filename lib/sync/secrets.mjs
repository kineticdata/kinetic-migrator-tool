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
