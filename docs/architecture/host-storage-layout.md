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

`Recreate` stops the old Pod before the new one starts. A rolling update can
run both Pods on the same node at once, and a `ReadWriteOnce` PVC does not
prevent that, so two processes could write the same SQLite file.

Agent file tools cannot read or write any file whose basename starts with
`state.db` (database, journals and `.pre-<ts>.bak` backups), checked on the
requested and on the resolved path
(`mcp-host/src/workspace/protectedPaths.ts`). The shell gate applies the same
prefix lexically and is not a security boundary.

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

**Trigger.** It acts only on the split-layout signature: `state/` is a real
directory (not a symlink) holding at least one `state.db*` entry. Every other
tree exits 0 unchanged, including an agent folder named `workspace/` or
`state/` without a database, and a `state` that is a symlink or not a
directory. An agent can create those on a stateful Host, so they must not
stop it from starting. A stateful or desktop tree changes only if it carries
the signature, which only the earlier init or an agent-created
`state/state.db*` entry produces.

Two agent-made `state/` folders on a stateful Host do stop it from starting:

- a `state/` holding a `state.db*` entry beside the root database. The
  signature holds and F2 refuses, because the merge cannot tell the agent's
  file from a second database;
- a `state/` the container uid cannot list and search. F1 refuses before the
  signature check, because the merge cannot tell whether it holds a database.

In both cases the operator renames the folder from a helper Pod.

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

| Case                                                                                                                                                                                                                                                                       | Line contains                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: `workspace` or the PVC root is a symlink, not a directory, or escapes the root; a real `state/` or a present `workspace/` cannot be listed and searched; a `state.db*` entry is a symlink or not a regular file; a directory that decides a collision cannot be listed | `directory is a symlink`, `is not a directory`, `escapes the workspace PVC root`, `state directory is not readable and searchable`, `workspace directory is not readable and searchable`, `SQLite file is a symlink`, `SQLite file is not a regular file`, `cannot list directory` |
| F2: more than one live database family across the root, `state/` and `workspace/`                                                                                                                                                                                          | `more than one live SQLite database`                                                                                                                                                                                                                                               |
| F3: a name to move already exists at the root, or under both `state/` and `workspace/`; `workspace/lost+found` exists                                                                                                                                                      | `destination exists`, `exists under both state/ and workspace/`, `lost+found would remain`                                                                                                                                                                                         |
| F4: the PVC root, `state/`, `workspace/`, or a directory to be moved out of them is not writable by the container uid                                                                                                                                                      | `not writable by uid`                                                                                                                                                                                                                                                              |

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

- Rolling HCC back is safe for stateful and stateless Hosts, with the one
  exception below. The previous `workspace-layout-init` re-splits stateless
  trees, and `workspace-layout-merge` merges them again on roll-forward.
- The exception is a tree cut inside the previous init. That init moves the
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
  `Init:Error` in `workspace-layout-merge`, and do not change a Host's
  lifecycle while rolled back.
- Never roll back the Host image alone; HCC's Deployment carries both
  (`CONTEXT_MAPPER_HOST_IMAGE`, `CONTEXT_MAPPER_DESKTOP_IMAGE`).
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
