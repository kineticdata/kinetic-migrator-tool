// lib/sync/artifacts/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, APPLY_ORDER, moduleFor, PRUNABLE } from './index.mjs';

const SAMPLE_KEYS = {
  space: 'space',
  teams: 'teams/Ops',
  models: 'models/People',
  'file-resources': 'file-resources/docs',
  connections: 'connections/My API/connection',
  operations: 'connections/My API/operations/Get Thing',
  kapps: 'kapps/services/kapp',
  forms: 'kapps/services/forms/data/form',
  webapis: 'kapps/services/webapis/lookup',
  workflows: 'kapps/services/forms/request/workflows/Submission Submitted/Notify',
  data: 'kapps/services/forms/codes/data',
  routines: 'routines/Send Email',
  handlers: 'handlers/mail_send_v1/handler',
  'task-refs': 'task-refs',
};

test('every sample key is owned by exactly one module', () => {
  for (const [type, key] of Object.entries(SAMPLE_KEYS)) {
    const owners = MODULES.filter((m) => m.owns(key)).map((m) => m.type);
    assert.deepEqual(owners, [type], key);
  }
  assert.equal(moduleFor('webapis/token').type, 'webapis');
  assert.equal(moduleFor('workflows/User Created/Welcome').type, 'workflows');
  assert.equal(moduleFor('kapps/k/workflows/Submission Created/Audit').type, 'workflows');
  assert.equal(moduleFor('kapps/k/forms/f/form').type, 'forms');
  assert.equal(moduleFor('kapps/k/forms/f/workflows/E/N').type, 'workflows');
  assert.equal(moduleFor('kapps/k/forms/f/data').type, 'data');
  assert.equal(moduleFor('connections/X/connection').type, 'connections');
  assert.equal(moduleFor('connections/X/operations/Y').type, 'operations');
  assert.equal(moduleFor('nonsense/thing'), undefined);
});

test('modules are in dependency order and task-refs runs last', () => {
  const order = MODULES.map((m) => m.type);
  const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  before('space', 'teams');
  before('connections', 'operations');
  before('operations', 'kapps');
  before('kapps', 'forms');
  before('forms', 'workflows');
  before('workflows', 'data');
  assert.equal(order.at(-1), 'task-refs');
  assert.ok(PRUNABLE.includes('data') && PRUNABLE.includes('teams') && PRUNABLE.includes('handlers') && !PRUNABLE.includes('space'));
  assert.ok(PRUNABLE.includes('routines') && !PRUNABLE.includes('task-refs'));
});

test('handlers are listed after what references them but applied before it', () => {
  const listed = MODULES.map((m) => m.type);
  const applied = APPLY_ORDER.map((m) => m.type);
  for (const t of ['webapis', 'workflows', 'routines']) {
    assert.ok(listed.indexOf('handlers') > listed.indexOf(t), `handlers listed after ${t}`);
  }
  for (const t of ['routines', 'webapis', 'workflows']) {
    assert.ok(applied.indexOf('handlers') < applied.indexOf(t), `handlers applied before ${t}`);
  }
  for (const t of ['webapis', 'workflows']) {
    assert.ok(applied.indexOf('routines') < applied.indexOf(t), `routines applied before ${t}`);
  }
  assert.deepEqual([...applied].sort(), listed.filter((t) => t !== 'task-refs').sort());
  const before = (a, b) => assert.ok(applied.indexOf(a) < applied.indexOf(b), `${a} before ${b}`);
  before('space', 'teams');
  before('connections', 'operations');
  before('kapps', 'forms');
  before('forms', 'workflows');
  before('workflows', 'data');
});
