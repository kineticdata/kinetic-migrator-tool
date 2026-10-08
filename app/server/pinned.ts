// Reading pinned content from the project repository: one JSON file at a
// commit, and a snapshot folder at a commit written out (binary attachments
// such as handler packages included) so the engine can read it as a source.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { upgradeTree } from './engine-sync.ts';

export async function readJsonAt(dir: string, commit: string, filepath: string): Promise<unknown> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: commit, filepath });
    return JSON.parse(Buffer.from(blob).toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function resolveCommit(dir: string, ref: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(ref)) return null;
  try {
    const oid = ref.length === 40 ? ref : await git.expandOid({ fs, dir, oid: ref });
    await git.readCommit({ fs, dir, oid });
    return oid;
  } catch {
    return null;
  }
}

// A tree entry name that is one plain file name on every OS: no separator of
// any platform (a `\\` is a separator on Windows), no drive or stream colon,
// not `.`/`..`. Entries the app never writes are skipped, so history from
// elsewhere cannot write outside `dest`.
export const isSafeEntryName = (name: string): boolean => (
  name !== '' && name !== '.' && name !== '..' && !/[/\\:\x00]/.test(name)
);

// Writes every file under `subdir` at `commit` into `dest` (emptied first).
// Returns false when the commit has no such folder.
export async function materializeTree(dir: string, commit: string, subdir: string, dest: string): Promise<boolean> {
  let root: string;
  try {
    root = (await git.readTree({ fs, dir, oid: commit, filepath: subdir })).oid;
  } catch {
    return false;
  }
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const walk = async (oid: string, base: string): Promise<void> => {
    fs.mkdirSync(base, { recursive: true });
    const { tree } = await git.readTree({ fs, dir, oid });
    for (const entry of tree) {
      if (!isSafeEntryName(entry.path)) continue;
      const target = path.join(base, entry.path);
      if (entry.type === 'tree') await walk(entry.oid, target);
      else if (entry.type === 'blob') fs.writeFileSync(target, (await git.readBlob({ fs, dir, oid: entry.oid })).blob);
    }
  };
  await walk(root, dest);
  // A snapshot from before the file-name layout change gets today's names.
  upgradeTree(dest);
  return true;
}
