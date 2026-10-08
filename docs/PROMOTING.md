# Promoting a Kinetic space between environments

`kinetic-migrate.mjs` exports a space's configuration into a project directory
you keep in git, shows exactly what promoting it would change in another
environment, and applies only those changes. It never deletes anything unless
you ask (by type with `--prune`, or item by item with `--remove` and the app's
Remove action), and it never writes to an environment marked `readOnly`.

You need Node.js 20 or newer. Nothing else is installed.

## What is promoted

Space settings, attribute definitions and security policies; teams (without
memberships); bridge models; file resources; Integrator connections and
operations; kapps (settings, attribute definitions, policies, categories,
form types, integrations, index definitions); forms; WebAPIs; workflows; Task
handlers (package and settings); global routines; and submissions on forms
you allowlist as reference data.

Not promoted: users, team memberships, transactional submissions, built-in
handlers (`utilities_*`, `system_*`, and any handler with no downloadable
package), and webhooks.

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

The upgrade is safe to interrupt: files are moved one at a time inside each
snapshot folder (it is never missing), the renames and the original contents
of `state/` and `overrides/` files are kept in `plans/layout-upgrade.json`
(git-ignored) until it finishes, and running it again carries on where it
stopped. A project with nothing to rename gets no changes at all, only a
local note in `plans/`. Changesets saved before the upgrade keep working
whichever way the project was upgraded: their keys are mapped through the
snapshot they are pinned to.

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

Some values must differ per environment. There are four mechanisms.

**Environment-bound fields** are never copied: the space name and slug, its
platform component locations (UI location, task server URL), bundle paths,
and each kapp's bundle path. The target keeps its own values.

**Space settings kept per environment** are listed in
`kinetic-sync.config.json` as `envBoundSpaceFields`. Promoting never changes
a listed setting: the target keeps its own value, including an empty one
(`null`, `""` or an empty list), on every promotion, the first one included.
The source value is never copied by itself. If the list is left out, it is:

```json
"envBoundSpaceFields": ["displayType", "displayValue", "trustedFrameDomains", "trustedResourceDomains", "allowedIps", "allowedIpsEnabled"]
```

You can also add `loginPage`, `resetPasswordPage`, `afterLogoutPath`,
`defaultLocale`, `defaultTimezone` and `sessionInactiveLimitInSeconds`. You
can remove names so those settings are promoted like any other, and `[]`
keeps none. Two pairs go together because one half means nothing without
the other: `displayType` with `displayValue`, and `allowedIps` with
`allowedIpsEnabled`. List both halves of a pair or neither.

- The app refuses to save an unknown name or half a pair.
- A hand-edited file still loads. An unknown name is ignored, and half a pair
  is treated as the whole pair. Both are reported, as a plan warning and on
  the settings page.
- In the app, edit the list under Settings → Data & values → "Space settings
  kept per environment". There is one checkbox per setting or pair.
- The fixed fields above (name, slug, platform components, bundle paths) are
  always kept, whatever the list says. Kapp settings are not affected.

An override in `overrides/<env>.json` for a listed setting still applies and
wins over the target's value. `replace` rules rewrite text in every value
that is promoted, including the target values carried back for kept settings
and attributes.

When a listed setting is empty in the target and the source has a value:

- The CLI plan notes that the source value is not copied. Set an override to
  use it.
- The app's "Environment values" step shows the setting with the source
  value offered. "Use Dev's value" fills it in, and fills both halves of a
  pair together. Applying then saves it as that environment's value (an
  override). Left empty, the target stays empty.
- A setting that is empty on both sides is not listed. To set one, add an
  override.

Unticking a setting promotes it from then on. Any value it was given by hand
in the target is replaced at the next promotion. This is not reported as
drift, because the setting was kept when the state was recorded.

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
- Keep the space `displayType`/`displayValue` (the portal bundle URL) per
  environment (they are in the default `envBoundSpaceFields`); for a space
  that has none yet, set them once with an override or under Environment
  values.
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

Handlers and global routines in the export are created by apply, so the
plan only reports a missing handler that is not in the export (usually a
handler in no category that the source no longer has installed). Built-in
handlers are never reported. When you promote a selection (in the app), a
workflow, WebAPI or routine that runs a routine the target does not have
(by definitionId, under any name) needs that routine in the selection too;
Compare suggests it.

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
creates and updates in dependency order (handlers, then global routines,
then the WebAPIs and workflows that use them; a routine that calls another
routine comes after it). If something fails it stops and
says how far it got; fix the cause and run it again, since every step is
safe to repeat.

Nothing is deleted unless you name the type: `--prune teams`,
`--prune forms`, `--prune data` (rows not in the export, for entries with
match fields only), and so on. The
types are teams, models, file-resources, connections, operations, handlers,
routines, kapps, forms, webapis, workflows and data.

Routines are exported with their inputs and outputs (the Task API returns
them only when asked: `include=treeJson,details,inputs,outputs`); a snapshot
taken before this version stores them empty. An empty list is never sent
(a routine's interface also lives in its tree, which is promoted), and it
is no difference when the tree's own interface matches the target's; take a
new snapshot of the source to compare the lists themselves.

Global routines are created and updated through the Task API's component
path (`/app/components/task/app/api/v2/trees`; the `/kinetic-task` path
silently drops a routine's inputs and outputs). A new routine is one `POST
/trees` (type `Global Routine`, source and group `-`, with its definitionId,
notes, status, inputs, outputs and tree); a changed one is a `PUT
/trees/<name>` with only the fields that changed and the routine's current
`versionId`. Routines are matched across environments by name.

For handlers, apply installs a new one (upload, then its settings and any
supplied secret values), re-uploads the package with `force` when its
`packageSha256` changed (then re-sends the plaintext settings), and
otherwise sends only the plaintext settings that differ. Other differences
(name, categories, status) come from the package or the console; apply warns
and leaves them for you.

## Removing items from a target

Promoting never deletes. To delete something that is only in the target,
remove it on purpose:

- In the app, Compare shows each item only in the target with a **Remove
  from <target>** action (it has no tick box, a parent tick never selects it,
  and nothing is ever suggested for removal). Removals sit in their own red
  section of the changeset tray and are saved with the changeset (a
  `remove` list beside its keys, and `removeFrom`, the environment they were
  chosen for; changesets saved before removals existed have neither). A
  changeset's removals are planned only against that environment; against
  any other the plan says so and leaves them out. Removals saved without an
  environment are not planned until you confirm one on the changeset's page.
- On the command line, `apply --remove <key>` (repeatable) removes one item
  by its key, its path under `snapshots/<to>/` without `.json`, for example
  `--remove teams/Contractors` or `--remove kapps/legacy/kapp`. `--prune`
  still removes every target-only item of a type.

What happens:

- Only the items the plan shows as **Remove** are deleted. One the plan
  keeps (changed since it was last promoted), finds already gone, or finds
  in the source again (the snapshot being promoted, or the source's newest
  snapshot when a changeset is pinned to an older one: "still exists in
  <source> — not removed") is never sent to apply.
- They are deleted after every create and update, in
  reverse dependency order (workflows and WebAPIs before the routines and
  handlers they run, operations before connections).
- A kapp takes its forms, workflows, WebAPIs and reference data with it; a
  form its workflows and data; a connection its operations. The plan lists
  them, and they are not deleted one by one, with one exception: a kapp's
  or form's workflows are deleted first, through the Core API, because
  deleting the kapp or form leaves their Task trees behind in the Task
  engine (deleting a workflow removes its tree). Afterwards the Task API is
  checked for any tree of those workflows still there; one is deleted by
  title, or reported failed. After the deletes the target is
  read again: anything listed that is still there is deleted on its own (or,
  if that fails, reported as failed, kept in drift state, and the run is
  partial).
- The plan warns about anything that will still use a removed item (a
  workflow running a removed routine, a form calling a removed operation,
  and so on), with **Also remove** for users that are only in the target.
  For teams, models and file resources it also looks by name: a team named
  in a security policy rule or set as an attribute value, a model a form's
  bridged resources use, a file resource named in a value ("may be used
  by"). It is a warning: the apply is not blocked.
- If the item (or anything it takes with it) changed in the target after
  you reviewed the plan, it is not deleted; the run says so and is partial.
  One that is already gone is fine.
- Never removable: the space itself, built-in handlers (`utilities_*`,
  `system_*`), reference data records (use `--prune data`) and the
  `task-refs` summary. A changeset cannot save a removal of an item that
  is in its pinned source snapshot.
- The backup taken before the apply can restore removed items (History,
  Restore…), with limits the plan and the confirm step spell out: a kapp
  or form comes back without its submissions (other than reference data),
  a connection without its credentials, a handler without its secret
  property values, and a team without its members.

### Entries of the space and of a kapp

The space's attribute definitions (space, team, user, user profile) and
security policy definitions, and a kapp's attribute definitions (kapp, form,
category), security policy definitions, form types, categories and
integrations are created and updated with their item. Entries only the
target has are kept and never count as a difference. Compare lists them on
the item under **Only in <target>**, each with its own Remove action. Such
a removal is keyed `<item key>#<collection>/<name>` (for example
`kapps/services/kapp#categories/old-hardware`; the name is encoded like a
file name) and works with `--remove` too. Apply deletes only the chosen
entries, through the collection's own endpoint
(`DELETE /kapps/<kapp>/categories/<slug>`, `DELETE /spaceAttributeDefinitions/<name>`…).
The plan warns when an entry is still in use: an attribute definition set on
the space, a team, the kapp, a category or a form; a category forms are in;
a security policy definition a policy names; a form type forms use. (User
attributes and kapp integrations are not traced.) An entry changed in the
target since review is kept. Restoring the item from the backup brings the
entries back; forms are put back in a removed category only if they are
restored too.

## Drift

After an apply, `state/<env>.json` records what each promoted artifact looked
like. If someone later changes one directly in that environment, the next
plan reports it as drift and apply leaves it alone. Bring the change back
into the source space and re-export, or pass `--overwrite-drift` to replace
it. Commit `state/`.

Environment-bound fields, attributes and handler settings are left out of the
recorded state, so a change to them in the target is not drift. The space's
entry also records which space settings were kept per environment at the
time (`<hash>;space-fields=…`).

When that differs from the current `envBoundSpaceFields`, a precise check is
not possible. This happens after you change the list, or after upgrading
from a version without it. The plan then skips the space's drift check and
warns: "Drift check for the space skipped: kept settings changed since the
last promotion". The space is never reported as drifted on a guess, but a
change made to it in the target in the meantime is not caught either. The
next apply that includes the space records the current list, and later plans
check drift normally.

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
  hidden: environment-bound values, handler references included, and items
  that exist on only one side.

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
