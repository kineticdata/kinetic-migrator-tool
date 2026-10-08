// Registers the snapshot, explore, compare, changeset, plan/apply and history
// routes on the server's router.
import { registerChangesetRoutes } from './changesets.ts';
import { registerCompareRoutes } from './compare.ts';
import type { ClientFactory } from './engine.ts';
import { registerExploreRoutes } from './explore.ts';
import { registerHistoryRoutes } from './history.ts';
import type { JobRegistry } from './jobs.ts';
import { findProject } from './projects.ts';
import type { Router } from './router.ts';
import { registerRunRoutes } from './runs.ts';
import type { SecretStore } from './secrets.ts';
import { registerSnapshotRoutes, type SyncContext } from './snapshots.ts';

export function registerSyncRoutes(router: Router, opts: { workspace: string; secrets: SecretStore; clientFactory?: ClientFactory; jobs: JobRegistry }): void {
  const ctx: SyncContext = { ...opts, find: (id) => findProject(opts.workspace, id) };
  registerSnapshotRoutes(router, ctx);
  registerExploreRoutes(router, ctx);
  registerCompareRoutes(router, ctx);
  registerChangesetRoutes(router, ctx);
  registerRunRoutes(router, ctx);
  registerHistoryRoutes(router, ctx);
}
