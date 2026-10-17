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
allows. A repository or archive operation run there, such as
`git add -A && git push` or a `tar` of the workspace, copies the database out
with the agent's files; neither prefix check sees it. Stateful Hosts had this exposure before #825; stateless Hosts gain it,
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
`state.db-shm` or a `.pre-<ts>.bak` copy of one of those three
(`state.db.pre-<ts>.bak`, `state.db-wal.pre-<ts>.bak`,
`state.db-shm.pre-<ts>.bak`). Every other tree exits 0
unchanged, including an agent folder named `workspace/` or `state/` alone, a
`state/` holding other `state.db*` names (`state.db.json`, `state.dbx`,
`state.dbX.pre-1.bak`), and a
`state` or `workspace` that is a symlink or not a directory. An agent can
create those on a stateful Host, so they must not stop it from starting. A
stateful or desktop tree changes only if it carries the signature, which only
the earlier init or agent-created `state/` and `workspace/` folders with one
of those exact names produce.

A `state/` holding `state.db` or one of its journals beside the root
database, next to a `workspace/` folder without a database, is superseded
(T5). The earlier release produces this tree without any agent: a Host
created stateless and switched to stateful on v0.10 or v0.11 keeps its old
history in `state/state.db` and writes new chats to a root `state.db`. Every
stateless start moves the root database into `state/` (the earlier init
relied on the same rule), so the root database is the newer one. The merge
keeps it, renames `state/` in one step to `state.db.superseded-<UTC ts>`,
leaves `workspace/` in place, and exits 0. No `state/` remains, so later
starts carry no signature. Nothing is deleted, and the new name starts with
`state.db`, so agent file tools cannot read it or anything under it. An
agent-made `state/` folder in that position gets the same rename.
`host-layout-merge.sh inventory` reports the tree as `WILL_SUPERSEDE`, which
is not an upgrade blocker. A destination that already exists, or a PVC root
the container uid cannot write, refuses before the rename.

One agent-made folder pair on a stateful Host does stop it from starting: a
`state/` the container uid cannot list and search, next to a `workspace/`
folder. F1 refuses before the database check, because the merge cannot tell
whether it holds a database. The operator renames the folder from a helper
Pod.

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
   names; otherwise the next start keeps that root database and renames
   `state/`, which holds the history, to `state.db.superseded-<ts>`. Chats
   written to that database stay in the backup;
3. start the Host: the signature holds and the merge moves the history to
   the root.

**Moves**, in this order:

1. every entry of `workspace/`, dotfiles and symlinks included, to the root
   (`mv` renames a symlink and never follows it);
2. every entry of `state/` except `state.db`, including journals and
   `.pre-<ts>.bak` backups;
3. `state/state.db` last, so an interrupted merge still carries the
   signature and completes on the next start;
4. remove the empty `state/` and `workspace/`, then `sync`.

A crash after step 3 and before step 4 leaves empty `state/` and `workspace/`
directories at the root. The signature is gone, so later starts exit 0 and
keep them; the database and its journals are already at the root.

**Refusals.** Each prints one `workspace layout merge refused: ...` line to
stderr and exits 1 before the first move, leaving the tree unchanged. The Pod
stays in `Init:Error`.

| Case                                                                                                                                                                                                                                           | Line contains                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: the PVC root is a symlink, not a directory, or resolves to `/`; `state/` or `workspace/` escapes the root or cannot be listed and searched; a database entry (`state.db`, `-wal`, `-shm`, `.pre-*.bak`) is a symlink or not a regular file | `directory is a symlink`, `is not a directory`, `escapes the workspace PVC root`, `state directory is not readable and searchable`, `workspace directory is not readable and searchable`, `SQLite file is a symlink`, `SQLite file is not a regular file` |
| F2: more than one live database family across the root, `state/` and `workspace/`, except the superseded tree (root main, `state/` family, no `workspace/` family)                                                                             | `more than one live SQLite database`                                                                                                                                                                                                                      |
| F3: a name to move already exists at the root, or under both `state/` and `workspace/`; a directory that decides such a collision cannot be listed; `workspace/lost+found` exists                                                              | `destination exists`, `exists under both state/ and workspace/`, `lost+found would remain`, `cannot list directory`                                                                                                                                       |
| F4: the PVC root, `state/`, `workspace/`, or a directory to be moved out of them is not writable by the container uid                                                                                                                          | `not writable by uid`                                                                                                                                                                                                                                     |

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
Host, and the flag closes that window once every Host is merged. While the
flag is on, the init runs on every Host at every start, so such an entry can
also make it act: next to a root `state.db` and a `workspace/` folder it
renames `state/` to `state.db.superseded-<ts>`, and a symlinked `state.db*`
entry refuses with F1 and leaves a stateful Host in `Init:Error` until an
operator renames the entry.

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
  4. no Host PVC still carries the split-layout signature.

  [`deploy/scripts/host-layout-merge.sh verify`](../../deploy/scripts/host-layout-merge.sh)
  checks all four and reads each PVC without a Pod from a read-only check
  Pod; it prints `HOST_LAYOUT_VERIFY=PASS` only when they hold. The procedure
  for any installation is in
  [Host PVC Layout Upgrade Note](../deploy/host-pvc-layout-upgrade.md).

- The turn-off is a patch in the installation's own overlay (clerum:
  `keyper-labs/evenfire-infra`, `patches/hcc-workspace-layout-merge.yaml`,
  value `"false"`), never in `dynamic-images.yaml`. Turning it off changes the
  pod template, so every running Host restarts once.
- Never turn it off in the deploy that first introduces this HCC.
- Before any manual HCC undo to a revision older than #825's, set it back to
  `true`. The older init re-splits stateless trees, and only a roll-forward
  with the merge rendered brings them back to the root.

## Database failures in `mcp-host`

- If the database worker exits, or an asynchronous write fails, the persist
  queue rejects later writes and the process exits with code 1. The kubelet
  restarts the container; a persistent cause shows as `CrashLoopBackOff`.
- A slow write is not a failure. If the worker has operations in flight and
  completes none of them for `CLERUM_DB_WORKER_STALL_TIMEOUT_MS` (default
  `30000`, at least `1000`, at most `2147483647` and above
  `CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS`, or config load fails), the queue fails
  the same way and the worker is terminated. The bound counts completed
  operations, so a single operation that runs longer than it counts as a
  stall too: the boot reaps of processing and awaiting-approval sessions and
  the checkpoint the worker runs when it closes the database are such single
  operations.
- At shutdown mcp-host waits for every queued write, bounded only by that
  stall timeout and the Pod's termination grace period. A persistence failure
  detected during shutdown exits 1 instead of 0. With the default settings
  the stall timeout (30 s) equals the default grace period (30 s), so a worker
  that stalls during shutdown is killed by the kubelet first and the container
  ends with SIGKILL (137), not 1.
- The boot retention sweep of session search runs before the Host listens:
  `main.ts` awaits it before bootstrap, so its duration counts against the
  Host startup probe window (310 s; 630 s for desktop Hosts). A restart keeps
  the batches already committed.
- A failed synchronous write, such as `SQLITE_FULL` on the first write of a
  turn, rejects only that request; the queue stays usable and the process
  keeps running. A full PVC therefore shows either as turns that fail while
  the Pod stays Ready, or as `CrashLoopBackOff` once an asynchronous write
  fails.
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
  `.pre-<ts>.bak` backup from an earlier start. The tree then carries the
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
  `workspace/`, including `.pre-<ts>.bak` backups, and moves back to
  `state/` only the exact names `state.db`, `state.db-wal` and `state.db-shm`.
  The backups stay under `workspace/`, the agent's workspace on a stateless
  Host, where the previous mcp-host (which protects only those three exact
  names) lets agent file tools read them. Move them into `state/` from a helper
  Pod after the rollback, or roll forward.
- A `state.db.superseded-<ts>` directory is a root entry like any other: the
  previous init moves it into `workspace/` on a stateless Host, and the merge
  moves it back to the root on roll-forward. While rolled back, the previous
  mcp-host protects only the three exact names, so agent file tools can read
  the directory's other files.
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
  because every refusal exits before the first move. The workflow reads no
  Host state, so it can also roll back while a Host Pod is still running
  `workspace-layout-merge`, the window the operator rule below forbids, and
  the case above of a merge cut between the journals and the main database
  can then occur.
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
- Script: `deploy/scripts/host-layout-merge.test.mjs` runs
  `host-layout-merge.sh` against a fake `kubectl`, and runs its check script
  on real trees. The HCC merge suite above also checks that the check script
  predicts the merge's outcome (merge, no-op or the refusal line) on every
  tree it tests.
- Live: `make test-e2e-hcc-storage-layout-switch`
  (`scripts/e2e/e2e-hcc-storage-layout-switch.sh`) on an owned branch profile.
  S5 and S6 also run `host-layout-merge.sh inventory` and `verify` on their
  Hosts.
- Desktop: `make test-e2e-825-desktop-continuity`
  (`desktop-app/test/e2e-playwright/stateful-stateless-switch-continuity.spec.ts`)
  keeps one conversation across stateful → stateless → stateful switches.
