// The request handler: Host check on everything, the launch-key exchange,
// /api access control + JSON bodies (1 MB limit) + routing, and static files
// from webDir with an SPA fallback to index.html.
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, mapError, notFound } from './errors.ts';
import { checkApi, checkHost, safeEqual, sessionCookie } from './security.ts';
import type { Router } from './router.ts';
import { defaultLogger, type Logger } from './log.ts';

export const BODY_LIMIT = 1024 * 1024;

export interface HandlerOptions {
  key: string;
  port: () => number;
  router: Router;
  webDir?: string;
  logger?: Logger;
}

// Rejects before reading the body; the connection is closed afterwards.
class EarlyRejection extends ApiError {}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function sendJson(res: ServerResponse, status: number, json: unknown): void {
  const body = json === undefined ? '' : JSON.stringify(json);
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(req: IncomingMessage, res: ServerResponse, err: unknown, logger: Logger): void {
  const { status, body } = mapError(err);
  if (status >= 500) logger.error(`${req.method} ${(req.url ?? '').split('?')[0]}`, err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof EarlyRejection) {
    res.setHeader('connection', 'close');
    res.on('finish', () => req.destroy());
  }
  sendJson(res, status, body);
}

// Reads a JSON body; empty bodies give undefined. Oversized bodies are drained
// and rejected with 413.
export function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    return Promise.reject(new EarlyRejection(413, 'payload_too_large', 'Request body is larger than 1 MB.'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooBig = true;
      if (!tooBig) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooBig) return reject(new ApiError(413, 'payload_too_large', 'Request body is larger than 1 MB.'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, 'invalid_json', 'Request body is not valid JSON.'));
      }
    });
  });
}

function serveFile(res: ServerResponse, file: string, size: number, head: boolean): void {
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const cache = path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-length': size, 'cache-control': cache });
  if (head) res.end();
  else createReadStream(file).pipe(res);
}

function fileSize(file: string): number | null {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, webDir: string | undefined): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
  if (!webDir) throw notFound();
  const root = path.resolve(webDir);
  const decoded = decodePath(pathname);
  const target = path.resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + path.sep)) throw notFound();
  const head = req.method === 'HEAD';
  const size = target === root ? null : fileSize(target);
  if (size !== null) return serveFile(res, target, size, head);
  // SPA fallback for client routes (paths without a file extension).
  if (path.extname(decoded)) throw notFound();
  const index = path.join(root, 'index.html');
  const indexSize = fileSize(index);
  if (indexSize === null) throw notFound();
  serveFile(res, index, indexSize, head);
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw notFound();
  }
}

// Parses the request target without normalising it (so `..` can't be hidden
// by URL resolution) and refuses any `..` segment, raw or encoded.
function parseTarget(rawUrl: string): URL {
  if (!rawUrl.startsWith('/')) throw notFound();
  const rawPath = rawUrl.split('?')[0];
  if (decodePath(rawPath).split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) throw notFound();
  return new URL(`http://localhost${rawUrl}`);
}

export function createRequestHandler(opts: HandlerOptions) {
  const logger = opts.logger ?? defaultLogger;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      checkHost(req, opts.port());
      const url = parseTarget(req.url ?? '/');
      const { pathname } = url;

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        checkApi(req, opts.key, opts.port());
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await readJsonBody(req) : undefined;
        const m = opts.router.match(req.method ?? 'GET', pathname);
        if (!m) throw notFound('No such API endpoint.');
        if ('methodNotAllowed' in m) {
          res.setHeader('allow', m.allowed.join(', '));
          throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
        }
        const out = await m.handler({ req, res, params: m.params, query: url.searchParams, body });
        if (out) sendJson(res, out.status ?? 200, out.json);
        return;
      }

      // Launch: exchange the key from the printed URL for the session cookie.
      if (pathname === '/' && url.searchParams.has('key')) {
        if (!safeEqual(url.searchParams.get('key') ?? '', opts.key)) throw new ApiError(403, 'forbidden', 'Invalid launch key.');
        res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': sessionCookie(opts.key, opts.port()), location: '/', 'cache-control': 'no-store' });
        res.end();
        return;
      }

      serveStatic(req, res, pathname, opts.webDir);
    } catch (err) {
      sendError(req, res, err, logger);
    }
  };
}
