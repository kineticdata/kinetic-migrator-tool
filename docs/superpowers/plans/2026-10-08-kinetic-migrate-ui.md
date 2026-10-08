# kinetic-migrate UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A local web app (served by `kinetic-migrate ui`) to explore an environment, compare it with another, build changesets and migrate them safely, on top of the existing `lib/sync` engine.

**Architecture:** The engine (`lib/sync`, plain JS, zero runtime deps) gains structured events, injectable environments, per-environment snapshots, selections, drift resolutions, a relationships index and per-type summaries. A TypeScript Node server (`app/server`) exposes a localhost-only JSON + SSE API, manages projects as git repos (isomorphic-git) and keeps secrets in the OS keychain. A React + Vite + Tailwind + Radix UI app (`app/web`) implements the screens. A build bundles both into `dist/`.

**Tech Stack:** Node ≥ 20.6; engine: built-ins only. App: TypeScript, React 18, Vite, Tailwind CSS, Radix UI, TanStack Query, React Router, lucide-react, isomorphic-git, esbuild, tsx, Vitest, Testing Library, Playwright (dev only).

**Spec:** `docs/superpowers/specs/2026-10-08-kinetic-migrate-ui-design.md` (binding). Engine background: `docs/superpowers/specs/2026-10-07-kinetic-sync-design.md`, `docs/PROMOTING.md`.

**Plan granularity ruling:** Engine tasks (1–4) are specified to exact signatures and test cases. App tasks (5–15) are specified by file layout, interfaces, API contracts, behaviours and named test cases. Writing full React code into a plan would double the work without adding safety, so implementers write it against these contracts and reviewers check it against the spec.

## Global Constraints

- `lib/sync` stays plain JavaScript (ES modules) with **no runtime dependencies**; house style: 2-space indent, single quotes, semicolons, header comment per file; locale-independent sorting via `compareText`.
- The published package has **no runtime dependencies**: everything app-side is bundled into `dist/` (esbuild for the server, Vite for the web). `package.json` lists app libraries under `devDependencies` only.
- TypeScript `strict` for `app/**`.
- **Secrets**: never in API responses, logs, run records, commits, snapshots, diagnostics or UI. The API reports only `has`. `SecretInput` never renders a value.
- **Read-only environments**: the engine's guard stays the enforcement point; the server never opens a write client for `readOnly` environments.
- The server binds to `127.0.0.1` only. Every `/api` request requires the session cookie, the header `X-Kinetic-Migrate: 1`, and a Host of `localhost:<port>` or `127.0.0.1:<port>`.
- **No customer names or URLs** in code, tests, fixtures or docs; use dev/test/prod, `your-space.kinops.io`, `api.example.com`. `projects/` is gitignored and holds real local test projects; never commit anything from it.
- Commit after every task; every commit message ends with a blank line then exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `npm test` runs engine tests; `npm run test:app` runs server and web tests; both green before each commit.
- Live checks may **write only** to the environment named `scratch` in `projects/roundtrip-test`; the source environment is read-only.

## Review Focus

1. **A secret value reaching the browser.** For example via an item's JSON tab, a plan's environment values, an error message or a run record. Expected: never. Pinned by server tests that grep every API response in the test suite for the planted secret.
2. **The UI's apply touching unselected items.** Expected: only selected keys (plus explicitly accepted suggestions) are written. Pinned in Task 3 and Task 13.
3. **Stale state after a job.** For example the tree not updating after a refresh snapshot, or the tray holding keys that no longer differ. Expected: query invalidation on job completion, with the tray pruned to current differences. Pinned in Tasks 10 and 12.
4. **Another local process or web page driving the API.** Expected: 401/403 without cookie, header and Host. Pinned in Task 6.
5. **A big space making the tree unusable.** For example 500 or more items, or a kapp with 60 forms. Expected: a virtualized tree and lazy child loading. Pinned in Task 11 with a 2,000-node fixture.

---

## Phase 1 — Engine

### Task 1: Events and injectable environments
**Files:** modify `lib/sync/commands.mjs`, `lib/sync/commands.test.mjs`; create `lib/sync/events.mjs`, `lib/sync/events.test.mjs`.
- `events.mjs` exports:
  - `createEmitter(onEvent)` returns `{ progress(phase, done, total, key), item(key, status, message), warning(message), log(message) }`; each call invokes `onEvent({ type, … })` if provided.
  - `cancelled(signal)`, which throws `CancelledError` when an `AbortSignal` is aborted.
- `runExport`, `computePlan`, `runPlan`, `runApply` and `runCompare` accept optional `env` (a resolved environment object; when given, `loadEnvironment` is not called for that environment), `onEvent`, and `signal`. `runCompare` takes `envs: { from, to }` objects.
  - Export emits `progress('export', i, MODULES.length, type)` per module.
  - Apply emits `item(key, 'running' | 'done' | 'failed' | 'skipped')` and `progress('apply', done, total)`, and checks `signal` between items.
  - Every existing `log(...)` call stays, and is mirrored as `{ type: 'log' }`.
- Return values are now structured: `runExport` returns `{ code, artifacts: count, counts, leftovers }`. Other `run*` functions return objects that still carry `code`. Update `kinetic-migrate.mjs` to use `.code`.
- **Tests:**
  - export emits one progress event per module;
  - apply emits running/done per item in apply order, and a failed item emits `failed` then stops;
  - an aborted signal stops apply between items, with no further writes;
  - passing `env` skips `.env` loading (the project has no `.env.*` file);
  - CLI text output is unchanged (existing tests stay green).
- Commit: `feat(engine): structured events, cancellation and injectable environments`.

### Task 2: Snapshots per environment
**Files:** `lib/sync/commands.mjs`, `kinetic-migrate.mjs`, `lib/sync/commands.test.mjs`, `docs/PROMOTING.md`.
- `snapshotDir(projectDir, env)` → `join(projectDir, 'snapshots', env)`.
- `runExport` writes `snapshotDir(projectDir, env.name)`.
- `computePlan`, `runPlan` and `runApply` take `from` (an environment name):
  - with `from`, the source is `readTree(snapshotDir(projectDir, from))`;
  - with neither `from` nor `sourceArtifacts`, and only legacy `export/` existing, they read `export/` (back-compat);
  - with neither, they error: `Specify --from <env> (snapshots/<env> holds each environment's export)`.
- CLI:
  - `export --env X` writes `snapshots/X/`;
  - `plan` and `apply` accept `--from X`;
  - usage and PROMOTING.md updated, with a migration note: "`export/` from older versions is still read when `--from` is omitted".
- **Tests:** an export lands in `snapshots/<env>`; a plan with `from` reads it; the legacy fallback works; a missing source gives a clear error.
- Commit: `feat(engine): a snapshot folder per environment`.

### Task 3: Selection and drift resolutions
**Files:** `lib/sync/plan.mjs`, `lib/sync/commands.mjs`, tests.
- `buildPlan({ …, select })`: when `select` (a Set of keys) is given, items whose key is not selected are reported as `excluded` (a new action), never applied. `targetOnly` items are only eligible for prune when selected.
- `preflightChecks`: for a selection, a dependency (integration or workflow connection / operation id; handler or routine definitionId) must be in `select ∪ target ∪ (exported but unchanged)`. Otherwise it is an error: `"<key> needs <depKey> (<reason>), which is not selected and not in the target"`.
- `runApply({ select, resolutions })`:
  - `resolutions[key] === 'overwrite'` turns that item's `skip-drift` into `update`;
  - `'keep'` keeps it skipped;
  - `--overwrite-drift` maps to overwrite-all.
- `recordState` records only applied or unchanged selected keys.
- `formatPlan` hides `excluded` items behind a single count line.
- **Tests:** unselected items are never written; a selected form with an unselected new operation gives the preflight error; resolutions work per item; state is recorded only for the selection.
- Commit: `feat(engine): plan and apply a selection with per-item drift resolutions`.

### Task 4: Relationships and summaries
**Files:** create `lib/sync/relationships.mjs`, `lib/sync/summaries.mjs`, and tests.
- `buildRelationships(artifacts: Array<{key,data}>) → { uses: Map<key, Edge[]>, usedBy: Map<key, Edge[]> }` where `Edge = { key, kind, reason }`. Edges as listed in the spec, including:
  - form → kapp (`kind: 'parent'`);
  - workflow → form or kapp (`parent`);
  - operation → connection (`parent`);
  - form or kapp integration → connection and operation (`calls`), matched by id against connection/operation artifacts' `data.id`;
  - workflow `system_integration_v1` node → connection and operation (`calls`);
  - workflow or WebAPI → handler (`runs`, by definitionId → `handlers/<id>/handler`) and routine (`runs`, by `data.definitionId` of `routines/*`);
  - form or kapp `securityPolicies[].name` → the kapp's or space's policy definition (`secured-by`; edge target is the kapp/space key with reason naming the policy);
  - form `categorizations` → kapp (`categorized`).

  Reasons are human sentences, e.g. `IT Request calls operation "Create Ticket" on connection "ServiceNow"`. Dangling references are skipped.
- `suggest({ selected: Set, relationships, changedKeys: Set }) → Array<{ key, forKey, reason }>`: for each selected key, each `uses` edge whose target is in `changedKeys` and not selected, recursively, de-duplicated and stable-sorted.
- `summarize(key, data, type) → { title, subtitle, sections: Array<{ heading, rows: Array<{ label, value }>|items }> }`: per-type builders for form, kapp, workflow, connection, operation, handler, team and space, with a generic fallback (top-level scalars and array counts). Secret values are never included: use `isSecretName` and the handler `isSecretProperty` to render `•••• set` / `not set`.
- **Tests:** each edge kind from a synthetic fixture; suggestions are recursive and de-duplicated; summaries for each type; a secret-named property is never present in summary output (search the JSON string for the planted value).
- Commit: `feat(engine): relationships index, dependency suggestions and item summaries`.

---

## Phase 2 — Server

### Task 5: App scaffold
**Files:** `package.json` (scripts + devDependencies), `tsconfig.base.json`, `app/server/tsconfig.json`, `app/web/tsconfig.json`, `app/web/vite.config.ts`, `app/web/index.html`, `app/web/src/main.tsx` (placeholder), `tailwind.config.ts`, `postcss.config.js`, `app/web/src/index.css`, `vitest.config.ts`, `.gitignore` additions.
- Scripts:
  - `test` (engine);
  - `test:app` (`vitest run` for web + `node --import tsx --test app/server/**/*.test.ts`);
  - `dev` (server on a fixed dev port with Vite middleware);
  - `build` (`vite build` → `dist/web`; esbuild `app/server/main.ts` → `dist/server.mjs`, platform node, format esm, bundle, with lib/sync bundled too);
  - `typecheck` (`tsc -b`).
- Run `npm install`; commit `package-lock.json`.
- **Acceptance:** `npm run typecheck`, `npm run build` and `npm run test:app` (zero tests is OK) all succeed.
- Commit: `chore(app): TypeScript, Vite, Tailwind and test scaffold`.

### Task 6: Server core: security, routing, jobs, SSE
**Files:** `app/server/{main.ts,http.ts,security.ts,router.ts,jobs.ts,errors.ts}` and tests; `app/shared/api.ts` (types).
- `startServer({ workspace, port?, webDir?, secrets?, clientFactory? }) → { url, port, close() }`. It binds `127.0.0.1`, generates the session key, and the launch URL is `http://localhost:<port>/?key=<k>`. `GET /?key=` sets the cookie `km_session` (HttpOnly, SameSite=Strict, Path=/) and redirects to `/`.
- `/api/*` requires the cookie, the `X-Kinetic-Migrate: 1` header and a valid Host, else 401/403. JSON bodies are limited to 1 MB.
- Static files are served from `webDir`, with an SPA fallback to `index.html`.
- Router: tiny method + path-pattern matcher with params; handlers return `{ status?, json }`; errors map via `errors.ts` to `{ error: { code, message } }`.
- `jobs.ts`:
  - `createJob(kind, run: (emit, signal) => Promise<result>)` → id;
  - an in-memory registry;
  - a per-target write lock (`lockKey`);
  - `GET /api/jobs/:id` (status and result);
  - `GET /api/jobs/:id/events` (SSE: replays past events, streams new ones, ends with `event: end`);
  - `DELETE /api/jobs/:id` aborts.
- **Tests:**
  - security: no cookie → 401; missing header → 403; bad Host → 403; a good request → 200;
  - SSE replay includes earlier events;
  - a second write job on the same lock is rejected with 409;
  - aborting cancels.
- Commit: `feat(server): localhost-only API core with jobs and live events`.

### Task 7: Projects, environments, credentials, repo, secrets
**Files:** `app/server/{projects.ts,repo.ts,secrets.ts,environments.ts}` and tests.
- **secrets.ts:**
  - a `SecretStore` interface with `get`, `set`, `delete` and `has`;
  - `KeychainStore` per platform via `execFile` (macOS `security`, Windows PowerShell CredentialManager / PasswordVault, Linux `secret-tool`), with `available()` detection;
  - `MemoryStore`.

  Accounts are `<projectId>/<env>/<scope>/<name>`. Never log values.
- **repo.ts** (isomorphic-git):
  - `ensureRepo(dir)`;
  - `commitAll(dir, message, author)`, which stages adds and deletes and no-ops when clean;
  - `log(dir, { path?, limit })`;
  - `readTreeAt(dir, commit, subdir) → Map<key, data>`, which parses JSON blobs;
  - `setRemote` and `push` (token from SecretStore).

  The project `.gitignore` excludes `.env*`, `backups/`, `plans/` and `compares/`.
- **projects.ts:** list projects in the workspace (folders with `kinetic-sync.config.json` or `environments/`); create (runInit + ensureRepo + first commit); open an existing folder; read the project (environments in pipeline order from `environments/*.json` plus `order` stored in `kinetic-migrate.json`, and last snapshot info per env from the repo log).
- **environments.ts:** CRUD for `environments/<env>.json` (`url`, `readOnly`, keeping the engine's allowed keys). Pipeline order lives in `kinetic-migrate.json`.
  - credentials: `PUT` sets the username and password in the store;
  - `resolveEnv(project, env)` builds the engine env object from the file plus the store, with `vars` holding `KINETIC_<ENV>_SECRET_*` / `HANDLER_*` values from the store;
  - `POST …/test` calls Core `/me` and the Integrator token through the engine client and reports which step failed.
- **API routes** per the spec for session, projects, environments, credentials, config and overrides. Every mutation commits with a plain message.
- **Tests** (temp workspace, MemoryStore, fake fetch):
  - create, list and open a project;
  - add an environment and set credentials;
  - responses never contain the planted password (assert on the serialized response bodies);
  - a commit happens per mutation;
  - test-connection reports a failing step.
- Commit: `feat(server): projects as managed repos, environments and keychain-backed credentials`.

### Task 8: Snapshot, explore, compare, changesets, plans, apply, history
**Files:** `app/server/{snapshots.ts,explore.ts,compare.ts,changesets.ts,runs.ts,history.ts}` and tests.
- **Snapshots:** `POST snapshots {env}` starts a job: engine `runExport` with the resolved env, `onEvent` → emit, writing `snapshots/<env>/`, then a commit "Snapshot of <Env>". The result has counts.
- **Explore:**
  - the tree index is built from the snapshot (cache keyed by commit): node `{ id, label, kind, key?, count, children? }`, with groups Space / Kapps → Forms → Workflows / kapp Workflows / WebAPIs, Connections → Operations, Handlers, Teams, Models, File resources, Routines;
  - `?parent=` returns children (lazy);
  - `item?key=` → `{ summary, relationships: { uses, usedBy }, json, history }`, where json is the normalized data (secrets are already absent from snapshots) and history is the commits touching that file;
  - `search?q=` does a case-insensitive name, slug and field-name match, capped at 200 results.
- **Compare:** `POST compare {from,to,mode}` starts a job:
  - preview runs engine `computePlan` with `from` snapshot artifacts and the live target, or with `snapshots/<to>` when `useSnapshots: true` for instant compares;
  - raw runs `compareArtifacts` over both snapshots.

  The result is stored in memory with an id: a tree with per-node status and counts, plus per-item `{ status, diff, threeWay? }`. `threeWay` = { lastPromoted (the state-hash commit's content via repo log of runs), target, incoming } for drift. `POST compare/:id/suggestions {selected}` uses the engine's `suggest`.
- **Changesets:** CRUD for `changesets/<id>.json`: `{ id, name, description, from, sourceCommit, keys[], createdAt, appliedTo: [{ env, runId, at }] }`, each change committed.
- **Plans:** `POST plans {to, changesetId? | {from, selected}}` starts a job.
  - Source: the pinned commit tree for a changeset (`readTreeAt`), else `snapshots/<from>`.
  - Engine `computePlan` with `select` → `{ planId, items, counts, needsAttention[], environmentValues[], secretsNeeded[], errors, warnings }`.
  - `needsAttention`: handler create or update, index changes (forms or kapps whose `indexDefinitions` differ), the data-workflow warnings, new connections without secrets, drift.
  - `environmentValues`: overrides and env-bound fields or attributes for selected keys, with from and to values.
  - `secretsNeeded`: secret fields of new connections and handler installs, with `has` per field from the store.
- **Apply:** `POST plans/:id/apply {acknowledgements, values, secrets, resolutions, confirm}`. It validates that every needs-attention id is acknowledged, required values are present, and protected targets have `confirm === env name`. It then:
  1. saves `values` to `overrides/<to>.json`;
  2. puts `secrets` into the store if `remember`, otherwise passes them only via `env.vars` for the run;
  3. takes a backup snapshot of the target (commit "Backup of <Env> before applying '<name>'");
  4. runs engine `runApply` with `select`, `resolutions` and onEvent;
  5. writes `runs/<stamp>-<to>.json` and commits "Applied '<name>' to <Env>" (or "Partly applied…");
  6. updates the changeset's `appliedTo`.

  Resume calls apply again with the same planId after re-planning.
- **History:** maps the repo log to events (snapshot / changeset / applied / backup / restore / drift) using commit-message prefixes and run files. `POST restore {commit}` starts a compare job (raw / preview) with the backup tree as From and the live target as To.
- **Tests** (fake clients reuse engine fake-client semantics through `clientFactory`):
  - snapshot → explore tree and item → compare → suggestions → plan with a selection → apply writes only selected keys;
  - a run file, commits and history events are created;
  - a planted secret never appears in any response;
  - apply refuses without acknowledgements or confirmation;
  - a readOnly target is refused.
- Commit: `feat(server): snapshots, explore, compare, changesets, guided apply and history`.

### Task 9: `kinetic-migrate ui`
**Files:** `kinetic-migrate.mjs`, `app/server/main.ts`.
- `ui [--workspace <dir>] [--port <n>] [--no-open]`:
  - in a built install, imports `dist/server.mjs`;
  - in development, prints the instruction to run `npm run dev`;
  - opens the browser via `open`, `start` or `xdg-open` (execFile), unless `--no-open`.

  The default workspace is `~/KineticMigrate`. Usage text and README updated.
- **Test:** CLI arg parsing; startServer is invoked with the options (inject a fake).
- Commit: `feat(cli): kinetic-migrate ui`.

---

## Phase 3 — Web

Shared for Tasks 10–14:
- **API client:** `src/api/client.ts`, fetch with the header and JSON. `useJob(id)` hook: SSE via `EventSource`, collecting events, done or failed state, and invalidating related queries when the job ends.
- **Design tokens** in `index.css` (light and dark, following `prefers-color-scheme` plus a manual toggle stored in localStorage). Status colours as specified.
- **Plain-language copy:** "item", "environment values", "backup", "promote".
- Each screen has loading, empty and error states.
- **Tests:** Vitest + Testing Library on logic-heavy components, with a mocked API.

### Task 10: Shell, projects, environments, overview
- `AppFrame`, `PipelineStrip` (pills per env: name, lock, snapshot age, drift; click sets the active env, stored in the URL).
- Tabs and routes:
  - `/` (projects)
  - `/p/:projectId/overview`
  - `/p/:projectId/explore/:env/*`
  - `/p/:projectId/compare`
  - `/p/:projectId/changesets[/:id]`
  - `/p/:projectId/plan/:planId`
  - `/p/:projectId/history`
  - `/p/:projectId/settings/*`
- **Projects launcher:** list, new, and open folder (path input).
- **First-run wizard:** project name → first environment (URL, protected, username, password via `SecretInput`, Test connection) → take snapshot (live progress) → Overview.
- **Settings → Environments:** add, edit, reorder (pipeline), set credentials, test. Settings → Data & values covers env-bound attributes and the reference-data allowlist.
- **Overview:** lanes with last snapshot, counts, drift, latest run, actions (Refresh snapshot, Explore, Compare with next); arrows show "N differences" (an instant raw compare from snapshots); recent activity.
- **Tests:** SecretInput never renders a value and shows set / not set; the wizard gates Next on a successful test; the pipeline order can be changed.
- Commit: `feat(web): app shell, projects, environment setup and overview`.

### Task 11: Explore
- `ObjectTree`: virtualized (`@tanstack/react-virtual`), lazy children, keyboard navigation (arrows, Enter, Home/End, type-ahead), ARIA tree, search box (server search), type filter, counts.
- `DetailPane` tabs:
  - **Summary**: renders the engine's summary sections as cards, field tables and lists;
  - **Relationships**: Uses / Used by, clickable;
  - **JSON**: collapsible viewer, copy button, monospace;
  - **History**: list of snapshot and run events touching the item.
- "Refresh snapshot" button with live progress.
- **Tests:** a 2,000-node tree renders with fewer than 100 DOM rows; keyboard navigation; a secret shows as `•••• set`.
- Commit: `feat(web): explore an environment`.

### Task 12: Compare and changeset
- From / To pickers (defaults: active env → next); Preview / Raw toggle; "Use latest snapshots (instant)" vs "Check live target" (preview).
- `CountBar`; filters; "Only differences" (default on); Expand / Collapse all.
- `ObjectTree` in diff mode: `StatusChip`s, rolled-up counts, tri-state checkboxes, drifted items unchecked by default.
- Detail: `FieldDiffTable` (path / To now / From incoming, readable path labels), a side-by-side JSON toggle, and `ThreeWayDiff` with Overwrite / Keep target for drift.
- `ChangesetTray`: grouped selected items with remove, `SuggestionsList` (reason, Add, Add all; recomputed on every change), Review plan → (creates a plan job and navigates), Save as changeset… (name, description).
- **Changesets screen:** list (name, from, pinned date, items, applied to) and detail (items, Plan against…).
- **Tests:** tri-state parent and child logic; adding a suggestion recomputes; the tray is pruned when a compare refresh removes a key; drifted items start unchecked.
- Commit: `feat(web): compare environments and build changesets`.

### Task 13: Plan and apply
- `Stepper`: Review → Environment values → Confirm → Apply.
- **Review:** counts, the `NeedsAttention` checklist (each must be ticked), errors with plain fixes (block), expandable per-item diffs.
- **Environment values:** `EnvironmentValuesForm` (from → to, editable to-values, required markers), plus Secrets needed via `SecretInput` and a "Remember in keychain" checkbox.
- **Confirm:** summary, the backup note, and a typed env name for protected targets.
- **Apply:** `ApplyChecklist` grouped by phase, driven by SSE item events, with per-item status; on failure, the error, Resume, View backup and Restore… (navigates to compare with the backup as From).
- **Tests:** Next is blocked until every attention item is ticked and required values are filled; the protected confirm requires the exact name; the checklist reflects streamed events; Resume calls apply again.
- Commit: `feat(web): guided plan and apply with live progress`.

### Task 14: History and repository
- `Timeline` grouped by day, with env and type filters, plus a detail panel (who, when, duration, counts, acknowledgements, values changed; actions Open in Compare, View plan, Restore…; Advanced: commit id).
- **Settings → Repository:** author name and email, connect remote (URL + token via SecretInput), Push, last push status.
- **Tests:** event mapping renders each type; Restore navigates to compare with the right params.
- Commit: `feat(web): history timeline, restore and repository settings`.

---

## Phase 4 — Ship

### Task 15: End-to-end smoke, packaging, docs
- **Playwright smoke:** start the built server against a temporary workspace with a fake engine client (`KINETIC_MIGRATE_FAKE=1` wires the engine fake client with a synthetic two-env fixture), then walk:
  1. create project → add env dev → add env test (both fake) → snapshot both;
  2. compare dev→test → tick a form → accept the suggestion;
  3. Review plan → acknowledge → values → confirm → apply → checklist done;
  4. History shows the apply.
- `npm run build` produces `dist/`; `node kinetic-migrate.mjs ui --no-open --workspace <tmp>` serves the built app.
- README: install, `kinetic-migrate ui`, screenshots placeholder list (text only), the CLI section linking PROMOTING.md.
- Commit: `test(app): end-to-end smoke and packaging`.

### Task 16: Live verification (controller-run)
- With the built app, using `projects/roundtrip-test` (copied into a temp workspace):
  - snapshot `the read-only source space` (read-only) and `scratch`;
  - Explore a form and a handler (secrets masked);
  - compare and build a small changeset (one form + suggestions);
  - plan into `scratch` → apply → re-plan shows nothing to do;
  - check History.
- Record the results and screenshots descriptions in `docs/LIVE-CHECK.md` without any customer names or URLs (refer to "source" / "scratch").
- Fix defects via the normal fix loop.
