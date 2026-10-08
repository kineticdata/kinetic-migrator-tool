import { describe, expect, it } from 'vitest';
import { segmentLabel } from './key-label';

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
