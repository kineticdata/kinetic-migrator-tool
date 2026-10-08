// Field-level differences for Compare: readable path labels and the
// three-way rows of a drifted item.
import { expect, test } from 'vitest';
import { displayValue, pathLabel, threeWayRows } from './diff';

test('pathLabel reads like the screen, not like JSON', () => {
  expect(pathLabel('pages[Details].elements[Priority].required')).toBe('Page “Details” › Element “Priority” › Required');
  expect(pathLabel('attributes[Owner].values.0')).toBe('Attribute “Owner” › Values › #1');
  expect(pathLabel('indexDefinitions')).toBe('Index definitions');
  expect(pathLabel('securityPolicies[Display].rule')).toBe('Security policy “Display” › Rule');
  expect(pathLabel('(root)')).toBe('Whole item');
  expect(pathLabel('config.baseUrl')).toBe('Config › Base url');
  // Names may contain "." and "]".
  expect(pathLabel('elements[Cost.Center].required')).toBe('Element “Cost.Center” › Required');
  expect(pathLabel('elements[a]b].label')).toBe('Element “a]b” › Label');
  expect(pathLabel('pages[v1.2][x]')).toBe('Page “v1.2” › Entry “x”');
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
  const targetChanges = [{ path: 'description', from: 'v1', to: 'edited in test' }];
  const incoming = [{ path: 'description', from: 'edited in test', to: 'v1' }, { path: 'status', from: 'Active', to: 'Inactive' }];
  expect(threeWayRows(targetChanges, incoming)).toEqual([
    { path: 'description', last: 'v1', target: 'edited in test', incoming: 'v1', drifted: true },
    { path: 'status', last: 'Active', target: 'Active', incoming: 'Inactive', drifted: false },
  ]);
});
