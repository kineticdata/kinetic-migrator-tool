// lib/sync/events.mjs
// Structured progress events and cancellation for the commands, so a server
// can drive them. Every call is a no-op when no onEvent callback is given.

export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function createEmitter(onEvent) {
  const emit = (event) => { if (typeof onEvent === 'function') onEvent(event); };
  return {
    progress: (phase, done, total, key) => emit({ type: 'progress', phase, done, total, key }),
    item: (key, status, message, extra) => emit({ type: 'item', key, status, message, ...extra }),
    warning: (message) => emit({ type: 'warning', message }),
    log: (message) => emit({ type: 'log', message }),
  };
}

// Throws CancelledError when the AbortSignal has been aborted.
export function cancelled(signal) {
  if (signal?.aborted) throw new CancelledError();
}
