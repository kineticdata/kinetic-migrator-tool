# Kinetic Migrator

Kinetic Migrator promotes Kinetic Platform configuration between
environments, for example from Dev to Test to Prod. It takes a snapshot of
each environment, shows what differs, lets you pick exactly what to promote
(a changeset), shows a plan of every change, and applies it with a backup
taken first. It runs on your computer as a local web app, with a command
line for scripted use. The command is `kinetic-migrate`.

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

- **Node.js 20.6 or newer** (from `package.json` `engines`). Node 22 or 24
  is recommended: Node 20 reached its end of life in April 2026.
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

From a copy of the source:

```
npm install
npm run build
npm link        # optional: puts the kinetic-migrate command on your PATH
```

`npm run build` bundles the server and the web app into `dist/`. The built
app has no runtime dependencies. Without `npm link`, run
`node kinetic-migrate.mjs` from the source folder wherever these docs say
`kinetic-migrate`.

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

## Quickstart: your first promotion

This takes about five minutes with two real spaces, or with `--fake`.

1. **Create a project.** On the Projects page choose **Create your first
   project** (or **New project**). Give it a name and choose **Next**.
2. **Add the first environment.** Enter a name such as `dev`, the Space URL
   (for example `https://dev.example.com`), a username and a password.
   Choose **Test connection**. When it says **Connected**, choose **Next**.
3. **Take a snapshot.** Choose **Take snapshot**. Optionally enter your name
   and email for History, then choose **Open overview**.
4. **Add the second environment.** Open **Settings**, choose **Add
   environment**, enter `test` and its URL and credentials, **Test
   connection**, then **Save**.
5. **Snapshot it.** On **Overview**, choose **Take snapshot** on the Test
   lane.
6. **Compare.** Choose **Compare with Test** on the Dev lane. The tree shows
   what is new or changed in Dev. Select an item to see its changes.
7. **Build a changeset.** Tick the items to promote. Check the
   **Suggested** list in the tray and choose **Add** (or **Add all**) for the
   dependencies you need. Optionally choose **Save as changeset…**.
8. **Plan.** Choose **Review plan**. Read the counts and the item list, and
   tick each entry under **Needs attention**. Choose **Next: Environment
   values**, fill in any value or secret it asks for, then **Next: Confirm**.
9. **Apply.** Type the target's name (`test`) and choose **Apply to Test**.
   A backup of Test is taken, then each change is shown as it is made.
10. **Check History.** Choose **View in History** to see the backup and the
    promotion. From there you can restore the backup if you need to.

The [User guide](docs/USER-GUIDE.md) covers every screen in detail.

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
