// Reading pinned content from the project repository: one JSON file at a
// commit, and a snapshot folder at a commit written out (binary attachments
// such as handler packages included) so the engine can read it as a source.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { upgradeTree } from './engine-sync.ts';
import { g, type ProjectRepo } from './repo.ts';

export async function readJsonAt(repo: ProjectRepo, commit: string, filepath: string): Promise<unknown> {
  try {
    const { blob } = await git.readBlob({ ...g(repo), oid: commit, filepath });
    return JSON.parse(Buffer.from(blob).toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function resolveCommit(repo: ProjectRepo, ref: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(ref)) return null;
  try {
    const oid = ref.length === 40 ? ref : await git.expandOid({ ...g(repo), oid: ref });
    await git.readCommit({ ...g(repo), oid });
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
export async function materializeTree(repo: ProjectRepo, commit: string, subdir: string, dest: string): Promise<boolean> {
  let root: string;
  try {
    root = (await git.readTree({ ...g(repo), oid: commit, filepath: subdir })).oid;
  } catch {
    return false;
  }
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const walk = async (oid: string, base: string): Promise<void> => {
    fs.mkdirSync(base, { recursive: true });
    const { tree } = await git.readTree({ ...g(repo), oid });
    // Windows and macOS would write two names that differ only in letter
    // case into one file, silently.
    const seen = new Map<string, string>();
    for (const entry of tree) {
      const folded = entry.path.normalize('NFC').toLowerCase();
      const other = seen.get(folded);
      if (other !== undefined) {
        throw new Error(`This snapshot holds "${other}" and "${entry.path}", which differ only in letter case and cannot both be written on this computer.`);
      }
      seen.set(folded, entry.path);
    }
    for (const entry of tree) {
      if (!isSafeEntryName(entry.path)) continue;
      const target = path.join(base, entry.path);
      if (entry.type === 'tree') await walk(entry.oid, target);
      else if (entry.type === 'blob') fs.writeFileSync(target, (await git.readBlob({ ...g(repo), oid: entry.oid })).blob);
    }
  };
  await walk(root, dest);
  // A snapshot from before the file-name layout change gets today's names.
  upgradeTree(dest);
  return true;
}
