// Field-level differences for Compare: the engine's diff rules, readable path
// labels and the three-way rows of a drifted item.
import { expect, test } from 'vitest';
import { diffValues, displayValue, pathLabel, threeWayRows } from './diff';

test('diffValues matches named lists by name and reports a reorder', () => {
  const target = { name: 'IT Request', pages: [{ name: 'Details', required: false }, { name: 'Review' }] };
  const incoming = { name: 'IT Request', pages: [{ name: 'Review' }, { name: 'Details', required: true }] };
  expect(diffValues(target, incoming)).toEqual([
    { path: 'pages', from: ['Details', 'Review'], to: ['Review', 'Details'] },
    { path: 'pages[Details].required', from: false, to: true },
  ]);
  expect(diffValues({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 3] }, a: 1 })).toEqual([{ path: 'b.c.1', from: 2, to: 3 }]);
  expect(diffValues(null, { a: 1 })).toEqual([{ path: '(root)', from: null, to: { a: 1 } }]);
  expect(diffValues({ a: undefined }, { a: null })).toEqual([]);
});

test('pathLabel reads like the screen, not like JSON', () => {
  expect(pathLabel('pages[Details].elements[Priority].required')).toBe('Page “Details” › Element “Priority” › Required');
  expect(pathLabel('attributes[Owner].values.0')).toBe('Attribute “Owner” › Values › #1');
  expect(pathLabel('indexDefinitions')).toBe('Index definitions');
  expect(pathLabel('securityPolicies[Display].rule')).toBe('Security policy “Display” › Rule');
  expect(pathLabel('(root)')).toBe('Whole item');
  expect(pathLabel('config.baseUrl')).toBe('Config › Base url');
});

test('displayValue', () => {
  expect(displayValue(undefined)).toBe('Not set');
  expect(displayValue(null)).toBe('Empty');
  expect(displayValue('')).toBe('Empty');
  expect(displayValue(true)).toBe('true');
  expect(displayValue(['Review', 'Details'])).toBe('Review, Details');
  expect(displayValue({ a: 1 })).toBe('{"a":1}');
  expect(displayValue('x'.repeat(300)).length).toBeLessThanOrEqual(161);
});

test('threeWayRows marks what changed in the target since the last promotion', () => {
  const last = { name: 'Approval', description: 'v1', status: 'Active' };
  const target = { name: 'Approval', description: 'edited in test', status: 'Active' };
  const incoming = { name: 'Approval', description: 'v1', status: 'Inactive' };
  expect(threeWayRows(last, target, incoming)).toEqual([
    { path: 'description', last: 'v1', target: 'edited in test', incoming: 'v1', drifted: true },
    { path: 'status', last: 'Active', target: 'Active', incoming: 'Inactive', drifted: false },
  ]);
});
