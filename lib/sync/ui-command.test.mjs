import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseUiArgs, runUi, openCommand } from './ui-command.mjs';

test('parseUiArgs defaults and flags', () => {
  assert.deepEqual(parseUiArgs([]), { workspace: join(homedir(), 'KineticMigrate'), port: undefined, open: true });
  const o = parseUiArgs(['--workspace', '/tmp/ws', '--port', '4000', '--no-open']);
  assert.deepEqual(o, { workspace: '/tmp/ws', port: 4000, open: false });
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
    built: true, webDir: '/x/web', log: (m) => lines.push(m),
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
    openBrowser: async () => { opened = true; }, built: true, log: () => {},
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
    argv: ['--no-open'], built: true, log: (m) => lines.push(m),
    loadServer: async () => ({ startServer: async () => ({ url: 'http://localhost:1/?key=k', fake: true }) }),
  });
  assert.match(lines.join('\n'), /fake mode/i);
  const quiet = [];
  await runUi({
    argv: ['--no-open'], built: true, log: (m) => quiet.push(m),
    loadServer: async () => ({ startServer: async () => ({ url: 'http://localhost:1/?key=k', fake: false }) }),
  });
  assert.doesNotMatch(quiet.join('\n'), /fake mode/i);
});

test('openCommand uses platform launchers without a shell', () => {
  assert.deepEqual(openCommand('darwin', 'u'), ['open', ['u']]);
  assert.deepEqual(openCommand('linux', 'u'), ['xdg-open', ['u']]);
  assert.deepEqual(openCommand('win32', 'u'), ['cmd', ['/c', 'start', '', 'u']]);
});
