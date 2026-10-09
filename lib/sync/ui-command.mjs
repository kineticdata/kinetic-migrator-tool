// `kinetic-migrate ui`: start the local web UI server and open the browser.
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Demo mode keeps its projects out of the real workspace: they live in a
// throwaway folder unless --workspace says otherwise.
export const DEMO_WORKSPACE = join(tmpdir(), 'kinetic-migrator-demo');

export function parseUiArgs(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, fake: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number from 0 to 65535 (got "${values.port}")`);
  }
  // The profile folder, not Documents: OneDrive's folder backup often moves
  // Documents, and syncing a git repository there locks and conflicts files.
  const fake = values.fake === true;
  const demo = fake || env.KINETIC_MIGRATE_FAKE === '1';
  return { workspace: values.workspace ?? (demo ? DEMO_WORKSPACE : join(homedir(), 'KineticMigrate')), port, open: !values['no-open'], fake };
}

// A cloud-synced folder (OneDrive, Dropbox, iCloud Drive, Google Drive) holds
// files open and syncs .git internals mid-write.
export const isSyncedFolder = (dir) => /[\\/](OneDrive|Dropbox|iCloud ?Drive|Mobile Documents|Google ?Drive)([ \-][^\\/]*)?([\\/]|$)/i.test(dir);

// Launcher command for a platform. Always an argv array, never a shell string.
// On Windows, `start` is a cmd.exe builtin and cmd would split the URL at `&`
// or expand `%...%`. Explorer opens a URL in the default browser with no
// shell parsing (rundll32 url.dll,FileProtocolHandler would too, but
// endpoint-security tools flag that pattern). Explorer exits 1 even when it
// worked, so its exit code is ignored.
export function openCommand(platform, url, env = process.env) {
  if (!/^https?:\/\/[^\s"]+$/.test(url)) throw new Error('Only an http(s) address without spaces or quotes can be opened');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT;
    return [root ? `${root}\\explorer.exe` : 'explorer.exe', [url]];
  }
  return ['xdg-open', [url]];
}

export function openBrowser(url, platform = process.platform, run = execFile) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    try {
      [cmd, args] = openCommand(platform, url);
    } catch (err) {
      return resolve(err);
    }
    run(cmd, args, { windowsHide: true, timeout: 15_000 }, (err) => {
      // Explorer's exit code says nothing; only a failure to start counts.
      if (platform === 'win32' && err && typeof err.code !== 'string') return resolve(null);
      resolve(err ?? null);
    });
  });
}

// Ctrl+C (SIGINT on every OS, SIGBREAK for Ctrl+Break on Windows) and SIGTERM
// (macOS and Linux only; Windows never sends it) stop the server cleanly; a
// second signal exits at once.
export function stopOnSignals(handle, { proc = process, log = () => {} } = {}) {
  const signals = proc.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  let stopping = false;
  const onSignal = () => {
    if (stopping) return proc.exit(130);
    stopping = true;
    log('Stopping Kinetic Migrator…');
    Promise.resolve(handle.close?.()).catch(() => {}).finally(() => proc.exit(0));
  };
  for (const s of signals) proc.on(s, onSignal);
  return signals;
}

// Injected: loadServer (imports dist/server.mjs), openBrowser, built, webDir, log.
export async function runUi({ argv, loadServer, openBrowser: open = openBrowser, built, webDir, log, onStarted = (h) => stopOnSignals(h, { log }) }) {
  const opts = parseUiArgs(argv);
  if (!built) {
    log('The web UI has not been built in this checkout.');
    log('For development, run `npm run dev` (web) and `npm run dev:server` (server).');
    log('To use the built UI, run `npm run build` first.');
    return 1;
  }
  const { startServer } = await loadServer();
  const handle = await startServer({ workspace: opts.workspace, port: opts.port, webDir, ...(opts.fake ? { fake: true } : {}) });
  onStarted(handle);
  log(`Kinetic Migrator is running at ${handle.url}`);
  log(`Workspace: ${opts.workspace}. Press Ctrl+C to stop.`);
  if (handle.logFile) log(`Log file: ${handle.logFile}`);
  if (isSyncedFolder(opts.workspace)) {
    log('Note: the workspace is in a cloud-synced folder; syncing can lock project files mid-write. A local folder (--workspace) is safer.');
  }
  if (handle.fake) log('Fake mode (--fake or KINETIC_MIGRATE_FAKE=1): synthetic dev and test spaces; no live server is contacted.');
  if (opts.open) {
    const err = await open(handle.url);
    if (err) log('Could not open a browser automatically; open the address above.');
  }
  return 0;
}
