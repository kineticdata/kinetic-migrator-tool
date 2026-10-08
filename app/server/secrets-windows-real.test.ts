// The real Windows Credential Manager, on Windows only (CI's windows-latest
// runs it; skipped elsewhere): the PowerShell helper compiles and answers,
// values of any size and text round-trip, a missing secret is "not found",
// and nothing is left behind. Uses a throwaway service name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { KeychainStore } from './secrets.ts';

const onWindows = process.platform === 'win32';

test('Windows Credential Manager round-trip through the real helper', { skip: !onWindows && 'Windows only', timeout: 180_000 }, async () => {
  const service = `kinetic-migrate-test-${randomBytes(6).toString('hex')}`;
  const store = new KeychainStore({ service });
  const accounts = ['José Núñez/dev/secret/MAIL__PASSWORD', 'p/dev/secret/BIG', 'p/dev/secret/missing'];
  try {
    assert.equal(await store.availability(), 'available');
    const small = 'pässwörd "quoted" \\ back & amp % percent 日本 😀';
    await store.set(accounts[0], small);
    assert.equal(await store.get(accounts[0]), small);
    assert.equal(await store.has(accounts[0]), true);
    const big = `-----BEGIN PRIVATE KEY-----${randomBytes(3800).toString('base64')}-----END PRIVATE KEY----- é`;
    assert.ok(Buffer.byteLength(big) > 5000);
    await store.set(accounts[1], big);
    assert.equal(await store.get(accounts[1]), big);
    await store.set(accounts[1], 'short now');
    assert.equal(await store.get(accounts[1]), 'short now');
    assert.equal(await store.get(accounts[2]), undefined);
    assert.equal(await store.has(accounts[2]), false);
    await store.delete(accounts[0]);
    assert.equal(await store.get(accounts[0]), undefined);
    await store.delete(accounts[2]); // absent is fine
  } finally {
    for (const a of accounts) await store.delete(a).catch(() => {});
    store.close();
  }
});
