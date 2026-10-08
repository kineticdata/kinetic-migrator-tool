# Troubleshooting

Each entry gives the symptom (usually the message you see), the cause and
the fix. Messages are quoted as the app or the command line shows them;
"Test", "Dev" and `test.example.com` stand for your own environments.

Contents:

- [The log file](#the-log-file)
- [Connecting and signing in](#connecting-and-signing-in)
- [Snapshots](#snapshots)
- [Plans](#plans)
- [Applying](#applying)
- [Handlers](#handlers)
- [Reference data](#reference-data)
- [Keychain unavailable](#keychain-unavailable)
- [Projects and the repository](#projects-and-the-repository)
- [Windows notes](#windows-notes)
- [Reporting a problem](#reporting-a-problem)

## The log file

The web app writes one log file per day in the workspace:

```
<workspace>/.kinetic-migrate/logs/kinetic-migrate-<YYYY-MM-DD>.log
```

Its path is printed when `kinetic-migrate ui` starts and shown on the
Projects page and under Settings. The last 14 days are kept, and on macOS
and Linux only your user can read the folder.

It holds the same lines the server prints to the terminal, each with a
time:

- one line when the server starts (version, port, workspace; never the
  launch link),
- unexpected errors (an API request that failed with a server error) with
  their stack,
- failed jobs (snapshot, compare, plan, apply, push), with the platform's
  own error message and the names of the fields it complained about,
- notes such as "The system keychain is not available".

**Secrets are scrubbed.** Every line is passed through a filter that removes
Basic and Bearer credentials, secret-named JSON values, tokens and sign-in
codes, and every password or secret value the server has been given in
this session. Request bodies are never logged. It is safe to attach the log
to a support request, but read it first: it contains item names, host names
and the workspace path.

The command line prints to the terminal only.

## Connecting and signing in

### "No credentials for Test: set the username and password in Settings → Environments."

**Cause:** the environment has no saved username or password (or the keychain
was unavailable and the app restarted). **Fix:** enter them in Settings →
Environments → Edit. On the command line the message is "No credentials for
"test": set KINETIC_TEST_USERNAME and KINETIC_TEST_PASSWORD, or put them in
.env.test in the project".

### "The username or password was not accepted (401)."

**Cause:** Core login refused the credentials. **Fix:** check them in
Settings → Environments → Edit, then **Test connection**. The account must
be a space admin with a local password.

### "Could not reach the server; check the URL."

**Cause:** the host does not answer (wrong address, VPN, proxy).
**Fix:** check the Space URL opens in your browser. Use the space's address
only, for example `https://test.example.com`, with no path.

### "This space signs in with single sign-on; Kinetic Migrator needs a local account with a password."

**Cause:** on Kinetic Platform 7.x, the sign-in page refused a password that
the Core API accepts, or sent the request to an identity provider. The
space signs people in only with single sign-on (OpenID Connect or SAML).
**Fix:** use a local account with a password for that environment. The
tool cannot sign in through single sign-on.

### Integrator token fails, or connections are left out

The Integrator serves connections and operations and needs its own sign-in.
What you see depends on why it failed:

| Message | Cause | Fix |
|---------|-------|-----|
| "test.example.com runs Kinetic Platform 7.0.0, which doesn't offer the sign-in this tool uses for the Integrator yet. Snapshots will leave connections and operations out." (or "…doesn't offer the sign-in this tool uses for the Integrator (it answered 404)") | Neither the 6.x nor the 7.x Integrator sign-in exists on this platform build. | Nothing to fix in the tool. Everything else is snapshotted, compared and promoted; connections and operations are left out, with a note, until the platform offers the sign-in. |
| "The Integrator rejected the sign-in (401): check the username and password." | 6.x: the implicit grant refused the credentials. | Check the credentials. |
| "test.example.com rejected the sign-in (403): check the username and password, or the space's sign-in settings." | 7.x: the sign-in page refused the request (the account, or the space's sign-in settings such as its XSRF check). | Check the credentials, then the space's authentication settings. |
| "The Integrator sign-in did not return a token (302, redirected without one): check the username and password." | 6.x: the sign-in redirected to a login page. | Check the credentials. |
| "The sign-in did not start a session (…): check the username and password." | 7.x: the sign-in answered without a session. | Check the credentials. |
| "The Integrator sign-in failed (503) after 3 attempts; try again later." | The sign-in answered 5xx or 429, or did not answer, three times. | Try again later; check the platform's health. |

Every failure except "doesn't offer the sign-in" stops the snapshot or plan:
the tool never silently leaves connections out because of a wrong password.

### "Dev runs 6.1.7 and Prod runs 7.0.0-rc3 — review differences carefully."

**Cause:** the two environments run different major platform versions.
**Fix:** nothing is blocked. Read the differences closely; the platform may
store the same item differently between versions.

## Snapshots

### Connections and operations were left out

**Symptom:** "Connections and operations were left out: …" after a
snapshot, a note in Explore, and in Compare "Connections and operations are
left out of this comparison: Dev's snapshot has none recorded."
**Cause:** the Integrator sign-in is not offered (see above). A comparison or
plan where either side has none recorded leaves them out on both sides:
none show as new, only in the target or removable, and references to them
are not checked (one warning lists the items that have them).
**Fix:** none needed. When the platform offers the sign-in, take a new
snapshot.

### "Artifacts "teams/Ops" and "teams/ops" differ only by case and would collide on case-insensitive file systems (Windows, macOS); rename one of them in the source space"

**Cause:** two items whose names differ only in letter case would be one file
on Windows and macOS. **Fix:** rename one of them in the source space, then
take the snapshot again. ("Folders … differ only by case" is the same
problem for a kapp or form folder.)

### A routine shows empty inputs and outputs, or keeps showing as changed

**Cause:** the snapshot was taken by a version that did not read routine
inputs and outputs, so it stored them empty. Empty lists are never sent (they
would wipe the routine's interface), and a routine whose tree has the same
interface as the target's is not a difference. **Fix:** take a new snapshot of
the source.

### "Upgraded the project to the new file-name layout (commit these changes)"

**Cause:** the project was made before the current file-name encoding. It is
upgraded once: the command line prints the renames, the app commits
"Upgraded project layout". **Fix:** on the command line, commit the changes.
The upgrade is safe to interrupt; running again carries on.

If a plan then stops with "<key>: cannot be matched safely after the
file-name layout change (…); take a new snapshot of Dev and choose the item
again", the old file could not be renamed with certainty (for example it was
edited by hand). Take a new snapshot of that environment.

## Plans

### "Routine … is used by exported workflows but does not exist in the target" / "Handler … is used by exported workflows but is not installed in the target"

**Cause:** a selected workflow, WebAPI or routine runs a routine or handler the
target lacks, and it is not in the selection. **Fix:** add it to the changeset
(Compare suggests it), or create or install it in the target first, then plan
again. A handler that is in no snapshot (no longer installed in the source)
must be installed by hand.

### "… the target has one with the same name but id …" / "… it was probably renamed"

**Cause:** a connection or operation was created in the target by hand with
the same name, or renamed. Forms and workflows refer to connections by id,
so the promoted one needs the source's id. **Fix:** delete or rename the
target's copy, take a new snapshot, then plan again.

### "<key>: not in the source snapshot"

**Cause:** a changeset names an item its pinned snapshot no longer has.
**Fix:** take a new snapshot of the source and build the changeset again.

### "This plan has expired; plan again."

**Cause:** plans and comparisons are kept in the server's memory; the server
was restarted (or the plan is old). **Fix:** go back to Compare (or the
changeset) and choose **Review plan** again.

### An item is "Kept" or "skip-drift"

**Cause:** it was changed in the target since it was last promoted (drift).
It is left alone. **Fix:** look at the three-way view in Compare. Choose
**Overwrite** to replace the target's change, or bring the change back into
the source and take a new snapshot. On the command line, `--overwrite-drift`
overwrites every drifted item.

### "Drift check for the space skipped: kept settings changed since the last promotion"

**Cause:** the list of space settings kept per environment changed since the
space was last promoted, so drift on the space cannot be checked exactly.
The space is never reported as drifted on a guess, but a change made to it
in the target in the meantime is not caught either. **Fix:** none needed. The
next apply that includes the space records the current list.

### Plan shows changes right after an apply

**Cause:** the platform added a default to an item on write, so the next read
differs from what was sent. **Fix:** report it, with the item and the field.

## Applying

### "Test is protected (read-only); nothing can be applied to it."

**Cause:** the target is marked Protected. **Fix:** check you chose the right
target. To allow writes, turn off **Protected** in Settings → Environments.
On the command line: "Environment "test" is readOnly; apply never writes to
it" (set `"readOnly": false` in `environments/test.json`).

### "Something is already running against Test." / "Another change is already running against this environment."

**Cause:** a snapshot or apply is already running on that environment.
**Fix:** wait for it to finish, or cancel it.

### Partly applied, failed or cancelled

**Symptom:** "Partly applied to Test", "Failed to apply to Test" or
"Cancelled applying to Test", with "Nothing was rolled back."
**Cause:** an item failed (the run stops there), was cancelled, needs
attention (a handler without a required setting), or changed in the target
between review and apply (it is skipped, not overwritten).
**Fix:** read the failed or skipped rows in the checklist; the message after
each is the platform's own. Fix the cause and choose **Resume**: it plans
again against the target and continues with what is left, skipping what is
already in place. If secrets were used for the last run only, Resume asks for
them again. To undo instead, choose **Restore…**. On the command line, run
the same `apply` again.

### "The Kinetic Platform rejected the change (400): …"

**Cause:** the platform refused a write. The text after the status is the
platform's own message and error list, which name fields, not values (it is
still redacted and shortened). With nothing usable in the response, the app
shows only "The Kinetic Platform returned an error (<status>)." **Fix:**
depends on the message. For "<name> may not be empty" on a handler, see
[Handlers](#handlers).

### "The apply finished, but Kinetic Migrator could not take a new snapshot of Test. Take one before comparing."

**Cause:** the snapshot taken after the apply failed. The apply itself is
complete. **Fix:** take a snapshot of the target before comparing, otherwise
Compare shows the pre-apply state.

### "Connection … will be created without credentials" / "created with an empty auth "password"; set it in the target"

**Cause:** no secret was entered for a new connection. **Fix:** enter it under
Secrets needed, or set it in the target's console after the apply.

### A KQL search fails with "requires index definition" after a promotion

**Cause:** this comes from the platform, not from Kinetic Migrator. A form or
kapp was promoted with new or changed index definitions, and the target is
still building them (the plan's Needs attention said "Rebuilds search
indexes of …; searches on it may be incomplete until the rebuild
finishes"), or a query uses an index the form does not define. **Fix:** wait
for the index build job to finish in the target (the form's indexes show
their status in the console). If the index is missing, add it in the source,
snapshot and promote the form again.

## Handlers

### "<name> may not be empty"

**Cause:** the Task API saves none of a handler's settings while any required
property is empty: every settings write is refused with one error per empty
required property, even a write that changes some other property.
**What the tool does:** the plan lists each required property that would
still be empty under Needs attention ("Mail Send needs Server before its
settings can be saved in Test"). If you go ahead without it, apply installs
the package, skips the settings write, and reports the handler as done with
a note: "Installed; set <names> in Test's Task console (or enter them here
and apply again)". The run carries on and finishes as partly applied.
**Fix:** enter the value under Environment values (or the secret under
Secrets needed) and apply again, or use **Resume**. On the command line,
supply secrets as `KINETIC_<ENV>_HANDLER_<DEFINITION_ID>__<PROPERTY>` and
other settings as overrides, then apply again. See
[Required handler settings](PROMOTING.md#required-handler-settings).

### A handler keeps showing as an update

**Cause:** a required property is still empty in the target, or a secret you
entered has not been accepted yet. **Fix:** fill it in and apply. A handler
you leave unconfigured on purpose keeps showing as an update; leave it out of
the selection.

### "… come from the handler package or console; change them in Test by hand"

**Cause:** a handler's name or status differs. Those come from the package or
the Task console, not from its settings. **Fix:** change them in the target's
console.

## Reference data

### "<kapp>/<form>: reference-data settings changed since the snapshot of Dev was taken — take a new snapshot"

**Cause:** the entry's match fields (or their order) or its filter changed
since the snapshot was taken; matching records read in two different ways
could duplicate or delete the wrong ones. "no longer in the reference-data
settings" means the entry was removed. **Fix:** take a new snapshot of the
source (and of the target, if you compare snapshots), then plan again.

### Two source records with the same key, or an empty key field, stop the snapshot

**Cause:** with match fields, every record must have a unique, non-empty key.
**Fix:** clean up the source records, or choose other match fields.

### An edited record is created again instead of updated

**Cause:** the entry has no match fields, so a record is matched only when
every value is equal; an edited record is a new one (the plan warns). **Fix:**
add match fields under Settings → Data & values → Reference data.

## Keychain unavailable

**Symptom:** "No system keychain was found, so passwords are kept only until
Kinetic Migrator stops." on the Projects page, and "The system keychain is
not available; secrets are kept in memory until the server stops." in the
log.
**Cause and fix by system:**

| System | Keychain used | When it is unavailable |
|--------|---------------|------------------------|
| macOS | The login keychain, through the built-in `security` tool | Rare; check the login keychain is unlocked (Keychain Access). |
| Windows | Credential Manager, through a helper process running the built-in Windows PowerShell 5.1 | Some remote or service sessions, or PowerShell blocked by policy. Run the app in a normal desktop session. |
| Linux | The Secret Service (GNOME Keyring, KWallet's Secret Service, KeePassXC…) through `secret-tool` | No `secret-tool`, or no Secret Service running (common on servers and in containers). Install `libsecret-tools` (Debian, Ubuntu) or `libsecret` (Fedora) and run a Secret Service in your session. |

While the keychain is unavailable, everything still works: credentials and
secrets are kept in memory and never written to disk in plain text. Enter
them again after each restart. While the Windows helper is still starting the
Projects page shows "Checking the system keychain…"; if it is slow, the log
says "The Windows Credential Manager helper is slow to start; secrets still go
to Credential Manager once it is ready."

## Projects and the repository

### "This folder is a git repository on branch master; Kinetic Migrator manages projects on main."

**Fix:** rename the branch (`git -C <folder> branch -m main`) and open the
folder again.

### "That folder is not a Kinetic project (no kinetic-sync.config.json or environment files in environments/)."

**Fix:** open the project folder itself, not its parent. To start a new
project in an existing folder from the command line, run
`kinetic-migrate init --project <folder>`.

### Push fails

| Message | Fix |
|---------|-----|
| "The remote repository refused the token (401). Check it has write access." | Create a token with write access and save it again. |
| "There is no repository at that address (404)." | Check the address, or create the repository on the server. |
| "The remote repository has changes this project does not have, so the push was refused." | Someone pushed to that repository. Use a new, empty repository for each project; the app always pushes `main`. |
| "The remote repository's address must start with https:// …" | Use an `https://` address. |
| "Could not reach the remote repository." | Check the network and the address. |

### "Your session has ended. Open the app again from the link printed by kinetic-migrate ui."

**Cause:** the server was restarted, or the browser lost its session cookie.
Each start makes a new launch link. **Fix:** open the link printed in the
terminal (start it again with `kinetic-migrate ui` if it stopped).

### "Could not reach Kinetic Migrator. Is it still running?"

**Fix:** check the terminal where you started `kinetic-migrate ui`; start it
again if it stopped.

## Windows notes

- Run it from Command Prompt, PowerShell or Windows Terminal. Every npm script
  works in cmd.exe and PowerShell; use `--fake`, not
  `KINETIC_MIGRATE_FAKE=1 …`.
- The browser opens through Explorer, in your default browser. With
  `--no-open`, copy the printed address.
- Secrets go to **Windows Credential Manager** (Control Panel → Credential
  Manager → Windows Credentials, entries named `kinetic-migrate:…`), saved
  for your user on this computer and never roamed. The first start of the
  helper compiles a small helper and can take several seconds (longer under
  some antivirus); later operations are quick. Long values are split across
  `…#1`, `…#2` entries.
- The default workspace is `%USERPROFILE%\KineticMigrate`, not Documents,
  which OneDrive often syncs. Keep the workspace out of OneDrive, Dropbox and
  other synced folders: syncing locks files mid-write. The app warns when it
  is in one.
- Paths with spaces and non-ASCII letters are fine. Long item names are
  shortened in file names. If you clone a project with Git for Windows and
  still hit the 260-character path limit, run
  `git config --global core.longpaths true`.
- Projects carry a `.gitattributes` that keeps LF line ends, so a clone with
  Git for Windows (which defaults to CRLF) compares cleanly.
- Ctrl+C stops the server.

## Reporting a problem

Include:

- what you did and what you expected,
- the exact message,
- the platform versions of both environments (Settings → Environments),
- your operating system and `node --version`,
- the relevant lines of the log file (read them first),
- for a plan or apply problem, the item key.

Never include passwords, tokens or exported reference data.
