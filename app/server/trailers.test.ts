// Commit message trailers and the secret scrubber.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitMessage, parseMessage } from './trailers.ts';
import { makeScrubber } from './scrub.ts';

test('commit messages round-trip title, body and trailers', () => {
  const m = commitMessage('Snapshot of Dev', { Environment: 'dev', Run: null, Plan: 'p\n1' }, 'Drifted: 1\nteams/Ops');
  assert.equal(m, 'Snapshot of Dev\n\nDrifted: 1\nteams/Ops\n\nEnvironment: dev\nPlan: p 1');
  assert.deepEqual(parseMessage(m), { title: 'Snapshot of Dev', body: 'Drifted: 1\nteams/Ops', trailers: { Environment: 'dev', Plan: 'p 1' } });
  assert.deepEqual(parseMessage('Created project X'), { title: 'Created project X', body: '', trailers: {} });
});

test('the scrubber masks known secrets in nested strings only', () => {
  const scrub = makeScrubber(['s3cret-value', '', 'ab', undefined]);
  assert.deepEqual(scrub({ a: ['x s3cret-value y', 3], b: { c: 's3cret-value' }, ab: 'ab' }), { a: ['x •••• y', 3], b: { c: '••••' }, ab: 'ab' });
});
