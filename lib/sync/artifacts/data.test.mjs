import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import data, { rowKey, walkSubmissions } from './data.mjs';

const sub = (id, createdAt, values) => ({ id, createdAt, values });
const route = 'GET core/kapps/ref/forms/codes/submissions';

test('rowKey is a stable tuple of the key fields', () => {
  assert.equal(rowKey({ A: '1', B: 'x', C: 'ignored' }, ['A', 'B']), '["1","x"]');
  assert.equal(rowKey({}, ['A']), '[null]');
});

test('walkSubmissions pages by createdAt and keeps rows that share a timestamp across the page boundary', async () => {
  // 25 rows on page one; the last two share createdAt T; page two (<= T) returns those two again plus three older.
  const first = Array.from({ length: 23 }, (_, i) => sub(`s${i}`, `2026-01-01T00:00:${String(59 - i).padStart(2, '0')}Z`, {}));
  const T = '2026-01-01T00:00:10Z';
  first.push(sub('t1', T, {}), sub('t2', T, {}));
  const second = [sub('t1', T, {}), sub('t2', T, {}), sub('t3', T, {}), sub('o1', '2026-01-01T00:00:05Z', {}), sub('o2', '2026-01-01T00:00:01Z', {})];
  const c = fakeClient({ [route]: ({ query }) => ({ submissions: query.q ? second : first }) }, { mode: 'read' });
  const all = await walkSubmissions(c, 'ref', 'codes');
  assert.equal(all.length, 28);
  assert.equal(new Set(all.map((s) => s.id)).size, 28);
  assert.equal(c.calls[1].query.q, `createdAt <= "${T}"`);
  assert.equal(c.calls[0].query.limit, 25);
  for (const call of c.calls) assert.deepEqual([call.query.orderBy, call.query.direction], ['createdAt', 'DESC']);
});

test('walkSubmissions refuses to loop forever when a full page shares one timestamp', async () => {
  const same = Array.from({ length: 25 }, (_, i) => sub(`s${i}`, '2026-01-01T00:00:00Z', {}));
  const c = fakeClient({ [route]: () => ({ submissions: same }) }, { mode: 'read' });
  await assert.rejects(walkSubmissions(c, 'ref', 'codes'), /share createdAt/);
});

const config = { ...TEST_CONFIG, data: [{ kapp: 'ref', form: 'codes', key: ['Code'] }] };

test('data list keys rows, sorts them, and rejects duplicate or empty keys', async () => {
  const ok = fakeClient({ [route]: { submissions: [sub('2', 't2', { Code: 'B', Label: 'b' }), sub('1', 't1', { Code: 'A', Label: 'a' })] } });
  const [a] = await data.list(ok, { config });
  assert.equal(a.key, 'kapps/ref/forms/codes/data');
  assert.deepEqual(a.data, { key: ['Code'], rows: [{ Code: 'A', Label: 'a' }, { Code: 'B', Label: 'b' }] });
  assert.deepEqual(a.meta.ids, { '["A"]': '1', '["B"]': '2' });

  const dup = fakeClient({ [route]: { submissions: [sub('1', 't', { Code: 'A' }), sub('2', 't', { Code: 'A' })] } });
  await assert.rejects(data.list(dup, { config }), /duplicate key \["A"\]/);
  const empty = fakeClient({ [route]: { submissions: [sub('1', 't', { Code: '' })] } });
  await assert.rejects(data.list(empty, { config }), /empty key field/);
});

test('data list skips a form that does not exist in this environment', async () => {
  assert.deepEqual(await data.list(fakeClient({}), { config }), []);
});

test('mergeTargetOnly keeps target-only rows so they do not show as a perpetual diff', () => {
  const merged = data.mergeTargetOnly({ key: ['Code'], rows: [{ Code: 'A' }] }, { key: ['Code'], rows: [{ Code: 'Z' }, { Code: 'A', x: 1 }] });
  assert.deepEqual(merged.rows, [{ Code: 'A' }, { Code: 'Z' }]);
});

test('data apply creates missing rows, updates changed rows, leaves equal rows, prunes only when asked', async () => {
  const existing = {
    data: { key: ['Code'], rows: [{ Code: 'A', Label: 'old' }, { Code: 'B', Label: 'same' }, { Code: 'Z', Label: 'extra' }] },
    meta: { ids: { '["A"]': 'id-a', '["B"]': 'id-b', '["Z"]': 'id-z' } },
  };
  const source = { key: ['Code'], rows: [{ Code: 'A', Label: 'new' }, { Code: 'B', Label: 'same' }, { Code: 'C', Label: 'c' }] };
  const item = { key: 'kapps/ref/forms/codes/data', source, desired: source, existing };
  const c = fakeClient();
  await data.apply(c, item, { prune: new Set() });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['PUT /submissions/id-a', 'POST /kapps/ref/forms/codes/submissions']);
  assert.deepEqual(c.calls[0].body, { values: { Code: 'A', Label: 'new' } });

  const p = fakeClient();
  await data.apply(p, item, { prune: new Set(['data']) });
  assert.equal(p.calls.at(-1).method, 'DELETE');
  assert.equal(p.calls.at(-1).path, '/submissions/id-z');
});
