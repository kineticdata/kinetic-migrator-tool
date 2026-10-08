# kinetic-migrate UI — Design

Date: 2026-10-08
Status: Approved in brainstorming (decisions below); written for overnight implementation.
Builds on: `2026-10-07-kinetic-sync-design.md` (the engine: export / plan / apply / compare).

## Goal

Replace an embarrassing, script-driven migration process with a clean, intuitive
local app. A customer admin points it at a Kinetic environment, explores what is
there, compares it with another environment, builds a changeset, and migrates it
safely. Technical users get full detail one click away.

### Success criteria

- A customer admin who knows their kapps and forms, but not git, JSON or APIs,
  can promote a set of form changes from Dev to Test without help.
- Every write to an environment is previewed, acknowledged where risky, backed
  up first and recorded in history. Nothing is ever deleted unless chosen
  explicitly.
- No secret value is ever displayed, logged, exported or committed.
- Opening a project and exploring a snapshot is fast (< 1 s for the tree), even
  though a live snapshot takes about a minute to export.
- The CLI keeps working, using the same engine. Nothing is implemented twice.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Users | Both, admin-first: friendly by default, raw detail one click away |
| Changesets | One-off by default, plus "Save as changeset" to name one and promote it through further environments |
| Home | Pipeline strip on every screen + tree/detail workspace; the environment lanes are the Overview tab |
| Explore | Summary-first detail pane with tabs Summary / Relationships / JSON / History |
| Compare & changeset | Tri-state checkboxes in the diff tree, persistent changeset tray, dependency suggestions with a reason, never added or removed silently |
| Plan & apply | Guided steps: Review → Environment values → Confirm → Apply (live checklist) |
| History | Plain-language timeline; git underneath, linear, optional remote |
| Secrets | Write-only everywhere; OS keychain or session memory; a future "Configure" screen must be possible without re-architecture |
| Packaging | npm package with a local web UI (`kinetic-migrate ui`), then a Node single-executable build |
| Code | New repo `kinetic-migrate`; engine `lib/sync` stays plain JS with no runtime deps; app (server + web) in TypeScript |
| Repo engine | isomorphic-git, bundled — customers don't need git installed |
| Built-in handlers | `utilities_*` / `system_*` handlers are never exported or migrated (engine already enforces) |

## Concepts

- **Project**: one customer's migration workspace — a folder that is also a git
  repository managed by the app. It holds environment definitions, overrides,
  snapshots, changesets and run records. Projects live under a workspace root
  (default `~/KineticMigrate/`; configurable), one folder per project.
- **Environment**: a named Kinetic space (`dev`, `test`, `prod`…) with a URL, a
  `readOnly` flag ("protected" in the UI), an order in the pipeline, and
  credentials kept outside the project (keychain).
- **Snapshot**: a full export of one environment at a point in time, stored at
  `snapshots/<env>/` in the project and committed. The newest snapshot per
  environment is what Explore and Compare read; "Refresh" takes a new one.
- **Changeset**: a selection of artifact keys taken from a comparison, with its
  source environment and the source snapshot commit it is pinned to. Saved
  changesets live at `changesets/<id>.json` and can be planned against any
  later environment; they always ship the pinned content.
- **Run**: one plan or apply against a target environment: who, when, the
  selection, acknowledgements, environment values used (never secrets), the
  outcome per item, and the backup snapshot taken before writing. Stored at
  `runs/<timestamp>-<target>.json` and committed.
- **Environment values**: per-environment overrides (`overrides/<env>.json`,
  committed) plus secrets (keychain or session only, never on disk in the
  project).

## Screens

All screens share the **app frame**: a top bar with the project name and the
**pipeline strip** (one pill per environment in pipeline order: name, protected
lock, sync age, drift count; click = switch the active environment) and the tabs
**Overview · Explore · Compare · Changesets · History · Settings**. Light and
dark themes follow the OS, with a manual toggle. Layout works from 1024 px wide;
below that, panes stack.

### Projects (launcher)
List of projects in the workspace root, "New project" (name, first environment)
and "Open folder…". Remembers the last project.

### Overview
Environment lanes left to right (Dev → Test → Prod). Each card shows URL, last
snapshot age, item counts, drift since last promotion, the latest run, and
actions (Refresh snapshot, Explore, Compare with next). Arrows between lanes
show "N differences" once both sides have snapshots, linking to Compare. A
recent-activity list sits below. Empty states guide setup ("Add your first
environment", "Take a snapshot").

### Environment setup (Settings → Environments, and first-run wizard)
Add or edit: name, URL, protected flag, pipeline position, credentials (username
plus a write-only password), "Test connection" (Core `/me` plus the Integrator
token). Credentials go to the keychain. Also: environment-bound attributes and
the reference-data allowlist (kapp, form, key fields) as friendly forms over
`kinetic-sync.config.json`.

### Explore
Left: searchable, filterable **object tree** (Space → Settings / Attributes /
Policies; Kapps → Forms → Workflows, kapp Workflows, WebAPIs; Connections →
Operations; Handlers; Teams; Models; File resources; Routines). Counts per
node. Right: the **detail pane**:
- **Summary**: a per-type card (below).
- **Relationships**: "Uses" and "Used by", each a clickable list.
- **JSON**: the exact normalized artifact, read-only, collapsible, with copy.
- **History**: snapshots and runs that changed this item.
Secrets show as `•••• set` / `not set`, never values.

Per-type summaries (generic key/value fallback for anything else):
- *Form*: kapp, status, type, page and field counts, a field list (name, type,
  required), workflows by event, integrations (connection › operation), index
  definitions, attributes.
- *Kapp*: forms count, categories, form types, attribute definitions, security
  policies, integrations.
- *Workflow*: scope, event, status, filter, node count, handlers and routines
  used.
- *Connection*: type, base URL, auth type (secrets as set / not set), operation
  count. *Operation*: method, path, inputs, outputs.
- *Handler*: version, status, categories, settings (secrets masked), package
  size and hash.
- *Team*: name, description, attributes. *Space*: settings, attribute
  definitions, security policies.

### Compare & changeset
Pick **From** and **To** (defaults: the active environment and the next one).
Mode toggle **Preview** (what promoting From → To would change: overrides,
environment-bound values and drift applied) or **Raw** (every difference).
- **Count bar**: + new, ~ changed, − only in target, ⚠ drifted, plus filters
  (type, status, search), "Only differences" (on by default), Expand all /
  Collapse all.
- **Diff tree**: the same hierarchy as Explore with a status chip per node and
  counts rolled up to parents. **Tri-state checkboxes**: ticking a parent
  selects all its selectable children.
- **Detail pane**: a field-level before/after table (what · To now · From
  incoming) for the selected item; a side-by-side JSON toggle; for drifted items
  a **three-way view** (last promoted · target now · incoming) with per-item
  **Overwrite** or **Keep target**.
- **Changeset tray** (right, always visible): selected items grouped by type,
  each removable. **Suggestions** list each dependency of a selected item that
  is new or changed in From and not yet selected, with a plain reason ("IT
  Request calls operation ServiceNow › Create Ticket, which is new in Dev") and
  Add / Add all. Suggestions are recomputed after every change and are never
  applied silently. Actions: **Review plan →**, **Save as changeset…**.
- Drifted items are not ticked by default.

### Changesets
List of saved changesets: name, description, source environment, pinned
snapshot date, item count, and where each has been applied. Open one to see
its items and diff against any environment, and **Plan against…** a target.

### Plan & apply (guided steps)
Entered from the tray or a saved changeset.
1. **Review**: target (with lock if protected), counts (create / update /
   delete / skip), and a **Needs attention** checklist that must be ticked one
   by one:
   - handler installs or upgrades
   - index rebuilds
   - reference-data rows whose writes fire workflows (named)
   - new connections created without credentials
   - drifted items being overwritten
   - preflight warnings

   Preflight errors (for example a missing routine) block with a plain fix.
   Field-level diffs expand per item.
2. **Environment values**: every environment-bound value and override affecting
   the selected items, From value beside To value (attributes such as Web Server
   Url, connection base URLs, handler settings). Editing saves to
   `overrides/<target>.json`. **Secrets needed** (new connections, handler
   installs) are write-only inputs, used for this run and optionally saved to
   the keychain. Missing required values block step 3.
3. **Confirm**: summary plus "A backup snapshot of <target> is taken first".
   Protected targets require typing the environment name.
4. **Apply**: a live checklist streamed from the server: backup → handlers →
   connections → kapps → forms → WebAPIs → workflows → data. Each item shows
   pending / running / done / failed / skipped. On failure it stops with the
   error in plain words and offers **Resume** (re-plans and continues),
   **View backup** and **Restore…**. On success it shows a summary and links to
   History.

### History
A timeline filterable by environment and event type. Events:
- snapshot taken (with "what changed since previous")
- changeset saved
- plan reviewed
- applied, partially applied or failed
- drift detected
- restore

The detail panel shows who, when, duration, counts and acknowledgements, with
actions: Open in Compare, View plan, Restore… (opens Compare with the backup
snapshot as From, pre-ticking the items that apply touched). Commit hashes
appear under "Advanced" only. Settings → Repository offers "Connect remote"
(URL plus token, kept in the keychain) and Push.

### Configure (future; design must allow it)
Per environment, a list of items with secret settings: connection credentials
and handler secret properties, each `•••• set` / `not set` with a write-only
"Set…" action. The plumbing it needs is specified now (see Secrets), so it is a
screen, not a re-architecture.

## Architecture

### Repository layout (`kinetic-migrate`)
```
kinetic-migrate.mjs           # CLI entry (existing commands + `ui`)
lib/sync/                     # engine — plain JS, zero runtime deps (existing)
  events.mjs                  # NEW: job/event primitives used by commands
  relationships.mjs           # NEW: uses / used-by index over artifacts
  summaries.mjs               # NEW: per-type summary builders (pure)
app/
  shared/                     # TS types for the HTTP API contract (no runtime code)
  server/                     # TS: localhost HTTP server, jobs, projects, repo, secrets
  web/                        # TS + React + Vite + Tailwind + Radix UI
dist/                         # build output (gitignored): web/ and server.mjs
docs/
```
`npm run build` builds the web app (Vite) to `dist/web` and bundles the server,
including isomorphic-git, with esbuild to `dist/server.mjs`. The published
package ships the CLI, `lib/sync` and `dist/`, and declares no runtime
dependencies. `kinetic-migrate ui [--workspace <dir>] [--port <n>] [--no-open]`
starts the server and opens the browser.

### Engine changes (lib/sync)
- **Structured events.** `runExport`, `computePlan`, `runApply` and
  `runCompare` accept an optional `onEvent(event)` callback and return
  structured results. Events: `{ type: 'progress', phase, done, total, key? }`,
  `{ type: 'item', key, status, message? }`, `{ type: 'warning', message }`,
  `{ type: 'log', message }`. The CLI renders them as today's text; the server
  streams them. Existing CLI output stays byte-compatible where tests assert
  it.
- **Injectable environments.** Every run accepts a resolved environment object
  (`{ name, url, readOnly, username, password, vars }`) instead of loading
  `.env` itself; the CLI resolves from `.env` / process env as now, and the
  server resolves from the keychain.
- **Snapshots per environment.** New helper `snapshotDir(project, env)` →
  `snapshots/<env>/`. The UI always uses it. CLI: `export --env X` writes
  `snapshots/X/`, `plan/apply --from X --to Y` read `snapshots/X/`, and the
  legacy `export/` folder is still read when `--from` is omitted (back-compat).
- **Selection.** `computePlan` / `runApply` accept `select: Set<key>`. Only
  selected keys are planned for create / update / delete, and preflight checks
  dependencies against selection ∪ target (a selected form whose operation is
  neither selected nor in the target is an error with a suggestion).
- **Source from memory.** Plans can take `sourceArtifacts` (already exists)
  read from a pinned git commit.
- **Backup as snapshot.** Before writing, apply snapshots the target into
  `snapshots/<target>/` and the server commits it as "Backup before apply"; the
  existing `backups/` folder remains for the CLI.
- **Drift resolution.** `runApply` accepts `resolutions: { [key]: 'overwrite' |
  'keep' }`, replacing the global `--overwrite-drift` for UI runs (the CLI flag
  maps to overwrite-all).
- **Relationships index** (`relationships.mjs`, pure): from artifacts, derive
  edges, each with a reason string:
  - form → kapp
  - workflow → form / kapp
  - form or kapp integration → connection / operation (by id)
  - workflow node `system_integration_v1` → connection / operation
  - workflow or WebAPI → handler and routine (by definitionId)
  - operation → connection
  - form / kapp security policy → policy definition (by name)
  - form categorization → category

  Used for the Relationships tab and changeset suggestions.
- **Summaries** (`summaries.mjs`, pure): per-type summary objects for the
  detail pane (secrets masked), with a generic fallback.
- **Secret setters (for Configure, later).** Each artifact module may expose
  `setSecrets(client, existing, values, ctx)`; handlers already support a
  partial property PUT; connections get one only after their safe secret-only
  update path is verified live. Nothing in the UI reads a secret back.

### Server (app/server)
- **HTTP**: Node `http`, listening on `127.0.0.1` on a random free port (or
  `--port`).
- **Access control**: a random 32-byte session key in the launch URL sets an
  HttpOnly SameSite=Strict cookie. Every `/api` request needs the cookie plus
  the header `X-Kinetic-Migrate: 1`. The Host header must be `localhost:<port>`
  or `127.0.0.1:<port>`, as a DNS-rebinding guard. There is no CORS.
- **Static files**: serves `dist/web` (or proxies Vite in development).
- **Jobs**: snapshot, compare, plan and apply run as jobs in an in-memory
  registry (`id`, `kind`, `status`, `events[]`, `result`). One write job per
  target environment at a time. `GET /api/jobs/:id/events` is Server-Sent
  Events, replaying past events then streaming; `DELETE /api/jobs/:id` cancels
  between items.
- **Projects**: workspace root scanning; create (init folder + repo + files);
  open existing (including CLI-created projects, which become managed on first
  commit).
- **Repo manager**: isomorphic-git; commits after each snapshot, changeset save
  or delete, override edit and run record, with plain messages ("Snapshot of
  Dev", "Applied 'Q4 forms' to Test"). Author from Settings (name and email).
  The log is shown as History. `readTree(commit, path)` reads pinned snapshots.
  Remote push is optional.
- **Secrets store**: an interface with `get`, `set`, `delete` and `has`.
  - **macOS**: `security add-generic-password` / `find-generic-password` via
    `execFile` (no shell).
  - **Windows**: PowerShell `PasswordVault` / CredentialManager via `execFile`.
  - **Linux**: `secret-tool`.
  - **Fallback**: in-memory for the session.

  Service `kinetic-migrate`, account `<projectId>/<env>/<scope>/<name>`.
  Values never cross the API in responses; the API only reports `has`.
- **API** (JSON; all under `/api`). Types live in `app/shared`.
  - **Session and workspace**
    - `GET session` — version, workspace, keychain availability
    - `GET projects`, `POST projects`, `POST projects/open`
    - `GET projects/:p` — environments, pipeline order, last snapshot per env
  - **Environments**
    - `PUT projects/:p/environments/:env`
    - `DELETE projects/:p/environments/:env`
    - `POST …/environments/:env/test`
    - `PUT …/environments/:env/credentials` (write-only)
  - **Config and values**
    - `GET/PUT projects/:p/config` — env-bound attributes, data allowlist
    - `GET/PUT projects/:p/overrides/:env`
  - **Snapshots and explore**
    - `POST projects/:p/snapshots` `{ env }` → job
    - `GET projects/:p/explore/:env/tree` — tree nodes with counts (lazy by `?parent=`)
    - `GET projects/:p/explore/:env/item?key=` — summary, relationships, json, history
    - `GET projects/:p/search/:env?q=`
  - **Compare**
    - `POST projects/:p/compare` `{ from, to, mode }` → job; result `compareId`
    - `GET projects/:p/compare/:id/tree` and `GET projects/:p/compare/:id/item?key=`
    - `POST projects/:p/compare/:id/suggestions` `{ selected: [keys] }` → suggestions with reasons
  - **Changesets**: `GET/POST/PUT/DELETE projects/:p/changesets[/:id]`
  - **Plan and apply**
    - `POST projects/:p/plans` `{ to, changesetId? | { from, selected } }` → job; result planId with items, needs-attention, environment values needed, secrets needed
    - `POST projects/:p/plans/:planId/apply` `{ acknowledgements, values, secrets, resolutions, confirm }` → job
  - **Jobs**: `GET jobs/:id`, `GET jobs/:id/events` (SSE), `DELETE jobs/:id`
  - **History and repository**
    - `GET projects/:p/history?env=&type=`
    - `GET projects/:p/history/:commit`
    - `POST projects/:p/restore` `{ commit }` → compare job
    - `GET/PUT projects/:p/repository` (remote, author), `POST projects/:p/repository/push`
- **Caching**: the snapshot tree index and relationship index are computed once
  per snapshot commit and kept in memory (LRU), so Explore is instant after the
  first load.

### Web (app/web)
- Vite + React 18 + TypeScript, Tailwind CSS, Radix UI primitives (dialog,
  tabs, checkbox, dropdown, tooltip, toast), TanStack Query for server state,
  React Router. Icons from `lucide-react`.
- Design tokens are CSS variables: neutral surfaces; status colours for added
  (green), changed (blue), removed / only-in-target (neutral grey), drift
  (amber), error (red); one accent colour. Typography: system UI stack, with a
  monospace font for keys and JSON.
- Components:
  - `AppFrame`, `PipelineStrip`
  - `ObjectTree` (virtualized, keyboard navigable, tri-state selection mode)
  - `StatusChip`, `CountBar`
  - `DetailPane` with per-type `Summary*` cards
  - `RelationshipsList`, `JsonView` (collapsible, copy)
  - `FieldDiffTable`, `ThreeWayDiff`
  - `ChangesetTray`, `SuggestionsList`
  - `Stepper`, `NeedsAttention`, `EnvironmentValuesForm`, `SecretInput`
    (write-only, shows set / not set)
  - `ApplyChecklist` (SSE-driven)
  - `Timeline`
  - `EmptyState`
- Accessibility: every control is reachable by keyboard, the tree uses ARIA
  `tree` semantics, colour is never the only signal (chips carry text or
  symbols), and contrast meets WCAG AA in both themes.
- Copy: plain words ("Promote", "Environment values", "Backup"), never
  "commit", "artifact" or "override" in primary UI. "Item" replaces "artifact".

## Error handling

- Engine errors map to API errors `{ error: { code, message, detail? } }` with
  plain messages. `HttpError` bodies are already redacted.
- Connection failures in Test connection report the step that failed (Core
  login, Integrator token).
- A job failure mid-apply leaves a run record with per-item outcomes. Resume
  re-plans against the live target and skips items already in the desired
  state.
- The UI never shows stack traces. Advanced → "Copy diagnostic" gives a
  redacted error bundle.

## Security

- Read-only environments: the engine's guard (read clients, `readOnly` refusal)
  stays the enforcement point; the UI only mirrors it.
- Secrets never leave the server process except to the Kinetic API being
  written. Responses, logs, run records, commits and diagnostics never contain
  them; `has(…)` is the only read.
- The server binds to loopback only, with the session key, CSRF header and Host
  check above.

## Testing

- **Engine** (node:test): existing suite plus events, selection, resolutions,
  relationships, summaries and snapshot dirs.
- **Server** (node:test via tsx or compiled): API contract tests against a
  temporary workspace with fake Kinetic clients (the engine's `clientFactory`
  injection), the security checks (missing key / header / bad Host → 401/403),
  job SSE replay, and the secrets store using the in-memory backend.
- **Web** (Vitest + Testing Library): tree selection logic, suggestions tray,
  stepper gating (unacknowledged items and missing values block), and
  SecretInput never rendering a value.
- **End-to-end smoke** (Playwright, dev-only): start the server against a
  fake-backed workspace; walk create project → add env → snapshot → compare →
  select with suggestion → plan → apply.
- **Live** (manual, overnight): snapshot the read-only source and the scratch
  space; compare; promote a small changeset into scratch through the UI; verify
  the re-plan is clean.

## Phases (each ends working, tested, committed)

1. Engine events, injectable environments, snapshots per env, selection,
   resolutions, relationships, summaries.
2. Server skeleton: security, jobs and SSE, projects, environments,
   credentials (keychain), the repo manager, `kinetic-migrate ui`.
3. Web shell, Projects launcher, Overview (pipeline lanes), environment setup,
   snapshots.
4. Explore (tree, search, summaries, relationships, JSON, history).
5. Compare and changeset (diff tree, tri-state, tray, suggestions, saved
   changesets, three-way drift).
6. Plan and apply (stepper, needs attention, environment values, secrets,
   confirm, live checklist, resume, restore).
7. History and repository (timeline, detail, restore, remote push), and
   packaging (`npm run build`, bin).

## Out of scope (now)

- The Configure screen (plumbing only).
- Single-executable packaging.
- Multi-user / hosted mode.
- Approvals.
- A visual workflow-tree diff (JSON / field diff instead).
- Users and team memberships.
- Editing configuration in the tool (it is a migration tool, not an editor).
