# Host Storage Layout

Every Host keeps its files and its conversation database on one workspace
PVC, in the same place, whatever its lifecycle. Switching a Host between
stateful and stateless changes how its Pod runs (replicas, priority class,
probes, `CLERUM_STATELESS_LIFECYCLE`); it never changes where data lives
(#825). Through `CLERUM_STATELESS_LIFECYCLE` it also changes SQLite
durability, as before #825: a stateless Host always writes with
`PRAGMA synchronous = FULL`, a stateful one only with
`CLERUM_DB_BARRIER_MODE=full` (`mcp-host/src/main.ts`).

## Layout

HCC renders the same storage for every Host Deployment
(`host-context-controller/src/hostReconciler.ts`):

| Item                  | Value                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Volume mount          | the PVC `<host>-workspace` root at `workspacePath`, no `subPath`                                 |
| `workspacePath`       | `/workspace`; `/config/workspace` for a `spec.desktop` Host                                      |
| Conversation database | `<workspacePath>/state.db` (with `-wal` and `-shm`)                                              |
| Store env             | `CLERUM_SESSION_STORE=sqlite`, `CLERUM_SESSION_DB_DIR=<workspacePath>`                           |
| Init container        | `workspace-layout-merge`, while `CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE` is enabled (the default) |
| Deployment strategy   | `Recreate`                                                                                       |

HCC puts the store env in the container's `env`, which Kubernetes applies over
the `mcp-host-config` ConfigMap loaded through `envFrom`, and mcp-host prefers
`CLERUM_SESSION_DB_DIR` to `CLERUM_SESSION_DB_PATH` and to the memory
workspace path (`resolveSessionDbPath`, `mcp-host/src/main.ts`), so a
ConfigMap cannot move the database. The gcp-dev and gcp-prod overlays
(`keyper-labs/evenfire-infra`, `mcp-host-config.yaml`) set
`CLERUM_MEMORY_ENABLED` and `CLERUM_SESSION_STORE=sqlite`, and none of
`CLERUM_SESSION_DB_DIR`, `CLERUM_SESSION_DB_PATH` or
`CLERUM_MEMORY_WORKSPACE_PATH`. A stateful Host therefore already resolved its
database to `/workspace/state.db`, the PVC root, before #825.

`Recreate` stops the old Pod before the new one starts. A rolling update can
run both Pods on the same node at once, and a `ReadWriteOnce` PVC does not
prevent that, so two processes could write the same SQLite file.

Agent file tools cannot read or write any file whose basename starts with
`state.db` (database, journals and `.pre-<ts>.bak` backups), checked on the
requested and on the resolved path
(`mcp-host/src/workspace/protectedPaths.ts`). The shell gate applies the same
prefix lexically and is not a security boundary.

The database is part of the agent tree. The shell tool runs with the
workspace root as its working directory (`mcp-host/src/core/tools/shell.ts`),
so a command such as `rm -f *`, `find . -type f -delete` or `git clean -fdx`
run there deletes `state.db` and its journals, and a hard link
(`ln state.db notes`) exposes its contents under a name the prefix rule
allows. Stateful Hosts had this exposure before #825; stateless Hosts gain it,
because their database moves from the separate `state/` mount to the root.
Isolating the database from the agent tree is a follow-up.

## The previous split layout

Before #825, stateless Hosts mounted `PVC/workspace` at `/workspace` and
`PVC/state` at `/var/lib/clerum/state`, and an init container
(`workspace-layout-init`) moved root content into those two directories. A
switch back to stateful mounted the PVC root again, did not find
`state.db` there, and started an empty database. Repeated switches split the
history across databases and duplicated personalization files.

## `workspace-layout-merge`

The init container runs before `mcp-host` on every start, with the Host
image, the main container's `securityContext` and pull policy, the PVC root
mounted at `/mnt/workspace-root`, and requests of 10m CPU / 32Mi memory
(`host-context-controller/src/statelessDeployment.ts`). It never opens
SQLite.

**Trigger.** It acts only on the split-layout signature the earlier init
leaves: `state/` and `workspace/` are both real directories (not symlinks),
and `state/` holds a file that init writes: `state.db`, `state.db-wal`,
`state.db-shm` or a `state.db*.pre-<ts>.bak` copy. Every other tree exits 0
unchanged, including an agent folder named `workspace/` or `state/` alone, a
`state/` holding other `state.db*` names (`state.db.json`, `state.dbx`), and a
`state` or `workspace` that is a symlink or not a directory. An agent can
create those on a stateful Host, so they must not stop it from starting. A
stateful or desktop tree changes only if it carries the signature, which only
the earlier init or agent-created `state/` and `workspace/` folders with one
of those exact names produce.

Two agent-made folder pairs on a stateful Host do stop it from starting:

- a `state/` holding `state.db` or one of its journals beside the root
  database, next to a `workspace/` folder. The signature holds and F2
  refuses, because the merge cannot tell the agent's file from a second
  database;
- a `state/` the container uid cannot list and search, next to a
  `workspace/` folder. F1 refuses before the database check, because the
  merge cannot tell whether it holds a database.

In both cases the operator renames the folder from a helper Pod.

A split tree whose `workspace` is missing, a symlink or a regular file also
carries no signature, because the earlier init always leaves a real
`workspace/` directory. The merge exits 0 and changes nothing; mcp-host then
finds no `state.db` at the root and creates an empty one, while the history
stays in `state/state.db`. No dev or prod Host had this tree when #825 shipped
(all five dev stateless roots had a real `workspace/`; prod had no stateless
Host). Recovery, with the Host stopped and the PVC mounted in a helper Pod:

1. restore `workspace` as a real directory (move the symlink target or the
   file aside and `mkdir workspace`);
2. if mcp-host already created a root `state.db`, rename the root
   `state.db`, `state.db-wal` and `state.db-shm` to `state.db.<label>.bak`
   names, or the next start refuses with F2 (two live databases). Chats
   written to that database stay in the backup;
3. start the Host: the signature holds and the merge moves the history to
   the root.

**Moves**, in this order:

1. every entry of `workspace/`, dotfiles and symlinks included, to the root
   (`mv` renames a symlink and never follows it);
2. every entry of `state/` except `state.db`, including journals and
   `state.db*.pre-<ts>.bak` backups;
3. `state/state.db` last, so an interrupted merge still carries the
   signature and completes on the next start;
4. remove the empty `state/` and `workspace/`, then `sync`.

A crash after step 3 and before step 4 leaves empty `state/` and `workspace/`
directories at the root. The signature is gone, so later starts exit 0 and
keep them; the database and its journals are already at the root.

**Refusals.** Each prints one `workspace layout merge refused: ...` line to
stderr and exits 1 before the first move, leaving the tree unchanged. The Pod
stays in `Init:Error`.

| Case                                                                                                                                                                                                                                                                                                  | Line contains                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: the PVC root is a symlink, not a directory, or resolves to `/`; `state/` or `workspace/` escapes the root or cannot be listed and searched; a database entry (`state.db`, `-wal`, `-shm`, `.pre-*.bak`) is a symlink or not a regular file; a directory that decides a collision cannot be listed | `directory is a symlink`, `is not a directory`, `escapes the workspace PVC root`, `state directory is not readable and searchable`, `workspace directory is not readable and searchable`, `SQLite file is a symlink`, `SQLite file is not a regular file`, `cannot list directory` |
| F2: more than one live database family across the root, `state/` and `workspace/`                                                                                                                                                                                                                     | `more than one live SQLite database`                                                                                                                                                                                                                                               |
| F3: a name to move already exists at the root, or under both `state/` and `workspace/`; `workspace/lost+found` exists                                                                                                                                                                                 | `destination exists`, `exists under both state/ and workspace/`, `lost+found would remain`                                                                                                                                                                                         |
| F4: the PVC root, `state/`, `workspace/`, or a directory to be moved out of them is not writable by the container uid                                                                                                                                                                                 | `not writable by uid`                                                                                                                                                                                                                                                              |

The PVC root checks of F1 run on every start, before the signature check.

Two exceptions to F2/F3 cover the earlier init or this merge stopped
half-way:

- root orphan journals with `state/state.db` as the only main file. A journal
  with the same name both at the root and in `state/` still refuses, because
  the merge cannot tell which one belongs to the database;
- an empty source directory whose destination is a real directory.

**Operator action on `Init:Error`.** Read the line with
`kubectl --context <ctx> -n mcp-host logs <pod> -c workspace-layout-merge`,
inspect the PVC from a helper Pod, and rename or remove the conflicting entry.
Keep every database file until the history is confirmed.

### `CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE`

HCC renders `workspace-layout-merge` only while this flag is enabled
(`host-context-controller/src/config.ts`, `parseWorkspaceLayoutMerge`). On a
stateful Host the PVC root is the agent workspace, so an agent can create a
`state/state.db*` entry and trigger the merge; the merge is needed once per
Host, and the flag closes that window once every Host is merged.

- Unset or empty means `true`. Only the exact strings `true` and `false` are
  accepted; any other value fails HCC config load with
  `CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE must be 'true' or 'false', got '<value>'`.
- The default is `true` because dev deploys automatically after a `dev` push
  and prod promotes the dev image pins, so HCC can reach a cluster before any
  overlay sets the flag. With the init missing, a split Host would start on an
  empty database without an error.
- Turn it off per cluster only when all four hold:
  1. every Host Deployment renders `workspace-layout-merge`, with no `subPath`
     and no `workspace-layout-init`;
  2. every running Host Pod's `workspace-layout-merge` exited 0;
  3. no Host is in `Init:Error` in `workspace-layout-merge`;
  4. every Host that was suspended at deploy time has woken once with that
     init exiting 0.
- The turn-off is an overlay patch in `keyper-labs/evenfire-infra`
  (`patches/hcc-workspace-layout-merge.yaml`, value `"false"`), never in
  `dynamic-images.yaml`. Turning it off changes the pod template, so every
  running Host restarts once.
- Never turn it off in the deploy that first introduces this HCC.
- Before any manual HCC undo to a revision older than #825's, set it back to
  `true`. The older init re-splits stateless trees, and only a roll-forward
  with the merge rendered brings them back to the root.

## Database failures in `mcp-host`

- If the database worker exits, or an asynchronous write fails, the persist
  queue rejects later writes and the process exits with code 1. The kubelet
  restarts the container; a persistent cause shows as `CrashLoopBackOff`.
- mcp-host never creates `state.db` next to an orphan `state.db-wal` or
  `state.db-shm`; opening the store fails with `ORPHAN_WAL` instead
  (`mcp-host/src/db/worker/openDatabase.ts`).
- A PVC with files and no database starts normally and mcp-host creates
  `state.db`.

## Suspended stateless Hosts

A suspended Host has no Pod, so its PVC is merged on its next wake. No wake is
forced by a deploy.

## Rollback

- Rolling HCC back is safe for stateful and stateless Hosts, with the
  exceptions below (risk R6 of #825). The previous `workspace-layout-init`
  re-splits stateless trees, and `workspace-layout-merge` merges them again
  on roll-forward.
- The first exception is a tree cut inside the previous init. That init moves the
  root entries into `workspace/` in one loop and then `workspace/state.db*`
  into `state/` in a second loop. A crash between the loops leaves
  `workspace/state.db*` and a `state/` without a database. The previous init
  completes that tree on its next start; the merge does not, because the tree
  has no signature: it exits 0, and mcp-host creates an empty root database
  while the history stays in `workspace/state.db*`. Stateful Hosts never run
  the previous init, and every dev stateless tree was complete when
  inventoried, so reaching this needs a rollback, a crash in that window, and
  a roll-forward before the Host starts again. To recover, scale the Host to
  zero, rename the new root `state.db*` files from a helper Pod (keep them),
  and move `workspace/state.db*` to the root.
- The second exception is the same cut when `state/` already holds a
  `state.db*.pre-<ts>.bak` from an earlier start. The tree then carries the
  signature, and the merge moves `workspace/` entries in name order:
  `state.db` before `state.db-shm` and `state.db-wal`. Resume covers only
  journals at the root next to `state/state.db`, so a merge cut after
  `workspace/state.db` moved leaves a root database next to journals in
  `workspace/`, and every later start refuses with F2
  (`more than one live SQLite database`). Nothing is lost: the Host stays in
  `Init:Error` with the database and its journals on the PVC. To recover,
  move the remaining `workspace/state.db-*` journals to the root from a
  helper Pod.
- A rollback over a merge cut between the journals and the main database
  (journals already at the root, `state/state.db` not yet moved) loses the
  journals' pairing. The previous init sees a root SQLite source next to
  `state/state.db`, renames that main file to `state/state.db.pre-<ts>.bak`,
  and then moves the root journals into `state/` without their main file. The
  backup holds the database only up to its last checkpoint, and the previous
  mcp-host creates a new `state/state.db` next to a WAL that belongs to the
  backup. A Pod in this window is Pending with the merge init still running,
  not in `Init:Error`, so the rule below names it explicitly.
- After a rollback, the previous init moves every root entry into
  `workspace/`, including `state.db*.pre-<ts>.bak` backups, and moves back to
  `state/` only the exact names `state.db`, `state.db-wal` and `state.db-shm`.
  The backups stay under `workspace/`, the agent's workspace on a stateless
  Host, where the previous mcp-host (which protects only those three exact
  names) lets agent file tools read them. Move them into `state/` from a helper
  Pod after the rollback, or roll forward.
- A merged root that holds a symlink (for example one an agent created under
  `workspace/`, which the merge moved to the root) blocks the previous init:
  it creates empty `state/` and `workspace/`, then exits 1 with
  `legacy source is a symlink` and moves nothing, so the Host stays in
  `Init:Error` with its history intact. Roll forward (the merge exits 0 and
  keeps the two empty directories), or remove the root symlinks from a
  helper Pod before the rollback.
- The deploy workflows roll HCC back automatically when its rollout gate fails
  (`keyper-labs/evenfire-infra`, `deploy-clerum-dev.yml:715-742`,
  `deploy-clerum-prod.yml:643-670`). This is safe for a Host in `Init:Error`,
  because every refusal exits before the first move.
- For an operator-initiated rollback: do not roll back while any Host is in
  `Init:Error` in `workspace-layout-merge` or any Host Pod is still running
  that init (Pending, init not finished), and do not change a Host's
  lifecycle while rolled back.
- Never roll back the Host image alone; HCC's Deployment carries it. The
  gcp-dev and gcp-prod overlays set both `CONTEXT_MAPPER_HOST_IMAGE` and
  `CONTEXT_MAPPER_DESKTOP_IMAGE` (`patches/dynamic-images.yaml`);
  `deploy/base` sets only the first, so without an overlay HCC renders desktop
  Hosts with `clerum/mcp-host-desktop:latest`
  (`host-context-controller/src/config.ts`).
- A desktop Host's history from before #825 lived in the container, outside
  the PVC, and is lost at the first rollout unless it is copied out of the
  live Pod first (`kubectl --context <ctx> cp` of `/workspace/state.db*`).

## Tests

- Unit: `host-context-controller/test/statelessDeployment.workspaceLayoutMerge.test.ts`
  runs the script under `sh` on real trees, including an uncheckpointed WAL,
  at least one case of each refusal family (F1–F4), re-runs after an
  interrupted merge and a round trip through the previous init
  (`test/__fixtures__/base-workspace-layout-init.sh`).
- Live: `make test-e2e-hcc-storage-layout-switch`
  (`scripts/e2e/e2e-hcc-storage-layout-switch.sh`) on an owned branch profile.
- Desktop: `make test-e2e-825-desktop-continuity`
  (`desktop-app/test/e2e-playwright/stateful-stateless-switch-continuity.spec.ts`)
  keeps one conversation across stateful → stateless → stateful switches.
