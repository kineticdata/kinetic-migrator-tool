# Concepts

The mental model behind Kinetic Migrator. Read this once; the
[User guide](USER-GUIDE.md) and the [command line](CLI.md) then make sense
on their own. For the full engine reference, see [PROMOTING.md](PROMOTING.md).

## Environments and the pipeline

An **environment** is one Kinetic space: a name (`dev`, `test`, `prod`), a
URL and an admin account. A project's environments form a **pipeline**, an
order in which changes move: Dev → Test → Prod. The order is a convenience
(Overview lanes, the default "Compare with" target); you can compare and
promote between any two environments.

An environment marked **Protected** (`"readOnly": true` in its file) is only
ever read. Every read uses a client that refuses any request other than
GET to the Core, Task and Integrator APIs, and apply refuses a Protected
target before it starts. Mark the space you promote from as Protected if
nobody should change it through the tool.

To **promote** is to make the target match the source for the items you
choose, by creating and updating them. Promoting never deletes.

## Snapshots

A **snapshot** is a full read of one environment, written to
`snapshots/<env>/` in the project as one JSON file per item:

- bookkeeping fields (when and by whom an item was created or updated, lock
  versions) are stripped,
- secrets are removed,
- keys are sorted, so the same space always produces the same files.

Re-snapshotting an unchanged space changes nothing, so the git history shows
exactly what changed between two snapshots. In the app every snapshot is a
commit (`Snapshot of Dev`) with a `Platform:` trailer naming the version it
was taken from.

Explore, Compare and the Overview read snapshots, which makes them instant.
A plan always reads the **target live**, so it is never based on a stale
copy of the place it writes to.

## Items and keys

Each thing Kinetic Migrator promotes is an **item** with a **key**: its file
path under the snapshot folder, without `.json`.

| Item | Key |
|------|-----|
| Space settings | `space` |
| Team | `teams/<name>` |
| Bridge model | `models/<name>` |
| File resource | `file-resources/<slug>` |
| Connection | `connections/<name>/connection` |
| Operation | `connections/<connection>/operations/<name>` |
| Kapp | `kapps/<kapp>/kapp` |
| Form | `kapps/<kapp>/forms/<form>/form` |
| Reference data of a form | `kapps/<kapp>/forms/<form>/data` |
| WebAPI | `webapis/<slug>`, `kapps/<kapp>/webapis/<slug>` |
| Workflow | `workflows/<event>/<name>`, `kapps/<kapp>/workflows/<event>/<name>`, `kapps/<kapp>/forms/<form>/workflows/<event>/<name>` |
| Task handler | `handlers/<definitionId>/handler` (with `package.zip` beside it) |
| Global routine | `routines/<name>` |
| Workflow category | `task-categories/<name>` |

An item that has children gets its own folder with its definition inside, so
a form's folder holds `form.json`, its `workflows/` and its `data.json`.

Workflow categories keep the key prefix `task-categories/` (the Task API's
name for them), although the app calls them workflow categories.

Items are matched across environments by key. Two kinds also carry an id
that must agree: connections and operations keep the same id in every
environment, because forms and workflows refer to them by id. A connection
or operation with the same name but a different id in the target (one
created there by hand) is a plan error to reconcile by hand. Workflows are
matched by scope, event and name, never by id.

**Entries** are parts of an item that can be removed on their own: the
space's attribute definitions and security policy definitions; a kapp's
attribute definitions, security policy definitions, form types, categories
and integrations; a workflow category's handlers and routines. An entry's key
is `<item key>#<collection>/<name>`, for example
`kapps/services/kapp#categories/hardware` or
`task-categories/Notifications#handlers/mail_send_v1`.

### File-name encoding

Names become file names the same way on every operating system, so a
project committed on a Mac opens on Windows and the other way round:

- Names that are valid file names everywhere stay as they are.
- Characters Windows forbids (`< > : " / \ | ? *` and control characters)
  become `%` and two hex digits: `Departments::IT` is
  `Departments%3A%3AIT.json`. A leading or trailing dot or space is escaped
  the same way.
- Windows device names (`con`, `nul`, `aux`, `com1`…) get their first letter
  escaped: `%63on`.
- A name longer than 80 bytes is cut and ends in `%~` plus 8 hex digits of a
  hash of the full name. The full name is inside the file.
- Two items whose names differ only in letter case (`Ops` and `ops`) would be
  one file on Windows and macOS, so the snapshot stops and names both.

Projects from before this encoding are upgraded once, automatically (see
[PROMOTING.md](PROMOTING.md#3-export)).

## Changesets

A **changeset** is a named selection of item keys from one source
environment, **pinned** to the snapshot commit it was taken from. Promoting a
changeset ships the items exactly as they were in that snapshot, so the set
you tested in Test is the set that reaches Prod, even if Dev has moved on.

A changeset can also hold **removals**: keys of items that are only in a
target, to delete when it is applied there. Removals are bound to the
environment they were chosen for and are planned only against it.

In the app, a selection you have not saved is an unsaved changeset; it is
promoted from the source's newest snapshot.

## Plans

A **plan** is the exact list of what an apply would do to one target. To
build it, Kinetic Migrator reads the target live, applies the target's
environment values to the source items, and compares each item:

| Action | Meaning |
|--------|---------|
| create | Not in the target |
| update | Differs; the field-level differences are listed |
| unchanged | Already the same |
| manual | Differs, but is never written automatically (change it by hand) |
| skip-drift | Changed in the target since it was last promoted; left alone unless you choose to overwrite it |

A plan also lists **errors** that block it (for example a workflow that runs
a handler the target does not have), **warnings**, what **needs attention**,
the **environment values** involved, the **secrets** needed, and the
**removals**. Nothing is written while planning.

When you apply, the plan is worked out again against the live target just
before writing, so a change made in the target after you reviewed the plan
is caught: that item is skipped, not overwritten.

In the app, plans and comparisons are kept in the server's memory. After a
restart a plan link says "This plan has expired; plan again."

## Drift

After an apply, `state/<env>.json` records a fingerprint of each item as it
was promoted into that environment. **Drift** is when an item in the target
no longer matches its fingerprint: someone changed it directly in the
target.

- A drifted item is **not overwritten** by default. In the app you decide per
  item (**Overwrite** or **Keep Test**); on the command line,
  `--overwrite-drift` overwrites every drifted item.
- A removal of an item that changed since it was last promoted, or since you
  reviewed the plan, is not deleted.
- Snapshots record which items drifted, and History shows a "Drift detected"
  entry.
- Environment values (below) are left out of the fingerprint, so changing
  them in the target is not drift.
- Reference data without match fields only ever creates records, so it is not
  subject to drift protection.

Commit `state/` (the app does) so everyone sees the same drift.

## Environment-bound values

Some values must differ per environment. Kinetic Migrator keeps the
target's own value for them instead of copying the source's.

| Mechanism | What it covers | Where it is set |
|-----------|----------------|-----------------|
| Always kept | The space's name, slug, platform component locations (UI location, task server), bundle paths, shared bundle base; each kapp's bundle path | Fixed |
| Space settings kept per environment | Default: `displayType` + `displayValue`, `trustedFrameDomains`, `trustedResourceDomains`, `allowedIps` + `allowedIpsEnabled`. Optional: `loginPage`, `resetPasswordPage`, `afterLogoutPath`, `defaultLocale`, `defaultTimezone`, `sessionInactiveLimitInSeconds` | Settings → Data & values, or `envBoundSpaceFields` in `kinetic-sync.config.json` |
| Environment-specific attributes | Attributes of the space, kapps, forms, teams or kapp categories, by name and optionally by where | Settings → Data & values, or `envBoundAttributes` |
| Handler settings | Every handler property value: a handler already in the target keeps its values; a first install starts from the source's | Automatic |
| Overrides (environment values) | A specific value for one target, plus text replacements | The plan's Environment values step, or `overrides/<env>.json` |

Rules worth knowing:

- A kept setting is never copied from the source, not even on the first
  promotion, and not even when the target's value is empty. The app offers
  the source's value ("Use Dev's value") when the target has none.
- `displayType` and `displayValue`, and `allowedIps` and `allowedIpsEnabled`,
  are pairs: both halves are kept or promoted together.
- An override for a kept setting still applies and wins.
- `replace` rules in an override file rewrite text in every promoted value,
  for example a database name that differs per environment.

## Secrets

Secrets are connection credentials, tokens, passwords and secret handler
properties. A handler property is a secret when its type is encrypted or its
name looks secret (it contains `password`, `passphrase`, `secret`, `token`,
`apikey`, `privatekey`, `credential`, `authorization` and similar).

- **Never exported.** Snapshots, backups and the git history never hold a
  secret value. Credential headers typed as literal values in a connection
  or operation are dropped too; templated ones such as `Bearer {{Token}}`
  are kept.
- **Write-only.** In the app, a secret field shows whether a value is set,
  never the value. Secrets are sent with a plain request and cleared from the
  page as it goes out.
- **Kept in the system keychain**, under the service `kinetic-migrate`, one
  entry per secret, named `<project id>/<environment>/<scope>/<name>`. The
  project id is random, so credentials never follow a folder name.

  | System | Store |
  |--------|-------|
  | macOS | Keychain (through the `security` tool) |
  | Windows | Credential Manager, entries named `kinetic-migrate:…` (through a built-in PowerShell helper) |
  | Linux | Secret Service, such as GNOME Keyring (through `secret-tool`) |

  Without a keychain, secrets are kept in memory until the app stops.
- **Never logged.** The log file, job events, run records and error messages
  are scrubbed of every secret the server has seen.
- **Existing connections are never written.** Sending a connection back to
  the platform can wipe its stored credentials, so a connection that differs
  is shown as manual for you to change by hand. Credentials are asked for
  only when a connection is created.

The command line does not use the keychain: it reads credentials and secrets
from environment variables or a git-ignored `.env.<env>` file (see
[CLI.md](CLI.md#credentials-and-secrets)).

## What is promoted, and what is not

| Promoted | Not promoted |
|----------|--------------|
| Space settings, space attributes, attribute definitions (space, team, user, user profile), security policy definitions | Users |
| Teams (settings and attributes) | Team memberships |
| Bridge models, file resources | Submissions, except reference data you list |
| Integrator connections (created only) and operations | Connection credentials, and any update to an existing connection |
| Kapps: settings, attributes, attribute definitions, security policies, categories, form types, integrations, index definitions | Webhooks (space and kapp) |
| Forms, with their index definitions | Translations |
| Workflows at space, kapp and form level | Built-in handlers (`utilities_*`, `system_*`, and any handler with no downloadable package) |
| WebAPIs at space and kapp level | Built-in (Integrated) workflow categories |
| Task handlers: package and settings | Task policy rules (including those on workflow categories) |
| Global routines, with their inputs and outputs | Secret values of any kind |
| Stored workflow categories, with their handlers and routines | |
| Reference data: records of forms you list | |

Kapps and forms can be left out of every snapshot with `exclude` in
`kinetic-sync.config.json` (`"exclude": { "kapps": ["legacy"], "forms":
["services/old-form"] }`).

## Apply order

Creates and updates run in dependency order, so everything an item needs is
in place first:

1. Space
2. Teams
3. Models
4. File resources
5. Connections, then operations
6. Handlers
7. Routines (a routine that calls another comes after it)
8. Workflow categories (their members exist by now)
9. Kapps
10. Forms
11. WebAPIs
12. Workflows
13. Reference data

Removals run after every create and update, in the reverse order: workflows
and WebAPIs before the routines and handlers they run, operations before
connections.

Each step is safe to repeat. A run that stops part way leaves what it wrote;
nothing is rolled back. Running the same plan again (Resume, or the same
`apply` command) skips what is already in place.

## Platform versions

Kinetic Migrator works with Kinetic Platform 6.x and 7.x. It asks each
environment which version it runs (the Integrator's version endpoint, which
needs no sign-in, then the Core API's) and shows it, for example "Kinetic
Platform 6.1.7".

The version decides one thing: how the tool signs in to the Integrator, the
service behind connections and operations. Core and Task API calls use the
username and password on both versions.

| | 6.x | 7.x |
|-|-----|-----|
| Integrator sign-in | OAuth implicit grant with the username and password; the token lasts 12 hours | A sign-in session, then the authorization code flow with PKCE; the token lasts 5 minutes and is renewed from the same session as needed, so long snapshots and applies keep working |

When the version cannot be read, the 6.x sign-in is tried first and the 7.x
one after it.

- **Sign-in not offered.** If neither sign-in exists on the platform,
  snapshots keep everything else and leave connections and operations out,
  saying why. Comparisons and plans where either side has no connections
  recorded leave connections and operations out entirely: none show as new,
  only in the target or removable.
- **Sign-in refused or failing.** A refusal (wrong password) or a server
  error fails the snapshot or plan with a plain message. A transient failure
  (5xx, 429 or no answer) is tried up to 3 times first.
- **Single sign-on only.** A space that signs people in only with single
  sign-on cannot be used: the tool needs a local account with a password.
- **Different major versions.** Promoting from 6.x to 7.x (or back) is
  allowed, with a warning in Compare and Plan, because the platform may store
  the same item differently.

## What is in a project folder

| Path | What it holds | Committed |
|------|---------------|-----------|
| `kinetic-sync.config.json` | Reference data, excludes, environment-bound attributes and space settings, layout version | Yes |
| `kinetic-migrate.json` | The app's project data: display name, pipeline order, commit author, secrets id | Yes |
| `environments/<env>.json` | Each environment's `url` and `readOnly` | Yes |
| `snapshots/<env>/` | Each environment's newest snapshot | Yes |
| `state/<env>.json` | Drift fingerprints of what was promoted into each environment | Yes |
| `overrides/<env>.json` | Environment values for each target | Yes |
| `changesets/<id>.json` | Saved changesets (app) | Yes |
| `runs/` | A record of each apply: items, outcomes, acknowledgements, values used (app) | Yes |
| `plans/` | Plan records, platform versions seen, working folders | No |
| `backups/` | Pre-apply backups (command line; the app commits backups instead) | No |
| `compares/` | Comparison reports (command line) | No |
| `.env.<env>` | Credentials and secrets for the command line | No |

The `.gitignore` the tool writes keeps the last four out of git. Reference
data can contain real records, so check what you list before pushing a
project anywhere.
