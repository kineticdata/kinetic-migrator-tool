// A tiny method + path-pattern router. Patterns use `:name` segments.
// Handlers return `{ status?, json }`, or `undefined` when they wrote the
// response themselves (for example Server-Sent Events).
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface RouteResult {
  status?: number;
  json: unknown;
}

export type Handler = (ctx: RouteContext) => Promise<RouteResult | undefined> | RouteResult | undefined;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export type Match =
  | { handler: Handler; params: Record<string, string> }
  | { methodNotAllowed: true; allowed: string[] };

const split = (p: string) => p.split('/').filter(Boolean);

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg.startsWith(':')) {
      try {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (seg !== parts[i]) return null;
  }
  return params;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  get(pattern: string, h: Handler) { return this.add('GET', pattern, h); }
  post(pattern: string, h: Handler) { return this.add('POST', pattern, h); }
  put(pattern: string, h: Handler) { return this.add('PUT', pattern, h); }
  delete(pattern: string, h: Handler) { return this.add('DELETE', pattern, h); }

  match(method: string, pathname: string): Match | null {
    const parts = split(pathname);
    const allowed: string[] = [];
    for (const r of this.routes) {
      const params = matchSegments(r.segments, parts);
      if (!params) continue;
      if (r.method === method.toUpperCase()) return { handler: r.handler, params };
      allowed.push(r.method);
    }
    return allowed.length ? { methodNotAllowed: true, allowed } : null;
  }
}
