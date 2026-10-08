# kinetic-migrate

Explore a Kinetic Platform environment, compare it with another, build
changesets and promote them safely, from a local web UI or the command line.

- Engine: `lib/sync/` (plain JavaScript, no runtime dependencies)
- Web app: `app/server` (local API) and `app/web` (React), bundled into `dist/`
- CLI: `node kinetic-migrate.mjs --help`
- Guide: [`docs/PROMOTING.md`](docs/PROMOTING.md)

## Install

Requires Node.js 20.6 or newer.

```
npm install
npm run build
```

`npm run build` bundles the server and the web app into `dist/`. The built
app has no runtime dependencies.

## Start the web UI

```
node kinetic-migrate.mjs ui [--workspace <dir>] [--port <n>] [--no-open]
```

(or `kinetic-migrate ui` when the package is linked or installed globally).

This starts a local server on 127.0.0.1 and opens the browser at a one-time
launch URL; the session key is in that URL only. Projects live in the
workspace, `~/KineticMigrate` by default, each one a git repository of
snapshots, changesets and run records. Passwords go to the system keychain
(macOS Keychain, Windows Credential Manager, Secret Service on Linux); without
one they are kept in memory until the server stops. Press Ctrl+C to stop.

The server also writes a log file in the workspace,
`.kinetic-migrate/logs/kinetic-migrate-<YYYY-MM-DD>.log` (one per day, the
last 14 kept), with the same lines it prints to the terminal: unexpected
errors and failed jobs (with the platform's error message and the names of
the fields it complained about). Passwords, tokens and other secrets are
never written to it. `ui` prints its path on start; the Projects page and
Settings show it too.

To try it without a Kinetic server, start it in fake mode:

```
node kinetic-migrate.mjs ui --fake
```

(`npm run start:fake` does the same; `KINETIC_MIGRATE_FAKE=1` in the
environment still works too.)

Fake mode serves two synthetic spaces, `dev` and every other environment name
(a copy of a `test` space), from memory. Any URL and password are accepted and
applies change only the in-memory space. Nothing leaves your machine. The
fake `dev` space reports Kinetic Platform 6.1.7 and the others 7.0.0-rc3, so
Compare and Plan show the cross-version warning.

## Supported platforms

- **Kinetic Platform** 6.x and 7.x. The version of each environment is
  detected and shown; what differs between versions (how the Integrator is
  signed in to) is described in [docs/PROMOTING.md](docs/PROMOTING.md#platform-versions).
- **macOS** 12 or newer (Apple silicon and Intel)
- **Windows** 10 and 11 (x64 or Arm64)
- **Linux** (tested on Ubuntu in CI; keychain needs a Secret Service such as
  GNOME Keyring and `secret-tool`)
- **Node.js** 20.6 or newer to run the app. Developing it (build and tests)
  needs Node 20.19+ or 22.12+ (Vite's requirement). Node 20 reached its end of
  life in April 2026; prefer Node 22 or 24.

CI runs every suite and a smoke test of the built app on macOS, Windows and
Ubuntu with Node 20 and 22.

### Windows notes

- Run it from Command Prompt, PowerShell or Windows Terminal:
  `node kinetic-migrate.mjs ui` (or `npm run start`). Every npm script works
  in cmd.exe and PowerShell; none needs a Unix shell or inline environment
  variables (use `--fake`, not `KINETIC_MIGRATE_FAKE=1 …`).
- The browser opens through Explorer (`explorer.exe <url>`, the default browser); with `--no-open`, copy the printed address.
- Secrets are stored in **Windows Credential Manager** (Control Panel →
  Credential Manager → Windows Credentials, entries named
  `kinetic-migrate:…`), saved for your user on this computer and never
  roamed. kinetic-migrate talks to it through one helper process running
  the built-in Windows PowerShell 5.1
  (`%SystemRoot%\System32\WindowsPowerShell\v1.0`), started on first use
  and kept for as long as the app runs; nothing to install. Its first start
  compiles a small helper and can take several seconds (longer under some
  antivirus); later operations are quick. Secrets of any size are stored
  (values longer than one Credential Manager entry holds are split across
  `…#1`, `…#2` entries). Where Credential Manager cannot be used (for example
  some remote or service sessions, or PowerShell blocked by policy), secrets
  are kept in memory until the server stops and the app says so; they are
  never written to disk in plain text.
- The default workspace is `%USERPROFILE%\KineticMigrate` (not Documents,
  which OneDrive often syncs). Avoid putting the workspace in a OneDrive,
  Dropbox or other synced folder: syncing locks files mid-write. The app
  warns when it is in one.
- Paths with spaces and non-ASCII letters (`C:\Users\José Núñez\…`) are
  fine. Long item names are shortened in file names (see
  [`docs/PROMOTING.md`](docs/PROMOTING.md)); if you clone a project with Git
  for Windows and still hit the 260-character path limit, enable
  `git config --global core.longpaths true`.
- Projects carry a `.gitattributes` that keeps LF line ends, so a clone with
  Git for Windows (which defaults to CRLF) compares cleanly.
- Ctrl+C stops the server.

## A short tour

- **Projects.** Create a project, connect its first environment (Space URL,
  username, password, *Test connection*) and take a snapshot. Mark an
  environment *Protected* to make it read-only for kinetic-migrate.
- **Overview.** The pipeline of environments, left to right: when each was last
  snapshotted, what it holds, drift since the last promotion and the latest
  promotion. Take or refresh snapshots here.
- **Explore.** A tree of everything in one environment (space, teams, kapps,
  forms, workflows, connections, handlers and more) with search, a readable
  detail view, relationships and the raw JSON.
- **Compare.** Pick a source and a target to see what is new or changed. Tick
  items to add them to a changeset; kinetic-migrate suggests the dependencies
  they need, such as the connection and operation a form calls. Save a
  changeset to come back to it, or go straight to *Review plan*.
- **Plan and apply.** A guided apply in four steps: *Review* what will be
  created or updated and acknowledge anything that needs attention;
  *Environment values* for settings that differ per environment and secrets for
  new connections and handlers; *Confirm* by typing the target's name; *Apply*,
  with live progress. A backup snapshot of the target is taken first.
- **Changesets.** Saved selections, pinned to the snapshot they were built
  from, with where they have been applied.
- **History.** Every snapshot, promotion, backup, drift event and restore in
  plain words, with restore from a backup.
- **Settings.** Environments and their pipeline order, data and environment
  values, and the project's git repository (a remote to push to).

Screenshots (to be added):

- Projects and the new-project wizard
- Overview
- Explore
- Compare with a changeset and a suggestion
- Plan: review, environment values, confirm, apply
- History

## Command line

The same engine runs from the command line for scripted promotions:
`init`, `export`, `plan`, `apply` and `compare`. See
[`docs/PROMOTING.md`](docs/PROMOTING.md) for the project layout, environment
values, secrets, handlers and the safety rules, and
`node kinetic-migrate.mjs --help` for the options.

## Development

```
npm run dev          # web app with hot reload (Vite)
npm run dev:server   # API server, restarts on change
npm test             # engine tests
npm run test:app     # server and web tests
npm run typecheck
npm run build
npm run smoke        # starts the built app in fake mode and checks it answers
npm run test:e2e     # builds, then runs the Playwright smoke test in fake mode
```

The end-to-end smoke test walks the main journey (create a project, add dev
and test, snapshot both, compare, accept a suggestion, plan, apply, history)
and writes a screenshot of each step to `e2e-artifacts/screenshots/`. The first
run needs a browser: `npx playwright install chromium`.
