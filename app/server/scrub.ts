// Belt and braces for job events and results: replaces every known secret
// value (passwords, keychain secrets, secrets typed for one run) in any
// string, however deeply nested, before it leaves the server process.
const MASK = '••••';

export type Scrubber = <T>(value: T) => T;

export function makeScrubber(secrets: Iterable<string | null | undefined>): Scrubber {
  // Short values would mask ordinary words; secrets are long enough in practice.
  const list = [...new Set([...secrets].filter((s): s is string => typeof s === 'string' && s.length >= 4))]
    .sort((a, b) => b.length - a.length);
  const text = (s: string) => list.reduce((acc, secret) => (acc.includes(secret) ? acc.split(secret).join(MASK) : acc), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return (<T>(value: T): T => (list.length ? (walk(value) as T) : value)) as Scrubber;
}

// Masks known secrets in a thrown error's message, stack and body (engine
// HttpErrors carry the response body), so the job log never holds them.
export function scrubError(err: unknown, secrets: Iterable<string | null | undefined>): unknown {
  if (!err || typeof err !== 'object') return err;
  const scrub = makeScrubber(secrets);
  const e = err as { message?: unknown; stack?: unknown; body?: unknown };
  for (const k of ['message', 'stack', 'body'] as const) {
    if (typeof e[k] === 'string') {
      try { e[k] = scrub(e[k] as string); } catch { /* read-only property */ }
    }
  }
  return err;
}
