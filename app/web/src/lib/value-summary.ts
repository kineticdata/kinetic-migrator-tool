// Readable summaries of the values in a Compare "Changes" row: a form
// element, an index definition or an integration in a few words, any other
// object as a short "Key: value" list and a list of objects as one line per
// entry. The full value stays one click away (pretty-printed JSON).
import { humanize } from './diff';

// Names for the ids an integration refers to (connection and operation ids
// differ per environment, so each side resolves its own).
export type IdNames = Readonly<Record<string, string>>;

export type ValueSummary =
  | { kind: 'empty'; text: string }
  | { kind: 'text'; text: string; full: boolean }
  | { kind: 'props'; entries: Array<[string, string]> }
  | { kind: 'list'; items: string[]; more: number };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

// Over this many characters a text value is cut, with the full text a click away.
export const TEXT_MAX = 160;
// A list shows this many entries, then "and N more".
export const LIST_MAX = 6;
// An object shows this many properties.
const PROPS_MAX = 6;

const RENDER_TYPES: Record<string, string> = {
  text: 'Text field', dropdown: 'Dropdown', checkbox: 'Checkboxes', radio: 'Radio buttons', date: 'Date', datetime: 'Date and time',
  time: 'Time', attachment: 'Attachment', team: 'Team', user: 'User', 'user-list': 'User list', 'team-list': 'Team list',
  html: 'HTML', submit: 'Submit button', save: 'Save button', 'previous-page': 'Previous page button', custom: 'Custom button',
};
const ELEMENT_TYPES: Record<string, string> = { section: 'Section', content: 'Content', button: 'Button', page: 'Page' };

const yesNo = (v: unknown) => (v === true ? 'Yes' : 'No');

// "values[Priority]" → "Priority"; "closedBy" → "Closed by".
function indexPart(part: unknown): string {
  const s = String(part);
  const m = /^values\[(.+)\]$/.exec(s);
  return m ? m[1] : humanize(s);
}

function isElement(v: Obj): boolean {
  return (typeof v.type === 'string' && (v.type === 'field' || v.type in ELEMENT_TYPES) && (str(v.name) !== null || str(v.label) !== null));
}
const isIndex = (v: Obj) => Array.isArray(v.parts) && 'unique' in v;
const isIntegration = (v: Obj) => typeof v.connectionId === 'string' && typeof v.operationId === 'string';
const isAttribute = (v: Obj) => str(v.name) !== null && Array.isArray(v.values) && Object.keys(v).length === 2;
const isPolicy = (v: Obj) => str(v.endpoint) !== null && str(v.name) !== null && Object.keys(v).length === 2;

function elementType(v: Obj): string {
  if (v.type === 'field') return RENDER_TYPES[String(v.renderType)] ?? (str(v.renderType) ? humanize(String(v.renderType)) : 'Field');
  return ELEMENT_TYPES[String(v.type)] ?? humanize(String(v.type));
}

function integrationText(v: Obj, names: IdNames): string {
  const op = names[String(v.operationId)] ?? str(v.name) ?? 'an operation';
  const conn = names[String(v.connectionId)];
  return conn ? `Calls ${op} on ${conn}` : `Calls ${op}`;
}

function indexText(v: Obj): string {
  const parts = (v.parts as unknown[]).map(indexPart);
  return `Index on ${parts.length ? parts.join(', ') : str(v.name) ?? '—'} (${v.unique ? 'unique' : 'not unique'})`;
}

// A primitive (or a short list of them) in a few words.
function scalarText(v: unknown): string {
  if (v === undefined) return 'Not set';
  if (v === null || v === '') return 'Empty';
  if (typeof v === 'boolean') return yesNo(v);
  if (Array.isArray(v)) return v.length ? v.map(scalarText).join(', ') : 'None';
  if (isObj(v)) return `${plain(Object.keys(v).length, 'property', 'properties')}`;
  return String(v);
}

const plain = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cut = (s: string, max = TEXT_MAX) => (s.length > max ? `${s.slice(0, max)}…` : s);

// An object in one line (list entries).
export function oneLine(v: unknown, names: IdNames = {}): string {
  if (!isObj(v)) return cut(scalarText(v));
  if (isElement(v)) {
    const bits = [elementType(v)];
    if (v.type === 'field') bits.push(v.required === true ? 'required' : 'optional');
    return `${str(v.label) ?? str(v.name)} (${bits.join(', ')})`;
  }
  if (isIndex(v)) return indexText(v);
  if (isIntegration(v)) return integrationText(v, names);
  if (isAttribute(v)) return `${v.name}: ${scalarText(v.values)}`;
  if (isPolicy(v)) return `${v.endpoint}: ${v.name}`;
  const label = str(v.name) ?? str(v.label) ?? str(v.title);
  const rest = props(v).filter(([k]) => !(label && (k === 'Name' || k === 'Label' || k === 'Title')));
  const detail = rest.slice(0, 3).map(([k, x]) => `${k}: ${x}`).join(', ');
  return cut(label ? (detail ? `${label} (${detail})` : label) : detail || '{}');
}

// An object's properties as label/value pairs, primitives first.
function props(v: Obj): Array<[string, string]> {
  const keys = Object.keys(v);
  const simple = keys.filter((k) => !isObj(v[k]) && !(Array.isArray(v[k]) && (v[k] as unknown[]).some(isObj)));
  const nested = keys.filter((k) => !simple.includes(k));
  return [...simple, ...nested].map((k) => {
    const x = v[k];
    const text = Array.isArray(x) && x.some(isObj) ? plain(x.length, 'entry', 'entries') : scalarText(x);
    return [humanize(k), cut(text, 80)];
  });
}

export function summarizeValue(v: unknown, names: IdNames = {}): ValueSummary {
  if (v === undefined) return { kind: 'empty', text: 'Not set' };
  if (v === null || v === '') return { kind: 'empty', text: 'Empty' };
  if (Array.isArray(v)) {
    if (!v.length) return { kind: 'empty', text: 'None' };
    if (!v.some((x) => isObj(x) || Array.isArray(x))) {
      const text = v.map(scalarText).join(', ');
      return { kind: 'text', text: cut(text), full: text.length <= TEXT_MAX };
    }
    return { kind: 'list', items: v.slice(0, LIST_MAX).map((x) => oneLine(x, names)), more: Math.max(0, v.length - LIST_MAX) };
  }
  if (isObj(v)) {
    if (isElement(v)) {
      const entries: Array<[string, string]> = [['Label', str(v.label) ?? str(v.name) ?? '—'], ['Type', elementType(v)]];
      if (v.type === 'field') entries.push(['Required', yesNo(v.required)]);
      if (str(v.name) && str(v.label) && v.name !== v.label) entries.push(['Name', String(v.name)]);
      return { kind: 'props', entries };
    }
    if (isIndex(v) || isIntegration(v) || isAttribute(v) || isPolicy(v)) return { kind: 'text', text: oneLine(v, names), full: false };
    const entries = props(v);
    if (!entries.length) return { kind: 'empty', text: 'Empty' };
    return { kind: 'props', entries: entries.slice(0, PROPS_MAX) };
  }
  const text = scalarText(v);
  return { kind: 'text', text: cut(text), full: text.length <= TEXT_MAX };
}

// Whether the row offers "Show full value": anything structured, or text that was cut.
export function hasFullValue(v: unknown, s: ValueSummary): boolean {
  if (s.kind === 'empty') return false;
  if (s.kind === 'text') return !s.full || (typeof v === 'object' && v !== null);
  return true;
}

// The full value: text as it is, anything else as pretty-printed JSON.
export function fullValueText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
