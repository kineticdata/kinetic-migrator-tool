// API client: the CSRF header, JSON bodies, plain error messages and SSE parsing.
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, api, parseSse, streamJobEvents } from './client';
import { mockApi, sse } from '../test/mock-api';

afterEach(() => vi.unstubAllGlobals());

test('sends the X-Kinetic-Migrate header and JSON bodies', async () => {
  const m = mockApi({ 'POST /api/projects': (c: { body: unknown }) => ({ status: 201, json: { echo: c.body } }) });
  const out = await api.post<{ echo: unknown }>('/api/projects', { name: 'X' });
  expect(out.echo).toEqual({ name: 'X' });
  const [call] = m.calls;
  expect(call.headers['x-kinetic-migrate']).toBe('1');
  expect(call.headers['content-type']).toContain('application/json');
});

test('turns error bodies into an ApiError with the plain message', async () => {
  mockApi({ 'GET /api/projects/:p': { status: 404, json: { error: { code: 'not_found', message: 'No such project.' } } } });
  const err = await api.get('/api/projects/x').catch((e: unknown) => e) as ApiError;
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(404);
  expect(err.message).toBe('No such project.');
});

test('parseSse splits frames and keeps the incomplete rest', () => {
  const { events, rest } = parseSse('event: progress\ndata: {"done":1}\n\nevent: item\ndata: {"k');
  expect(events).toEqual([{ type: 'progress', data: { done: 1 } }]);
  expect(rest).toBe('event: item\ndata: {"k');
});

test('streamJobEvents reads events with the header and stops at end', async () => {
  const m = mockApi({
    'GET /api/jobs/:id/events': { sse: sse([{ type: 'progress', data: { type: 'progress', done: 1, total: 2 } }], 'succeeded') },
  });
  const seen: string[] = [];
  const end = await streamJobEvents('j1', (e) => seen.push(e.type));
  expect(seen).toEqual(['progress']);
  expect(end).toEqual({ status: 'succeeded' });
  expect(m.calls[0].headers['x-kinetic-migrate']).toBe('1');
});
