import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './summaries.mjs';

const PLANTED = 'planted-s3cr3t-value';

const rows = (s, heading) => s.sections.find((x) => x.heading === heading)?.rows ?? [];
const items = (s, heading) => s.sections.find((x) => x.heading === heading)?.items ?? [];
const row = (s, heading, label) => rows(s, heading).find((r) => r.label === label)?.value;

test('form summary: kapp, status, counts, fields, integrations, indexes, attributes', () => {
  const s = summarize('kapps/services/forms/it-request/form', {
    slug: 'it-request', name: 'IT Request', status: 'Active', type: 'Service',
    pages: [
      { name: 'Page 1', elements: [
        { type: 'field', name: 'Summary', renderType: 'text', required: true },
        { type: 'section', name: 'More', elements: [{ type: 'field', name: 'Details', renderType: 'text', required: false }] },
        { type: 'button', name: 'Submit' },
      ] },
      { name: 'Confirmation', elements: [] },
    ],
    integrations: [{ name: 'Ticket', connectionId: 'c-1', operationId: 'o-1' }],
    indexDefinitions: [{ name: 'values[Summary]', parts: ['values[Summary]'], unique: false }],
    attributes: [{ name: 'Icon', values: ['fa-laptop'] }],
  }, 'forms');
  assert.equal(s.title, 'IT Request');
  assert.equal(row(s, 'Overview', 'Kapp'), 'services');
  assert.equal(row(s, 'Overview', 'Status'), 'Active');
  assert.equal(row(s, 'Overview', 'Type'), 'Service');
  assert.equal(row(s, 'Overview', 'Pages'), 2);
  assert.equal(row(s, 'Overview', 'Fields'), 2);
  assert.deepEqual(rows(s, 'Fields'), [
    { label: 'Summary', value: 'text, required' },
    { label: 'Details', value: 'text' },
  ]);
  assert.equal(items(s, 'Integrations').length, 1);
  assert.deepEqual(items(s, 'Index definitions'), ['values[Summary]']);
  assert.deepEqual(rows(s, 'Attributes'), [{ label: 'Icon', value: 'fa-laptop' }]);
});

test('form summary groups workflows by event and takes resolved integration labels', () => {
  const s = summarize('kapps/k/forms/f/form', { name: 'F', integrations: [{ name: 'Ticket' }] }, 'forms', {
    workflows: [{ event: 'Submission Submitted', name: 'Notify' }, { event: 'Submission Created', name: 'Audit' }, { event: 'Submission Submitted', name: 'Assign' }],
    integrations: ['ServiceNow › Create Ticket'],
  });
  assert.deepEqual(rows(s, 'Workflows'), [
    { label: 'Submission Created', value: 'Audit' },
    { label: 'Submission Submitted', value: 'Assign, Notify' },
  ]);
  assert.deepEqual(items(s, 'Integrations'), ['ServiceNow › Create Ticket']);
});

test('form summary accepts the singular type name too', () => {
  assert.equal(summarize('kapps/k/forms/f/form', { name: 'F' }, 'form').title, 'F');
});

test('kapp summary: forms count, categories, form types, attribute definitions, policies, integrations', () => {
  const s = summarize('kapps/services/kapp', {
    slug: 'services', name: 'Services',
    categories: [{ slug: 'hw', name: 'Hardware' }],
    formTypes: [{ name: 'Service' }],
    kappAttributeDefinitions: [{ name: 'Icon' }],
    formAttributeDefinitions: [{ name: 'Owner' }],
    securityPolicyDefinitions: [{ name: 'Authenticated Users', type: 'Kapp', rule: 'true' }],
    securityPolicies: [{ endpoint: 'Display', name: 'Authenticated Users' }],
    integrations: [{ name: 'Lookup', connectionId: 'c', operationId: 'o' }],
  }, 'kapps', { formsCount: 3 });
  assert.equal(s.title, 'Services');
  assert.equal(row(s, 'Overview', 'Forms'), 3);
  assert.deepEqual(items(s, 'Categories'), ['Hardware']);
  assert.deepEqual(items(s, 'Form types'), ['Service']);
  assert.ok(items(s, 'Attribute definitions').includes('Kapp: Icon'));
  assert.deepEqual(rows(s, 'Security policies'), [{ label: 'Display', value: 'Authenticated Users' }]);
  assert.deepEqual(items(s, 'Integrations'), ['Lookup']);
});

test('workflow summary: scope, event, status, filter, node count, handlers and routines', () => {
  const s = summarize('kapps/services/forms/it-request/workflows/Submission Submitted/Notify', {
    name: 'Notify', event: 'Submission Submitted', status: 'Active', filter: "values('A') = 'B'",
    treeJson: { nodes: [{ definitionId: 'system_start_v1' }, { definitionId: 'mail_send_v1' }, { definitionId: 'routine_x_v1' }] },
  }, 'workflows');
  assert.equal(s.title, 'Notify');
  assert.equal(row(s, 'Overview', 'Scope'), 'Form services / it-request');
  assert.equal(row(s, 'Overview', 'Event'), 'Submission Submitted');
  assert.equal(row(s, 'Overview', 'Nodes'), 3);
  assert.equal(row(s, 'Overview', 'Filter'), "values('A') = 'B'");
  assert.deepEqual(items(s, 'Handlers and routines'), ['mail_send_v1', 'routine_x_v1']);
  assert.equal(row(summarize('workflows/User Created/W', { name: 'W', treeJson: { nodes: [] } }, 'workflows'), 'Overview', 'Scope'), 'Space');
  assert.equal(row(summarize('kapps/k/workflows/E/W', { name: 'W' }, 'workflows'), 'Overview', 'Scope'), 'Kapp k');
});

test('connection summary masks secret auth fields as set / not set', () => {
  const s = summarize('connections/ServiceNow/connection', {
    id: 'c-1', name: 'ServiceNow', type: 'http',
    config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc', password: PLANTED, token: '' } },
  }, 'connections', { operationCount: 2, secrets: { password: true, token: false } });
  assert.equal(row(s, 'Overview', 'Type'), 'http');
  assert.equal(row(s, 'Overview', 'Base URL'), 'https://api.example.com');
  assert.equal(row(s, 'Overview', 'Auth type'), 'basic');
  assert.equal(row(s, 'Overview', 'Operations'), 2);
  assert.equal(row(s, 'Authentication', 'username'), 'svc');
  assert.equal(row(s, 'Authentication', 'password'), '•••• set');
  assert.equal(row(s, 'Authentication', 'token'), 'not set');
  assert.ok(!JSON.stringify(s).includes(PLANTED));
});

test('operation summary: method, path, inputs, outputs', () => {
  const s = summarize('connections/ServiceNow/operations/Create Ticket', {
    id: 'o-1', name: 'Create Ticket', connectionId: 'c-1',
    config: { method: 'POST', path: '/tickets', body: { short_description: '{{Summary}}' } },
    inputs: [{ name: 'Summary' }], outputs: { Id: 'body.id' },
  }, 'operations');
  assert.equal(s.title, 'Create Ticket');
  assert.equal(row(s, 'Overview', 'Method'), 'POST');
  assert.equal(row(s, 'Overview', 'Path'), '/tickets');
  assert.deepEqual(items(s, 'Inputs'), ['Summary']);
  assert.deepEqual(items(s, 'Outputs'), ['Id']);
});

test('handler summary masks secret properties and shows version, status, categories, package', () => {
  const s = summarize('handlers/mail_send_v1/handler', {
    definitionId: 'mail_send_v1', definitionVersion: '1', name: 'Mail Send', status: 'Active',
    categories: ['Mail'],
    properties: [
      { name: 'server', type: 'Plaintext', value: 'smtp.example.com' },
      { name: 'password', type: 'Encrypted', value: PLANTED },
      { name: 'API Token', type: 'Plaintext', value: PLANTED },
      { name: 'key', type: 'Encrypted' },
    ],
    packageSha256: 'abc123',
  }, 'handlers', { packageSize: 2048, secrets: { password: true, 'API Token': true, key: false } });
  assert.equal(s.title, 'Mail Send');
  assert.equal(row(s, 'Overview', 'Version'), '1');
  assert.equal(row(s, 'Overview', 'Package SHA-256'), 'abc123');
  assert.equal(row(s, 'Overview', 'Package size'), 2048);
  assert.deepEqual(items(s, 'Categories'), ['Mail']);
  assert.equal(row(s, 'Settings', 'server'), 'smtp.example.com');
  assert.equal(row(s, 'Settings', 'password'), '•••• set');
  assert.equal(row(s, 'Settings', 'API Token'), '•••• set');
  assert.equal(row(s, 'Settings', 'key'), 'not set');
  assert.ok(!JSON.stringify(s).includes(PLANTED));
});

test('team summary: name, description, attributes (secret-named attributes masked)', () => {
  const s = summarize('teams/Admins', {
    name: 'Admins', description: 'Space admins',
    attributes: [{ name: 'Icon', values: ['fa-users'] }, { name: 'Api Key', values: [PLANTED] }],
  }, 'teams');
  assert.equal(s.title, 'Admins');
  assert.equal(row(s, 'Overview', 'Description'), 'Space admins');
  assert.equal(row(s, 'Attributes', 'Icon'), 'fa-users');
  assert.equal(row(s, 'Attributes', 'Api Key'), '•••• hidden');
  assert.ok(!JSON.stringify(s).includes(PLANTED));
});

test('space summary: settings, attribute definitions, security policies; secret-named settings masked', () => {
  const s = summarize('space', {
    name: 'Space', defaultLocale: 'en', sharedBundleBaseUrl: 'https://cdn.example.com',
    sessionSecret: PLANTED,
    spaceAttributeDefinitions: [{ name: 'Theme' }],
    teamAttributeDefinitions: [{ name: 'Icon' }],
    securityPolicyDefinitions: [{ name: 'Space Admins', type: 'Space', rule: 'false' }],
    securityPolicies: [{ endpoint: 'Discussions Access', name: 'Space Admins' }],
  }, 'space');
  assert.equal(s.title, 'Space');
  assert.equal(row(s, 'Settings', 'defaultLocale'), 'en');
  assert.equal(row(s, 'Settings', 'sessionSecret'), '•••• hidden');
  assert.ok(items(s, 'Attribute definitions').includes('Space: Theme'));
  assert.deepEqual(items(s, 'Security policy definitions'), ['Space Admins']);
  assert.deepEqual(rows(s, 'Security policies'), [{ label: 'Discussions Access', value: 'Space Admins' }]);
  assert.ok(!JSON.stringify(s).includes(PLANTED));
});

test('generic fallback shows top-level scalars and array counts, masking secret names', () => {
  const s = summarize('models/People', {
    name: 'People', status: 'Active', attributes: [1, 2, 3], nested: { a: 1 }, clientSecret: PLANTED, password: null,
  }, 'models', { secrets: { clientSecret: true } });
  assert.equal(s.title, 'People');
  assert.equal(s.subtitle, 'models/People');
  assert.equal(row(s, 'Overview', 'status'), 'Active');
  assert.equal(row(s, 'Overview', 'attributes'), '3 items');
  assert.equal(row(s, 'Overview', 'nested'), undefined);
  assert.equal(row(s, 'Overview', 'clientSecret'), '•••• set');
  assert.equal(row(s, 'Overview', 'password'), '•••• hidden');
  assert.ok(!JSON.stringify(s).includes(PLANTED));
});

test('summaries tolerate missing data', () => {
  for (const type of ['forms', 'kapps', 'workflows', 'connections', 'operations', 'handlers', 'teams', 'space', 'other']) {
    const s = summarize('x/y', undefined, type);
    assert.equal(typeof s.title, 'string');
    assert.ok(Array.isArray(s.sections));
  }
});

test('set / not set come only from extra.secrets; a planted value with no flag is hidden', () => {
  const conn = summarize('connections/C/connection', {
    name: 'C', type: 'http', config: { auth: { authType: 'basic', username: 'svc', password: PLANTED } },
  }, 'connections');
  assert.equal(row(conn, 'Authentication', 'password'), '•••• hidden');
  const stripped = summarize('connections/C/connection', {
    name: 'C', type: 'http', config: { auth: { authType: 'basic', username: 'svc' } },
  }, 'connections', { secrets: { password: false, apiKey: true } });
  assert.equal(row(stripped, 'Authentication', 'password'), 'not set');
  assert.equal(row(stripped, 'Authentication', 'apiKey'), '•••• set');
  const noFlags = summarize('connections/C/connection', {
    name: 'C', type: 'http', config: { auth: { authType: 'raw_bearer_token' } },
  }, 'connections');
  assert.equal(row(noFlags, 'Authentication', 'token'), '•••• hidden');
  const h = summarize('handlers/h/handler', { name: 'H', properties: [{ name: 'key', type: 'Encrypted' }] }, 'handlers');
  assert.equal(row(h, 'Settings', 'key'), '•••• hidden');
  assert.ok(!JSON.stringify([conn, stripped, noFlags, h]).includes(PLANTED));
});

test('connection auth never shows nested values, and URLs lose userinfo and secret query parameters', () => {
  const s = summarize('connections/C/connection', {
    name: 'C', type: 'http',
    config: {
      baseUrl: `https://svc:${PLANTED}@api.example.com/v1?api_key=${PLANTED}&page=2`,
      auth: { authType: 'custom', headers: { Authorization: `Bearer ${PLANTED}` }, realm: `https://u:${PLANTED}@login.example.com` },
    },
  }, 'connections');
  assert.equal(row(s, 'Authentication', 'headers'), '(object)');
  assert.equal(row(s, 'Overview', 'Base URL'), 'https://•••@api.example.com/v1?api_key=•••&page=2');
  assert.equal(row(s, 'Authentication', 'realm'), 'https://•••@login.example.com');
  const op = summarize('connections/C/operations/O', { name: 'O', config: { method: 'GET', path: `/x?token=${PLANTED}&q=1` } }, 'operations');
  assert.equal(row(op, 'Overview', 'Path'), '/x?token=•••&q=1');
  const g = summarize('models/M', { name: 'M', url: `https://a:${PLANTED}@db.example.com?password=${PLANTED}` }, 'models');
  assert.equal(row(g, 'Overview', 'url'), 'https://•••@db.example.com?password=•••');
  assert.ok(!JSON.stringify([s, op, g]).includes(PLANTED));
});

test('an Object.prototype name as type falls back to the generic summary', () => {
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const s = summarize('models/M', { name: 'M', status: 'Active' }, type);
    assert.equal(s.title, 'M');
    assert.equal(s.subtitle, 'models/M');
  }
});

test('attributes without a name are skipped', () => {
  const s = summarize('teams/T', { name: 'T', attributes: [{ values: ['x'] }, { name: 'Icon', values: ['i'] }] }, 'teams');
  assert.deepEqual(rows(s, 'Attributes'), [{ label: 'Icon', value: 'i' }]);
});

test('labels taken from keys show names, not their encoded file names', () => {
  assert.equal(summarize('kapps/%63on/forms/f/form', { name: 'F' }, 'forms').subtitle, 'Form in kapp con');
  assert.equal(summarize('connections/Mail%3A Prod/operations/Send', { name: 'Send' }, 'operations').subtitle, 'Operation on connection Mail: Prod');
  assert.equal(summarize('teams/Departments%3A%3AIT', {}, 'teams').title, 'Departments::IT');
});

test('a SQL connection summary shows its host and database, and its password only as set / not set', () => {
  // Content from an older snapshot that still holds the password, and from a current one.
  for (const config of [
    { configType: 'postgres', host: 'db.example.com', port: 5432, username: 'reporter', password: PLANTED, database: 'warehouse' },
    { configType: 'postgres', host: 'db.example.com', port: 5432, username: 'reporter', database: 'warehouse' },
  ]) {
    const s = summarize('connections/Warehouse DB/connection', { id: 'c', name: 'Warehouse DB', type: 'postgres', config, ...(config.password ? {} : { strippedSecrets: ['password'] }) }, 'connections', { operationCount: 1, secrets: { password: false } });
    assert.equal(row(s, 'Overview', 'Type'), 'postgres');
    assert.equal(row(s, 'Overview', 'Host'), 'db.example.com');
    assert.equal(row(s, 'Overview', 'Database'), 'warehouse');
    assert.equal(row(s, 'Overview', 'Username'), 'reporter');
    assert.equal(row(s, 'Authentication', 'password'), 'not set');
    assert.ok(!JSON.stringify(s).includes(PLANTED));
  }
});
