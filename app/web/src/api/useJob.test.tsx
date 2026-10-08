// useJob: collects SSE events, fetches the result at the end and invalidates
// the related queries so nothing is stale after a job.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useJob } from './useJob';
import { mockApi, sse } from '../test/mock-api';
import { testQueryClient } from '../test/render';

afterEach(() => vi.unstubAllGlobals());

test('collects events, loads the result and invalidates queries on completion', async () => {
  mockApi({
    'GET /api/jobs/:id/events': {
      sse: sse([
        { type: 'progress', data: { type: 'progress', phase: 'export', done: 1, total: 4 } },
        { type: 'progress', data: { type: 'progress', phase: 'export', done: 4, total: 4 } },
      ]),
    },
    'GET /api/jobs/:id': { id: 'j1', kind: 'snapshot', status: 'succeeded', createdAt: 'x', result: { total: 4 } },
  });
  const client = testQueryClient();
  client.setQueryData(['project', 'p1'], { stale: true });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const onDone = vi.fn();
  const { result } = renderHook(() => useJob('j1', { invalidate: [['project', 'p1']], onDone }), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('succeeded'));
  expect(result.current.events).toHaveLength(2);
  expect(result.current.progress).toEqual({ phase: 'export', done: 4, total: 4 });
  expect(result.current.result).toEqual({ total: 4 });
  expect(client.getQueryState(['project', 'p1'])?.isInvalidated).toBe(true);
  expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
});

test('reports a failed job with its plain message', async () => {
  mockApi({
    'GET /api/jobs/:id/events': { sse: sse([], 'failed') },
    'GET /api/jobs/:id': { id: 'j2', kind: 'snapshot', status: 'failed', createdAt: 'x', error: { code: 'http', message: 'Could not sign in.' } },
  });
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useJob('j2'), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('failed'));
  expect(result.current.error).toBe('Could not sign in.');
});
