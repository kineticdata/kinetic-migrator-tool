// Server entry point: startServer() wires security, routing, jobs and static
// files on 127.0.0.1. Dependencies (workspace, secrets store, client factory)
// are injected so tests can run against fakes.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '../shared/api.ts';
import pkg from '../../package.json' with { type: 'json' };
import { HOST, DEV_PORT } from './config.ts';
import { createRequestHandler } from './http.ts';
import { JobRegistry, registerJobRoutes } from './jobs.ts';
import { Router } from './router.ts';
import { generateKey } from './security.ts';
import type { ClientFactory } from './engine.ts';
import { registerProjectRoutes, upgradeWorkspace } from './projects.ts';
import { registerSyncRoutes } from './sync-routes.ts';
import { registerRepositoryRoutes } from './repository.ts';
import { createDefaultStore, DeferredStore, type SecretStore } from './secrets.ts';
import { defaultLogger, type Logger } from './log.ts';
import { fakeMode } from './fake-mode.ts';

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
  // Fake mode without the environment variable (`kinetic-migrate ui --fake`).
  fake?: boolean;
}

export interface ServerContext {
  workspace: string;
  secrets: SecretStore;
  clientFactory?: ClientFactory;
  jobs: JobRegistry;
  router: Router;
  logger?: Logger;
}

export interface ServerHandle {
  url: string;
  port: number;
  // True when KINETIC_MIGRATE_FAKE=1 put the server on synthetic spaces.
  fake: boolean;
  // Settles when the workspace's projects are on the current file layout.
  upgraded: Promise<void>;
  jobs: JobRegistry;
  router: Router;
  close(): Promise<void>;
}

export function buildRouter(ctx: Omit<ServerContext, 'router'>): Router {
  const router = new Router();
  router.get('/api/session', async () => {
    // A keychain still being probed gets a few seconds to report.
    const ready = (ctx.secrets as { ready?: () => Promise<void> }).ready;
    if (ready) await Promise.race([ready.call(ctx.secrets), new Promise((r) => { setTimeout(r, 3000).unref(); })]);
    const session: SessionInfo = { version: VERSION, workspace: ctx.workspace, keychain: { available: Boolean(ctx.secrets.persistent) } };
    return { json: session };
  });
  registerJobRoutes(router, ctx.jobs);
  registerProjectRoutes(router, ctx);
  registerSyncRoutes(router, ctx);
  registerRepositoryRoutes(router, ctx);
  return router;
}

function defaultWebDir(): string | undefined {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  return existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const key = generateKey();
  const logger = opts.logger ?? defaultLogger;
  const jobs = new JobRegistry({ logger });
  const workspace = path.resolve(opts.workspace);
  // Fake mode only fills in what the caller did not inject.
  const fake = opts.clientFactory || opts.secrets ? undefined : fakeMode(opts.fake ? { KINETIC_MIGRATE_FAKE: '1' } : process.env);
  // Chosen in the background: the server listens without waiting for the keychain probe.
  const secrets: SecretStore = opts.secrets ?? fake?.secrets ?? new DeferredStore(() => createDefaultStore((m) => process.stderr.write(`[kinetic-migrate] ${m}\n`)));
  const clientFactory = opts.clientFactory ?? fake?.clientFactory;
  // Built bundle: dist/server.mjs serves dist/web next to itself.
  const webDir = opts.webDir ?? defaultWebDir();
  const router = buildRouter({ workspace, secrets, clientFactory, jobs, logger });
  let port = 0;
  const server = http.createServer(createRequestHandler({ key, port: () => port, router, webDir, logger }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const upgraded = upgradeWorkspace(workspace, (id, err) => logger.error(`Could not upgrade the file layout of project ${id}`, err));
  return {
    upgraded,
    url: `http://localhost:${port}/?key=${key}`,
    port,
    fake: Boolean(fake),
    jobs,
    router,
    close: () => new Promise<void>((resolve, reject) => {
      jobs.abortAll();
      secrets.close?.();
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Run directly (not imported)? Windows paths compare without case: the drive
// letter in argv can differ from the one in import.meta.url.
export function isMainModule(moduleUrl: string, argv1: string | undefined, platform: string = process.platform): boolean {
  if (!argv1) return false;
  const a = fileURLToPath(moduleUrl);
  const b = path.resolve(argv1);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const dev = args.includes('--dev');
  const portArg = argValue(args, '--port');
  const handle = await startServer({
    workspace: argValue(args, '--workspace') ?? process.cwd(),
    port: portArg ? Number(portArg) : dev ? DEV_PORT : 0,
    webDir: argValue(args, '--web-dir'),
    fake: args.includes('--fake'),
  });
  console.log(`kinetic-migrate is running at ${handle.url}`);
  if (handle.fake) console.log('Fake mode: synthetic dev and test spaces, nothing leaves this machine.');
}
