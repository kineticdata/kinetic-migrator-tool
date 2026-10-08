// The Kinetic Platform version each environment was last seen running, in
// plans/platforms.json (local, never committed). Detected by Test connection,
// snapshots, plans and live comparisons (see lib/sync/platform.mjs), and
// shown on the environment cards and, when two environments differ in major
// version, in the Compare and Plan headers.
//
// Why local: it is derived from the live server and changes under the
// project with every platform upgrade; committing it would add a commit per
// Test connection. History still records it: each snapshot commit carries a
// `Platform:` trailer with the version the export ran against.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- untyped engine module
import * as platformModule from '../../lib/sync/platform.mjs';
import type { PlatformInfo } from '../shared/api.ts';
import { createClient, stableStringify, type ClientFactory, type EngineClient } from './engine.ts';
import { displayName, isPlainObject } from './project-meta.ts';

type EnginePlatform = { version: string | null; major: number | null; minor: number | null; source: string | null };

export const parseVersion: (v: unknown) => { version: string; major: number; minor: number } | null = platformModule.parseVersion;
export const crossVersionWarning: (a: { name: string; platform?: EnginePlatform | null }, b: { name: string; platform?: EnginePlatform | null }) => string | null = platformModule.crossVersionWarning;

const fileFor = (dir: string) => path.join(dir, 'plans', 'platforms.json');

function readAll(dir: string): Record<string, PlatformInfo> {
  const file = fileFor(dir);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlainObject(raw)) return {};
    const out: Record<string, PlatformInfo> = {};
    for (const [env, v] of Object.entries(raw)) {
      if (!isPlainObject(v)) continue;
      const parsed = parseVersion(v.version);
      if (!parsed) continue;
      out[env] = {
        ...parsed,
        source: typeof v.source === 'string' ? v.source : null,
        detectedAt: typeof v.detectedAt === 'string' ? v.detectedAt : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function readPlatform(dir: string, env: string): PlatformInfo | null {
  return readAll(dir)[env] ?? null;
}

// Keeps a detected version; an unknown one leaves the last known in place.
export function rememberPlatform(dir: string, env: string, p: EnginePlatform | null | undefined, at: Date = new Date()): PlatformInfo | null {
  const parsed = parseVersion(p?.version);
  if (!parsed) return readPlatform(dir, env);
  const info: PlatformInfo = { ...parsed, source: p?.source ?? null, detectedAt: at.toISOString() };
  try {
    mkdirSync(path.join(dir, 'plans'), { recursive: true });
    writeFileSync(fileFor(dir), stableStringify({ ...readAll(dir), [env]: info }));
  } catch { /* the next detection writes it */ }
  return info;
}

export function forgetPlatform(dir: string, env: string): void {
  const all = readAll(dir);
  if (!(env in all)) return;
  delete all[env];
  try { writeFileSync(fileFor(dir), stableStringify(all)); } catch { /* stale until the next detection */ }
}

// The platform a client talks to (null when the client cannot tell).
export async function platformOf(client: EngineClient | undefined): Promise<EnginePlatform | null> {
  try {
    return (await client?.platform?.()) ?? null;
  } catch {
    return null;
  }
}

// A client factory that keeps the first client it makes, so the version it
// detected (once per client) can be read afterwards.
export function capturingFactory(factory: ClientFactory = createClient): { factory: ClientFactory; platform: () => Promise<EnginePlatform | null> } {
  let first: EngineClient | undefined;
  return {
    factory: (opts) => {
      const c = factory(opts);
      first ??= c;
      return c;
    },
    platform: () => platformOf(first),
  };
}

// The header warning for two environments (by name) that differ in major
// version, from what was last detected; null when they match or either is
// unknown.
export function crossVersionFor(dir: string, a: string, b: string): string | null {
  return crossVersionWarning(
    { name: displayName(a), platform: readPlatform(dir, a) },
    { name: displayName(b), platform: readPlatform(dir, b) },
  );
}
