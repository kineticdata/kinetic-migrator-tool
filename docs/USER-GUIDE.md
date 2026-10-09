# User guide

This guide walks through the Kinetic Migrator web app screen by screen. Start
it with `kinetic-migrate ui` (see the [README](../README.md#start-the-web-app)).
For the ideas behind the screens (snapshots, changesets, plans, drift), read
[Concepts](CONCEPTS.md).

New to Kinetic Migrator? Start with the [walkthrough](WALKTHROUGH.md): your
first promotion from Dev to Test, with a screenshot of every step.

Examples use three environments, Dev, Test and Prod, at
`https://dev.example.com`, `https://test.example.com` and
`https://prod.example.com`.

Contents:

- [The app at a glance](#the-app-at-a-glance)
- [Projects](#projects)
- [Environments](#environments)
- [Overview and snapshots](#overview-and-snapshots)
- [Explore](#explore)
- [Compare](#compare)
- [Changesets](#changesets)
- [Plan and apply](#plan-and-apply)
- [Removing items from a target](#removing-items-from-a-target)
- [History and restore](#history-and-restore)
- [Settings](#settings)

## The app at a glance

The header shows the Kinetic Migrator wordmark (a link back to all
projects), the open project (choose its name to switch project), the
pipeline of environments, and a **Theme** menu (System, Light, Dark).

Under the header are the project's tabs:

| Tab | What it is for |
|-----|----------------|
| Overview | The pipeline: each environment's snapshot, item counts, drift and latest promotion |
| Explore | Everything in one environment's newest snapshot |
| Compare | What differs between two environments; build a changeset |
| Changesets | Saved selections you can promote again |
| History | Every snapshot, promotion, backup and restore |
| Settings | Environments, data and environment values, the git repository |

Long tasks (snapshots, comparisons, plans, applies, pushes) run as jobs on
the local server. They show live progress and most have a **Cancel**
button. Only one snapshot or apply runs against an environment at a time; a
second one is refused ("Something is already running against Test.").

## Projects

A project holds the environments of one Kinetic setup and everything
promoted between them. The Projects page lists the projects in your
workspace, the workspace path, and the path of today's log file. The
project you opened last is first, marked **Last opened**.

### Create a project

Choose **New project** (or **Create your first project** in an empty
workspace). The wizard has three steps:

1. **Project.** A name of up to 100 characters, for example "Service
   portal". The project folder is named after it.
2. **Environment.** The first environment, usually the one where changes
   are made first, such as Dev. See [Add an environment](#add-an-environment)
   for the fields. Choose **Test connection**; **Next** is enabled once the
   test passes. Changing any field means testing again.
3. **Snapshot.** Choose **Take snapshot** to read the environment. This only
   reads; nothing is changed. You can also enter **Your name** and **Your
   email**: History records your snapshots and promotions under them. Choose
   **Open overview** when it is done, or **Skip for now**.

The project is saved as soon as the connection is first tested. If you stop
part way, "Your project was saved. You can finish setup any time from
Settings."

### Open an existing folder

Choose **Open folder…** and enter the full path of a project folder: one
made by Kinetic Migrator or by the `kinetic-migrate` command line (it must
contain `kinetic-sync.config.json` or files in `environments/`). From then
on the app manages it.

A folder that is already a git repository must be on the branch `main`;
otherwise the app refuses with "This folder is a git repository on branch
<name>; Kinetic Migrator manages projects on main." Rename the branch with
`git branch -m main` and open it again.

### The managed git repository

Every project is a git repository on `main`, managed for you (no git
installation is needed). Each change is a commit with a plain title:

| Commit | Made when |
|--------|-----------|
| `Snapshot of Dev` | A snapshot is taken |
| `Backup of Test before applying '…'` | An apply starts |
| `Applied '…' to Test`, `Partly applied …`, `Failed to apply …` | An apply ends |
| `Removed 1 item from Test` | A plan that only removes items ends |
| `Restored Test from a backup` | A restore ends |
| `Saved changeset …`, `Updated changeset …`, `Deleted changeset …` | Changesets change |
| `Upgraded project layout` | An old project's file names are upgraded |

Credentials, plan records and comparison reports are never committed (see
[What is in a project folder](CONCEPTS.md#what-is-in-a-project-folder)).

To share the history, connect a remote repository in
[Settings → Repository](#repository) and choose **Push**.

## Environments

An environment is one Kinetic space. Environments are ordered as a
pipeline: changes are promoted from the top of the list to the bottom
(Dev → Test → Prod).

### Add an environment

Open **Settings → Environments** and choose **Add environment**. New
environments go at the end of the pipeline.

| Field | Notes |
|-------|-------|
| Environment name | Letters, digits, `-` and `_`, starting with a letter or digit, for example `dev`, `test` or `prod`. It is shown capitalised ("Dev"). It cannot be changed later. |
| Space URL | The address of the space, for example `https://dev.example.com`. It must start with `https://`; plain `http://` is accepted only for a space on this computer (`localhost`, `127.0.0.1` or `[::1]`), because it would send the password unencrypted. No path, query or sign-in details. |
| Protected | When on, Kinetic Migrator only reads from this environment and never changes it. |
| Username | A space admin with a password. |
| Password | Write-only: once saved, the field shows that a password is set but never shows it. |

Choose **Test connection** (it saves first, because the server tests what
is stored) or **Save**. To change the credentials later, choose the pencil
(**Edit**) and type new ones; "Leave the username and password empty to
keep the saved ones."

### Protected environments

Mark the environment you promote from, or one nobody may change through the
app, as **Protected**. A lock badge shows on it everywhere. Snapshots,
comparisons and plans still work. Apply is refused: the plan page says
"Test is protected (read-only), so nothing can be applied to it. You can
still review the plan."

### Credentials

Credentials are kept in your system keychain (macOS Keychain, Windows
Credential Manager, or the Secret Service on Linux), never in the project.
The environment list shows "Username set · Password set", or a warning when
something is missing. An environment without a password shows "No password
saved. Add credentials" on the Overview. An environment saved earlier with
a plain `http://` address to another machine shows "This address uses
http://, which would send your password unencrypted. Change it to https://."
on its card, and nothing signs in to it until the address is changed.

If no keychain is available, the Projects page says "No system keychain was
found, so passwords are kept only until Kinetic Migrator stops." See
[Keychain unavailable](TROUBLESHOOTING.md#keychain-unavailable).

### Test connection

**Test connection** (or **Test** in the list) checks two steps:

| Step | What it checks |
|------|----------------|
| Core login | The username and password against the Core API |
| Integrator token | Signing in to the Integrator, which serves connections and operations |

The result says **Connected** or **Could not connect**, with a plain message
for the step that failed. If Core login fails, the Integrator step is
skipped.

### Platform version

The test also shows the version the environment runs, for example "Kinetic
Platform 7.0.0-rc3". The app remembers the last version seen for each
environment and shows it in the environment list and on the Overview lane.

When two environments run different major versions, Compare and Plan show
a note in their header: "Dev runs 6.1.7 and Prod runs 7.0.0-rc3 — review
differences carefully." Nothing is blocked; the platform may store the same
item differently, so check the differences closely.

### Reorder and remove

Use the arrows (**Move Dev earlier**, **Move Dev later**) to change the
pipeline order. **Remove** takes the environment out of the project and
forgets its saved credentials. Nothing in the Kinetic space is changed,
and its snapshots stay in History.

## Overview and snapshots

The Overview shows one lane per environment, left to right in pipeline
order. Each lane shows:

- the host and the platform version,
- **Snapshot**: when the last one was taken, or "No snapshot yet",
- the item count, with a count per type,
- **Drift**: how many items changed in this environment since they were last
  promoted into it ("No changes since the last promotion" when none),
- **Latest promotion**: its title and outcome (Done, Partly done, Error,
  Cancelled).

Between two lanes, an arrow shows how many differences there are between
their newest snapshots ("3 differences" or "No differences"). Choose it to
open Compare. "Snapshot both to compare" means one of them has no snapshot
yet.

Below the lanes, **Recent activity** lists the last eight events; **View
history** opens the full History.

### Take a snapshot

Choose **Take snapshot** (or **Refresh snapshot**) on a lane, or in
Explore. A snapshot reads every item in the environment, with secrets left
out, and commits it as `Snapshot of Dev`. It only reads. When nothing changed
since the last one, the toast says "Nothing changed since the last
snapshot."

Behind the scenes:

- The snapshot is written to a temporary folder and swapped in only when it
  is complete, so a failed or cancelled snapshot leaves the previous one in
  place.
- Items that changed since they were last promoted into this environment are
  recorded as drift, and History shows a "Drift detected" entry.
- If the Integrator sign-in is not available, the snapshot keeps everything
  else and leaves connections and operations out. A note says why ("Snapshot
  of Dev taken, with notes").

## Explore

Explore shows everything in one environment's newest snapshot. Choose an
environment in the header pipeline, or **Explore** on an Overview lane.

The left side is a tree, grouped as Space (with the space's workflows and
WebAPIs), Kapps (each with its forms, workflows and WebAPIs; a form holds its
workflows and reference data), Connections (each with its operations),
Handlers, Teams, Models, File resources, Routines, Workflow categories and
Other.

- **Search names, slugs and fields** searches the whole snapshot. Press
  Escape to clear it.
- **Show** limits the tree to one group, with its item count.

Select an item to open its details:

| Tab | What it shows |
|-----|---------------|
| Summary | A readable summary: settings, fields (with Required markers), attributes and so on |
| Relationships | **Uses** (what this item needs) and **Used by** (what needs it), each with a reason such as "IT Request calls operation Create Ticket on connection Ticketing" |
| JSON | The item as stored in the snapshot |
| History | Each snapshot, promotion, backup, restore or drift that changed this item |

Secret values never appear: they are not in the snapshot.

The item you select is kept in the address, so you can share a link or use
Back.

## Compare

Compare shows what differs between two environments. Open it from the
**Compare** tab, from **Compare with Test** on an Overview lane, or from an
arrow between lanes.

### Choose what to compare

| Control | Choices |
|---------|---------|
| From, To | The source and the target. **Swap** exchanges them. |
| Mode | **Preview**: what promoting would change, with environment values and drift applied. **Raw**: every difference between the two snapshots, nothing hidden. |
| Target | **Latest snapshots (instant)**: both newest snapshots. **Check live target**: reads the target now (Preview only). |
| Run again | Runs the comparison again. |

The source is always its newest snapshot. Comparing snapshots is instant
and works offline; checking the live target reads the target as it is now,
so it also catches changes made since its last snapshot. A finished
comparison is cached; a new snapshot or apply means a new comparison.

If an environment has no snapshot yet, Compare says "Take a snapshot of Test
first" and, for a missing target, offers **Check live target** instead.

### Preview or raw

Preview answers "if I promoted Dev into Test now, what would change?" It
hides what is expected to differ: environment-specific attributes, space
settings kept per environment, handler settings and saved environment
values. Raw shows every difference, including those, and is useful for an
audit or to find why two spaces behave differently.

### Statuses

| Status | Meaning |
|--------|---------|
| New (`+`) | In the source, not in the target. Promoting creates it. |
| Changed (`~`) | In both, different. Promoting updates the target. |
| Drifted (`!`) | Changed in the target since it was last promoted. Promoting would overwrite that change; you decide. |
| Manual (`•`) | Different, but never written automatically: change it by hand in the target. Connections are always manual when they differ (writing one can wipe its stored credentials). A workflow category whose name a built-in category also has is manual too. |
| Only in target (`−`) | In the target only. Promoting never deletes it; you can remove it on purpose. |
| Same (`=`) | No difference. |

The count bar above the tree shows a total per status. Choose a count to
show only items with that status; choose it again to show every status.

### Filters

- **Filter by name** keeps the items whose name matches, and opens the tree
  to show them.
- **Show** limits the tree to one type (All types, Kapps, Connections…).
- **Only differences** (on by default) hides items that are the same.
- **Expand all** and **Collapse all** open or close the whole tree.

### An item's changes

Select an item to see it on the right:

- **Changes**: a table of each field that differs, the target's value beside
  the incoming one. A new item shows "New in Dev: Test doesn't have it yet.
  Everything below is incoming."
- **Side by side**: the target's JSON ("Test now") beside the source's ("Dev
  incoming").
- **This item needs**: dependencies of this item that are not selected yet.
- **Only in Test**: entries inside this item that only the target has (see
  [Entries inside the space, a kapp or a workflow category](#entries-inside-the-space-a-kapp-or-a-workflow-category)).

A drifted item also shows a three-way view, **Changed in Test since it was
last promoted**: what was last promoted, the target now, and the incoming
value, with the target's own changes marked "changed in Test". Choose
**Overwrite** to replace the target's changes, or **Keep Test** to leave the
item as it is in the target.

### Select items

Tick an item to add it to the changeset, or choose **Add to changeset** in
its detail. Ticking a group selects everything new or changed in it that the
filters show. A group tick never selects drifted items: each one needs its
own decision ("Only drifted items are below: review each one and choose
Overwrite or Keep."). Ticking a drifted item is the same as choosing
**Overwrite**.

Manual and only-in-target items have no tick box.

### The changeset tray

The tray on the right is always visible. It lists what is selected, grouped
by type, with an **Overwrite** badge on drifted items you chose to overwrite,
and a red **Remove from Test** section for removals. **Clear** empties it.
Under the list:

- **Suggested** lists dependencies of the selection that are new or changed
  in the source and not selected yet. Choose **Add** for one, or **Add all**.
- **Review plan** plans the selection against the target.
- **Save as changeset…** saves it for later.

The selection is kept for this browser session for each From → To pair. If
an item no longer differs after a new comparison, it is taken out of the
tray with a note. If a selected item has drifted since, it is taken out
"until you choose Overwrite".

### Why suggestions appear

Kinetic Migrator knows how items depend on each other. When you select an
item, it suggests each dependency that the target lacks or that differs, so
the promoted item works in the target. Each suggestion says why, for
example:

- "IT Request calls operation Create Ticket on connection Ticketing, which is
  new in Dev"
- "Operation Create Ticket belongs to connection Ticketing, which is new in
  Dev"
- "Notify Requester runs handler Mail Send (mail_send_v1), which changed in
  Dev"
- "Notify Requester runs routine Lookup Manager, which is new in Dev"
- "Mail Send belongs to workflow category Notifications, so Mail Send appears
  in the workflow builder, which is new in Dev"
- "IT Request is secured by policy Admins (display) defined in the space"

Suggestions are followed through: a suggested item's own dependencies are
suggested too. Nothing is added without you choosing it. A dependency that
could not be checked (connections were left out of the comparison) shows
**Not checked** and cannot be added.

## Changesets

A changeset is a saved selection: a name, the source environment, the item
keys, any removals, and the source snapshot it was taken from (it is
"pinned" to that snapshot). Promoting a changeset always ships the items
exactly as they were in that snapshot, even after newer snapshots are taken.
That lets you promote the same, tested set from Dev to Test and later to
Prod.

### Save a changeset

In Compare, choose **Save as changeset…** in the tray, enter a **Name** and
an optional **Description**, and choose **Save changeset**. Removals are
saved with it, together with the environment they were chosen for.

### The Changesets tab

The list shows each changeset's name, source (From), the date of its pinned
snapshot, how many items (and removals, in red) it holds, and the
environments it has been **Applied to**.

Open one to see:

- **Promote**: its source, pinned snapshot, when it was saved and where it was
  applied. Pick an environment under **Plan against** and choose **Review
  plan**.
- **Compare with…**: how the pinned items differ from another environment
  now.
- **Items**: every item, grouped by type.
- **Remove from Test**: its removals. They are planned only against the
  environment they were chosen for; against any other the plan says so and
  leaves them out. Removals saved before this was recorded show **These
  removals are for** with **Confirm removals for Test**: they are not planned
  until you confirm one.
- **Delete**: removes the changeset from the project. Promotions already made
  are not affected, and History keeps the record.

A plan from a changeset fails with "<item>: not in the source snapshot" if
the pinned snapshot no longer has an item; take a new snapshot and build the
changeset again. A removal of an item that is in the source again ("still
exists in Dev — not removed") is never planned.

## Plan and apply

**Review plan** prepares a plan: it reads the target live, compares it with
the selection and works out every change. Nothing is written yet. The plan
page has four steps.

### 1. Review

- **Summary**: how many items will be created, updated, deleted, and left with
  no change.
- **Problems** (red): anything that blocks the plan, each with a **Fix**. For
  example a workflow that runs a routine the target lacks: "Add the routine to
  the changeset, or create it in Test first, then plan again." Fix the cause
  and plan again.
- **Needs attention**: what deserves a second look. Tick each entry; the
  counter shows "2 of 3 done". Entries include:

  | Kind | Example |
  |------|---------|
  | Handler | "Installs handler Mail Send in Test." |
  | Handler settings | "Mail Send needs Server before its settings can be saved in Test." |
  | Index rebuild | "Rebuilds search indexes of IT Request; searches on it may be incomplete until the rebuild finishes." |
  | Runs workflows | Writing reference data runs the form's submission workflows in the target |
  | Credentials | "Connection Ticketing will be created without credentials unless you enter them." |
  | Overwrites changes | A drifted item you chose to overwrite |
  | Preflight | Other warnings, such as an environment-specific attribute that is empty in the target |

  An entry you take care of by filling in a value shows "Filled in under
  Environment values" and needs no tick.
- **Remove from Test**: the removals (see [Removing items](#removing-items-from-a-target)).
- **Items**: every item grouped by type in apply order, each with its action
  (Create, Update, No change, By hand, Kept). Expand one to see its field
  changes. "Overwrites drift" marks a drifted item that will be overwritten.

Choose **Next: Environment values** when there are no problems and every
entry is done.

### 2. Environment values

Values that differ per environment, the source's beside the target's. Edit
the target's value where needed. Edits are saved as the target's
environment values (overrides) when the apply starts, and used for every
later promotion into it.

| Origin | What it is |
|--------|-----------|
| Saved value | A value saved for this environment earlier (an override) |
| Environment-bound | A space setting each environment keeps |
| Attribute | An environment-specific attribute |
| Handler setting | A handler property value |

A value marked **Required** is empty in the target with nothing to set it:
"Test has no value for this yet."

**Kept space settings with no value in the target.** A space setting kept
per environment is never copied from the source. When the target has no
value and the source has one, the source's is offered: "Promoting does not
copy Dev's value: Test stays empty unless you use it." Choose **Use Dev's
value** to fill it in. For a linked pair the button fills both halves
together, for example "Use Dev's values (displayType and displayValue)".
Applying then saves it as Test's value.

**Secrets needed.** Passwords and keys for connections being created and
for handlers, each labelled like "Ticketing › password" or "Mail Send ›
Password". A database connection's password, kept in its settings rather
than its authentication, is asked for the same way ("Warehouse DB ›
password"). "They are never shown again; leave one empty to keep what Test
has." For a handler already in the target, a secret it has stored is "Not
readable in Test — leave blank to keep Test's value"; a required one that is
empty there says "Empty in Test; needed before the handler's settings can
be saved."

Tick **Remember in keychain** to keep the secrets you enter for later
applies to this environment. Otherwise they are used for this apply only and
then forgotten.

### 3. Confirm

A summary of what will happen: changes written, removals, the source ("Dev,
newest snapshot" or "as saved in the changeset"), environment values saved,
secrets, and reviewed attention items. Removals are listed again in red,
with anything that still uses them and what a restore cannot bring back.

"A backup snapshot of Test is taken first, so you can restore it if
anything goes wrong."

Type the environment name (for example `test`) and choose **Apply to Test**.

### 4. Apply

A live checklist: the **Backup of Test** first, then each item as Pending,
Running, Done, Failed or Skipped, in apply order, with removals last.
**Cancel** stops after the current item.

Behind the scenes, in this order:

1. Environment values you edited are saved for the target.
2. Secrets are stored (or held for this run only).
3. A backup snapshot of the target is committed.
4. The plan is computed again against the live target, so anything that
   changed since you reviewed it is caught. An item changed in the target
   since review is skipped, not overwritten, and so is a removal.
5. Creates and updates run in dependency order, then removals in reverse
   order.
6. The run record and the changeset's "Applied to" are committed.
7. A fresh snapshot of the target is taken, so Compare and Explore show it as
   the apply left it. If it fails, the run keeps a warning (see Outcomes).

### Outcomes

| Heading | Meaning |
|---------|---------|
| Applied to Test | Every change was made. Choose **View in History** or **Back to Compare**. |
| Applied to Test, with a warning | Every change was made, but the snapshot taken afterwards failed: "The snapshot of Test taken after the apply failed: …. Take a snapshot before comparing again." History shows the run as "Applied, snapshot failed". |
| Partly applied to Test | Some items were skipped or need attention (for example a handler installed without a required setting). |
| Failed to apply to Test | An item failed; the run stopped there. |
| Cancelled applying to Test | You cancelled. |

For anything but a full success: "Nothing was rolled back. Resume plans
again against Test and continues with what is left; or restore Test from
the backup."

- **Resume** plans again and applies only what is still not in place. If
  secrets were used for the last run only, or a handler still needs one, it
  asks for them again first.
- **View backup** opens the backup in History.
- **Restore…** compares the backup with the target so you can put items back
  (see [Restore](#restore-from-a-backup)).

## Removing items from a target

Promoting never deletes. To delete an item that is only in the target,
remove it on purpose.

### Mark a removal

In Compare, select an item with the status "Only in Test" and choose **Remove
from Test** (on the item, or in its detail). Choose **Keep in Test** to undo.
Removals go in the red **Remove from Test** section of the tray: "Deleted
from Test after everything else is applied. The plan shows what still uses
them." A group tick never marks a removal, and nothing is ever suggested for
removal.

### Entries inside the space, a kapp or a workflow category

Some items hold entries of their own:

- the space: attribute definitions (space, team, user, user profile) and
  security policy definitions,
- a kapp: attribute definitions (kapp, form, category), security policy
  definitions, form types, categories and integrations,
- a workflow category: its handlers and routines.

Entries only the target has are kept when promoting and never make the item
differ. The item's detail lists them under **Only in Test**, "kept when
promoting; remove one on purpose to delete it", each with its own **Remove
from Test**.

### What can and cannot be removed

| Can be removed | Never removed |
|----------------|---------------|
| Teams, models, file resources | The space itself |
| Connections and operations | Built-in handlers (`utilities_*`, `system_*`) |
| Kapps, forms, WebAPIs, workflows | Built-in (Integrated) workflow categories |
| Handlers, routines, workflow categories | Reference data records (use `--prune data` on the command line) |
| Entries listed above | A Stored workflow category whose name a built-in one also has |

### What happens

- **Children go with their parent.** A kapp takes its forms, workflows,
  WebAPIs and reference data with it; a form its workflows and data; a
  connection its operations. The plan lists them under "Also deletes what is
  inside it". A kapp's or form's workflows are deleted first, because
  deleting the kapp or form would leave their Task trees behind. Afterwards
  the target is read again, and anything listed that is still there is
  deleted on its own or reported failed.
- **In-use warnings.** The plan warns about anything that will still use a
  removed item: "Still in use in Test: removing it may break these 2. You can
  still go ahead." For an item that is also only in the target, choose
  **Also remove** (or **Also remove all**) to add it to the removals. Teams,
  models and file resources are also found by name ("may use"), for example a
  team named in a security policy. A team is matched by its whole name: team
  `Ops` is not found in `DevOps` or `IT::Ops`. A warning never blocks the apply.
- **Notes.** "Removing a team also removes its memberships; they are not kept
  in any snapshot." "Removing a kapp deletes all of its forms and
  submissions." "Removing a form deletes all of its submissions."
- **Drift protection.** An item that changed in the target after you
  reviewed the plan is not deleted. It shows as "Kept: changed since last
  promoted", and the run is partial. One that is already gone shows "Already
  gone", which is fine.
- **Order.** Removals run after every create and update, callers before what
  they call (workflows before routines and handlers, operations before
  connections).
- **Restore limits.** The confirm step lists what a restore from the backup
  cannot bring back:

  | Removed | Restore brings back |
  |---------|---------------------|
  | Kapp | The kapp, its forms, workflows and reference data, but not its other submissions |
  | Form | The form, its workflows and reference data, but not its other submissions |
  | Connection | The connection and its operations, without credentials |
  | Handler | The handler, without its secret property values |
  | Team | The team, without its members |
  | Workflow category | The category, with the handlers and routines it held that are in the target |
  | Kapp category | The category; forms are put back in it only if they are restored too |

## History and restore

History lists every event in plain words, newest first, grouped by day.
Filter by **Environment** and by **Type**: Snapshots, Drift, Changesets,
Promotions, Backups, Restores, Project changes.

Select an event to see its details:

- **Who** (the author name from Settings → Repository, or "You" with a link
  to set your name), **When**, **Environment**, **Duration** and **From**.
- For a snapshot, its notes and the items that drifted.
- For a promotion: counts (selected, done, failed, skipped), failed items with
  their messages, **Acknowledgements** (each Needs attention entry you
  ticked), and **Environment values used**.
- **Open in Compare**, **View plan**, and **Restore…** for a backup, a
  snapshot, or a promotion that took a backup.
- Under **Advanced**: the commit id, backup commit id and run id.

### Restore from a backup

**Restore…** opens Compare with the backup as the source ("Backup of Test
(<date>)") and the live target as the target. The items the promotion
changed are ticked for you (drifted ones are left for your decision). Review
the tree, adjust the selection, choose **Review plan**, and apply as usual:
the restore is itself a plan, with its own backup first.

A restore only creates and updates; it never removes items added since the
backup. To delete those, remove them on purpose. A restore of a snapshot
works the same way: any snapshot of an environment can be restored into it.

## Settings

### Environments

See [Environments](#environments). The side navigation also shows the path
of today's log file ("Server log for today (secrets are never written); the
last 14 days are kept.").

### Data & values

Three cards. Each has its own **Save** button and saves only its own part of
`kinetic-sync.config.json`. Pickers list kapps, forms, teams, categories and
fields from the latest snapshot; without one, type the names.

**Space settings kept per environment.** "Promoting never changes a ticked
setting: each environment keeps its own value, even an empty one." Tick the
settings each environment keeps:

| Group | Settings |
|-------|----------|
| Usually different per environment (ticked by default) | `displayType + displayValue`, `trustedFrameDomains`, `trustedResourceDomains`, `allowedIps + allowedIpsEnabled` |
| Optional | `loginPage`, `resetPasswordPage`, `afterLogoutPath`, `defaultLocale`, `defaultTimezone`, `sessionInactiveLimitInSeconds` |
| Always kept (cannot be unticked) | `name`, `slug`, `platformComponents`, `bundlePath`, `sharedBundleBase` |

A pair is one checkbox: both halves are kept or promoted together. Unticking
a setting promotes it from the next promotion on, and replaces any value it
was given by hand in the target. Choose **Save space settings**.

**Environment-specific attributes.** "Attributes whose values differ in each
environment, such as a server address. They are never copied when
promoting; each environment keeps its own value." Choose **Add rule**, then:

| Level | Where |
|-------|-------|
| Space | The whole space |
| Kapp | A kapp, or any kapp |
| Form | A kapp and a form, or any |
| Team | A team, or any team |
| Category | A kapp and a category, or any |

and the **Attribute** name. A rule with "any" applies to every item at that
level. Choose **Save attributes**. A rule in the project file that cannot be
used is listed as ignored; saving replaces the rules.

**Reference data.** "Records copied along with the configuration, such as
lookup lists." Choose **Add entry**, pick the kapp and form, then:

- **Which records**: **All records**, or **Add condition** for Field = Value
  conditions. "A record is copied when every condition holds." A list value
  (checkboxes) matches when it contains the value.
- **Match records by**: the fields that find the same record in the other
  environment. With them, a changed record is updated in place. Without them,
  "edited records are copied as new ones", and nothing is ever updated or
  deleted.

Choose **Save reference data**. After changing an entry's match fields or
filter, take a new snapshot of the source before planning: a plan from an
older snapshot stops with "settings changed since the snapshot".

Creating or updating records runs the target form's submission workflows;
the plan names them under Needs attention.

### Repository

**Author**: the **Name** and **Email** that History records your snapshots,
changesets and promotions under. Until you set them, History shows "You".
Choose **Save author**.

**Remote repository** (optional): push the project's history to a git
server so others can see it. Snapshots and settings go; credentials never
do.

1. Enter the **Address**, which must start with `https://` (for example
   `https://git.example.com/team/project.git`).
2. Enter a **Token**: a personal access token with write access. It is kept
   in this computer's keychain and never shown again.
3. Choose **Connect** (or **Save**), then **Push**.

The last push's outcome is shown below. **Disconnect** forgets the remote
and its token. Changing the address without a new token also forgets the
token, so a token is never sent to a different server.
