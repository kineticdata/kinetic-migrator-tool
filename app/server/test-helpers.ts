// Test helpers: raw HTTP requests against a started server (node:http, so the
// Host header can be set freely, which fetch forbids).
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type ServerHandle, type StartServerOptions } from './main.ts';
import { MemoryStore } from './secrets.ts';

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

// A new connection per request: a kept-alive socket the server already closed
// (after a long pause on a slow runner) would fail with ECONNRESET.
export function request(port: number, pathname: string, opts: RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: opts.method ?? 'GET', agent: false, headers: { host: `localhost:${port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export interface TestServer extends ServerHandle {
  key: string;
  cookie: string;
  // Headers that pass every /api check.
  good: Record<string, string>;
  api: (pathname: string, opts?: RequestOptions) => Promise<RawResponse>;
  cleanup: () => Promise<void>;
}

export async function startTestServer(opts: Partial<StartServerOptions> = {}): Promise<TestServer> {
  const workspace = mkdtempSync(path.join(tmpdir(), 'km-ws-'));
  // Session memory by default: tests never touch the OS keychain.
  const server = await startServer({ workspace, secrets: new MemoryStore(), ...opts });
  const key = new URL(server.url).searchParams.get('key') ?? '';
  const cookie = `km_session_${server.port}=${key}`;
  const good = { cookie, 'x-kinetic-migrate': '1' };
  return {
    ...server,
    key,
    cookie,
    good,
    api: (pathname, o = {}) => request(server.port, pathname, { ...o, headers: { ...good, ...o.headers } }),
    cleanup: async () => {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
