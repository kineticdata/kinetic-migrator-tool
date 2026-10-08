// lib/sync/overrides.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePath, setPath, replaceStrings, resolveTemplates, applyOverrides, prepareDesired,
} from './overrides.mjs';

test('parsePath splits on dots and honours \\. escapes', () => {
  assert.deepEqual(parsePath('config.baseUrl'), ['config', 'baseUrl']);
  assert.deepEqual(parsePath('attributes.api\\.example\\.com'), ['attributes', 'api.example.com']);
  assert.throws(() => parsePath('a..b'), /Invalid override path/);
});

test('setPath sets nested object values and creates missing objects', () => {
  const src = { config: { baseUrl: 'https://dev' } };
  assert.deepEqual(setPath(src, 'config.baseUrl', 'https://prod'), { config: { baseUrl: 'https://prod' } });
  assert.deepEqual(setPath({}, 'platformComponents.app.location', 'https://ui'), {
    platformComponents: { app: { location: 'https://ui' } },
  });
  assert.equal(src.config.baseUrl, 'https://dev', 'input is not mutated');
});

test('setPath addresses array elements by name and sets attribute values', () => {
  const space = { attributes: [{ name: 'Environment', values: ['dev'] }] };
  assert.deepEqual(setPath(space, 'attributes.Environment', ['prod']), {
    attributes: [{ name: 'Environment', values: ['prod'] }],
  });
  assert.deepEqual(setPath({ attributes: [] }, 'attributes.Region', ['eu']), {
    attributes: [{ name: 'Region', values: ['eu'] }],
  });
  assert.deepEqual(setPath({}, 'attributes.Region', ['eu']), { attributes: [{ name: 'Region', values: ['eu'] }] });
  assert.deepEqual(
    setPath({ items: [{ name: 'a', x: 1 }] }, 'items.a', { x: 2 }),
    { items: [{ name: 'a', x: 2 }] },
  );
});

test('replaceStrings rewrites every string, deeply, and leaves non-strings alone', () => {
  const data = { body: 'SELECT * FROM DEV_DB.T', n: 3, list: ['DEV_DB', { k: 'DEV_DB' }] };
  assert.deepEqual(replaceStrings(data, [{ from: 'DEV_DB', to: 'PROD_DB' }]), {
    body: 'SELECT * FROM PROD_DB.T', n: 3, list: ['PROD_DB', { k: 'PROD_DB' }],
  });
  assert.equal(replaceStrings(data, []), data);
});

test('resolveTemplates fills known variables and leaves unknown mustache tokens alone', () => {
  assert.equal(resolveTemplates('{{targetUrl}}/app', { targetUrl: 'https://t' }), 'https://t/app');
  assert.equal(resolveTemplates('{{Query Param}} {{other}}', { targetUrl: 'x' }), '{{Query Param}} {{other}}');
});

test('applyOverrides applies artifact paths then replace rules', () => {
  const overrides = {
    artifacts: { 'connections/My API/connection': { 'config.baseUrl': '{{targetUrl}}/api' } },
    replace: [{ from: 'dev-tenant', to: 'prod-tenant' }],
  };
  const out = applyOverrides('connections/My API/connection', { config: { baseUrl: 'x', path: '/dev-tenant' } }, overrides, { targetUrl: 'https://t' });
  assert.deepEqual(out, { config: { baseUrl: 'https://t/api', path: '/prod-tenant' } });
  assert.deepEqual(applyOverrides('other', { a: 'dev-tenant' }, overrides, {}), { a: 'prod-tenant' });
});

test('prepareDesired keeps the target env-bound values unless an override sets them', () => {
  const exported = { name: 'Dev Space', bundlePath: null, attributes: [{ name: 'Environment', values: ['dev'] }, { name: 'Theme', values: ['blue'] }] };
  const existing = { name: 'Prod Space', bundlePath: 'prod', attributes: [{ name: 'Environment', values: ['prod'] }] };
  const eba = { space: ['Environment'] };
  const plain = prepareDesired({ key: 'space', scope: 'space', exported, existing, overrides: {}, vars: {}, envBoundAttributes: eba });
  assert.deepEqual(plain, {
    name: 'Prod Space', bundlePath: 'prod',
    attributes: [{ name: 'Environment', values: ['prod'] }, { name: 'Theme', values: ['blue'] }],
  });
  const overridden = prepareDesired({
    key: 'space', scope: 'space', exported, existing,
    overrides: { artifacts: { space: { 'attributes.Environment': ['production'] } } }, vars: {}, envBoundAttributes: eba,
  });
  assert.deepEqual(overridden.attributes[0], { name: 'Environment', values: ['production'] });
});

test('prepareDesired for a new artifact drops env-bound values entirely', () => {
  const out = prepareDesired({ key: 'kapps/k/kapp', scope: 'kapp', exported: { slug: 'k', bundlePath: 'dev-ui' }, existing: null, overrides: {}, vars: {}, envBoundAttributes: {} });
  assert.deepEqual(out, { slug: 'k' });
});

test('parsePath rejects unsafe segments __proto__, constructor, prototype', () => {
  assert.throws(() => parsePath('__proto__.polluted'), /segment "__proto__" is not allowed/);
  assert.throws(() => parsePath('a.constructor'), /segment "constructor" is not allowed/);
  assert.throws(() => parsePath('prototype'), /segment "prototype" is not allowed/);
});

test('setPath throws on unsafe paths and does not pollute Object.prototype', () => {
  assert.throws(() => setPath({}, '__proto__.polluted', 1), /segment "__proto__" is not allowed/);
  assert.equal(({}).polluted, undefined, 'Object.prototype is not polluted');
  assert.throws(() => setPath({}, 'constructor.polluted', 1), /segment "constructor" is not allowed/);
});

test('replaceStrings validates rules: from must be non-empty string and to must be string', () => {
  const data = { a: 'test' };
  assert.throws(() => replaceStrings(data, [{ from: '', to: 'x' }]), /Invalid replace rule.*needs a non-empty "from"/);
  assert.throws(() => replaceStrings(data, [{ from: 'a' }]), /Invalid replace rule.*needs a non-empty "from"/);
  assert.throws(() => replaceStrings(data, [{ from: 'a', to: 123 }]), /Invalid replace rule.*needs a non-empty "from"/);
});

const handler = (props) => ({ definitionId: 'mail_send_v1', properties: props });
const prop = (name, value, type = 'Plaintext') => ({ name, type, required: true, description: '', ...(value === undefined ? {} : { value }) });

test('handler property values are environment-bound: the target keeps its own', () => {
  const exported = handler([prop('password', undefined, 'Encrypted'), prop('port', '25'), prop('server', 'smtp.dev.example.com')]);
  const existing = handler([prop('password', undefined, 'Encrypted'), prop('port', '587'), prop('server', 'smtp.test.example.com')]);
  const desired = prepareDesired({ key: 'handlers/mail_send_v1/handler', scope: 'handler', exported, existing, overrides: {}, vars: {} });
  assert.deepEqual(desired, existing);
});

test('a handler property override (object form) replaces the target value', () => {
  const exported = handler([prop('port', '25'), prop('server', 'smtp.dev.example.com')]);
  const existing = handler([prop('port', '587'), prop('server', 'smtp.test.example.com')]);
  const overrides = { artifacts: { 'handlers/mail_send_v1/handler': { 'properties.server': { value: 'smtp.prod.example.com' } } } };
  const desired = prepareDesired({ key: 'handlers/mail_send_v1/handler', scope: 'handler', exported, existing, overrides, vars: {} });
  assert.deepEqual(desired.properties, [prop('port', '587'), prop('server', 'smtp.prod.example.com')]);
});

test('a handler not yet in the target starts from the exported values; a new property too', () => {
  const exported = handler([prop('password', undefined, 'Encrypted'), prop('port', '25'), prop('tls', 'true')]);
  const fresh = prepareDesired({ key: 'k', scope: 'handler', exported, existing: null, overrides: {}, vars: {} });
  assert.deepEqual(fresh, exported);
  const existing = handler([prop('password', undefined, 'Encrypted'), prop('port', '587')]);
  const upgraded = prepareDesired({ key: 'k', scope: 'handler', exported, existing, overrides: {}, vars: {} });
  assert.deepEqual(upgraded.properties.map((p) => p.value), [undefined, '587', 'true']);
});
