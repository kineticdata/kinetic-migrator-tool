import { describe, expect, it } from 'vitest';
import { entryItemKey, entryLabel, isEntryKey, segmentLabel } from './key-label';
import { ancestorsOf, kindOfKey, sectionOf } from './tree-layout';

describe('segmentLabel', () => {
  it('decodes the engine file-name escapes and keeps a literal %', () => {
    expect(segmentLabel('Departments%3A%3AIT')).toBe('Departments::IT');
    expect(segmentLabel('100% %2F 2')).toBe('100% / 2');
    expect(segmentLabel('%63on')).toBe('con');
    expect(segmentLabel('IT Request')).toBe('IT Request');
  });
  it('shows a shortened name with an ellipsis', () => {
    expect(segmentLabel('Notify approver and update%~0a1b2c3d')).toBe('Notify approver and update…');
  });
});

describe('Task categories', () => {
  it('a category member is an entry of its category (a name may hold "#")', () => {
    const key = 'task-categories/A#B#handlers/mail_send_v1';
    expect(isEntryKey(key)).toBe(true);
    expect(entryItemKey(key)).toBe('task-categories/A#B');
    expect(entryLabel(key)).toBe('mail_send_v1 (handler)');
    expect(entryLabel('task-categories/N#routines/routine_x_v1')).toBe('routine_x_v1 (routine)');
    expect(isEntryKey('task-categories/A#B')).toBe(false);
    expect(kindOfKey(key)).toBe('task-category');
  });
  it('sit in their own section of the tree', () => {
    expect(sectionOf('task-categories/Notifications')).toBe('group:task-categories');
    expect(ancestorsOf('task-categories/Notifications')).toEqual(['group:task-categories']);
    expect(kindOfKey('task-categories/Notifications')).toBe('task-category');
  });
});
