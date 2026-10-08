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

export interface RepositorySettings {
  author: RepositoryAuthor;
  // The token is never returned: only whether one is stored.
  remote: { url: string | null; token: { has: boolean } };
  lastPush: LastPush | null;
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
