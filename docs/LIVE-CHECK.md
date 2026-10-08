# Live check

This check runs the built server API against two real spaces: a **source** space,
which is only read, and a disposable **scratch** space, which is written to. It
covers what the fake-mode e2e test cannot: real API shapes, real data volumes and
real secret handling.

## How it runs

A script copies a project into a temporary workspace and removes its
credentials, exports, snapshots, state and git history. It then starts the
server with an in-memory secret store and drives the HTTP API the way the web UI
does: it logs in with the session key, sends the `X-Kinetic-Migrate` header and
polls jobs. Every response body is checked for the raw passwords used in the
run.

## Steps and results (2026-10-07)

| Step | Result |
|------|--------|
| Open the project, set credentials for both environments (write-only) | OK |
| Snapshot source | 504 items: space, 40 teams, 1 model, 4 file resources, 13 connections, 316 operations, 9 kapps, 63 forms, 2 WebAPIs, 40 workflows, 12 routines, 2 handlers, 1 task ref |
| Snapshot scratch | 510 items |
| Explore: roots, search, item summary + relationships for a handler and a connection | OK; the connection showed 21 dependents |
| Compare preview (from snapshots) | same 469 · changed 20 · new 2 · only-target 8 |
| Walk the compare tree, open a changed operation's field diff | OK (`config.body.raw` differed) |
| Suggestions for that operation | none (its connection already exists in scratch) |
| Plan → scratch | update 1, nothing that needs attention, no environment values or secrets needed |
| Apply with typed confirmation | applied 1, backup commit created |
| Re-plan the same selection | unchanged 1: nothing left to do |
| A second run, started from scratch | compare showed same 470 · changed 19: the first promotion stuck |
| History | Project started → two snapshots → backup of scratch → applied, in plain language |
| Secret leaks in any response | **0** |

## What it does not cover

- Applying anything that needs environment values or secrets, or that has
  needs-attention items. Unit and server tests cover these, and an earlier
  CLI-level full promotion into scratch reached a clean re-plan.
- The OS keychain. The run used the in-memory store.
- The web UI against real data. The e2e test covers the UI in fake mode.
