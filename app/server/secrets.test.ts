// Secrets store: in-memory backend, account naming and the keychain adapters'
// command shapes (a fake runner; no real keychain is touched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountFor, asciiJson, decodeStored, encodeStored, KeychainStore, MemoryStore, WIN_MAX_STORED, WIN_SCRIPT, winArgs, winPowerShell, type CommandRunner,
} from './secrets.ts';

const PLANTED = 'pl4nted-S3cret"\\value';

test('MemoryStore gets, sets, deletes and reports has', async () => {
  const s = new MemoryStore();
  assert.equal(s.persistent, false);
  assert.equal(await s.has('p/dev/credentials/password'), false);
  assert.equal(await s.get('p/dev/credentials/password'), undefined);
  await s.set('p/dev/credentials/password', 'x');
  assert.equal(await s.has('p/dev/credentials/password'), true);
  assert.equal(await s.get('p/dev/credentials/password'), 'x');
  await s.delete('p/dev/credentials/password');
  assert.equal(await s.has('p/dev/credentials/password'), false);
});

test('accounts are <projectId>/<env>/<scope>/<name> and reject slashes in parts', () => {
  assert.equal(accountFor('proj', 'dev', 'credentials', 'password'), 'proj/dev/credentials/password');
  assert.throws(() => accountFor('a/b', 'dev', 'credentials', 'password'));
  assert.throws(() => accountFor('p', '', 'credentials', 'password'));
});

interface Call { file: string; args: string[]; input?: string }

function fakeRunner(results: Array<{ code: number; stdout?: string }>): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, input) => {
    calls.push({ file, args, input });
    const r = results.shift() ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? '', stderr: '' };
  };
  return { run, calls };
}

test('macOS adapter never puts the value on the command line', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0, stdout: `${encodeStored(PLANTED)}\n` }, { code: 44 }]);
  const s = new KeychainStore({ platform: 'darwin', run });
  assert.equal(s.persistent, true);
  await s.set('p/dev/credentials/password', PLANTED);
  assert.equal(calls[0].file, 'security');
  assert.ok(!calls[0].args.join(' ').includes('pl4nted'));
  assert.ok(calls[0].input?.includes('add-generic-password'));
  assert.ok(calls[0].input?.includes(`-w "${encodeStored(PLANTED)}"`), 'stored base64-encoded');
  assert.equal(await s.get('p/dev/credentials/password'), PLANTED);
  assert.deepEqual(calls[1].args, ['find-generic-password', '-s', 'kinetic-migrate', '-a', 'p/dev/credentials/password', '-w']);
  assert.equal(await s.get('p/dev/credentials/username'), undefined);
});

test('Linux adapter stores via stdin with secret-tool', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0, stdout: encodeStored(PLANTED) }]);
  const s = new KeychainStore({ platform: 'linux', run });
  await s.set('p/dev/credentials/password', PLANTED);
  assert.equal(calls[0].file, 'secret-tool');
  assert.equal(calls[0].args[0], 'store');
  assert.equal(calls[0].input, encodeStored(PLANTED));
  assert.ok(!calls[0].args.join(' ').includes('pl4nted'));
  assert.equal(await s.has('p/dev/credentials/password'), true);
});

const decodedScript = (args: string[]) => {
  const i = args.indexOf('-EncodedCommand');
  assert.ok(i >= 0, 'script passed with -EncodedCommand');
  return Buffer.from(args[i + 1], 'base64').toString('utf16le');
};

test('Windows adapter: Credential Manager through a fixed encoded script; the request and value go as JSON on stdin', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0, stdout: encodeStored(PLANTED) }, { code: 0 }]);
  const s = new KeychainStore({ platform: 'win32', run, powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  await s.set('p/dev/credentials/password', PLANTED);
  assert.equal(await s.get('p/dev/credentials/password'), PLANTED);
  await s.delete('p/dev/credentials/password');
  for (const c of calls) {
    assert.equal(c.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(c.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(c.args.length, 5);
    assert.equal(decodedScript(c.args), WIN_SCRIPT, 'the same fixed script every time');
    assert.ok(!c.args.join(' ').includes('pl4nted'), 'no secret on the command line');
    assert.ok(!c.args.join(' ').includes(encodeStored(PLANTED)), 'not even encoded');
    assert.match(c.input ?? '', /^[\x20-\x7e]*$/, 'stdin is one line of ASCII');
  }
  assert.deepEqual(JSON.parse(calls[0].input ?? ''), {
    op: 'set', target: 'kinetic-migrate:p/dev/credentials/password', account: 'p/dev/credentials/password', value: encodeStored(PLANTED),
  });
  assert.deepEqual(JSON.parse(calls[1].input ?? ''), { op: 'get', target: 'kinetic-migrate:p/dev/credentials/password', account: 'p/dev/credentials/password' });
  assert.equal(JSON.parse(calls[2].input ?? '').op, 'delete');
});

test('Windows script: Win32 Credential Manager calls, local persistence, ASCII-only interface, no PasswordVault', () => {
  for (const api of ['CredWriteW', 'CredReadW', 'CredDeleteW', 'CredFree', 'advapi32.dll']) assert.ok(WIN_SCRIPT.includes(api), api);
  assert.match(WIN_SCRIPT, /c\.Type = 1;/, 'CRED_TYPE_GENERIC');
  assert.match(WIN_SCRIPT, /c\.Persist = 2;/, 'CRED_PERSIST_LOCAL_MACHINE (not roamed)');
  assert.match(WIN_SCRIPT, /\[Console\]::In\.ReadToEnd\(\)/, 'request read from stdin');
  assert.match(WIN_SCRIPT, /-eq 1168\) \{ exit 44 \}/, 'ERROR_NOT_FOUND maps to 44');
  assert.match(WIN_SCRIPT, /^\$ErrorActionPreference = 'Stop'\ntrap \{ exit 1 \}/, 'any error exits 1 without output');
  assert.doesNotMatch(WIN_SCRIPT, /PasswordVault|Write-Host|Write-Output|\$\{/);
  // Here-string delimiters must stand alone at line ends / starts.
  assert.match(WIN_SCRIPT, /@'\n/);
  assert.match(WIN_SCRIPT, /\n'@\n/);
  // The command line stays far below the 32767-character Windows limit.
  assert.ok(winArgs().join(' ').length < 16_000);
});

test('Windows: non-ASCII account names travel as \\u escapes; long values are refused before any process runs', async () => {
  assert.equal(asciiJson({ account: 'José/日本' }), '{"account":"Jos\\u00e9/\\u65e5\\u672c"}');
  assert.deepEqual(JSON.parse(asciiJson({ account: 'José/日本' })), { account: 'José/日本' });
  const { run, calls } = fakeRunner([]);
  const s = new KeychainStore({ platform: 'win32', run });
  await assert.rejects(s.set('p/dev/secret/x', 'x'.repeat(WIN_MAX_STORED)), /too long/);
  assert.equal(calls.length, 0);
});

test('Windows: output with a byte-order mark or CRLF still decodes; the system PowerShell is used by full path', async () => {
  const s = new KeychainStore({ platform: 'win32', run: scripted([result(0, `\uFEFF${encodeStored(PLANTED)}\r\n`)]) });
  assert.equal(await s.get('a/b/c/d'), PLANTED);
  assert.equal(winPowerShell({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(winPowerShell({}), 'powershell.exe');
});

test('Windows available(): the probe must compile and reach Credential Manager', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }]);
  assert.equal(await new KeychainStore({ platform: 'win32', run }).available(), true);
  assert.equal(JSON.parse(calls[0].input ?? '').op, 'probe');
  assert.equal(await new KeychainStore({ platform: 'win32', run: scripted([result(1)]) }).available(), false);
  const missing: CommandRunner = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  assert.equal(await new KeychainStore({ platform: 'win32', run: missing }).available(), false);
});

test('a failing keychain write never echoes the value in the error', async () => {
  const run: CommandRunner = async () => ({ code: 1, stdout: PLANTED, stderr: PLANTED });
  const s = new KeychainStore({ platform: 'darwin', run });
  await assert.rejects(s.set('p/dev/credentials/password', PLANTED), (err: Error) => !err.message.includes('pl4nted'));
});

test('available() is false when the tool is missing', async () => {
  const missing: CommandRunner = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  assert.equal(await new KeychainStore({ platform: 'linux', run: missing }).available(), false);
  assert.equal(await new KeychainStore({ platform: 'aix', run: missing }).available(), false);
  const ok: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
  assert.equal(await new KeychainStore({ platform: 'darwin', run: ok }).available(), true);
});

const result = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr });

function scripted(results: Array<{ code: number; stdout: string; stderr: string }>): CommandRunner {
  return async () => results.shift() ?? result(0);
}

test('macOS: only exit 44 means not found; other failures throw without tool output', async () => {
  const s = new KeychainStore({ platform: 'darwin', run: scripted([result(44), result(51, PLANTED, PLANTED), result(44), result(36, '', PLANTED), result(44), result(1, '', PLANTED)]) });
  assert.equal(await s.get('a/b/c/d'), undefined);
  await assert.rejects(s.get('a/b/c/d'), (e: Error) => e.name === 'KeychainError' && !e.message.includes('pl4nted'));
  assert.equal(await s.has('a/b/c/d'), false);
  await assert.rejects(s.has('a/b/c/d'), /keychain/i);
  await s.delete('a/b/c/d'); // absent is fine
  await assert.rejects(s.delete('a/b/c/d'), (e: Error) => !e.message.includes('pl4nted'));
});

test('Linux: an empty lookup is not found; failures with output throw; delete checks exit codes', async () => {
  const s = new KeychainStore({ platform: 'linux', run: scripted([result(1), result(0), result(1, '', 'Cannot autolaunch D-Bus'), result(0), result(1), result(2, '', 'error')]) });
  assert.equal(await s.get('a/b/c/d'), undefined);
  assert.equal(await s.get('a/b/c/d'), undefined);
  await assert.rejects(s.get('a/b/c/d'), /keychain/i);
  await s.delete('a/b/c/d');
  await s.delete('a/b/c/d');
  await assert.rejects(s.delete('a/b/c/d'), /keychain/i);
});

test('Linux available() needs a working secret-tool probe (a search with no match exits 1 quietly)', async () => {
  assert.equal(await new KeychainStore({ platform: 'linux', run: scripted([result(0)]) }).available(), true);
  assert.equal(await new KeychainStore({ platform: 'linux', run: scripted([result(1)]) }).available(), true);
  assert.equal(await new KeychainStore({ platform: 'linux', run: scripted([result(1, '', 'Cannot autolaunch D-Bus')]) }).available(), false);
  assert.equal(await new KeychainStore({ platform: 'linux', run: scripted([result(2)]) }).available(), false);
});

test('keychain values are stored base64-encoded with a marker; values stored before the marker still read back', async () => {
  const unicode = 'Pässwörd-日本-€';
  assert.match(encodeStored(unicode), /^b64:[A-Za-z0-9+/=]+$/);
  assert.equal(decodeStored(encodeStored(unicode)), unicode);
  assert.equal(decodeStored('legacy-plain-value'), 'legacy-plain-value');
  assert.equal(decodeStored(''), '');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const stored = new Map<string, string>();
    const run: CommandRunner = async (file, args, input) => {
      if (args.includes('find-generic-password') || args[0] === 'lookup' || (platform === 'win32' && JSON.parse(input ?? '{}').op === 'get')) {
        return result(0, platform === 'darwin' ? `${stored.get('v') ?? ''}\n` : stored.get('v') ?? '');
      }
      const value = platform === 'darwin' ? /-w "([^"]*)"/.exec(input ?? '')?.[1] : platform === 'linux' ? input : JSON.parse(input ?? '{}').value;
      stored.set('v', value ?? '');
      return result(0);
    };
    const s = new KeychainStore({ platform, run });
    await s.set('a/b/c/d', unicode);
    assert.ok(/^b64:/.test(stored.get('v') ?? ''), platform);
    assert.equal(await s.get('a/b/c/d'), unicode, platform);
    stored.set('v', 'legacy-plain-value');
    assert.equal(await s.get('a/b/c/d'), 'legacy-plain-value', platform);
  }
});

test('Windows: exit 44 is not found; other failures throw; delete checks exit codes', async () => {
  const s = new KeychainStore({ platform: 'win32', run: scripted([result(44), result(1, '', PLANTED), result(44), result(0), result(1)]) });
  assert.equal(await s.get('a/b/c/d'), undefined);
  await assert.rejects(s.get('a/b/c/d'), (e: Error) => !e.message.includes('pl4nted'));
  await s.delete('a/b/c/d');
  await s.delete('a/b/c/d');
  await assert.rejects(s.delete('a/b/c/d'), /keychain/i);
});
