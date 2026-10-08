import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseUiArgs, runUi, openCommand, openBrowser, stopOnSignals, isSyncedFolder } from './ui-command.mjs';

test('parseUiArgs defaults and flags', () => {
  assert.deepEqual(parseUiArgs([]), { workspace: join(homedir(), 'KineticMigrate'), port: undefined, open: true, fake: false });
  const o = parseUiArgs(['--workspace', '/tmp/ws', '--port', '4000', '--no-open', '--fake']);
  assert.deepEqual(o, { workspace: '/tmp/ws', port: 4000, open: false, fake: true });
  // A Windows path with spaces and non-ASCII letters passes through untouched.
  assert.equal(parseUiArgs(['--workspace', 'C:\\Users\\José Núñez\\Kinetic Projects']).workspace, 'C:\\Users\\José Núñez\\Kinetic Projects');
  assert.throws(() => parseUiArgs(['--port', 'abc']), /--port/);
  assert.throws(() => parseUiArgs(['--port', '70000']), /--port/);
});

test('runUi calls startServer with options, opens the browser, prints the URL', async () => {
  const calls = {};
  const lines = [];
  const code = await runUi({
    argv: ['--workspace', '/tmp/ws', '--port', '4001'],
    loadServer: async () => ({ startServer: async (o) => { calls.start = o; return { url: 'http://localhost:4001/?key=abc' }; } }),
    openBrowser: async (u) => { calls.open = u; },
    built: true, webDir: '/x/web', log: (m) => lines.push(m), onStarted: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.start, { workspace: '/tmp/ws', port: 4001, webDir: '/x/web' });
  assert.equal(calls.open, 'http://localhost:4001/?key=abc');
  assert.ok(lines.some((l) => l.includes('http://localhost:4001/?key=abc')));
  assert.equal(lines.filter((l) => l.includes('key=abc')).length, 1);
});

test('runUi with --no-open does not open; dev checkout prints instructions', async () => {
  let opened = false;
  await runUi({
    argv: ['--no-open'],
    loadServer: async () => ({ startServer: async () => ({ url: 'http://localhost:1/?key=k' }) }),
    openBrowser: async () => { opened = true; }, built: true, log: () => {}, onStarted: () => {},
  });
  assert.equal(opened, false);
  const lines = [];
  const code = await runUi({ argv: [], built: false, log: (m) => lines.push(m) });
  assert.equal(code, 1);
  assert.ok(lines.join('\n').includes('npm run dev'));
});

test('runUi says when the server runs in fake mode', async () => {
  const lines = [];
  await runUi({
    argv: ['--no-open'], built: true, log: (m) => lines.push(m), onStarted: () => {},
    loadServer: async () => ({ startServer: async () => ({ url: 'http://localhost:1/?key=k', fake: true }) }),
  });
  assert.match(lines.join('\n'), /fake mode/i);
  const quiet = [];
  await runUi({
    argv: ['--no-open'], built: true, log: (m) => quiet.push(m), onStarted: () => {},
    loadServer: async () => ({ startServer: async () => ({ url: 'http://localhost:1/?key=k', fake: false }) }),
  });
  assert.doesNotMatch(quiet.join('\n'), /fake mode/i);
});

const URL_ = 'http://localhost:51234/?key=AbC-_9&x=%41';

test('openCommand uses platform launchers without a shell', () => {
  assert.deepEqual(openCommand('darwin', URL_), ['open', [URL_]]);
  assert.deepEqual(openCommand('linux', URL_), ['xdg-open', [URL_]]);
});

test('on Windows the browser opens through url.dll, never cmd.exe (cmd would split the URL at & and expand %...%)', () => {
  const [cmd, args] = openCommand('win32', URL_, { SystemRoot: 'C:\\Windows' });
  assert.equal(cmd, 'C:\\Windows\\System32\\rundll32.exe');
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', URL_]);
  assert.ok(!/cmd(\.exe)?$/i.test(cmd));
  assert.equal(openCommand('win32', URL_, {})[0], 'rundll32.exe');
  // The URL is one argument without spaces or quotes, so it reaches the
  // handler exactly as given (Windows argument quoting adds nothing).
  assert.doesNotMatch(args[1], /[\s"]/);
});

test('openCommand refuses anything but a plain http(s) URL', () => {
  for (const bad of ['file:///C:/Windows/system.ini', 'http://x/ y', 'http://x/"&calc', 'javascript:alert(1)']) {
    assert.throws(() => openCommand('win32', bad), /http/);
  }
});

test('openBrowser runs the launcher hidden, without a shell, and reports failure instead of throwing', async () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(null); };
  assert.equal(await openBrowser(URL_, 'win32', run), null);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.shell, undefined);
  const failing = (cmd, args, opts, cb) => cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.match(String(await openBrowser(URL_, 'linux', failing)), /ENOENT/);
  assert.ok(await openBrowser('file:///x', 'win32', run) instanceof Error);
});

function fakeProcess(platform) {
  const p = new EventEmitter();
  p.platform = platform;
  p.exits = [];
  p.exit = (code) => { p.exits.push(code); };
  return p;
}

test('Ctrl+C stops the server cleanly; Windows listens for SIGINT and SIGBREAK (it never sends SIGTERM)', async () => {
  for (const [platform, expected] of [['win32', ['SIGINT', 'SIGBREAK']], ['darwin', ['SIGINT', 'SIGTERM']], ['linux', ['SIGINT', 'SIGTERM']]]) {
    const proc = fakeProcess(platform);
    let closed = 0;
    assert.deepEqual(stopOnSignals({ close: async () => { closed++; } }, { proc }), expected);
    proc.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1, platform);
    assert.deepEqual(proc.exits, [0]);
    proc.emit(expected[1]);
    assert.deepEqual(proc.exits, [0, 130], 'a second signal exits at once');
  }
});

test('runUi passes --fake to the server (no environment variable needed on cmd.exe)', async () => {
  let opts;
  await runUi({
    argv: ['--no-open', '--fake'], built: true, log: () => {}, onStarted: () => {},
    loadServer: async () => ({ startServer: async (o) => { opts = o; return { url: 'http://localhost:1/?key=k', fake: true }; } }),
  });
  assert.equal(opts.fake, true);
});

test('a workspace in a cloud-synced folder is noticed (OneDrive-redirected profiles on Windows)', async () => {
  assert.equal(isSyncedFolder('C:\\Users\\Ana\\OneDrive - Contoso\\KineticMigrate'), true);
  assert.equal(isSyncedFolder('C:\\Users\\Ana\\OneDrive\\Documents\\km'), true);
  assert.equal(isSyncedFolder('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/km'), true);
  assert.equal(isSyncedFolder('C:\\Users\\José Núñez\\KineticMigrate'), false);
  assert.equal(isSyncedFolder('/home/ana/KineticMigrate'), false);
  const lines = [];
  await runUi({
    argv: ['--no-open', '--workspace', 'C:\\Users\\Ana\\OneDrive\\km'], built: true, log: (m) => lines.push(m), onStarted: () => {},
    loadServer: async () => ({ startServer: async () => ({ url: 'http://localhost:1/?key=k' }) }),
  });
  assert.match(lines.join('\n'), /cloud-synced/);
});
