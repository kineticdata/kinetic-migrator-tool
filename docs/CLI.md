# Command line

The `kinetic-migrate` command runs the same engine as the web app, for
scripted promotions and CI. Run it as `kinetic-migrate` after `npm link` or a
global install, or as `node kinetic-migrate.mjs` from the source folder.

```
kinetic-migrate init    [--project <dir>]
kinetic-migrate export  [--project <dir>] --env <name>
kinetic-migrate plan    [--project <dir>] [--from <name>] --to <name> [--overwrite-drift]
kinetic-migrate apply   [--project <dir>] [--from <name>] --to <name> [--yes] [--overwrite-drift] [--prune <type>]... [--remove <key>]...
kinetic-migrate compare [--project <dir>] --from <name> --to <name> [--raw]
kinetic-migrate ui      [--workspace <dir>] [--port <n>] [--no-open] [--fake]
kinetic-migrate help
```

`kinetic-migrate --help` (or `-h`, or `help`) prints the usage. With no
command it prints the usage and exits with 1.

For what snapshots, plans, drift and environment values are, read
[Concepts](CONCEPTS.md). For the detailed engine behaviour (overrides,
handler settings, reference data, removals), read
[PROMOTING.md](PROMOTING.md).

## Common options

| Option | Commands | Meaning |
|--------|----------|---------|
| `--project <dir>` | init, export, plan, apply, compare | The project folder. Default: the current folder. |
| `--env <name>` | export | The environment to snapshot. |
| `--from <name>` | plan, apply, compare | The source environment. plan and apply read its snapshot, `snapshots/<from>/`. compare reads it live. |
| `--to <name>` | plan, apply, compare | The target environment. Always read live. |

Environment names use letters, digits, `-` and `_`.

Before `export`, `plan`, `apply` and `compare`, a project from before the
current file-name layout is upgraded once. The command prints "Upgraded the
project to the new file-name layout (commit these changes):" and the
renames; commit them.

## Exit codes

| Code | When |
|------|------|
| 0 | Success. `apply` with nothing to do is also 0. |
| 1 | `plan`, `compare` (preview) or `apply` found errors in the plan; `apply` was not confirmed; or any command failed. Failures print `kinetic-migrate: <message>` to stderr. |

## Credentials and secrets

The command line does not use the system keychain. It reads credentials and
secrets from environment variables, or from `.env.<env>` in the project (a
git-ignored file of `NAME=value` lines). A variable set in your shell wins
over the file.

`<ENV>` below is the environment name upper-cased, with anything other than
letters and digits turned into `_` (`prod-eu` → `PROD_EU`).

| Variable | Used for |
|----------|----------|
| `KINETIC_<ENV>_USERNAME`, `KINETIC_<ENV>_PASSWORD` | Signing in to the space (Core, Task and Integrator) |
| `KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD>` | A secret auth field of a connection created in `<ENV>`, for example `KINETIC_PROD_SECRET_TICKETING__PASSWORD` or `__CLIENT_SECRET`; also a secret kept in the connection's settings outside its auth, such as a database connection's password (`KINETIC_PROD_SECRET_WAREHOUSE_DB__PASSWORD`) |
| `KINETIC_<ENV>_HANDLER_<DEFINITION_ID>__<PROPERTY>` | A secret property of a handler installed (or re-installed) in `<ENV>`, for example `KINETIC_PROD_HANDLER_MAIL_SEND_V1__PASSWORD` |

Note the double underscore before the field or property. `<CONNECTION>`,
`<DEFINITION_ID>` and `<PROPERTY>` follow the same upper-casing rule;
`<FIELD>` turns `clientSecret` into `CLIENT_SECRET`.

Example `.env.prod`:

```
KINETIC_PROD_USERNAME=admin@example.com
KINETIC_PROD_PASSWORD=...
KINETIC_PROD_SECRET_TICKETING__PASSWORD=...
```

The app keeps the same values in the keychain instead; a project can be used
from both, but each needs its own credentials.

## init

```
kinetic-migrate init --project ../service-portal
```

Creates a project folder with:

- `kinetic-sync.config.json` (empty reference data, excludes and attribute
  rules; the default space settings kept per environment),
- `environments/dev.json` (a placeholder URL with `"readOnly": true`; edit
  it),
- `.gitignore` (keeps `.env.*`, `backups/`, `plans/` and `compares/` out of
  git),
- `.gitattributes` (LF line ends; handler packages are binary).

Files that exist are left alone; `init` warns if an existing `.gitignore`
does not ignore `.env.*` or `compares/`. Add one file per environment in
`environments/`, each with only `url` and, optionally, `readOnly`:

```json
{ "url": "https://test.example.com" }
```

The `url` must start with `https://`. Plain `http://` is accepted only for a
space on this computer (`localhost`, `127.0.0.1`, `[::1]`); any other
`http://` address is refused before anything is sent: "environments/test.json:
This address uses http://, which would send your password unencrypted.
Change it to https://."

## export

```
kinetic-migrate export --project ../service-portal --env dev
```

Takes a snapshot: reads every item of the environment with a read-only
client and rewrites `snapshots/<env>/` to match. Commit the result. It
prints a count per type, and:

- a warning when connections and operations were left out (the Integrator
  sign-in is not available on that platform),
- values that still contain the environment's host name and that no target's
  overrides handle ("3 value(s) still contain dev.example.com with no
  override for "prod""). Fix those before promoting.

## plan

```
kinetic-migrate plan --project ../service-portal --from dev --to test
```

Reads `snapshots/dev/` and the live target, and prints what applying would
do: each item as `create`, `update` (with its field changes), `unchanged`,
`manual` or `skip-drift`, the items only in the target, warnings and errors.
Nothing is written to either environment. A record is saved as
`plans/<to>-<time>.json`. Exits 1 if the plan has errors.

`--overwrite-drift` plans drifted items as updates instead of `skip-drift`.

Without `--from`, `plan` and `apply` read a legacy `export/` folder, only
when the project has no `snapshots/` folder; otherwise they stop with
"Specify --from <env>".

## apply

```
kinetic-migrate apply --project ../service-portal --from dev --to test
```

1. Refuses a target whose file says `"readOnly": true`.
2. Plans, as `plan` does, and prints the plan. Stops if it has errors
   ("Refusing to apply: fix the errors above first.").
3. If there is nothing to do, says so and exits 0.
4. Asks you to type the target's name. `--yes` skips this (for CI). With no
   terminal and no `--yes`, it stops: "No terminal to confirm on; re-run
   with --yes to apply without a prompt".
5. Saves a full snapshot of the target to `backups/<to>-<time>/`.
6. Creates and updates in dependency order, then deletes what you asked for
   (below), in reverse order.
7. Reads the target again and records drift fingerprints in
   `state/<to>.json`. Commit `state/`.

If an item fails, apply stops and says how far it got: "Stopped after 12
change(s). Nothing was rolled back; fix the cause and re-run apply". Every
step is safe to repeat, so run the same command again.

A handler installed without a required setting is reported as needing
attention, and the run carries on (see
[Required handler settings](PROMOTING.md#required-handler-settings)).

| Option | Meaning |
|--------|---------|
| `--yes` | Do not ask for the typed confirmation. |
| `--overwrite-drift` | Overwrite every item changed in the target since it was last promoted, and delete drifted items named by `--remove`. |
| `--remove <key>` | Delete one item that is only in the target. Repeat for more. |
| `--prune <type>` | Delete every item of that type that is only in the target. Repeat for more types. |

### --remove

`--remove` takes an item's key: its path under `snapshots/<to>/` without
`.json` (see [Items and keys](CONCEPTS.md#items-and-keys)).

```
kinetic-migrate apply --from dev --to test \
  --remove teams/Contractors \
  --remove kapps/legacy/kapp \
  --remove 'kapps/services/kapp#categories/old-hardware'
```

- A kapp takes its forms, workflows, WebAPIs and reference data with it; a
  form its workflows and data; a connection its operations.
- An entry key (`<item>#<collection>/<name>`) removes one entry of the
  space, a kapp or a workflow category.
- An item that is still in the source is not removed ("still exists in dev —
  not removed").
- An item that changed in the target since it was last promoted is not
  removed, unless you also pass `--overwrite-drift`.
- Removing the space, a built-in handler, reference data records or the
  `task-refs` summary is refused with an error.
- The plan warns about anything that still uses a removed item ("still used
  by …; removing it may break them"). It does not block the apply.

### --prune

`--prune <type>` deletes **every** item of that type that is only in the
target. It is broad: anything created directly in the target, or removed
from the source, goes. Run `plan` first and read the "only in the target"
list. Prefer `--remove` to delete specific items.

The types are: `teams`, `models`, `file-resources`, `connections`,
`operations`, `kapps`, `forms`, `webapis`, `workflows`, `routines`,
`handlers`, `task-categories` and `data`. Workflow categories use the type
name `task-categories`.

`--prune data` deletes reference data records in the target whose match
fields are not in the source, for entries that have match fields. For an
entry without match fields it deletes nothing and warns.

## compare

```
kinetic-migrate compare --project ../service-portal --from test --to prod
kinetic-migrate compare --project ../service-portal --from test --to prod --raw
```

Reads both environments live with read-only clients, so it works on
Protected environments too. Nothing is written to either, and snapshots are
not used or changed.

- **Preview** (default): the plan you would get after exporting `--from` and
  planning against `--to`, with the target's overrides, environment values
  and drift applied. Exits 1 if that plan has errors.
- **`--raw`**: every difference between the two environments, nothing
  hidden, including environment-bound values and items on only one side.

Each run prints the result and writes two reports to `compares/`:
`<from>-vs-<to>-<time>.json` and `.html`. The HTML page is self-contained;
open it in any browser. Reports can hold reference data values, so
`compares/` is git-ignored.

## ui

```
kinetic-migrate ui [--workspace <dir>] [--port <n>] [--no-open] [--fake]
```

Starts the web app on `127.0.0.1` and opens the browser at a one-time
launch link. Press Ctrl+C to stop.

| Option | Meaning |
|--------|---------|
| `--workspace <dir>` | Where projects are kept. Default: `KineticMigrate` in your home folder. The app warns when it is in a OneDrive, Dropbox, iCloud Drive or Google Drive folder. |
| `--port <n>` | Port 0 to 65535. Default: a free port chosen at start. |
| `--no-open` | Print the address without opening a browser. |
| `--fake` | Serve synthetic Dev and Test spaces from memory (the same as `KINETIC_MIGRATE_FAKE=1`). Unless `--workspace` is given, demo projects go to `kinetic-migrator-demo` in the system temporary folder, never to `~/KineticMigrate`. |

`ui` needs the built app (`npm run build`). In a source checkout without a
build it prints how to build or run the development servers, and exits 1.

On start it prints the address, the workspace and the log file path.

## A scripted promotion

```bash
#!/usr/bin/env bash
set -euo pipefail
P=../service-portal

kinetic-migrate export --project "$P" --env dev
git -C "$P" add -A && git -C "$P" commit -m "Snapshot of Dev" || true

kinetic-migrate plan  --project "$P" --from dev --to test
kinetic-migrate apply --project "$P" --from dev --to test --yes
git -C "$P" add state && git -C "$P" commit -m "Applied Dev to Test" || true
```

The command line promotes everything that differs (there is no selection).
To promote a chosen set, use the app's changesets.
