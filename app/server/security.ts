// Access control for the localhost server: a random session key (launch URL →
// HttpOnly cookie), the X-Kinetic-Migrate header as a CSRF guard, and a Host
// check against DNS rebinding.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.ts';

export const COOKIE_NAME = 'km_session';
export const CSRF_HEADER = 'x-kinetic-migrate';

export const generateKey = (): string => randomBytes(32).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(key: string): string {
  return `${COOKIE_NAME}=${key}; HttpOnly; SameSite=Strict; Path=/`;
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

// Throws 403 unless the Host header names this server on loopback.
export function checkHost(req: IncomingMessage, port: number): void {
  if (!hostAllowed(req.headers.host, port)) throw new ApiError(403, 'forbidden', 'Host not allowed.');
}

// Throws 401/403 unless an /api request carries the session cookie and header.
export function checkApi(req: IncomingMessage, key: string): void {
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!cookie || !safeEqual(cookie, key)) throw new ApiError(401, 'unauthorized', 'Open the app from the link printed by kinetic-migrate ui.');
  if (req.headers[CSRF_HEADER] !== '1') throw new ApiError(403, 'forbidden', 'Missing X-Kinetic-Migrate header.');
}
