// Serialises async work per key, so file writes and commits never interleave.
// Not re-entrant: never take a key from inside work already holding it.
const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

// True while work holds (or waits for) `key`.
export const isLocked = (key: string): boolean => locks.has(key);
