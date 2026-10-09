# Changelog

## Unreleased

### Web app

- Projects inside a repository you already have (a monorepo, any subfolder,
  any branch, a linked worktree or a submodule) open and work in
  **external mode**: Kinetic Migrator writes the project's files and leaves
  committing to you. It never commits, stages, pushes or changes the
  branches, index, config, remotes or root `.gitignore` of your repository.
  History, backups, Restore and pinned changesets use a private history
  kept in the app's data folder (`KINETIC_MIGRATOR_DATA_DIR` overrides it).
- Overview and History show which repository and branch the project is in
  and how many of its files changed since your last commit. Settings →
  Repository shows that repository read-only, without remote, token or
  push; the author applies to the private history.
- Branch switches and edits made outside the app are recorded in the private
  history ("Files changed outside Kinetic Migrator") before the app's next
  change. While a merge, rebase, cherry-pick or revert is in progress the
  project is read-only. Bare repositories and broken `.git` files are
  refused with plain messages.
- The refusal to open a repository on a branch other than `main` now applies
  only to repositories Kinetic Migrator created; those are marked with
  `.git/kinetic-migrator.json`. Existing managed projects stay managed.

### Fixed

- **Environment addresses must use `https://`.** Plain `http://` is accepted
  only for this computer (`localhost`, `127.0.0.1`, `[::1]`, any port). A
  project saved with an `http://` address to another machine still opens;
  its environment card, Test connection, snapshots, plans and applies say the
  address would send the password unencrypted, and nothing signs in to it.
  The command line refuses such an environment too.
- **Database connection passwords** (and any other secret-named key in a
  connection's settings outside its auth, such as a SQL connection's
  `password`) are stripped from snapshots like auth secrets. Only their names
  are recorded; creating the connection in a target asks for them
  write-only, and they are never shown, compared or diffed. A snapshot taken
  before this release is stripped the same way whenever it is read, so
  plans, compares, applies and restores from it never send or show the
  stored password and match a new snapshot. Its files and git history still
  hold it: take a new snapshot, and treat the old commits as sensitive.
- **Redirects are never followed with credentials elsewhere.** A request to a
  space follows a redirect only when it is a GET and stays on the
  environment's own https origin (or loopback http). Any other redirect,
  including every redirect of a write (whose body may hold secrets), is an
  error: "The space redirected the request to <address>; not following."
- **A failed snapshot after an apply** is now part of the run, whatever its
  outcome: the Plan page shows the warning and the reason (with "Applied to
  <env>, with a warning", or beside a partial or failed run's error), and
  History adds "snapshot failed" to the run's label.
- **Team "may use" warnings** match whole team names in security policy rules
  and attribute values, so `Ops` no longer matches `DevOps` or `IT::Ops`.
- Messages that pointed at the legacy `export/` folder now name the
  snapshot (`snapshots/<env>/`).

## 0.1.0 — 2026-10-08

The first release of Kinetic Migrator (command: `kinetic-migrate`).

### Web app

- Local web app started with `kinetic-migrate ui`, on `127.0.0.1` only,
  opened through a one-time launch link. Light, dark and system themes.
- Projects in a workspace folder, each a git repository on `main` managed by
  the app: every snapshot, changeset, backup, promotion and restore is a
  commit. Open existing project folders. A first-run wizard: project,
  first environment with Test connection, first snapshot.
- Environments in pipeline order, with add, edit, reorder and remove;
  Protected (read-only) environments; write-only credentials in the system
  keychain; Test connection with Core and Integrator steps.
- Overview: one lane per environment with snapshot age, item counts, drift
  and the latest promotion, and the number of differences between
  neighbours.
- Explore: a searchable tree of an environment's snapshot, with a summary,
  relationships (Uses, Used by), JSON and history for each item.
- Compare: preview (what promoting would change) or raw (every difference),
  against the target's snapshot or the live target; statuses new, changed,
  drifted, manual and only in target; filters, status counts, a three-way
  view for drifted items with Overwrite or Keep.
- Changesets: a tray with explained dependency suggestions; saved
  changesets pinned to their source snapshot, with Plan against and Compare
  with; where each has been applied.
- Plan and apply in four steps: Review (counts, problems with fixes, Needs
  attention, items), Environment values (with secrets needed), Confirm
  (typed environment name), Apply (live checklist). Backup first; Resume,
  View backup and Restore after a partial, failed or cancelled run.
- Removals: Remove from <target> for items and entries only in the target,
  with what goes with them, in-use warnings with Also remove, drift
  protection and restore notes.
- History: a timeline of snapshots, drift, changesets, promotions, backups
  and restores, with details, Open in Compare, View plan and Restore.
- Settings: space settings kept per environment, environment-specific
  attribute rules, reference data with filters and match fields; author for
  History; a remote repository with a write-only token and Push.
- A daily log file in the workspace, scrubbed of secrets.
- Fake mode (`--fake`) with synthetic Dev (6.1.7) and Test (7.0.0-rc3)
  spaces, for demos and the end-to-end test.

### Engine and command line

- `init`, `export`, `plan`, `apply` and `compare` (with `--raw` and JSON and
  HTML reports), and `ui`.
- Promotes space settings, attributes, attribute and security policy
  definitions; teams; bridge models; file resources; Integrator connections
  (create only) and operations; kapps; forms with index definitions;
  workflows; WebAPIs; Task handlers (package and settings); global routines
  with their inputs and outputs; Stored workflow categories with their
  members; and reference data.
- A snapshot folder per environment, stable and secret-free, with file names
  encoded the same way on every operating system, and a one-time upgrade of
  older projects.
- Plans and applies of a selection, in dependency order, with per-item drift
  resolutions; a backup before every apply; drift fingerprints after it.
- Environment-bound values: fixed space fields, configurable space settings
  kept per environment (with linked pairs), scoped attribute rules, handler
  settings, overrides and text replacements.
- Explicit removals (`--remove`, including single entries) and removals by
  type (`--prune`), with children, in-use checks and cleanup of Task trees
  left behind by deleted kapps and forms.
- Required handler settings asked for in the plan; a handler installed
  without them is reported as needing attention instead of failing the run.
- Kinetic Platform 6.x and 7.x: version detection, Integrator sign-in by
  implicit grant (6.x) or authorization code with PKCE (7.x), retries of
  transient sign-in failures, and snapshots that leave connections out
  when the platform offers no Integrator sign-in.

### Platforms

- macOS, Windows and Linux, tested in CI with Node 20 and 22. Windows
  Credential Manager through a built-in PowerShell helper; macOS Keychain;
  Linux Secret Service through `secret-tool`; memory when none is available.

### Known limitations

- **Not migrated:** users, team memberships, submissions other than listed
  reference data, webhooks, translations, built-in handlers, built-in
  (Integrated) workflow categories and Task policy rules (including those of
  workflow categories; the plan warns when a category's policy rules
  differ).
- **Connections are never updated automatically.** A connection that differs
  is shown as manual; change it in the target's console. A new connection's
  secret is asked for by name only for the `basic`, `raw_bearer_token` and
  `client_credentials` auth types; for other types, secret-named fields are
  asked for, and otherwise it is created with an empty value and a warning.
- **Credential headers** typed as literal values are not exported; on a new
  operation they must be added by hand in the target.
- **Spaces that sign in only with single sign-on** cannot be used.
- **Plans and comparisons are kept in memory** by the app; after a restart,
  plan again.
- **The command line promotes everything that differs**; selections and
  changesets are app-only. The CLI reads credentials from environment
  variables or `.env.<env>`, not from the keychain.
- **Open folder** accepts only repositories on the branch `main`.
- **Push** always pushes `main` and is refused when the remote has commits
  the project does not have.
- **A restore never removes** items created after the backup.
- **Removing a kapp or form deletes its submissions**, and a restore brings
  back only reference data. A removed team's memberships, a removed
  connection's credentials and a removed handler's secret values are not
  restored.
- **Team "may use" warnings** find a team only where its name is written out
  whole; a rule that builds the name from parts is not found. They are
  warnings only.
- **Keyless reference data** (no match fields) never updates or deletes
  records: an edited record is created as a new one.
