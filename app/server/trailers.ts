// Commit messages: a plain first line, an optional body, then `Key: value`
// trailers that History reads back (environment, run, changeset).
export type Trailers = Record<string, string | null | undefined>;

export function commitMessage(title: string, trailers: Trailers = {}, body?: string): string {
  const lines = Object.entries(trailers)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`);
  return [title.replace(/[\r\n]+/g, ' '), body?.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

export interface ParsedMessage {
  title: string;
  body: string;
  trailers: Record<string, string>;
}

const TRAILER = /^([A-Z][A-Za-z-]*): (.*)$/;

export function parseMessage(message: string): ParsedMessage {
  const blocks = message.replace(/\r/g, '').split(/\n{2,}/);
  const title = blocks.shift() ?? '';
  const trailers: Record<string, string> = {};
  const last = blocks[blocks.length - 1];
  if (last && last.split('\n').every((l) => TRAILER.test(l))) {
    blocks.pop();
    for (const l of last.split('\n')) {
      const m = TRAILER.exec(l);
      if (m) trailers[m[1]] = m[2];
    }
  }
  return { title, body: blocks.join('\n\n'), trailers };
}
