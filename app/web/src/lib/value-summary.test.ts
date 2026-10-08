// Readable summaries of Compare values.
import { expect, test } from 'vitest';
import { fullValueText, hasFullValue, oneLine, summarizeValue } from './value-summary';

const element = { dataType: 'string', label: 'Asset Tag', name: 'Asset Tag', renderType: 'text', required: false, type: 'field' };

test('a form field reads as label, type and whether it is required', () => {
  expect(summarizeValue(element)).toEqual({ kind: 'props', entries: [['Label', 'Asset Tag'], ['Type', 'Text field'], ['Required', 'No']] });
  expect(oneLine({ ...element, required: true, renderType: 'dropdown' })).toBe('Asset Tag (Dropdown, required)');
  expect(oneLine({ type: 'section', name: 'Details' })).toBe('Details (Section)');
});

test('index definitions and integrations get a sentence', () => {
  expect(oneLine({ name: 'values[Priority]', parts: ['values[Priority]'], unique: false })).toBe('Index on Priority (not unique)');
  expect(oneLine({ name: 'x', parts: ['values[A]', 'createdAt'], unique: true })).toBe('Index on A, Created at (unique)');
  const integration = { name: 'Create Ticket', connectionId: 'c-1', operationId: 'o-1' };
  expect(oneLine(integration, { 'c-1': 'Ticketing', 'o-1': 'Create Ticket' })).toBe('Calls Create Ticket on Ticketing');
  // Unresolved ids are left out rather than shown.
  expect(oneLine(integration)).toBe('Calls Create Ticket');
});

test('lists of objects become one line per entry; long lists say how many more', () => {
  const s = summarizeValue([{ name: 'values[Priority]', parts: ['values[Priority]'], unique: false }, element]);
  expect(s).toEqual({ kind: 'list', items: ['Index on Priority (not unique)', 'Asset Tag (Text field, optional)'], more: 0 });
  const many = summarizeValue(Array.from({ length: 9 }, (_, i) => ({ ...element, label: `F${i}` })));
  expect(many.kind === 'list' && many.items.length).toBe(6);
  expect(many.kind === 'list' && many.more).toBe(3);
});

test('other objects show their properties, primitives first', () => {
  expect(summarizeValue({ config: { a: 1 }, method: 'POST', enabled: true })).toEqual({
    kind: 'props', entries: [['Method', 'POST'], ['Enabled', 'Yes'], ['Config', '1 property']],
  });
});

test('primitives, empties and long text', () => {
  expect(summarizeValue(undefined)).toEqual({ kind: 'empty', text: 'Not set' });
  expect(summarizeValue('')).toEqual({ kind: 'empty', text: 'Empty' });
  expect(summarizeValue([])).toEqual({ kind: 'empty', text: 'None' });
  expect(summarizeValue(false)).toEqual({ kind: 'text', text: 'No', full: true });
  expect(summarizeValue(['Review', 'Details'])).toEqual({ kind: 'text', text: 'Review, Details', full: true });
  const long = summarizeValue('x'.repeat(300));
  expect(long.kind === 'text' && long.text.length).toBe(161);
  expect(hasFullValue('x'.repeat(300), long)).toBe(true);
  expect(hasFullValue('short', summarizeValue('short'))).toBe(false);
  expect(hasFullValue(element, summarizeValue(element))).toBe(true);
  expect(fullValueText({ a: 1 })).toBe('{\n  "a": 1\n}');
});
