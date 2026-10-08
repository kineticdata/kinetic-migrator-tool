# Changelog

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

- **`http://` space URLs are accepted.** Credentials then travel
  unencrypted. Use `https://` addresses.
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
- **Database connection passwords** stored outside the connection's auth
  settings are not known to be stripped from snapshots. Check a snapshot of
  such a connection before committing or pushing it.
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
- **Team "may use" warnings** match team names as text, so a team named
  `Ops` also matches `DevOps`. They are warnings only.
- **If the snapshot after an apply fails**, the plan page still shows the run
  as applied; the warning is in the job's events. Take a snapshot before
  comparing.
- **Keyless reference data** (no match fields) never updates or deletes
  records: an edited record is created as a new one.
