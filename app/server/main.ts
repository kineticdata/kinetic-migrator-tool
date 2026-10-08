// Server entry point: startServer() wires security, routing, jobs and static
// files on 127.0.0.1. Dependencies (workspace, secrets store, client factory)
// are injected so tests can run against fakes.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { SessionInfo } from '../shared/api.ts';
import pkg from '../../package.json' with { type: 'json' };
import { HOST, DEV_PORT } from './config.ts';
import { createRequestHandler } from './http.ts';
import { JobRegistry, registerJobRoutes } from './jobs.ts';
import { Router } from './router.ts';
import { generateKey } from './security.ts';
import type { ClientFactory } from './engine.ts';
import { registerProjectRoutes } from './projects.ts';
import { createDefaultStore, type SecretStore } from './secrets.ts';
import { defaultLogger, type Logger } from './log.ts';

export const VERSION: string = pkg.version;

// The secrets store moved to secrets.ts; the old name stays as an alias.
export type { SecretStore as SecretsStore } from './secrets.ts';
export type { ClientFactory } from './engine.ts';

export interface StartServerOptions {
  workspace: string;
  port?: number;
  webDir?: string;
  // Defaults to the OS keychain when available, else session memory.
  secrets?: SecretStore;
  clientFactory?: ClientFactory;
  logger?: Logger;
}

export interface ServerContext {
  workspace: string;
  secrets: SecretStore;
  clientFactory?: ClientFactory;
  jobs: JobRegistry;
  router: Router;
}

export interface ServerHandle {
  url: string;
  port: number;
  jobs: JobRegistry;
  router: Router;
  close(): Promise<void>;
}

export function buildRouter(ctx: Omit<ServerContext, 'router'>): Router {
  const router = new Router();
  router.get('/api/session', () => {
    const session: SessionInfo = { version: VERSION, workspace: ctx.workspace, keychain: { available: Boolean(ctx.secrets.persistent) } };
    return { json: session };
  });
  registerJobRoutes(router, ctx.jobs);
  registerProjectRoutes(router, ctx);
  return router;
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const key = generateKey();
  const logger = opts.logger ?? defaultLogger;
  const jobs = new JobRegistry({ logger });
  const workspace = path.resolve(opts.workspace);
  const secrets = opts.secrets ?? await createDefaultStore();
  const router = buildRouter({ workspace, secrets, clientFactory: opts.clientFactory, jobs });
  let port = 0;
  const server = http.createServer(createRequestHandler({ key, port: () => port, router, webDir: opts.webDir, logger }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}/?key=${key}`,
    port,
    jobs,
    router,
    close: () => new Promise<void>((resolve, reject) => {
      jobs.abortAll();
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const dev = args.includes('--dev');
  const portArg = argValue(args, '--port');
  const handle = await startServer({
    workspace: argValue(args, '--workspace') ?? process.cwd(),
    port: portArg ? Number(portArg) : dev ? DEV_PORT : 0,
    webDir: argValue(args, '--web-dir'),
  });
  console.log(`kinetic-migrate is running at ${handle.url}`);
}
