# Kinetic Migrator

Kinetic Migrator promotes Kinetic Platform configuration between
environments, for example from Dev to Test to Prod. It takes a snapshot of
each environment, shows what differs, lets you pick exactly what to promote
(a changeset), shows a plan of every change, and applies it with a backup
taken first. It runs on your computer as a local web app, with a command
line for scripted use. The command is `kinetic-migrate`.

## Get started

These steps take about five minutes. They are the same on macOS, Windows and
Linux; on Windows use PowerShell, Command Prompt or Windows Terminal.

### 1. Check the prerequisites

- **Node.js 22 or 24** (the current LTS releases). Get it from
  [nodejs.org](https://nodejs.org/) (choose the LTS download). Check with:

  ```
  node -v
  ```

  It should print `v22.12.0` or later, or `v24…`. Building needs Node
  20.19 or newer (22.12 or newer on Node 22), and Node 20 is past its end of
  life, so use 22 or 24.
- **git**, to download the code and update it later. Check with `git --version`.
  On Windows, install [Git for Windows](https://git-scm.com/download/win);
  macOS offers to install it the first time you run `git`.

### 2. Download, build and start

```
git clone https://github.com/kineticdata/kinetic-migrator-tool.git
cd kinetic-migrator-tool
npm install
npm run build
npm start
```

`npm install` downloads the build tools (a few minutes the first time) and
`npm run build` builds the app into `dist/`. `npm start` starts Kinetic
Migrator and opens it in your browser at a local address such as
`http://localhost:53124/?key=…`. The terminal shows:

```
Kinetic Migrator is running at http://localhost:53124/?key=…
Workspace: /Users/you/KineticMigrate. Press Ctrl+C to stop.
Log file: /Users/you/KineticMigrate/.kinetic-migrate/logs/kinetic-migrate-2026-10-09.log
```

Leave the terminal open while you use the app; press **Ctrl+C** in it to
stop. The app only listens on your own computer. If the browser does not
open, or you close the tab, open the printed address again. The `key` in it
signs your browser in and changes each time the app starts.

### 3. Try it without a Kinetic space first

```
npm run start:fake
```

Demo mode serves two synthetic spaces from memory and contacts no server.
Name the first environment `dev` (a Dev space on Kinetic Platform 6.1.7);
any other name, such as `test`, is a copy of a Test space on 7.0.0-rc3. Any
`https://` URL and any username and password are accepted. Demo projects go
to a separate throwaway folder (`kinetic-migrator-demo` in your system's
temporary folder), never to your real workspace, so you can experiment
freely.

### 4. Connect your spaces

You need the `https://` address of each space and the username and password
of a **space admin** account (single sign-on only accounts cannot be used).

1. On the Projects page choose **Create your first project**, name it and
   choose **Next**.
2. Enter the first environment, usually the source: name `dev`, its Space
   URL (for example `https://dev.example.com`), username and password. Turn
   on **Protected** so Kinetic Migrator only ever reads from it. Choose
   **Test connection**; when it says **Connected**, choose **Next**.
3. Choose **Take snapshot**, then **Open overview**.
4. Open **Settings**, choose **Add environment**, enter `test` with its URL
   and credentials, **Test connection**, then **Save**.
5. On **Overview**, choose **Take snapshot** on the Test lane.
6. Choose **Compare with Test** on the Dev lane to see what differs.

From there, the **[walkthrough](docs/WALKTHROUGH.md)** takes you through
your first promotion from Dev to Test, screen by screen.

### Windows notes

- The commands above are identical in PowerShell and Command Prompt.
- Passwords and tokens are kept in **Windows Credential Manager** (macOS:
  Keychain). The first time one is saved, Windows compiles a small helper,
  which can take several seconds.
- Keep the workspace out of OneDrive and other synced folders. See
  [Windows notes](docs/TROUBLESHOOTING.md#windows-notes) for more.

### Updating

Stop the app (Ctrl+C), then in the `kinetic-migrator-tool` folder:

```
git pull
npm install
npm run build
npm start
```

Your projects are kept outside this folder, so updating never touches them.

### Where things are kept

- **Projects:** the workspace folder `KineticMigrate` in your home folder
  (`~/KineticMigrate` on macOS and Linux, `%USERPROFILE%\KineticMigrate` on
  Windows). Each project is a git repository of snapshots, changesets and
  backups. Use `npm start -- --workspace <folder>` to use another folder.
- **Logs:** a daily log file in `.kinetic-migrate/logs/` inside the
  workspace. Its path is printed at start and shown on the Projects page.
  Secrets are never written to it.
- **Secrets:** your system keychain, never the project folder.

### Getting help

Check [Troubleshooting](docs/TROUBLESHOOTING.md) first. To report a problem
or ask a question, open an issue at
[github.com/kineticdata/kinetic-migrator-tool/issues](https://github.com/kineticdata/kinetic-migrator-tool/issues)
with the steps, the exact message and the relevant log lines. Never include
passwords, tokens or customer data.

## Who it is for

- **Kinetic admins and partners** who move kapps, forms, workflows and
  integrations from one space to another. Use the web app.
- **Power users** who script promotions or run them from CI. Use the
  command line.
- **Developers** who maintain the tool. See
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) in the source repository.

## Features

- **Projects.** Each project is a folder managed as a git repository: every
  snapshot, changeset, promotion and backup is a commit. Push it to a remote
  repository to share it.
- **Environments.** Connect any number of spaces and order them as a
  pipeline. Mark one Protected (read-only) and nothing is ever written to it.
- **Snapshots and Explore.** Browse everything in an environment: space
  settings, teams, kapps, forms, workflows, WebAPIs, connections and
  operations, handlers, routines, workflow categories and more. Each item
  has a summary, its relationships (what it uses and what uses it), the raw
  JSON and its history.
- **Compare.** See what is new, changed, drifted or only in the target,
  either as a preview of a promotion or as a raw difference.
- **Changesets.** Tick what to promote. Dependencies an item needs are
  suggested, with the reason. Save a changeset to promote the same set
  through each environment.
- **Plan and apply.** A guided apply: review, environment values and
  secrets, typed confirmation, then live progress. A backup snapshot of the
  target is taken first.
- **Removals.** Delete items that exist only in the target, on purpose and
  one by one, with warnings for anything that still uses them.
- **History and restore.** Every event in plain words, with restore from a
  backup.
- **Environment values.** Attributes, space settings and handler settings
  that must differ per environment stay as each environment has them.
- **Secrets.** Passwords, tokens and secret handler settings live in your
  system keychain. They are never exported, logged or shown again.

## Requirements

- **Node.js 22 or 24** recommended; at least **20.19** (`package.json`
  `engines`), which the build step needs. Node 20 reached its end of life in
  April 2026.
- **macOS** 12 or newer, **Windows** 10 or 11, or **Linux**. CI runs on
  macOS, Windows and Ubuntu.
- **Kinetic Platform 6.x or 7.x.** The version of each environment is
  detected and shown.
- A **space admin account with a password** for each environment. Spaces
  that only sign in with single sign-on cannot be used.
- To keep secrets between sessions: macOS Keychain, Windows Credential
  Manager, or on Linux a Secret Service (such as GNOME Keyring) with
  `secret-tool`. Without one, secrets are kept in memory until the app stops.

## Install

[Get started](#get-started) covers the usual install from a clone. To put the
`kinetic-migrate` command on your PATH as well:

```
npm link
```

`npm run build` bundles the server and the web app into `dist/`. The built
app has no runtime dependencies. Without `npm link`, run
`node kinetic-migrate.mjs` from the source folder (or `npm start`, which runs
`node kinetic-migrate.mjs ui`) wherever these docs say `kinetic-migrate`.

To install on another machine, build first, then pack and install the
tarball there:

```
npm run build
npm pack                                    # writes kinetic-migrate-0.1.0.tgz
npm install -g kinetic-migrate-0.1.0.tgz    # on the other machine
```

## Start the web app

```
kinetic-migrate ui
```

The server starts on `127.0.0.1` and your browser opens at a one-time launch
link. Leave the terminal open; press Ctrl+C to stop.

| Option | What it does |
|--------|--------------|
| `--workspace <dir>` | Where projects are kept. Default: `KineticMigrate` in your home folder (`%USERPROFILE%\KineticMigrate` on Windows). |
| `--port <n>` | The port to listen on, 0 to 65535. Default: a free port chosen at start. |
| `--no-open` | Do not open a browser. Open the printed address yourself. |
| `--fake` | Demo mode: two synthetic spaces in memory, nothing leaves your machine. |

To try it without a Kinetic server:

```
kinetic-migrate ui --fake
```

In fake mode an environment named `dev` is a synthetic Dev space on Kinetic
Platform 6.1.7, and any other name is a copy of a Test space on 7.0.0-rc3.
Any URL and password are accepted, and applies change only the in-memory
space.

## Your first promotion

The [walkthrough](docs/WALKTHROUGH.md) goes from an empty Projects page to a
promotion from Dev to Test and a restore preview, with a screenshot of every
step. The [User guide](docs/USER-GUIDE.md) covers every screen in detail.

## Safety model

- **Protected environments are read-only.** Snapshots, comparisons and plans
  use a client that cannot send anything but read requests. Apply refuses a
  Protected target.
- **You confirm every apply** by typing the target environment's name.
- **A backup comes first.** Before any write, a snapshot of the target is
  taken and committed as a backup you can restore from.
- **Drift protection.** An item changed in the target since it was last
  promoted is not overwritten unless you choose **Overwrite** for it.
- **Nothing is deleted unless you choose it.** Promoting only creates and
  updates. Items only in the target are removed only when you mark each one
  with **Remove from <target>** (or, on the command line, name it with
  `--remove` or a type with `--prune`).
- **Secrets are write-only.** Passwords, tokens and secret handler settings
  are never exported, committed, logged or shown again. Existing connections
  are never written, so their stored credentials are never touched.

## Documentation

| Guide | What it covers |
|-------|----------------|
| [Walkthrough](docs/WALKTHROUGH.md) | Your first promotion from Dev to Test, with screenshots |
| [User guide](docs/USER-GUIDE.md) | Every screen and flow of the web app |
| [Concepts](docs/CONCEPTS.md) | Snapshots, changesets, plans, drift, environment values, secrets, what is promoted |
| [Command line](docs/CLI.md) | Every command and flag, with examples |
| [Promoting reference](docs/PROMOTING.md) | Detailed engine behaviour: file layout, overrides, handlers, reference data, removals |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Symptoms, causes and fixes; the log file |
| [Development](docs/DEVELOPMENT.md) | Architecture, tests, adding an artifact type (source repository only) |
| [Changelog](CHANGELOG.md) | What shipped, and known limitations |

## Troubleshooting

Start with [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). The app
writes a daily log file in the workspace,
`.kinetic-migrate/logs/kinetic-migrate-<YYYY-MM-DD>.log`. Its path is
printed when the app starts and shown on the Projects page and in Settings.
Secrets are never written to it.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). In short: `npm run dev` for
the web app with hot reload, `npm test` and `npm run test:app` for the
tests.

## License

[MIT](LICENSE). Copyright (c) 2026 Kinetic Data. Source and issues:
[github.com/kineticdata/kinetic-migrator-tool](https://github.com/kineticdata/kinetic-migrator-tool).
