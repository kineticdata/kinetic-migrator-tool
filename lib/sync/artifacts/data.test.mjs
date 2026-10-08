import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, TEST_CONFIG } from '../fake-client.mjs';
import data, { rowKey, walkSubmissions, matchesFilter, matchesRecord, matchKeyless, isKeyless, recordId, dataConfigError } from './data.mjs';

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

test('a filter keeps only matching submissions (all conditions, list values by membership)', async () => {
  const subs = [
    sub('1', 't1', { Code: 'A', Type: 'Lookup', Region: 'EU' }),
    sub('2', 't2', { Code: 'B', Type: 'Lookup', Region: 'US' }),
    sub('3', 't3', { Code: 'C', Type: 'Other', Region: 'EU' }),
    sub('4', 't4', { Code: 'D', Type: ['Lookup', 'Extra'], Region: 'EU' }),
  ];
  const c = fakeClient({ [route]: { submissions: subs } });
  const filter = [{ field: 'Type', value: 'Lookup' }, { field: 'Region', value: 'EU' }];
  const [a] = await data.list(c, { config: { ...TEST_CONFIG, data: [{ kapp: 'ref', form: 'codes', key: ['Code'], filter }] } });
  assert.deepEqual(a.data.rows.map((r) => r.Code), ['A', 'D']);
  assert.deepEqual(Object.values(a.meta.ids), ['1', '4']);
  assert.equal(matchesFilter({ X: '1' }, []), true);
  assert.equal(matchesFilter({ X: '1' }, undefined), true);
});

test('a filter also excludes the rows a duplicate key would otherwise reject', async () => {
  const c = fakeClient({ [route]: { submissions: [sub('1', 't', { Code: 'A', Type: 'Lookup' }), sub('2', 't', { Code: 'A', Type: 'Old' })] } });
  const [a] = await data.list(c, { config: { ...TEST_CONFIG, data: [{ kapp: 'ref', form: 'codes', key: ['Code'], filter: [{ field: 'Type', value: 'Lookup' }] }] } });
  assert.deepEqual(a.data.rows, [{ Code: 'A', Type: 'Lookup' }]);
});

const keylessConfig = { ...TEST_CONFIG, data: [{ kapp: 'ref', form: 'codes' }] };

test('without key fields every record is kept, identical ones too, sorted by their values', async () => {
  const c = fakeClient({ [route]: { submissions: [sub('1', 't', { Label: 'b' }), sub('2', 't', { Code: '', Label: 'a' }), sub('3', 't', { Label: 'a', Code: '' })] } });
  const [a] = await data.list(c, { config: keylessConfig });
  assert.deepEqual(a.data, { key: [], rows: [{ Code: '', Label: 'a' }, { Label: 'a', Code: '' }, { Label: 'b' }] });
  assert.equal(isKeyless([]), true);
  assert.equal(isKeyless(undefined), true);
  assert.equal(isKeyless(['Code']), false);
  assert.equal(recordId({ b: 1, a: 2 }, []), recordId({ a: 2, b: 1 }, []));
  assert.equal(recordId({ Code: 'A' }, ['Code']), rowKey({ Code: 'A' }, ['Code']));
});

test('matchesRecord: every source value must be in the target; target-only fields are ignored; empty matches absent', () => {
  assert.equal(matchesRecord({ Label: 'a' }, { Label: 'a', Status: 'Active' }), true);
  assert.equal(matchesRecord({ Label: 'a', Note: '' }, { Label: 'a' }), true);
  assert.equal(matchesRecord({ Label: 'a', Note: null }, { Label: 'a', Note: '' }), true);
  assert.equal(matchesRecord({ Tags: [] }, {}), true);
  assert.equal(matchesRecord({ Label: 'a', Note: '' }, { Label: 'a', Note: 'x' }), false);
  assert.equal(matchesRecord({ Label: 'a' }, { Label: 'b' }), false);
  assert.equal(matchesRecord({ Tags: ['x', 'y'] }, { Tags: ['x', 'y'], More: 1 }), true);
});

test('matchKeyless pairs each target record with at most one source record, exact matches first', () => {
  assert.deepEqual(matchKeyless([{ A: '1' }, { A: '1' }], [{ A: '1' }]), [0, -1]);
  assert.deepEqual(matchKeyless([{ A: '1' }, { A: '1' }], [{ A: '1' }, { A: '1', B: 'x' }]), [0, 1]);
  // The looser source record does not take the target record the exact one needs.
  assert.deepEqual(matchKeyless([{ A: '1' }, { A: '1', B: 'x' }], [{ A: '1', B: 'x' }, { A: '1', C: 'z' }]), [1, 0]);
});

test('keyless mergeTargetOnly shows matched records as the target has them, so target-only fields are no change', () => {
  const existing = { key: [], rows: [{ Label: 'a', Status: 'Active' }, { Label: 'z', Status: 'Active' }] };
  const same = data.mergeTargetOnly({ key: [], rows: [{ Label: 'a' }] }, existing);
  assert.deepEqual(same, existing);
  const more = data.mergeTargetOnly({ key: [], rows: [{ Label: 'a' }, { Label: 'b' }] }, existing);
  assert.deepEqual(more.rows, [{ Label: 'a', Status: 'Active' }, { Label: 'b' }, { Label: 'z', Status: 'Active' }]);
});

test('keyless apply: two identical source records need two target records', async () => {
  const existing = { data: { key: [], rows: [{ Label: 'a', Status: 'Active' }] }, meta: { ids: {} } };
  const source = { key: [], rows: [{ Label: 'a' }, { Label: 'a' }] };
  const c = fakeClient();
  await data.apply(c, { key: 'kapps/ref/forms/codes/data', source, desired: source, existing }, { prune: new Set(['data']) });
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['POST /kapps/ref/forms/codes/submissions']);
});

test('keyless apply creates what the target lacks, skips identical records, never updates or deletes, even with prune', async () => {
  const same = { Label: 'same' };
  const existing = {
    data: { key: [], rows: [same, { Label: 'old' }] },
    meta: { ids: { [recordId(same, [])]: 'id-same', [recordId({ Label: 'old' }, [])]: 'id-old' } },
  };
  const source = { key: [], rows: [{ Label: 'new' }, same] };
  const item = { key: 'kapps/ref/forms/codes/data', source, desired: data.mergeTargetOnly(source, existing.data), existing };
  assert.deepEqual(item.desired.rows, [{ Label: 'new' }, { Label: 'old' }, { Label: 'same' }]);
  for (const prune of [new Set(), new Set(['data'])]) {
    const c = fakeClient();
    await data.apply(c, item, { prune });
    assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), ['POST /kapps/ref/forms/codes/submissions']);
    assert.deepEqual(c.calls[0].body, { values: { Label: 'new' } });
  }
});

test('dataConfigError accepts optional key and filter and explains malformed entries', () => {
  assert.equal(dataConfigError([{ kapp: 'k', form: 'f' }, { kapp: 'k', form: 'g', key: ['A'], filter: [{ field: 'T', value: 'x' }] }]), null);
  assert.match(dataConfigError({}), /must be a list/);
  assert.match(dataConfigError([{ kapp: 'k', form: '' }]), /entry 1 needs a kapp and a form/);
  assert.match(dataConfigError([{ kapp: 'k', form: 'f', filter: [{ field: 'T', value: '' }] }]), /filter condition 1 needs a field and a value/);
  assert.match(dataConfigError([{ kapp: 'k', form: 'f', filter: { field: 'T' } }]), /"filter" must be a list/);
  assert.match(dataConfigError([{ kapp: 'k', form: 'f', key: [''] }]), /"key" must be a list of field names/);
});
