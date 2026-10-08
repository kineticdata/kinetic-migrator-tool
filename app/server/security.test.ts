// Access control: session key cookie, CSRF header, Host check, body limit, static files.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { request, startTestServer, type TestServer } from './test-helpers.ts';

let s: TestServer;
let webDir: string;

before(async () => {
  webDir = mkdtempSync(path.join(tmpdir(), 'km-web-'));
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(path.join(webDir, 'app.js'), 'console.log(1);');
  s = await startTestServer({ webDir });
});
after(async () => {
  await s.cleanup();
  rmSync(webDir, { recursive: true, force: true });
});

test('launch URL is localhost with a long random key', () => {
  const url = new URL(s.url);
  assert.equal(url.hostname, 'localhost');
  assert.equal(Number(url.port), s.port);
  assert.ok(s.key.length >= 40);
});

test('GET /?key= sets an HttpOnly SameSite=Strict cookie and redirects to /', async () => {
  const res = await request(s.port, `/?key=${s.key}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, new RegExp(`km_session_${s.port}=${s.key}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

test('a wrong launch key is refused and sets no cookie', async () => {
  const res = await request(s.port, '/?key=nope');
  assert.equal(res.status, 403);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('no cookie → 401', async () => {
  const res = await request(s.port, '/api/session', { headers: { 'x-kinetic-migrate': '1' } });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'unauthorized');
});

test('another instance\'s cookie (other port) → 401', async () => {
  const res = await request(s.port, '/api/session', { headers: { 'x-kinetic-migrate': '1', cookie: `km_session_1=${s.key}` } });
  assert.equal(res.status, 401);
});

test('wrong cookie → 401', async () => {
  const res = await request(s.port, '/api/session', { headers: { 'x-kinetic-migrate': '1', cookie: `km_session_${s.port}=wrong` } });
  assert.equal(res.status, 401);
});

test('missing header → 403', async () => {
  const res = await request(s.port, '/api/session', { headers: { cookie: s.cookie } });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'forbidden');
});

test('bad Host → 403', async () => {
  for (const host of ['evil.example.com', `evil.example.com:${s.port}`, 'localhost:1', `localhost.evil.example.com:${s.port}`]) {
    const res = await request(s.port, '/api/session', { headers: { ...s.good, host } });
    assert.equal(res.status, 403, host);
  }
});

test('a good request → 200 (localhost and 127.0.0.1 hosts)', async () => {
  for (const host of [`localhost:${s.port}`, `127.0.0.1:${s.port}`]) {
    const res = await s.api('/api/session', { headers: { host } });
    assert.equal(res.status, 200, host);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.workspace, 'string');
  }
});

test('responses carry no CORS headers', async () => {
  const res = await s.api('/api/session', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('unknown API route → 404 JSON error', async () => {
  const res = await s.api('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'not_found');
});

test('JSON bodies over 1 MB → 413', async () => {
  const big = JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) });
  const res = await s.api('/api/session', { method: 'POST', body: big, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).error.code, 'payload_too_large');
});

test('a Content-Length over 1 MB → 413 at once, and the connection is closed', async () => {
  const res = await new Promise<{ status: number; body: string; closed: boolean }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/session', method: 'POST', headers: { host: `localhost:${s.port}`, ...s.good, 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode ?? 0, body, closed: r.headers.connection === 'close' }));
    });
    req.on('error', reject);
    // Send only the headers and a small part of the body; the server must not wait for the rest.
    req.write('{"x":"');
  });
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).error.code, 'payload_too_large');
  assert.ok(res.closed);
});

test('static files and SPA fallback, no path traversal', async () => {
  const js = await request(s.port, '/app.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  const deep = await request(s.port, '/projects/abc/explore');
  assert.equal(deep.status, 200);
  assert.match(deep.body, /<title>app<\/title>/);
  for (const p of ['/../', '/%2e%2e/', '/..%2f', '/..%5c', '/..%2f..%2fetc%2fpasswd', '/a/../../etc/passwd', '/%2e%2e%2fpackage.json']) {
    const trav = await request(s.port, p);
    assert.equal(trav.status, 404, p);
  }
  const dbl = await request(s.port, '//etc/passwd');
  assert.equal(dbl.status, 200);
  assert.match(dbl.body, /<title>app<\/title>/);
});

test('static files also require a valid Host', async () => {
  const res = await request(s.port, '/', { headers: { host: 'evil.example.com' } });
  assert.equal(res.status, 403);
});
