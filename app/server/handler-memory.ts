// What the app remembers about each target's handler settings between runs,
// in plans/handler-settings-<env>.json (local, never committed; names only,
// never a value):
// - `pending`: handler secrets (by store name, <DEFINITION>__<PROPERTY>)
//   entered and kept in the keychain but not yet accepted by the target. The
//   next plan shows the handler as needing a settings write and apply sends
//   them, even when nothing else changed. An accepted write clears them, so a
//   stored secret is not resent on every run.
// - `empty`: per definitionId, the required properties the platform last
//   said were empty (encrypted values are never read back, so this is the
//   only way to know). An accepted write clears it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { envKey } from './engine.ts';
import { isPlainObject } from './project-meta.ts';
import { handlerSecretName } from './secret-names.ts';

export interface HandlerMemory { pending: string[]; empty: Record<string, string[]> }

export interface HandlerSettingsOutcome { key: string; definitionId: string; saved: boolean; sent: string[]; empty: string[] | null }

const fileFor = (dir: string, env: string) => path.join(dir, 'plans', `handler-settings-${env}.json`);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function readHandlerMemory(dir: string, env: string): HandlerMemory {
  const file = fileFor(dir, env);
  if (!existsSync(file)) return { pending: [], empty: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const empty: Record<string, string[]> = {};
    if (isPlainObject(raw?.empty)) for (const [id, names] of Object.entries(raw.empty)) if (strings(names).length) empty[id] = strings(names);
    return { pending: strings(raw?.pending), empty };
  } catch {
    return { pending: [], empty: {} };
  }
}

export function writeHandlerMemory(dir: string, env: string, m: HandlerMemory): void {
  mkdirSync(path.join(dir, 'plans'), { recursive: true });
  const empty = Object.fromEntries(Object.entries(m.empty).filter(([, n]) => n.length).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(fileFor(dir, env), `${JSON.stringify({ pending: [...new Set(m.pending)].sort(), empty }, null, 2)}\n`);
}

// Records what a run's settings writes did: accepted writes clear what they
// sent and the remembered empty properties; refused or skipped ones remember
// the properties named empty (and keep every pending secret).
export function recordHandlerOutcomes(dir: string, env: string, outcomes: HandlerSettingsOutcome[] | undefined): void {
  if (!outcomes?.length) return;
  const m = readHandlerMemory(dir, env);
  for (const o of outcomes) {
    if (o.saved) {
      const sent = new Set(o.sent.map((p) => handlerSecretName(o.definitionId, p)));
      m.pending = m.pending.filter((n) => !sent.has(n));
      delete m.empty[o.definitionId];
    } else if (o.empty) {
      m.empty[o.definitionId] = [...o.empty];
    }
  }
  writeHandlerMemory(dir, env, m);
}

// Handler secrets the engine has for `env` (store names), from its vars.
export function availableHandlerSecrets(env: string, vars: Record<string, string>): Set<string> {
  const prefix = `KINETIC_${envKey(env)}_HANDLER_`;
  return new Set(Object.entries(vars).filter(([k, v]) => k.startsWith(prefix) && v !== '').map(([k]) => k.slice(prefix.length)));
}

// The engine's hints (see lib/sync/artifacts/handlers.mjs): a secret is
// pending only while a value for it is at hand.
export function engineHints(m: HandlerMemory, available: Set<string>, extraPending: Iterable<string> = []) {
  const pending = new Set([...m.pending, ...extraPending]);
  return {
    handlers: {
      pending: (definitionId: string, property: string) => {
        const name = handlerSecretName(definitionId, property);
        return pending.has(name) && available.has(name);
      },
      empty: (definitionId: string) => m.empty[definitionId] ?? [],
    },
  };
}
