// Shared contract types for Settings → Repository (no runtime code): the
// commit author, the optional remote and its write-only token, and pushes.

export interface RepositoryAuthor {
  name: string;
  email: string;
}

export interface LastPush {
  at: string;
  ok: boolean;
  // The commit pushed (when it worked).
  commit: string | null;
  // A plain reason when it did not.
  message: string | null;
}

// A project inside the user's own repository (external mode): read-only
// facts about that repository. Kinetic Migrator never commits, changes the
// index or config, or pushes there; its own history of the project is kept
// privately in `historyPath`.
export interface ExternalRepository {
  // The repository's work tree root and its folder name.
  root: string;
  name: string;
  kind: 'repository' | 'worktree' | 'submodule';
  // null when HEAD is detached.
  branch: string | null;
  // The project folder relative to root ('/'-separated, '' at the root).
  subfolder: string;
  // Files in the project folder that differ from the user's last commit
  // (null when it could not be worked out, or before the first count).
  changedFiles: number | null;
  // True while the count is being worked out in the background: ask again.
  checking: boolean;
  // A git operation in progress there: the project is read-only until it ends.
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  historyPath: string;
}

export interface RepositorySettings {
  // managed: the project's own repository, which the app commits to (and can
  // push). external: inside the user's repository (see `external`).
  mode: 'managed' | 'external';
  // Managed: committed in kinetic-migrate.json. External: this computer's
  // private history only.
  author: RepositoryAuthor;
  // The token is never returned: only whether one is stored.
  remote: { url: string | null; token: { has: boolean } };
  lastPush: LastPush | null;
  external?: ExternalRepository;
}

// Fields left out stay as they are. `remoteUrl: null` (or '') disconnects the
// remote and forgets its token; a different `remoteUrl` sent without a token
// also forgets the stored one. `token: null` (or '') forgets the token.
// Addresses must be https:// (http:// only for localhost). Any PUT clears the
// last push outcome.
export interface PutRepositoryRequest {
  author?: RepositoryAuthor;
  remoteUrl?: string | null;
  token?: string | null;
}
