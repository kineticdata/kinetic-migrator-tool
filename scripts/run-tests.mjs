// Runs `node --test` on every file under a folder whose name ends with a
// suffix. npm runs scripts with cmd.exe on Windows, which expands no globs,
// and Node 20's --test takes file paths, not patterns (patterns came in
// Node 21), so the files are listed here instead.
//
//   node scripts/run-tests.mjs [--import <module>]... <folder> <suffix>
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const imports = [];
const rest = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--import') imports.push('--import', argv[++i]);
  else rest.push(argv[i]);
}
if (rest.length !== 2) {
  console.error('usage: node scripts/run-tests.mjs [--import <module>]... <folder> <suffix>');
  process.exit(2);
}
const [folder, suffix] = rest;
const files = readdirSync(folder, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(suffix))
  .map((e) => path.join(e.parentPath ?? e.path, e.name))
  .filter((f) => !f.split(path.sep).includes('node_modules'))
  .sort();
if (!files.length) {
  console.error(`No ${suffix} files under ${folder}`);
  process.exit(1);
}
// Tests never touch this computer's real Kinetic Migrator data folder (the
// private histories of projects inside other repositories).
const dataDir = process.env.KINETIC_MIGRATOR_DATA_DIR ? null : mkdtempSync(path.join(tmpdir(), 'km-data-'));
const env = dataDir ? { ...process.env, KINETIC_MIGRATOR_DATA_DIR: dataDir } : process.env;
const child = spawn(process.execPath, [...imports, '--test', ...files], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
