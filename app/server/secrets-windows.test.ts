// Windows keychain without Windows: the long-lived helper process against a
// fake child (line protocol, secrets only on stdin, restart, timeouts), and
// value splitting against a fake Credential Manager with its 2560-byte limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  HelperError, PowerShellHelper, WIN_HELPER_SCRIPT, WIN_PART_CHARS, WinCredentials, asciiJson, winArgs, winPowerShell,
  type HelperChild, type WinRequest, type WinResponse,
} from './secrets-windows.ts';
import { KeychainStore, MemoryStore, createDefaultStore, encodeStored } from './secrets.ts';

const PLANTED = 'pl4nted-S3cret"\\&value';
const BLOB_MAX = 2560;

// Credential Manager in memory: targets to blobs, with the real size limit.
function fakeCredMan() {
  const creds = new Map<string, string>();
  const requests: WinRequest[] = [];
  const helper = {
    async request(req: WinRequest): Promise<WinResponse> {
      requests.push(req);
      if (req.op === 'probe') return { code: 0 };
      if (req.op === 'set') {
        if (Buffer.byteLength(req.value ?? '') > BLOB_MAX) return { code: 1 };
        creds.set(req.target, req.value ?? '');
        return { code: 0 };
      }
      if (req.op === 'get') return creds.has(req.target) ? { code: 0, value: creds.get(req.target) } : { code: 44 };
      return creds.delete(req.target) ? { code: 0 } : { code: 44 };
    },
  };
  return { creds, requests, helper };
}

test('values longer than one credential holds are split into parts under a header, and read back whole', async () => {
  const { creds, helper } = fakeCredMan();
  const w = new WinCredentials(helper, 'svc');
  const big = `b64:${'A'.repeat(5 * 1024)}`;
  await w.set('p/dev/secret/PEM', big);
  const parts = Math.ceil(big.length / WIN_PART_CHARS);
  assert.equal(creds.get('svc:p/dev/secret/PEM'), `km-parts:${parts}`);
  for (const [, blob] of creds) assert.ok(Buffer.byteLength(blob) <= BLOB_MAX);
  assert.equal(creds.size, parts + 1);
  assert.equal(await w.get('p/dev/secret/PEM'), big);
  assert.equal(await w.has('p/dev/secret/PEM'), true);
  // A shorter value replaces it and leaves no parts behind.
  await w.set('p/dev/secret/PEM', 'b64:c2hvcnQ=');
  assert.deepEqual([...creds.keys()], ['svc:p/dev/secret/PEM']);
  assert.equal(await w.get('p/dev/secret/PEM'), 'b64:c2hvcnQ=');
  await w.delete('p/dev/secret/PEM');
  assert.equal(creds.size, 0);
  assert.equal(await w.get('p/dev/secret/PEM'), undefined);
  assert.equal(await w.has('p/dev/secret/PEM'), false);
  await w.delete('p/dev/secret/PEM'); // absent is fine
});

test('leftover parts from an interrupted write are removed; a missing part is an error, never a short value', async () => {
  const { creds, helper } = fakeCredMan();
  const w = new WinCredentials(helper, 'svc');
  // A crash after parts 1..3 and before the header; then a later two-part write.
  for (const i of [1, 2, 3]) creds.set(`svc:a#${i}`, 'x');
  await w.set('a', `b64:${'B'.repeat(WIN_PART_CHARS + 10)}`);
  assert.deepEqual([...creds.keys()].sort(), ['svc:a', 'svc:a#1', 'svc:a#2']);
  // Orphans past the header's count go with the secret.
  creds.set('svc:a#3', 'x');
  creds.set('svc:a#4', 'x');
  await w.delete('a');
  assert.equal(creds.size, 0);
  // Parts with no header at all (the header write never happened).
  creds.set('svc:b#1', 'x');
  creds.set('svc:b#2', 'x');
  await w.delete('b');
  assert.equal(creds.size, 0);
  await w.set('c', `b64:${'C'.repeat(WIN_PART_CHARS * 2)}`);
  creds.delete('svc:c#2');
  await assert.rejects(w.get('c'), /could not read/);
});

test('KeychainStore on Windows: any size and any text round-trip; a stored value that is not ours is refused', async () => {
  const { creds, requests, helper } = fakeCredMan();
  const s = new KeychainStore({ platform: 'win32', winHelper: helper });
  const pem = `-----BEGIN PRIVATE KEY----- ${'Zm9v'.repeat(1200)} Pässwörd-日本-€ ${PLANTED}`;
  await s.set('p/dev/secret/KEY', pem);
  assert.equal(await s.get('p/dev/secret/KEY'), pem);
  assert.equal(await s.has('p/dev/secret/KEY'), true);
  // The secret index of a big environment (names only) fits too.
  const index = JSON.stringify(Array.from({ length: 200 }, (_, i) => `handler/KINETIC_CORE_API_V${i}__PASSWORD`));
  await s.set('p/dev/index/secrets', index);
  assert.equal(await s.get('p/dev/index/secrets'), index);
  for (const r of requests) assert.ok(!JSON.stringify({ ...r, value: undefined }).includes('pl4nted'), 'only `value` ever carries the secret');
  creds.set('kinetic-migrate:p/dev/secret/odd', '#< CLIXML\n<Objs/>');
  await assert.rejects(s.get('p/dev/secret/odd'), (e: Error) => e.name === 'KeychainError' && !e.message.includes('CLIXML'));
  await s.delete('p/dev/secret/KEY');
  assert.equal(await s.get('p/dev/secret/KEY'), undefined);
});

// ---- The helper process, against a fake child ----------------------------

class FakeChild extends EventEmitter implements HelperChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  lines: string[] = [];
  killed = false;
  constructor(private respond: (req: any, child: FakeChild) => string | null, ready = true) {
    super();
    let buf = '';
    this.stdin.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.lines.push(line);
        const out = this.respond(JSON.parse(line), this);
        if (out !== null) setImmediate(() => this.stdout.write(`${out}\r\n`));
      }
    });
    if (ready) setImmediate(() => this.stdout.write('{"ready":true}\r\n'));
  }
  kill() { this.killed = true; setImmediate(() => this.emit('exit', 1)); }
  crash() { this.emit('exit', 1); }
}

function spawner(make: (n: number) => FakeChild) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawn = (file: string, args: string[]) => {
    calls.push({ file, args });
    const c = make(children.length);
    children.push(c);
    return c;
  };
  return { spawn, calls, children };
}

const echo = (req: any) => JSON.stringify(req.op === 'get' ? { code: 0, value: `got:${req.target}` } : { code: 0 });

test('one helper serves every request: the fixed script by -EncodedCommand, requests and secrets only on stdin', async () => {
  const sp = spawner(() => new FakeChild(echo));
  const h = new PowerShellHelper({ spawn: sp.spawn, powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  const w = new WinCredentials(h, 'kinetic-migrate');
  await w.set('José/dev/secret/X', encodeStored(PLANTED));
  assert.equal(await w.get('p/dev/secret/Y'), 'got:kinetic-migrate:p/dev/secret/Y');
  await w.delete('p/dev/secret/Y').catch(() => {});
  assert.equal(sp.calls.length, 1, 'started once');
  const { file, args } = sp.calls[0];
  assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(args[4], 'base64').toString('utf16le'), WIN_HELPER_SCRIPT);
  assert.ok(!args.join(' ').includes('pl4nted') && !args.join(' ').includes(encodeStored(PLANTED)));
  const lines = sp.children[0].lines;
  for (const l of lines) assert.match(l, /^[\x20-\x7e]*$/, 'one ASCII line per request');
  assert.ok(lines.some((l) => l.includes('Jos\\u00e9')));
  assert.ok(lines.some((l) => JSON.parse(l).value === encodeStored(PLANTED)));
  h.close();
  assert.equal(sp.children[0].killed, true);
});

test('concurrent requests are answered in order, one at a time', async () => {
  const sp = spawner(() => new FakeChild((req) => JSON.stringify({ code: 0, value: req.target })));
  const h = new PowerShellHelper({ spawn: sp.spawn });
  const answers = await Promise.all(['a', 'b', 'c'].map((t) => h.request({ op: 'get', target: t })));
  assert.deepEqual(answers.map((a) => a.value), ['a', 'b', 'c']);
  h.close();
});

test('a helper that crashes is restarted and the request retried once', async () => {
  const sp = spawner((n) => new FakeChild((req, child) => {
    if (n === 0) { setImmediate(() => child.crash()); return null; }
    return JSON.stringify({ code: 0, value: req.target });
  }));
  const h = new PowerShellHelper({ spawn: sp.spawn });
  assert.deepEqual(await h.request({ op: 'get', target: 't' }), { code: 0, value: 't' });
  assert.equal(h.starts, 2);
  h.close();
});

test('a slow first start is a start timeout (not "unavailable"); a silent request times out and the helper is restarted', async () => {
  const slow = spawner(() => new FakeChild(echo, false));
  const h = new PowerShellHelper({ spawn: slow.spawn, startTimeoutMs: 30 });
  await assert.rejects(h.request({ op: 'probe', target: 'x' }), (e: Error) => e instanceof HelperError && e.reason === 'start-timeout');
  assert.equal(slow.children[0].killed, true);
  assert.equal(await new WinCredentials(new PowerShellHelper({ spawn: slow.spawn, startTimeoutMs: 30 }), 'svc').probe(), 'timeout');

  const mute = spawner((n) => new FakeChild((req) => (n === 0 ? null : echo(req))));
  const m = new PowerShellHelper({ spawn: mute.spawn, requestTimeoutMs: 30 });
  await assert.rejects(m.request({ op: 'get', target: 'x' }), (e: Error) => e instanceof HelperError && e.reason === 'timeout');
  assert.deepEqual(await m.request({ op: 'get', target: 'x' }), { code: 0, value: 'got:x' });
  assert.equal(m.starts, 2);
  m.close();
});

test('a helper that cannot run (PowerShell missing or locked down) means no keychain', async () => {
  const dead = spawner(() => {
    const c = new FakeChild(echo, false);
    setImmediate(() => c.crash());
    return c;
  });
  assert.equal(await new WinCredentials(new PowerShellHelper({ spawn: dead.spawn }), 'svc').probe(), 'unavailable');
  const missing = new PowerShellHelper({ spawn: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(await new WinCredentials(missing, 'svc').probe(), 'unavailable');
});

test('createDefaultStore keeps Credential Manager when the helper is only slow to start, and says which way it went', async () => {
  const logs: string[] = [];
  const slow = { request: async () => { throw new HelperError('start-timeout', 'slow'); }, close: () => {} };
  const kept = await createDefaultStore((m) => logs.push(m), { platform: 'win32', winHelper: slow });
  assert.equal(kept.persistent, true);
  assert.match(logs[0], /slow to start/);
  const broken = { request: async () => ({ code: 1 }), close: () => {} };
  const memory = await createDefaultStore((m) => logs.push(m), { platform: 'win32', winHelper: broken });
  assert.ok(memory instanceof MemoryStore);
  assert.match(logs[1], /kept in memory/);
  for (const l of logs) assert.ok(!l.includes('pl4nted'));
});

test('the helper script: Win32 Credential Manager, local persistence, a ready line, one JSON line per request', () => {
  for (const api of ['CredWriteW', 'CredReadW', 'CredDeleteW', 'CredFree', 'advapi32.dll']) assert.ok(WIN_HELPER_SCRIPT.includes(api), api);
  assert.match(WIN_HELPER_SCRIPT, /c\.Type = 1;/, 'CRED_TYPE_GENERIC');
  assert.match(WIN_HELPER_SCRIPT, /c\.Persist = 2;/, 'CRED_PERSIST_LOCAL_MACHINE (not roamed)');
  assert.match(WIN_HELPER_SCRIPT, /\{"ready":true\}/);
  assert.match(WIN_HELPER_SCRIPT, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(WIN_HELPER_SCRIPT, /ConvertTo-Json -Compress/);
  assert.match(WIN_HELPER_SCRIPT, /-eq 1168\) \{ \$code = 44 \}/, 'ERROR_NOT_FOUND maps to 44');
  assert.doesNotMatch(WIN_HELPER_SCRIPT, /PasswordVault|Write-Host|\$\{/);
  assert.match(WIN_HELPER_SCRIPT, /@'\n/);
  assert.match(WIN_HELPER_SCRIPT, /\n'@\n/);
  assert.ok(winArgs().join(' ').length < 16_000, 'far below the 32767-character command-line limit');
  assert.equal(winPowerShell({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(winPowerShell({}), 'powershell.exe');
  assert.equal(asciiJson({ a: 'José/日本😀' }), '{"a":"Jos\\u00e9/\\u65e5\\u672c\\ud83d\\ude00"}');
});

test('a secret whose value fails to store is still listed, so deleting the environment finds everything stored', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { setEnvSecret, deleteEnvSecret } = await import('./environments.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'km-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = '0b7e2c1a-3f4d-4e5f-8a9b-0c1d2e3f4a5b';
  writeFileSync(path.join(dir, 'kinetic-migrate.json'), JSON.stringify({ name: 'x', secretsId: sid }));
  const ref = { id: 'x', dir };
  class Flaky extends MemoryStore {
    fail = true;
    async set(account: string, value: string) {
      if (this.fail && !account.includes('/index/')) throw new Error('store failed');
      return super.set(account, value);
    }
  }
  const store = new Flaky();
  await assert.rejects(setEnvSecret(store, ref, 'dev', 'secret', 'MAIL__PASSWORD', 'v'), /store failed/);
  assert.match((await store.get(`${sid}/dev/index/names`)) ?? '', /secret\/MAIL__PASSWORD/);
  store.fail = false;
  await setEnvSecret(store, ref, 'dev', 'secret', 'MAIL__PASSWORD', 'v');
  await deleteEnvSecret(store, ref, 'dev', 'secret', 'MAIL__PASSWORD');
  assert.equal(await store.get(`${sid}/dev/secret/MAIL__PASSWORD`), undefined);
  assert.equal(await store.get(`${sid}/dev/index/names`), undefined);
});
