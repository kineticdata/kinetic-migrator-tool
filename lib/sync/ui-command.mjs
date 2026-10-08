// `kinetic-migrate ui`: start the local web UI server and open the browser.
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseUiArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { workspace: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
    allowPositionals: false,
  });
  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number from 0 to 65535 (got "${values.port}")`);
  }
  return { workspace: values.workspace ?? join(homedir(), 'KineticMigrate'), port, open: !values['no-open'] };
}

// Launcher command for a platform. Always an argv array, never a shell string.
export function openCommand(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url, platform = process.platform) {
  const [cmd, args] = openCommand(platform, url);
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(err ?? null));
  });
}

// Injected: loadServer (imports dist/server.mjs), openBrowser, built, webDir, log.
export async function runUi({ argv, loadServer, openBrowser: open = openBrowser, built, webDir, log }) {
  const opts = parseUiArgs(argv);
  if (!built) {
    log('The web UI has not been built in this checkout.');
    log('For development, run `npm run dev` (web) and `npm run dev:server` (server).');
    log('To use the built UI, run `npm run build` first.');
    return 1;
  }
  const { startServer } = await loadServer();
  const handle = await startServer({ workspace: opts.workspace, port: opts.port, webDir });
  log(`kinetic-migrate is running at ${handle.url}`);
  log(`Workspace: ${opts.workspace}. Press Ctrl+C to stop.`);
  if (handle.fake) log('Fake mode (KINETIC_MIGRATE_FAKE=1): synthetic dev and test spaces; no live server is contacted.');
  if (opts.open) {
    const err = await open(handle.url);
    if (err) log('Could not open a browser automatically; open the address above.');
  }
  return 0;
}
