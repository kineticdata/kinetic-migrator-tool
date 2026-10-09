// Work done at most once per API request or job (for example catching an
// external project's private history up with the files on disk), tracked in
// an AsyncLocalStorage scope that the request handler and each job open.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<Set<string>>();

export const inRequestScope = <T>(fn: () => T): T => storage.run(new Set(), fn);

// True the first time `key` is seen in the current scope (always true outside one).
export function firstInScope(key: string): boolean {
  const seen = storage.getStore();
  if (!seen) return true;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
