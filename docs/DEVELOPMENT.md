# Development

How Kinetic Migrator is built, how to run and test it, and how to extend
it. For what the tool does, read [Concepts](CONCEPTS.md) and
[PROMOTING.md](PROMOTING.md) first.

## Architecture

Three layers, each usable without the one above it:

| Layer | Where | What it is |
|-------|-------|------------|
| Engine | `lib/sync/` | Plain JavaScript (ES modules), no runtime dependencies. Reads and writes Kinetic spaces, snapshots, plans, applies, compares, removals, drift state. The CLI and the server both call it. |
| Server | `app/server/` | TypeScript on `node:http`. A local API over the engine: projects as git repositories (isomorphic-git), environments, the secrets store, jobs, history, changesets, plans and runs. Serves the built web app. |
| Web app | `app/web/` | React 18 with Vite, Tailwind CSS 4, TanStack Query and Radix UI. Talks only to the local API. |

`app/shared/` holds the TypeScript types of the API, shared by server and
web. `kinetic-migrate.mjs` is the CLI: it runs engine commands directly, and
for `ui` it imports the bundled server from `dist/server.mjs`.

### Jobs and live progress

Anything long (snapshot, compare, plan, apply, push) is a **job**:

1. A `POST` starts it and answers `202 { jobId }`.
2. `GET /api/jobs/:id/events` streams its events as server-sent events
   (progress, item states, log lines, warnings, the result), replaying what
   was already sent. The web app reads the stream with `fetch` and falls
   back to polling `GET /api/jobs/:id` if the connection drops.
3. `DELETE /api/jobs/:id` cancels it through an `AbortSignal` the engine
   checks between steps.

Jobs live in memory (`app/server/jobs.ts`). A write job takes a lock on
`<project>/<env>`, so only one snapshot or apply runs against an environment
at a time (`409 locked`). Comparisons and plans are also kept in memory and
are lost when the server stops.

### Security of the local server

The server is reachable only from this computer, and only by the browser
tab it opened:

- **Loopback only.** It listens on `127.0.0.1`.
- **Launch key.** Each start generates a random 32-byte key. The printed
  link `http://localhost:<port>/?key=<key>` is exchanged once for an
  `HttpOnly`, `SameSite=Strict` cookie named `km_session_<port>` (port-scoped
  so two instances do not clash), and the browser is redirected to `/`. The
  key is never logged.
- **Every `/api` request** needs that cookie (compared in constant time) and
  the header `X-Kinetic-Migrate: 1`, which a cross-site form or image cannot
  send (a CSRF guard).
- **Host check.** Every request's `Host` must be `localhost:<port>` or
  `127.0.0.1:<port>`, which defeats DNS rebinding.
- Request bodies are limited to 1 MB; paths with `..` are refused; responses
  carry `nosniff`, `X-Frame-Options: DENY` and `no-referrer`.
- Secrets travel only in request bodies, are never returned (only "is set"
  flags), are scrubbed from every log line, job event, run record and error,
  and are stored only in the system keychain or in memory.

## Repository layout

| Path | What it holds |
|------|---------------|
| `kinetic-migrate.mjs` | CLI entry point |
| `lib/sync/commands.mjs` | `init`, `export`, `computePlan`, `plan`, `apply`, `compare` |
| `lib/sync/artifacts/` | One module per artifact type, plus `index.mjs` (list and apply order) |
| `lib/sync/plan.mjs`, `removals.mjs`, `entries.mjs` | Plan building, removals, sub-collection entries |
| `lib/sync/normalize.mjs`, `env-bound.mjs`, `overrides.mjs` | Normalising, environment-bound values, drift fingerprints, overrides |
| `lib/sync/http.mjs`, `platform.mjs` | API client (read-only and write modes), Integrator sign-in, version detection, redaction |
| `lib/sync/store.mjs`, `layout.mjs` | Snapshot files, file-name encoding, layout upgrade |
| `lib/sync/relationships.mjs`, `summaries.mjs` | Uses / Used by, suggestions, Explore summaries |
| `lib/sync/compare.mjs`, `report.mjs`, `html-report.mjs` | Raw comparison, text and HTML reports |
| `lib/sync/fake-client.mjs`, `fake-platform.mjs` | Test doubles of a Kinetic space |
| `lib/sync/ui-command.mjs` | `kinetic-migrate ui` |
| `app/server/main.ts` | `startServer()` |
| `app/server/http.ts`, `security.ts`, `router.ts` | Request handling and access control |
| `app/server/projects.ts`, `environments.ts`, `project-meta.ts`, `repo.ts` | Projects, environments, credentials, git |
| `app/server/snapshots.ts`, `explore.ts`, `compare.ts`, `runs.ts`, `changesets.ts`, `history.ts`, `repository.ts` | The API behind each screen |
| `app/server/secrets.ts`, `secrets-windows.ts` | Keychain stores (macOS, Windows, Linux, memory) |
| `app/server/log.ts`, `scrub.ts` | Logging and secret scrubbing |
| `app/server/fake-mode.ts` | Synthetic Dev and Test spaces |
| `app/web/src/pages/`, `components/`, `lib/`, `api/` | Screens, components, view logic, API client |
| `e2e/` | Playwright end-to-end journey |
| `scripts/` | Test runner, server bundling, smoke test |
| `docs/` | User and developer documentation; `docs/superpowers/` holds design notes (not packaged) |

## Running in development

Development needs Node 20.19+ or 22.12+ (Vite's requirement).

```
npm install
KM_WORKSPACE=/tmp/km-dev npm run dev
```

`npm run dev` starts Vite on port 5173 and the API server on port 5273
(`tsx watch`, restarting on change), and prints a launch link on Vite's port:
`kinetic-migrate (dev): open http://localhost:5173/?key=…`.

- Set `KM_WORKSPACE` to a scratch folder. Without it the dev server uses the
  current folder (the repository) as its workspace.
- `KM_API=external npm run dev` starts only Vite; run the API yourself with
  `npm run dev:server` (add `-- --workspace <dir>`).
- **Fake mode:** add `KINETIC_MIGRATE_FAKE=1` (in PowerShell,
  `$env:KINETIC_MIGRATE_FAKE=1` first) to serve the synthetic spaces. With
  the built app, use `npm run start:fake` or `kinetic-migrate ui --fake`.

Fake mode (`app/server/fake-mode.ts`, `lib/sync/fake-client.mjs`) serves an
in-memory Dev space for the environment named `dev` and a copy of a Test
space for every other name, with an in-memory secrets store. Dev answers as
Kinetic Platform 6.1.7 and the others as 7.0.0-rc3, including the real
Integrator sign-in flows of each (`lib/sync/fake-platform.mjs`), so the
cross-version warning shows. Applies change the fake space, so a re-plan
after an apply has nothing to do. It is enabled only when the variable is
exactly `1` or `--fake` is passed, and only when no client or secrets store
is injected.

To run the built app: `npm run build`, then `npm start` (or
`npm run start:fake`).

## Tests

| Command | What it runs |
|---------|--------------|
| `npm test` | Engine tests: every `lib/sync/**/*.test.mjs` with `node --test` |
| `npm run test:app` | Web tests (Vitest with jsdom, `app/web/**/*.test.ts(x)`), then server tests (`app/server/*.test.ts` with `node --test` and tsx) |
| `npm run typecheck` | `tsc -b` over server, web and shared types |
| `npm run build` | Web app to `dist/web` (Vite), server to `dist/server.mjs` (esbuild) |
| `npm run smoke` | Starts the built app in fake mode with a workspace whose path has spaces and checks it answers |
| `npm run test:e2e` | Builds, then runs the Playwright journey in fake mode: create a project, add Dev and Test, snapshot both, compare, accept a suggestion, plan, apply, history, a removal, dark theme |
| `npm run docs:screenshots` | Builds, then retakes the walkthrough screenshots in `docs/images/walkthrough/` |

The first e2e run needs a browser: `npx playwright install chromium`.
Screenshots of each step go to `e2e-artifacts/screenshots/` (git-ignored).

`npm run docs:screenshots` builds, then drives the same fake-mode app through
the [walkthrough](WALKTHROUGH.md) journey
(`e2e/walkthrough/walkthrough.shots.ts`, its own Playwright config, so
`npm run test:e2e` stays fast) and rewrites the committed screenshots in
`docs/images/walkthrough/` (1440x900). Run it after a UI change, look at
every picture, and update `docs/WALKTHROUGH.md` if a label or step changed.

`scripts/run-tests.mjs` lists test files itself, because npm runs scripts
with cmd.exe on Windows (no glob expansion) and Node 20's `--test` takes no
patterns.

The Windows Credential Manager round trip
(`app/server/secrets-windows-real.test.ts`) runs for real only on Windows;
elsewhere it is skipped.

### CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request:

- **test** on macOS, Windows and Ubuntu, each with Node 20 and 22:
  `npm ci`, typecheck, `npm test`, `npm run test:app`, the real Windows
  Credential Manager test (Windows only), `npm run build`, `npm run smoke`.
- **e2e** on Ubuntu with Node 22: Playwright with Chromium; screenshots and
  traces are kept as an artifact for 14 days.

## Live checks against real spaces

Unit, server and e2e tests use fakes. Before a release, or after changing
how an artifact is read or written, check against real spaces. See
[LIVE-CHECK.md](LIVE-CHECK.md) for what was checked and how.

- Write only to a **disposable target** space that you are allowed to
  break. Create test items with a recognisable prefix and remove them
  afterwards.
- Mark the source environment **Protected** and never write to a read-only
  source. The read-only client refuses writes, but keep it that way.
- Check every response body and the log file for the passwords used in the
  run: the count must be zero.
- Record what you checked in `LIVE-CHECK.md`, in generic words (no space
  names, URLs or customer data).

## Adding an artifact type

An artifact type is one module in `lib/sync/artifacts/` that exports an
object (or a list of objects, as `connections.mjs` does) with this contract.

### Required

| Field | Meaning |
|-------|---------|
| `type` | The type name, for example `'models'`. It is the `--prune` name and the group in reports. |
| `scope` | `'space'`, `'team'`, `'kapp'`, `'form'`, `'handler'` or `null`: which environment-bound rules (attributes, fixed fields, handler property values) apply to its items, in plans and drift fingerprints. |
| `owns(key)` | True for the keys this module's items have. Keys of different modules must never overlap. |
| `list(client, ctx)` | Reads the environment with the read-only client and returns `[{ key, data, meta, files? }]`. `key` comes from `keyFor(...)` in `store.mjs` (it encodes each segment). `data` is the normalised item that is written to the snapshot: strip metadata with `stripMeta`, remove every secret, sort lists so the output is stable. `meta` holds what apply and prune need but is not compared (ids). `files` holds binary attachments (a handler's `package.zip`). `ctx.config` is the project config; share expensive reads with `cached(ctx, …)`. |
| `apply(client, item, ctx)` | Creates (`item.existing` is null) or updates the target. `item.desired` is the source item after environment values and target-only merges; `item.existing` is `{ key, data, meta }` from the target. It may return `{ skipped: true }`, or `{ attention: '<message>' }` when it wrote something that still needs the user (the run continues, partial). `ctx.warn(message)` adds a warning; `ctx.connectionSecrets(name)` and `ctx.handlerSecrets(definitionId)` give secrets. |

### Optional

| Field | Meaning |
|-------|---------|
| `prune(client, existing, ctx)` | Deletes one target item. Having it makes the type removable (Remove from <target>, `--remove`) and prunable (`--prune <type>`). |
| `namedCollections` | `[{ field, key }]`: lists inside an item whose target-only entries are kept by the default merge (attributes, definitions). |
| `mergeTargetOnly(desired, existingData)` | A custom merge instead of `namedCollections` (workflow category members, handler settings, data rows). |
| `subCollections`, `entryPath(itemKey, field, entry)`, `entryApi` | Entries that can be removed one by one: `subCollections` is `[{ field, key }]` (no `key` for plain ids); `entryPath` gives the collection's endpoint; `entryApi` names the API when it is not `core`. See `entries.mjs`. |
| `updatable: false` | Never update: a differing item is planned as `manual` (connections). |
| `applyable: false` | Never in plans or comparisons (the `task-refs` summary). |
| `wholeLists` | Fields that differ as whole lists instead of element by element. |
| `pendingDiff(desired, existing, hints)` | Writes still needed that the data cannot show (a handler's empty required settings). |
| `availableOnly(desired, existingData, ctx)` | Leaves out what the target cannot take yet; returns `{ desired, warnings, manual? }`. |
| `planInputs(reader, exported, target)` | Extra reads from the target before planning, passed to `availableOnly` and `refuseRemoval`. |
| `preflight(reader, exported)` | Extra plan checks; returns `{ errors, warnings }`. |
| `order(items, { reverse })` | Orders items of this type (routines that call routines). |
| `refuseRemoval(itemKey, data, inputs)` | A reason a target item can never be removed, or null. |

### Wiring it in

1. Add the module to `MODULES` in `lib/sync/artifacts/index.mjs` (list
   order: a module that reads what others collected comes after them) and to
   `APPLY_ORDER` (dependency order: what it needs comes first). `PRUNABLE`
   follows from `prune`.
2. **Explore and Compare tree:** add its key shape and group to
   `app/server/tree-index.ts`, and its kind and labels to
   `app/web/src/lib/tree-layout.ts`, `type-counts.ts`, the group labels in
   `ChangesetTray.tsx` and `ChangesetsPage.tsx`, and the apply phases in
   `app/web/src/lib/plan.ts`.
3. **Summary and relationships:** a readable summary in
   `lib/sync/summaries.mjs`; its edges (what it uses, what uses it, each with
   a reason) in `lib/sync/relationships.mjs`, which also drives suggestions.
4. **Removals:** restore limits and notes in `lib/sync/removals.mjs`, and
   in-use checks if items refer to it by name.
5. **Fake mode:** add it to the fake spaces (`lib/sync/fake-client.mjs`,
   `app/server/fake-mode.ts`) so the e2e journey and demos show it.
6. **Tests:** a `*.test.mjs` beside the module, at least: list output is
   stable and secret-free, create, update, unchanged, prune, and a re-plan
   after apply is unchanged.
7. **Docs:** add it to "What is promoted" in [CONCEPTS.md](CONCEPTS.md), the
   key table, and [PROMOTING.md](PROMOTING.md) if it has special rules.
8. **Live check** it against a disposable space.

## Packaging

```
npm run build
npm pack --dry-run   # check the file list
npm pack
```

`package.json` `files` ships the CLI, the engine (without tests), `dist/`,
the README, the changelog and the user-facing guides in `docs/`.
`docs/superpowers/`, `docs/DEVELOPMENT.md` and `docs/LIVE-CHECK.md` are not
packaged. The package has no runtime dependencies: React, the server's
libraries and everything else are bundled into `dist/` by the build, so
always build before packing.

## Coding rules

- **Secrets are never logged, returned or committed.** Pass them on stdin to
  keychain tools, never argv. New error paths go through the scrubber
  (`scrub.ts`, `log.ts` `redact`). New secret-looking fields use
  `isSecretName` / `isSecretProperty` from `lib/sync/secrets.mjs`.
- **Read-only by construction.** Reads use the `read` client mode, which
  refuses any non-GET request. Only apply opens a `write` client, and never
  for a `readOnly` environment.
- **Nothing is deleted on a guess.** Deletes happen only for explicit
  removals or `--prune`, and only for what the plan showed.
- **Generic naming.** Code, tests, fixtures and docs use generic names
  (`dev.example.com`, "Service portal", "Ticketing"). Never commit customer
  names, real space URLs, usernames, credentials or exported customer data.
  `git grep` for them before you push.
- **The engine stays dependency-free** plain JavaScript with Node built-ins
  only.
- **Plain words in the UI.** Messages say what happened and what to do, in
  the user's terms (environments by name, items by label).
- **Cross-platform.** No shell strings (`execFile` with argv arrays), paths
  through `node:path`, file names through `store.mjs` encoding; test Windows
  path behaviour with `path.win32` where it matters.
