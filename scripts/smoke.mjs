// Smoke test of the built app (run `npm run build` first): starts
// `kinetic-migrate ui --fake --no-open` with a workspace whose path has spaces
// and non-ASCII letters, follows the launch URL, fetches the index page and the
// session endpoint, then stops the server. Cross-platform; fails after 60 s.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 60_000;

function fail(message) {
  console.error(`smoke: FAIL ${message}`);
  process.exitCode = 1;
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'server.mjs'))) throw new Error('dist/server.mjs is missing: run npm run build first');
  const parent = mkdtempSync(path.join(tmpdir(), 'km-smoke-'));
  const workspace = path.join(parent, 'José Núñez', 'Kinetic Projects');
  const child = spawn(process.execPath, [path.join(ROOT, 'kinetic-migrate.mjs'), 'ui', '--fake', '--no-open', '--workspace', workspace], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    // Fake mode from the flag alone: no KINETIC_MIGRATE_FAKE in the environment.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'KINETIC_MIGRATE_FAKE')),
  });
  let out = '';
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  const timer = setTimeout(() => {
    fail(`timed out after ${TIMEOUT_MS / 1000} s\n${out}`);
    stop();
    process.exit(1);
  }, TIMEOUT_MS);
  try {
    const launch = await new Promise((resolve, reject) => {
      const read = (chunk) => {
        out += chunk.toString();
        const url = /running at (http:\/\/\S+)/.exec(out)?.[1];
        if (url && /fake mode/i.test(out)) resolve(url);
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('exit', (code) => reject(new Error(`kinetic-migrate ui exited (${code}) before it was ready:\n${out}`)));
    });
    // 127.0.0.1, not localhost: the server listens on IPv4 loopback only.
    const base = new URL(launch);
    base.hostname = '127.0.0.1';
    const origin = base.origin;

    const login = await fetch(base, { redirect: 'manual' });
    if (login.status !== 302) throw new Error(`launch URL answered ${login.status}, expected 302`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    if (!/^km_session_\d+=/.test(cookie)) throw new Error('launch URL set no session cookie');

    const index = await fetch(`${origin}/`, { headers: { cookie } });
    const html = await index.text();
    if (index.status !== 200 || !/<html/i.test(html) || !/<script/i.test(html)) throw new Error(`index page answered ${index.status}`);
    console.log(`smoke: index page ok (${html.length} bytes)`);

    const session = await fetch(`${origin}/api/session`, { headers: { cookie, 'x-kinetic-migrate': '1' } });
    const info = await session.json();
    if (session.status !== 200 || typeof info.version !== 'string') throw new Error(`/api/session answered ${session.status}`);
    if (path.resolve(info.workspace) !== path.resolve(workspace)) throw new Error(`workspace came back as ${info.workspace}`);
    console.log(`smoke: /api/session ok (version ${info.version}, workspace ${info.workspace})`);

    const projects = await fetch(`${origin}/api/projects`, { headers: { cookie, 'x-kinetic-migrate': '1' } });
    if (projects.status !== 200 || !Array.isArray(await projects.json())) throw new Error(`/api/projects answered ${projects.status}`);
    const denied = await fetch(`${origin}/api/session`);
    if (denied.status !== 401) throw new Error(`/api/session without the cookie answered ${denied.status}, expected 401`);
    console.log('smoke: ok');
  } finally {
    clearTimeout(timer);
    child.removeAllListeners('exit');
    stop();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((e) => fail(e.message));
