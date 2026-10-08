# Promoting a Kinetic space between environments

`kinetic-migrate.mjs` exports a space's configuration into a project directory
you keep in git, shows exactly what promoting it would change in another
environment, and applies only those changes. It never deletes anything unless
you ask, and it never writes to an environment marked `readOnly`.

You need Node.js 20 or newer. Nothing else is installed.

## What is promoted

Space settings, attribute definitions and security policies; teams (without
memberships); bridge models; file resources; Integrator connections and
operations; kapps (settings, attribute definitions, policies, categories,
form types, integrations, index definitions); forms; WebAPIs; workflows; Task
handlers (package and settings); and submissions on forms you allowlist as
reference data.

Not promoted: users, team memberships, transactional submissions, built-in
handlers (`utilities_*`, `system_*`, and any handler with no downloadable
package), global routines (checked for presence in the target), and webhooks.

## 1. Create a project

Keep each customer's project in its own repository (or a git-ignored
folder), never committed into this repo.

```bash
node kinetic-migrate.mjs init --project ../my-project
```

This creates `kinetic-sync.config.json`, `environments/dev.json` and a
`.gitignore` that keeps credentials, backups, plan records and comparison
reports out of git.

## 2. Describe your environments

One file per environment in `environments/`. Environment names use letters,
digits, `-` and `_`. A file may only contain `url` and `readOnly` (a boolean):

```json
{ "url": "https://your-space.kinops.io", "readOnly": true }
```

Mark the space you export from as `readOnly: true`. Apply refuses to write to
it, and every export and plan reads with a client that cannot send anything
but GET requests.

Credentials go in `.env.<env>` in the project (git-ignored), or in your shell:

```
KINETIC_DEV_USERNAME=you@example.com
KINETIC_DEV_PASSWORD=...
```

`<ENV>` is the environment name upper-cased, with anything other than letters
and digits turned into `_`. The same credentials are used for the Core, Task
and Integrator APIs; the tool fetches the Integrator token itself.

## 3. Export

```bash
node kinetic-migrate.mjs export --project ../my-project --env dev
```

This rewrites `snapshots/dev/` to match the space (each environment has its own
snapshot folder): one JSON file per artifact,
metadata and secrets removed, keys sorted. Commit it. Re-exporting an
unchanged space produces no diff, so a pull request shows exactly what
changed.

An item that has children gets its own folder, with its own definition inside
it: `kapps/<kapp>/forms/<form>/form.json` sits beside that form's `workflows/`
and `data.json`, and `connections/<name>/connection.json` sits beside its
`operations/`. Exploring one item means opening one folder. Exports made
before this layout change must be re-exported.

File and folder names are the item names and slugs, encoded the same way on
every operating system so a project committed on a Mac opens on Windows and
the other way round. Names that are already valid file names everywhere stay
as they are. Otherwise: the characters Windows forbids (`< > : " / \ | ? *`
and control characters) become `%` and two hex digits (`Departments::IT` is
`Departments%3A%3AIT.json`); a leading dot or space and a trailing dot or
space are escaped the same way; Windows device names (`con`, `nul`, `aux`,
`com1`… with any extension) get their first letter escaped (`%63on`); a `%`
is escaped only where it would read as an escape. A name longer than 80
bytes is cut and ends in `%~` plus 8 hex digits of a hash of the full name
(the full name is inside the file), which keeps paths under Windows'
260-character limit in most projects. Two items whose names differ only in
letter case (`Ops` and `ops`) would be one file on Windows and macOS, so
export stops and names both; rename one in the source space.

Projects from before this encoding (which used `_`, layout 1) are upgraded
once, the first time the app opens them or a CLI command runs in them: every
snapshot is renamed from its files' content (the names, slugs, events and ids
the exporter builds file names from), the keys in `state/` and `overrides/`
and in saved changesets follow, `kinetic-sync.config.json` records
`"layoutVersion": 2`, and the app commits "Upgraded project layout" (with the
CLI, commit the changes yourself). Older commits (pinned changesets, backups,
history) are re-keyed the same way when they are read. An item whose new name
cannot be derived from its content with certainty (for example a file edited
by hand so its content no longer matches its name) is left as it is, and a
plan that includes it stops with an error naming it: take a new snapshot.
Nothing is ever created or pruned on a guess.

Each installed handler is exported as `handlers/<definitionId>/handler.json`
(its settings without secret values, with a `packageSha256` of its package) beside
`handlers/<definitionId>/package.zip`. The zip holds the handler's code and
the defaults its author packaged, never the environment's configured
values. Before committing a custom handler, check those defaults (its
`process/info.xml`): an author may have packaged a real server name or
credential. Handlers that are in no category are exported when an
exported workflow, WebAPI or routine uses them.

Export also lists values that still contain the source space's host name and
are not handled by a target's overrides. Fix those before promoting.

## 4. Per-environment values

Some values must differ per environment. There are three mechanisms.

**Environment-bound fields** are never copied: the space name and slug, its
platform component locations (UI location, task server URL), bundle paths,
and each kapp's bundle path. The target keeps its own values.

**Environment-bound attributes** are listed in `kinetic-sync.config.json` and
treated the same way. Each level (`space`, `kapp`, `form`, `team`,
`category`) takes a list of rules. A plain name applies to every item at that
level; an object names the attribute and where it applies:

```json
"envBoundAttributes": {
  "space": ["Environment"],
  "kapp": [{ "name": "Portal Url", "kapp": "services" }],
  "form": ["Owner", { "name": "Queue", "kapp": "services" }, { "name": "Approver", "kapp": "services", "form": "it-request" }],
  "team": [{ "name": "Email", "team": "Service Desk" }],
  "category": [{ "name": "Icon", "kapp": "services", "category": "hardware" }]
}
```

| Level | Where-parts (all optional) |
|-------|----------------------------|
| `space` | none |
| `kapp` | `kapp` (kapp slug) |
| `form` | `kapp` (kapp slug), `form` (form slug) |
| `team` | `team` (team name) |
| `category` | `kapp` (kapp slug), `category` (category slug) |

A where-part that is left out matches any item, so `{ "name": "Owner" }` is
the same as `"Owner"`. Category attributes live inside the kapp, so a
category rule is applied to the categories of each kapp it matches. The
plan's "empty in the target" warning and drift detection use the same
rules. In the app, Settings → Data & values edits these rules and lists
kapps, forms, categories, teams and attribute names from the latest snapshot
(take one first to pick from lists; otherwise type the names).

When the project is loaded, a rule the tool cannot use (an unknown level such
as `"forms"`, a rule without a `name`, a where-part that level does not have)
is ignored and reported: as a plan warning and on the settings page. Saving
the rules from the settings page replaces them; the app refuses to save such
a rule.

**Overrides** in `overrides/<env>.json` set values for one target:

```json
{
  "artifacts": {
    "space": { "attributes.Environment": ["prod"] },
    "connections/My API/connection": { "config.baseUrl": "https://api.example.com" },
    "kapps/services/kapp": { "bundlePath": "services" }
  },
  "replace": [{ "from": "DEV_DATABASE", "to": "PROD_DATABASE" }]
}
```

- Keys under `artifacts` are file paths under a snapshot folder (`snapshots/<env>/`) without `.json`.
- Paths are dot-separated. In a list, a segment matches the item with that
  `name`; setting a plain value on an attribute sets its `values`. Write a
  literal dot as `\.`.
- `replace` rewrites text everywhere in every artifact (operation bodies,
  workflow parameters, and so on).
- `{{targetUrl}}` in an override value becomes the target environment's URL.

### Handler settings

Handler property values (an SMTP server, a port) are environment-bound: a
handler already in the target keeps its own values. A handler being
installed for the first time starts from the exported values, as does a
property the target's copy does not have yet. To set a value for one
target, override the property by name with an object holding `value`:

```json
"handlers/smtp_email_send_v1/handler": { "properties.server": { "value": "smtp.prod.example.com" } }
```

Use the object form. A plain string (`"properties.server": "smtp..."`)
follows the attribute convention and sets `values`, which handlers ignore.
`compare --raw` still shows every value difference.

### Typical environment-specific settings

These came up in a real dev-to-prod round trip:

- List the space attribute `Web Server Url` in `envBoundAttributes.space`, so
  each environment keeps its own.
- Override the space `displayValue` (the portal bundle URL) per environment.
- Add a `replace` rule from the source space host to the target host, for
  example `{ "from": "dev-space.kinops.io", "to": "your-space.kinops.io" }`,
  so self-referencing connection base URLs follow the environment.

## 5. Connection credentials

Secrets are never exported. When a connection is **created** in a target,
its secrets come from variables named
`KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD>` (note the double underscore
before the field), for example:

```
KINETIC_PROD_SECRET_MY_API__PASSWORD=...
KINETIC_PROD_SECRET_MY_API__CLIENT_SECRET=...
```

If a new connection's auth type needs a secret and none is supplied, it is
created with an empty one and the run prints a warning. Set the secret in the
console afterwards.

Credentials typed straight into a header are not exported either. A header
whose name is, or ends in, `Authorization`, `Api-Key`, `Token`, `Secret` or
`Password` (for example `X-Api-Key` or `X-Auth-Token`, but not
`X-Token-Expiry`) is dropped when its value is a literal; a templated value
such as `Bearer {{Token}}` is kept. For an operation, the export lists the
dropped header names (never their values) under `strippedHeaders`. When apply
updates an existing operation, it keeps the target's own values for those
headers. When it creates a new operation, it prints a warning for each
dropped header; add it by hand in the target.

### Secret handler properties

A handler property is treated as a secret when its type is encrypted **or**
its name looks secret. Names are compared ignoring case, spaces, `_`, `-`
and any other separators, so `Private Key`, `private-key`, `private_key` and
`privateKey` are the same. A name is secret when it contains `password`,
`passwd`, `passphrase` (also `Pass Phrase`), `passcode`, `secret`, `token`,
`apikey` (`API Key`, `Api-Key`, `x-api-key`, `api_key`), `privatekey`,
`credential` or `authorization`. Connection auth fields and error-message
redaction use the same rule. It catches secrets stored in plaintext
properties such as `prod_private_key_b64` or `api_token`. `token_url`,
`token_type`, `access_token_url`, `refresh_token_url`, `auth_type`,
`username` and `client_id` (in any separator style) are not secrets. Other
secret-looking names, such as `token_url_override`, are treated as secrets
to be safe.

Secret values are never exported, logged or compared, and overrides cannot
set them. When a handler is **installed** in a target, each one comes from
`KINETIC_<ENV>_HANDLER_<DEFINITION_ID>__<PROPERTY>`, where `<PROPERTY>` is the
property name upper-cased with anything other than letters and digits turned
into `_` (note the double underscore), for example:

```
KINETIC_PROD_HANDLER_SMTP_EMAIL_SEND_V1__PASSWORD=...
KINETIC_PROD_HANDLER_SMTP_EMAIL_SEND_V1__PROD_PRIVATE_KEY_B64=...
```

Each secret property with no variable is left unset, and the run prints a
warning; set it in the target console. Updates never send secret values, so
the target keeps its own. The one exception is a package re-install (the
package changed): apply then re-sends each secret that has a variable set,
and warns for each one without a variable so you can check it in the
console.

Existing connections are never written, because sending a connection back
to the platform can wipe its stored credentials. If one differs, the plan
marks it `manual` and shows the difference so you can change it in the
console.

## 6. Reference data

To promote the records of a lookup or configuration form, list its kapp and
form. Two parts are optional: which records (`filter`) and the fields that
match a record across environments (`key`, "Match records by" in the app):

```json
"data": [
  { "kapp": "services", "form": "categories", "key": ["Code"] },
  { "kapp": "services", "form": "settings", "key": ["Name"], "filter": [{ "field": "Scope", "value": "Global" }] },
  { "kapp": "services", "form": "messages" }
]
```

**Which records.** `filter` is a list of Field = Value conditions; a record is
promoted only when every condition holds (a list value, such as checkboxes,
matches when it contains the value). The filter is applied to the records
read from each environment, not as a search query, so no index is needed.
Records outside the filter are ignored on both sides: in the target they are
never compared, updated or deleted. With no filter, every record is promoted.
With match fields, a target record outside the filter that has the same key
as a source record is not seen either, so the source record is created
alongside it (and fails if the form has a unique index on the key); keep the
filter on fields that agree between environments.

**With match fields** (`key`), records are matched by those fields in every
environment: a record the target lacks is created, a changed one is updated
in place, and `--prune data` deletes target records whose key is not in the
source. Two source records with the same key, or a record with an empty key
field, stop the export with an error.

**Without match fields**, a target record stands for a source record when
every field of the source record has the same value in the target record.
Fields only the target record has (for example one the target form adds or
defaults) are ignored, and an empty source value matches a missing or empty
target value. Each target record stands for at most one source record, so
two identical source records need two target records. Source records the
target does not have are created; nothing is updated or deleted. A record
edited in the source is therefore created as a new record in the target
(the plan warns about this), and `--prune data` deletes nothing for that
form (apply warns that it is ignored). Records the target already has show
as unchanged in plans and comparisons, whatever extra fields they carry.
Because nothing is ever overwritten, these forms are not subject to drift
protection.

**Changing the settings.** A snapshot records the match fields and filter it
was taken with. If an entry's match fields (including their order) or filter
change, or the entry is removed, a plan from an older snapshot stops with
`<kapp>/<form>: reference-data settings changed since the snapshot of <env>
was taken — take a new snapshot` (or `no longer in the reference-data
settings`), instead of matching records read in two different ways. Take a
new snapshot of the source, and of the target if you compare snapshots. An
entry added since the snapshot simply has nothing to promote yet.

Creating or updating records runs the target form's submission workflows;
the plan names them.

## 7. Plan

```bash
node kinetic-migrate.mjs plan --project ../my-project --from dev --to test
```

Nothing is written. Each artifact is `create`, `update` (with field-level
differences), `unchanged`, `manual`, `skip-drift`, or only in the target.
Errors (a missing handler or routine, an integration pointing at a
connection that exists nowhere, a connection with the same name but a
different id) make the command exit non-zero. A record is saved under
`plans/`.

Handlers in the export are installed by apply, so the plan only reports a
missing handler that is not in the export (usually a handler in no category
that the source no longer has installed). Built-in handlers are never
reported. Missing global routines must exist in the target: create them in the target's workflow builder from
`snapshots/<from>/routines/<name>.json`.

## 8. Apply

```bash
node kinetic-migrate.mjs apply --project ../my-project --from dev --to test
```

`--from <env>` names the environment whose snapshot (`snapshots/<env>/`) is
promoted; `plan` takes it too. `export/` from older versions is still read
when `--from` is omitted; with neither, the command stops and asks for
`--from`.

Apply shows the plan, asks you to type the environment name (`--yes` skips
this for CI), saves a full export of the target under `backups/`, then
creates and updates in dependency order (handlers before the WebAPIs and
workflows that use them). If something fails it stops and
says how far it got; fix the cause and run it again, since every step is
safe to repeat.

Nothing is deleted unless you name the type: `--prune teams`,
`--prune forms`, `--prune data` (rows not in the export, for entries with
match fields only), and so on. The
types are teams, models, file-resources, connections, operations, handlers,
kapps, forms, webapis, workflows and data.

For handlers, apply installs a new one (upload, then its settings and any
supplied secret values), re-uploads the package with `force` when its
`packageSha256` changed (then re-sends the plaintext settings), and
otherwise sends only the plaintext settings that differ. Other differences
(name, categories, status) come from the package or the console; apply warns
and leaves them for you.

## Drift

After an apply, `state/<env>.json` records what each promoted artifact looked
like. If someone later changes one directly in that environment, the next
plan reports it as drift and apply leaves it alone. Bring the change back
into the source space and re-export, or pass `--overwrite-drift` to replace
it. Commit `state/`.

## Comparing two environments

```bash
node kinetic-migrate.mjs compare --project ../my-project --from test --to prod
node kinetic-migrate.mjs compare --project ../my-project --from test --to prod --raw
```

Both environments are read live with read-only clients, so this works for
`readOnly` environments too. Nothing is written to either environment, and
snapshots are not used or changed.

- **Default (preview)** answers "if `--from` were promoted into `--to` right
  now, what would change?" It is the plan you would get after exporting
  `--from`: the target's overrides, environment-bound fields and attributes,
  and drift state all apply, so expected per-environment differences are
  hidden. It exits non-zero when the plan has errors.
- **`--raw`** shows every difference between the two environments, nothing
  hidden: environment-bound values, routines and handler references
  included, and items that exist on only one side.

Each run prints the result and writes two reports to `compares/`
(`<from>-vs-<to>-<time>.json` and `.html`); their paths are printed at the
end. The HTML page is self-contained: open it in any browser. Reports can
contain reference-data values, so `compares/` is git-ignored.

## Troubleshooting

- **`No credentials for "<env>"`**: set the two variables it names, or add
  them to `.env.<env>` in the project.
- **`is readOnly`**: you are applying to an export-only environment. Check
  `--to`.
- **`Handler … is not installed in the target`**: a workflow or WebAPI uses a
  handler that is neither in the export nor in the target. Install it in the
  source and re-export (it is then promoted), or install it in the target by
  hand, then plan again.
- **`… the same name but id …`**: the connection or operation was created in
  the target by hand. Delete or rename it there so the promoted one (with
  the id forms and workflows expect) can be created.
- **Plan shows changes right after an apply**: the platform added defaults
  on write. Report it; the tool's normalizer should ignore that field.
