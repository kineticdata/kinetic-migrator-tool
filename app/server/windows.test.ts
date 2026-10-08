// Windows behaviour pinned on every OS: Windows path rules through path.win32,
// Windows-style paths (drive letters, backslashes, spaces, non-ASCII user
// names, UNC), reserved device names and files edited on Windows (BOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { staticTarget } from './http.ts';
import { isSafeEntryName } from './pinned.ts';
import { samePath, slugify } from './projects.ts';
import { isMainModule } from './main.ts';
import { readJsonFile } from './project-meta.ts';
import { validateEnvName } from './engine.ts';
import { inLayout } from './repo.ts';

const ROOT = 'C:\\Users\\José Núñez\\AppData\\Roaming\\npm\\node_modules\\kinetic-migrate\\dist\\web';

test('static files: Windows traversal through backslashes, drive letters and UNC prefixes stays inside the web folder', () => {
  const w = path.win32;
  assert.equal(staticTarget(ROOT, '/assets/app.js', w), `${ROOT}\\assets\\app.js`);
  assert.equal(staticTarget(ROOT, '/', w), null);
  for (const evil of ['/..\\..\\Windows\\win.ini', '/assets/..\\..\\..\\secret.txt', '/\\..\\x']) {
    assert.equal(staticTarget(ROOT, evil, w), 'outside', evil);
  }
  // Drive letters, NTFS streams and device names never name a file to serve.
  for (const odd of ['/C:/Windows/win.ini', '/C:\\Windows\\win.ini', '/index.html::$DATA', '/assets/app.js:secret', '/CON', '/assets/nul.js', '/com1.txt', '/index.html.', '/index.html ']) {
    assert.equal(staticTarget(ROOT, odd, w), null, odd);
  }
  // A leading // stays relative to the web folder, never a \\server\share path.
  const unc = staticTarget(ROOT, '//evil-host/share/x.js', w);
  assert.ok(typeof unc === 'string' && unc.startsWith(`${ROOT}\\`), String(unc));
  assert.equal(staticTarget('/srv/web', '/a/b.css', path.posix), '/srv/web/a/b.css');
  assert.equal(staticTarget('/srv/web', '/../etc/passwd', path.posix), 'outside');
});

test('pinned trees: entry names with a Windows separator, a drive colon or dot segments are never written', () => {
  for (const ok of ['space.json', 'package.zip', 'Departments%3A%3AIT.json', 'José.json', '%63on']) assert.equal(isSafeEntryName(ok), true, ok);
  for (const bad of ['..', '.', '', 'a/b', '..\\..\\evil', 'evil\\x', 'C:evil', 'x:stream', 'a\0b']) assert.equal(isSafeEntryName(bad), false, JSON.stringify(bad));
});

test('the same folder is recognised however Windows spells it', () => {
  assert.equal(samePath('C:\\Users\\Ana\\KineticMigrate\\demo', 'c:\\users\\ana\\kineticmigrate\\Demo', 'win32'), true);
  assert.equal(samePath('C:\\Users\\Ana\\Kinetic Projects\\demo\\', 'C:/Users/Ana/Kinetic Projects/demo', 'win32'), true);
  assert.equal(samePath('C:\\Users\\Ana\\demo', 'D:\\Users\\Ana\\demo', 'win32'), false);
  assert.equal(samePath('\\\\server\\share\\demo', '\\\\SERVER\\Share\\demo', 'win32'), true);
  assert.equal(samePath('/home/ana/Demo', '/home/ana/demo', 'linux'), false);
  assert.equal(samePath('/home/ana/demo/', '/home/ana/demo', 'linux'), true);
});

test('project folders and environments never take a name Windows reserves for a device', () => {
  assert.equal(slugify('Con'), 'con-project');
  assert.equal(slugify('AUX'), 'aux-project');
  assert.equal(slugify('COM1'), 'com1-project');
  assert.equal(slugify('Console'), 'console');
  assert.equal(slugify('José Núñez — Kinetic'), 'jose-nunez-kinetic');
  for (const bad of ['con', 'NUL', 'com1', 'Lpt9', 'prn']) assert.throws(() => validateEnvName(bad), /reserves/, bad);
  for (const ok of ['dev', 'test', 'prod', 'console', 'com10']) assert.doesNotThrow(() => validateEnvName(ok));
});

test('the server entry is recognised as run directly whatever the drive-letter case', () => {
  const file = path.resolve('dist', 'server.mjs');
  const url = pathToFileURL(file).href;
  assert.equal(isMainModule(url, file), true);
  assert.equal(isMainModule(url, file.toUpperCase(), 'win32'), true);
  assert.equal(isMainModule(url, path.resolve('kinetic-migrate.mjs')), false);
  assert.equal(isMainModule(url, undefined), false);
});

test('project files saved with a UTF-8 byte-order mark (Windows PowerShell 5, older Notepad) still read', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'km-bom-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kinetic-migrate.json');
  writeFileSync(file, '\uFEFF{\r\n  "name": "Demo"\r\n}\r\n');
  assert.deepEqual(readJsonFile(file), { name: 'Demo' });
});

test('git file paths are always forward-slashed relative paths, whatever the OS', () => {
  // isomorphic-git hands back paths like this on Windows too; the layout
  // check never sees backslashes.
  assert.equal(inLayout('snapshots/dev/space.json'), true);
  assert.equal(inLayout('.gitattributes'), true);
  assert.equal(inLayout('snapshots\\dev\\space.json'), false);
});
