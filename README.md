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

To try it without a Kinetic server, start it in fake mode:

```
KINETIC_MIGRATE_FAKE=1 node kinetic-migrate.mjs ui
```

Fake mode serves two synthetic spaces, `dev` and every other environment name
(a copy of a `test` space), from memory. Any URL and password are accepted and
applies change only the in-memory space. Nothing leaves your machine.

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
npm run test:e2e     # builds, then runs the Playwright smoke test in fake mode
```

The end-to-end smoke test walks the main journey (create a project, add dev
and test, snapshot both, compare, accept a suggestion, plan, apply, history)
and writes a screenshot of each step to `e2e-artifacts/screenshots/`. The first
run needs a browser: `npx playwright install chromium`.
