# kinetic-sync — Environment Promotion Design

Date: 2026-10-07
Status: Approved design

## Goal

Give customers a simple, local, zero-dependency way to export the
configuration artifacts of a Kinetic Platform space into a git repository and
promote them into another environment (dev → test → prod) **without breaking
the target**. It replaces the Ruby `install.rb` / `kinetic_sdk` template flow,
which customers found too complicated and which is destructive by design
(it deletes all kapps and task categories/groups/policy rules before
re-importing).

The tool is **generic**: it is reused across customer projects. No customer,
space name, URL or customer-specific artifact appears in the tool's code,
tests, fixtures, docs or examples. Each customer's configuration and exports
live in a separate **project directory** (typically its own repository).

### Success criteria

- One command exports a space to a git-friendly tree where `git diff` shows
  only meaningful changes, and re-exporting an unchanged space produces no
  diff.
- One command shows exactly what would change in a target (create / update /
  unchanged / target-only, with field-level diffs) without writing anything.
- Apply only adds or updates; it never deletes unless explicitly asked per
  artifact type.
- Exporting → applying into an empty scratch space → planning again yields
  **zero changes** (lossless round trip).
- Secrets never land in the repository, and connection credentials in a
  target are never overwritten.
- An environment marked `readOnly` can never be written to by the tool.

### Decisions made during brainstorming

| Question | Decision |
|---|---|
| Primary use case | Promotion into existing, live environments |
| Scope beyond config | Teams, plus opt-in reference-data submissions. Users excluded. |
| Approach | Zero-dependency Node CLI, per-artifact files, plan/apply |
| Integrator auth | Tool fetches the OAuth token itself from the same credentials |
| Customer data | Lives in a project directory passed with `--project`, never in the tool repo |

## Platform facts the design relies on

Observed read-only against a real customer space:

- Form/kapp integrations and `system_integration_v1` workflow nodes reference
  connections and operations by **raw UUID**.
- Workflows are bound to forms by `platformItemId`, a UUID that differs per
  environment.
- Core `?export=true` works on space/kapp/form/team but **omits workflows**;
  a single workflow GET returns full `treeJson`. WebAPI `/export` returns
  `treeXml`.
- Integrator `GET /api/export/connections/{id}` returns a connection with
  nested operations (secrets `null`); `POST /api/import/connections?force=`
  accepts the connection and operation `id`s, so **IDs can be held constant
  across environments**.
- Environment-specific values are commonly embedded in artifacts: external
  system base URLs, database/schema names inside operation bodies, token
  URLs pointing at the space's own WebAPIs, external object IDs, hard-coded
  submission ids.
- The space carries environment-bound locations (`platformComponents` — UI
  location and task server URL — plus `bundlePath`/`sharedBundleBase`, and
  kapp `bundlePath`) that differ per environment.
- `GET /space` returns `oauthSigningKey` in clear text; connection
  `status.events[].reason` can contain request headers including Basic auth
  credentials. Both must be stripped on export.

## Architecture

Tool (this repository):

```
kinetic-sync.mjs                 # CLI entry: init | export | plan | apply
lib/sync/
  http.mjs                       # fetch wrapper: Basic auth, Integrator token, retries, GET-only guard
  env.mjs                        # project/environment/credential/config loading
  store.mjs                      # export tree read/write, safe file names
  normalize.mjs                  # pure: strip metadata/secrets, stable ordering, env-bound fields
  overrides.mjs                  # pure: per-environment overrides + replace rules
  plan.mjs                       # pure: diff export vs target → plan + preflight results
  report.mjs                     # pure: human-readable plan output
  leftovers.mjs                  # pure: environment-specific value warnings
  state.mjs                      # drift hashes
  commands.mjs                   # export / plan / apply orchestration
  artifacts/<type>.mjs           # one module per artifact type
lib/sync/**/*.test.mjs           # node:test unit tests with synthetic fixtures
docs/PROMOTING.md                # user walkthrough
```

Project directory (one per customer, passed with `--project`, default the
current directory; created by `init`):

```
<project>/
  kinetic-sync.config.json       # data allowlist + key fields, exclusions, env-bound attributes
  environments/<env>.json        # { url, readOnly }
  overrides/<env>.json           # per-environment value overrides
  state/<env>.json               # hashes of what the last apply wrote
  export/                        # committed export tree
  .env.<env>                     # gitignored credentials (mode 0600)
  backups/                       # gitignored pre-apply target exports
  plans/                         # gitignored plan records
  .gitignore                     # written by init
```

Conventions follow `setup.mjs` + `lib/setup-core.mjs`: Node 20+, no npm
dependencies, side-effect-free logic in pure modules with `node:test` tests,
I/O at the edges.

### Artifact module interface

Every artifact type is one module exporting:

- `type`, `scope` (for environment-bound handling), `owns(key)`
- `list(client, ctx)` — enumerate and normalize every instance in an
  environment as `{ key, data, meta }`; used for both export and target
  fetch
- `apply(client, item, ctx)` — create or update in the target
- `prune(client, existing, ctx)` — delete (only reachable via `--prune <type>`)
- optional `namedCollections`, `mergeTargetOnly`, `preflight`, and
  `applyable: false` / `updatable: false` flags

Adding a type (e.g. webhooks) means one new module plus a position in the
apply order.

## Init

`node kinetic-sync.mjs init --project <dir>` creates the project directory
with an empty config, an example environment file, empty overrides and the
`.gitignore`. It never overwrites existing files.

## Export

`node kinetic-sync.mjs export --project <dir> --env <name>`

The client is opened in GET-only mode. Output layout under `<project>/export/`:

```
  space.json                  # settings, attribute definitions, space security policies
  teams/<name>.json
  models/<name>.json
  file-resources/<name>.json
  webapis/<slug>.json
  workflows/<event>/<name>.json
  kapps/<kapp>/kapp.json      # settings, attr defs, policies, categories, form types, integrations, index defs
  kapps/<kapp>/webapis/<slug>.json
  kapps/<kapp>/workflows/<event>/<name>.json
  kapps/<kapp>/forms/<form>/form.json
  kapps/<kapp>/forms/<form>/workflows/<event>/<name>.json
  kapps/<kapp>/forms/<form>/data.json        # only allowlisted forms
  connections/<name>/connection.json         # id retained, no secrets
  connections/<name>/operations/<name>.json  # id retained
  handlers/<definitionId>/handler.json       # installed, non-built-in Task handlers: settings (no secret values: Encrypted or secret-named), packageSha256
  handlers/<definitionId>/package.zip        # the handler package (package defaults only)
  routines/<name>.json                       # Task API global routines (reference only)
  task-refs.json                             # handler and routine definitionIds referenced by workflows/WebAPIs
```

File names are derived from names/slugs and made filesystem-safe; a name
collision after sanitization (including case-only collisions) is an export
error.

### Normalization

- Strip: `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `insertedAt`,
  `lockVersion`, `versionId`, `status` (connection health, index status),
  `platformItemId`, workflow `id`, `oauthSigningKey`, and every connection
  auth secret field (password, client secret, token, etc.).
- Sort object keys; order arrays whose order is not semantically meaningful
  (attribute definitions, policies, teams, categories) by name. Arrays whose
  order matters (form pages/elements, workflow connectors) keep source order.
- Output pretty JSON with a trailing newline.

### Reference data

`kinetic-sync.config.json` lists forms whose submissions are exported:

```json
{
  "data": [
    { "kapp": "<kapp-slug>", "form": "<form-slug>", "key": ["<Field Name>"] }
  ],
  "exclude": { "kapps": [], "forms": ["<kapp-slug>/<form-slug>"] }
}
```

Rows are stored keyed by their key-field values, with submission ids and
timestamps stripped. A form with no configured key cannot be allowlisted.

### Environment-specific value warnings

After export, scan string values for the source URL/host. Report occurrences
not covered by each environment's overrides so leftovers are visible before
promotion.

## Environments, credentials and overrides

`<project>/environments/<env>.json` (committed, no secrets):

```json
{ "url": "https://your-space.kinops.io", "readOnly": true }
```

Mark any environment that must only ever be an export source as
`readOnly: true`.

Credentials: env vars `KINETIC_<ENV>_USERNAME` / `KINETIC_<ENV>_PASSWORD`, or
gitignored `<project>/.env.<env>` (mode 0600). `<ENV>` is the env name
upper-cased with non-alphanumerics as `_`. Process environment variables win
over the file.

### Integrator authentication

The tool obtains the Integrator bearer token itself — the user never handles
it:

1. `GET {url}/app/oauth/authorize?grant_type=implicit&response_type=token&client_id=system`
   with Basic auth and `redirect: "manual"`.
2. Parse `access_token` and `expires_in` from the `Location` header fragment.
3. Cache in memory; refresh when within 30s of expiry or on a 401 (one retry).

Core and Task API calls use Basic auth with the same credentials.

### Overrides

`<project>/overrides/<env>.json` (committed):

```json
{
  "artifacts": {
    "connections/<Connection Name>/connection": { "config.baseUrl": "https://api.prod.example.com" },
    "space": { "attributes.Web Server Url": ["{{targetUrl}}"] }
  },
  "replace": [{ "from": "DEV_DATABASE", "to": "PROD_DATABASE" }]
}
```

- `artifacts` keys are export-relative paths without `.json`; values map
  dot-paths to replacement values.
- `replace` rules are literal, whole-substring replacements applied to every
  string value in every artifact, after `artifacts` overrides.
- `{{targetUrl}}` resolves to the target environment's `url`.
- Overrides are applied at plan/apply time only; the export is always a
  faithful copy of the source.
- An override for an artifact key that is not in the export is warned about.

Override dot-paths address array elements by their `name`, so
`attributes.Environment` targets the `{ "name": "Environment", "values": [...] }`
entry (created if absent). A literal `.` inside a segment is written `\.`.

### Environment-bound fields

Some fields describe *where an environment lives* rather than *what it is
configured to do*, and must never be copied from the source:

| Artifact | Field |
|---|---|
| space | `name`, `slug` |
| space | `platformComponents.*` — UI/app location, task server `url`, agents |
| space | `bundlePath`, `sharedBundleBase` |
| kapp | `bundlePath` |

Rules:

- Export records them (so the source is faithfully described); the list
  lives in one place in `normalize.mjs`.
- Plan/apply replace them with the target's own values before diffing, so
  they never show as changes and the target keeps its own value.
- A value is written only when an override for the target supplies it
  (e.g. `"space": { "platformComponents.app.location": "https://ui.prod.example.com" }`),
  which is also how a newly created kapp gets its `bundlePath`.
- `platformComponents` is sent to the target only when an override changes
  it.

#### Environment-bound attributes

Attribute *values* can also be environment-specific (e.g. a space attribute
`Environment` = `dev` / `test` / `prod`). `kinetic-sync.config.json` lists
them per scope:

```json
"envBoundAttributes": {
  "space": ["Environment"],
  "kapp": [],
  "form": [],
  "team": [],
  "category": []
}
```

Listed attributes follow the same rules as environment-bound fields: never
copied from the source, excluded from diffs and drift, written only from the
target's overrides (`"space": { "attributes.Environment": ["prod"] }`), and
warned about when empty in the target with no override. Unlisted attributes
promote normally and can still be overridden per environment.

### Connection secrets

- Never exported.
- When **creating** a connection, secrets come from
  `KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD>` (env var or `.env.<env>`), e.g.
  `KINETIC_PROD_SECRET_MY_API__PASSWORD` (double underscore between connection and field). If absent, the connection is created
  without them and the plan warns "needs credentials".
- An existing connection is **never updated automatically**. If its
  non-secret fields differ, the plan marks it `manual` and prints the diff to
  apply by hand. This avoids the platform behavior where masked `null`
  secrets in a PUT/PATCH permanently overwrite real credentials, and it holds
  until Integrator partial-update semantics are verified safe. Operations
  carry no secrets and are updated normally.

## Plan

`node kinetic-sync.mjs plan --project <dir> --to <env> [--overwrite-drift]` — read-only.

1. Load the export and apply `<env>` overrides.
2. Fetch and normalize the corresponding target artifacts.
3. Classify each artifact: **create**, **update** (field-level diff),
   **unchanged**, **manual**, **skip-drift**, **target-only**.
4. Preflight checks:
   - Error: workflow uses a handler absent from both the export and the target, or a routine absent from the target.
   - Error: integration references a connection/operation id present in
     neither the export nor the target.
   - Error: target has a connection or operation with the same name but a
     different id.
   - Warning: drift (see below).
   - Warning: new connection without supplied credentials.
   - Warning: reference-data rows will be created/updated on a form whose
     workflows fire on submission events (those workflows will run in the
     target).
   - Warning: environment-bound attribute empty in the target with no
     override.
5. Print a summary and diffs; write `<project>/plans/<env>-<timestamp>.json`;
   exit non-zero on errors.

Sub-items that exist only in the target inside an artifact (e.g. an extra
attribute definition or policy on the target space) are kept: they are
merged into the desired state so they neither show as a perpetual diff nor
get removed by full-replace PUTs.

## Apply

`node kinetic-sync.mjs apply --project <dir> --to <env> [--yes] [--prune <type>]... [--overwrite-drift]`

1. Refuse if the environment is `readOnly`.
2. Recompute the plan; refuse on errors; show it; confirm by typing the
   environment name (skip with `--yes`).
3. Back up the target (full export) to `<project>/backups/<env>-<timestamp>/`.
4. Apply in dependency order:
   1. space settings, attribute definitions, security policy definitions
   2. teams
   3. models, file resources
   4. connections, then operations (Integrator import with ids retained)
   5. kapps — settings, attribute definitions, security policies,
      categories, form types, kapp integrations, index definitions
   6. forms — including form integrations and index definitions; trigger a
      background index build where index definitions changed
   7. WebAPIs
   8. workflows — upserted under the target form/kapp/space path, matched by
      event + name, never by UUID
   9. reference data — upserted by configured key
5. Stop on the first failure and print what was applied. All steps are
   upserts, so re-running resumes safely.
6. On success, re-read the target and write the hash of each promoted
   artifact to `<project>/state/<env>.json`.

Deletes happen only for artifact types named with `--prune`, only for items
shown as target-only in the confirmed plan, and in reverse dependency order.
`--prune data` deletes target rows whose key is not in the export.

### Drift detection

`state/<env>.json` holds the hash of each artifact as last seen after an
apply. During plan, if a target artifact's normalized hash differs from the
recorded hash and the artifact would be updated, it is reported as **drift**
and skipped on apply unless `--overwrite-drift` is given. Artifacts with no
recorded hash (first promotion) are not treated as drift. Drift-skipped and
manual artifacts keep their previous recorded hash.

## Read-only safety

- `http.mjs` takes a `mode` of `read` or `write`. In `read` mode any non-GET
  request throws before it is sent. The OAuth authorize call is a GET.
  Opening a `write` client for a `readOnly` environment throws.
- `export` and `plan` always use `read` mode.
- `apply` uses `write` mode only for targets without `readOnly: true`; the
  plan, backup and post-apply re-read use `read` mode.

## Error handling

- HTTP: retry 429 for any method and 5xx for GET/PUT/DELETE with backoff
  (3 attempts) — never retry a POST on 5xx, to avoid duplicate creates; fail
  fast on other 4xx with method, path and response body (secrets redacted).
- Paginate every list endpoint — never assume a single page. Submissions
  page by `createdAt` cursor with de-duplication so rows sharing a timestamp
  are neither skipped nor duplicated.
- Missing credentials or environment file: clear message naming the expected
  env vars/file.

## Testing

- **Unit (node:test):** normalize, environment-bound fields and attributes,
  overrides, store, http guard/token/retries, artifact modules against a fake
  client, plan diff/classification, preflight checks, drift detection,
  report. Fixtures are synthetic and generic — no customer data.
- **Integration (manual, per customer project):** export a source space
  (read-only) → apply into a disposable scratch space → plan again must
  report zero create/update. A `readOnly` source is never a target.

## Documentation

- `docs/PROMOTING.md`: init → export → commit → review diff in PR → plan →
  apply, plus overrides, environment-bound values, secrets, drift and prune.
- A short pointer in `ONBOARDING.md`.

## Out of scope (now)

Users, built-in handlers, routine
creation (exported for reference; preflight verifies presence), robots,
webhooks (one module to add later), Task API trees not bound to Core
workflows, transactional submissions, deleting sub-items inside an artifact.
