// Test helper: a fetch stub that routes `METHOD /path` to handlers and
// records every call, so web tests run against a mocked API.
import { vi } from 'vitest';

export interface MockCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
  headers: Record<string, string>;
}

export type MockReply =
  | { status?: number; json?: unknown }
  | { status?: number; sse: string };

export type MockHandler = (call: MockCall, params: Record<string, string>) => MockReply | Promise<MockReply> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: MockHandler;
}

function compile(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const src = path.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { pattern: new RegExp(`^${src}$`), names };
}

// Formats SSE frames the way the server does.
export function sse(events: Array<{ type: string; data: unknown }>, end: string | null = 'succeeded'): string {
  let out = '';
  events.forEach((e, i) => {
    out += `id: ${i + 1}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
  });
  if (end) out += `event: end\ndata: ${JSON.stringify({ status: end })}\n\n`;
  return out;
}

const isReply = (v: unknown): v is MockReply => typeof v === 'object' && v !== null && ('json' in v || 'sse' in v || 'status' in v) && Object.keys(v).every((k) => ['json', 'sse', 'status'].includes(k));

export function mockApi(routes: Record<string, MockHandler | unknown>) {
  const table: Route[] = Object.entries(routes).map(([spec, handler]) => {
    const [method, path] = spec.split(' ');
    return { method, ...compile(path), handler: typeof handler === 'function' ? (handler as MockHandler) : () => handler };
  });
  const calls: MockCall[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: MockCall = { method, path: url.pathname, search: url.search, body, headers };
    calls.push(call);
    for (const r of table) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(call, params);
      if (out instanceof Response) return out;
      const reply: MockReply = isReply(out) ? out : { json: out };
      if ('sse' in reply) {
        return new Response(reply.sse, { status: reply.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const status = reply.status ?? 200;
      return new Response(reply.json === undefined ? '' : JSON.stringify(reply.json), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: `No mock for ${method} ${url.pathname}` } }), { status: 404 });
  });

  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetch: fetchMock,
    callsTo: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}
