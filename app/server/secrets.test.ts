// Secrets store: in-memory backend, account naming and the keychain adapters'
// command shapes (a fake runner; no real keychain is touched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFor, KeychainStore, MemoryStore, type CommandRunner } from './secrets.ts';

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
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0, stdout: `${PLANTED}\n` }, { code: 44 }]);
  const s = new KeychainStore({ platform: 'darwin', run });
  assert.equal(s.persistent, true);
  await s.set('p/dev/credentials/password', PLANTED);
  assert.equal(calls[0].file, 'security');
  assert.ok(!calls[0].args.join(' ').includes('pl4nted'));
  assert.ok(calls[0].input?.includes('add-generic-password'));
  assert.equal(await s.get('p/dev/credentials/password'), PLANTED);
  assert.deepEqual(calls[1].args, ['find-generic-password', '-s', 'kinetic-migrate', '-a', 'p/dev/credentials/password', '-w']);
  assert.equal(await s.get('p/dev/credentials/username'), undefined);
});

test('Linux adapter stores via stdin with secret-tool', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0, stdout: PLANTED }]);
  const s = new KeychainStore({ platform: 'linux', run });
  await s.set('p/dev/credentials/password', PLANTED);
  assert.equal(calls[0].file, 'secret-tool');
  assert.equal(calls[0].args[0], 'store');
  assert.equal(calls[0].input, PLANTED);
  assert.ok(!calls[0].args.join(' ').includes('pl4nted'));
  assert.equal(await s.has('p/dev/credentials/password'), true);
});

test('Windows adapter passes account and value as JSON on stdin', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }]);
  const s = new KeychainStore({ platform: 'win32', run });
  await s.set('p/dev/credentials/password', PLANTED);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(!calls[0].args.join(' ').includes('pl4nted'));
  assert.deepEqual(JSON.parse(calls[0].input ?? ''), { account: 'p/dev/credentials/password', value: PLANTED });
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
