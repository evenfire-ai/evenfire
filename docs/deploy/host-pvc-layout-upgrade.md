# Host PVC Layout Upgrade Note

This upgrade gives every Host one storage layout on its workspace PVC (#825):
the PVC root is mounted at the workspace path and the conversation database
is `<workspace>/state.db`, whatever the Host's lifecycle. The layout and the
`workspace-layout-merge` init container are described in
[Host Storage Layout](../architecture/host-storage-layout.md).

## Who is affected

Installations that run v0.10.x or v0.11.x and have created stateless Hosts.
Those releases render `workspace-layout-init`, which splits a stateless
Host's PVC into `state/` (the database) and `workspace/` (the agent files).
After the upgrade, `workspace-layout-merge` moves a split tree back to the
PVC root on the Host's next start. A Host that was always stateful keeps its
tree unchanged.

Desktop Hosts kept their history inside the container, outside the PVC.
Copy `/workspace/state.db*` out of each desktop Host Pod
(`kubectl --context <ctx> cp`) before the first rollout of this release, or
that history is lost.

No flag needs to be set for the upgrade: `CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE`
defaults to `true`, and none of the overlays in this repository set it.

## The script

[`deploy/scripts/host-layout-merge.sh`](../../deploy/scripts/host-layout-merge.sh)
reports what the merge does or did to every Host PVC. It needs `bash`, `jq`
and `kubectl`, and a context that can read the HCC Deployment, Hosts,
Deployments, Pods and PVCs, and create and delete Pods in the Host namespace.
Every call names `--context`; the current context is never used.

- `inventory`: what the merge will do to each PVC. Run it before the upgrade.
- `verify`: whether the flag can be turned off. Run it after the upgrade.

Each PVC is read by a short-lived Pod that runs the merge script with the
moves removed: Host image, uid/gid 1001, claim mounted read-only, no
service-account token, deleted after its log is read. For a running Host the
Pod is pinned to the Host Pod's node, because the claim is ReadWriteOnce. The
script never opens a database and never execs into a Host. `--no-pvc-pods`
skips the check Pods and reports every PVC as `UNVERIFIED`.

Exit codes: `0` pass, `1` an observed blocker, `2` usage error, read failure,
no Host and no Host PVC in the namespace, or a check Pod that could not be
deleted.

## Before the upgrade

With the old release still running:

```bash
deploy/scripts/host-layout-merge.sh inventory --context <ctx>
```

`PRE_825=yes` is expected: the old Host Deployments render
`workspace-layout-init` and `subPath` mounts. Each `PVC` line ends with a
result:

| Result                    | Meaning                                                                                       | Action                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `NO_SPLIT_SIGNATURE`      | The tree does not carry the split-layout signature; the merge exits 0 and changes nothing     | None                                                     |
| `WILL_MERGE`              | The merge moves the tree to the PVC root on the Host's next start                             | None                                                     |
| `WILL_SUPERSEDE`          | A Host switched back to stateful: the merge renames `state/` to `state.db.superseded-<ts>`    | None; see [Repairs](#repairs) for where the history goes |
| `WILL_REFUSE_F<n> <line>` | The merge will refuse with that line and the Host will stay in `Init:Error` after the upgrade | See [Repairs](#repairs); counted in `UPGRADE_BLOCKERS`   |
| `UNREADABLE <reason>`     | The check Pod could not read the PVC (pull error, timeout, unexpected output)                 | Fix the reason and run the command again                 |
| `UNKNOWN <reason>`        | A Host's claim is missing from the PVC list, or a PVC labelled for a Host has another name    | Find the claim the Host mounts and run the command again |

The command exits 1 while `UPGRADE_BLOCKERS` is above 0, while a PVC is
`UNREADABLE` or `UNKNOWN`, when Hosts exist but no PVC was inspected, or when the flag is set to an invalid value or to `false` with a
split tree present. `DESKTOP_HOSTS` repeats the export warning above.

`WILL_SUPERSEDE` is not a blocker: the merge handles that tree on the Host's
next start with no operator step.

Repair every `WILL_REFUSE_*` before the upgrade and run `inventory` again
until `UPGRADE_BLOCKERS=0`. A refused Host stays in `Init:Error` after the
upgrade, and a deploy that waits for Host rollouts fails on it (the minikube
setup does: `scripts/minikube/sync-auth-key.sh` waits for every Host
Deployment that is not suspended).

A `NO_SPLIT_SIGNATURE` result says only that the merge will not touch the
tree. It does not prove where the history is; see the trees without a
signature in [Host Storage Layout](../architecture/host-storage-layout.md).

## The upgrade

Deploy the release with the flag unset or `"true"`. **Never set it to
`"false"` in the upgrade deploy**: without the init, a split Host starts on an
empty database at the PVC root and reports no error. `inventory` and `verify`
print `FLAG_FALSE_WITH_SPLIT_TREES=<n>` and exit 1 in that state. Set the
flag back to `"true"` before the split Host starts: the next start then
merges the tree. If the Host already started with the flag off, it created a
root `state.db` next to `state/state.db`. With the flag back on, the next
start treats that tree like a Host switched from stateless to stateful: it
keeps the root database, which holds only the chats since the flag-off
start, and renames `state/` with the older history to
`state.db.superseded-<ts>`. To serve the older history instead, follow
[Repairs](#repairs).

Running Hosts restart with the new template and merge on that start.
Suspended Hosts merge on their next wake; the upgrade does not wake them.

## After the upgrade

```bash
deploy/scripts/host-layout-merge.sh verify --context <ctx>
```

| Result                                | Meaning                                                                                         | Action                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POD_OK`                              | The running Host Pod's merge init exited 0 and its tree carries no signature                    | None                                                                                        |
| `NO_SPLIT_SIGNATURE`                  | A Host without a Pod whose tree the merge will not touch                                        | None                                                                                        |
| `SPLIT`                               | A Host whose tree is still split (with a running Pod, the tree was split again after its start) | Wake the Host (open one of its chats, or `POST /api/v1/rpc/hosts/<host>/wake` on rpc-proxy) |
| `WILL_REFUSE_F<n> <line>`             | A Host whose next start will refuse                                                             | See [Repairs](#repairs)                                                                     |
| `MERGE_REFUSED <line>`                | The running Host Pod is in `Init:Error` with that line                                          | See [Repairs](#repairs)                                                                     |
| `MERGE_RUNNING`                       | The merge init has not finished                                                                 | Run `verify` again                                                                          |
| `UNKNOWN`, `UNREADABLE`, `UNVERIFIED` | The script could not decide                                                                     | Fix the reason and run `verify` again                                                       |

`HOST_LAYOUT_VERIFY=PRE_825` (exit 1) means a Host Deployment still renders
`workspace-layout-init` or a `subPath` mount: the upgrade has not reached it.
A Host Deployment that does not render `workspace-layout-merge` counts in
`template_stale` and fails the verdict; it means HCC has not reconciled that
Host yet.

`HOST_LAYOUT_VERIFY=PASS` (exit 0) when every Host Deployment renders the
merge init and no Host PVC is split, refused, running, or undecided.
`PVC_CONTENTS=NOT_INSPECTED` is a reminder that the script checks the layout,
not the database contents.

`verify` reads the PVC of every Host, running or not; for a running Host the
init exit code and the tree must both agree.

Orphan PVCs, whose `clerum.io/host` label names no Host, are listed with
`kind=ORPHAN` and counted in `ORPHAN_SPLIT` when split. A split orphan does not
block the verdict, because no Host will start on it; an orphan the script
could not read is counted in `ORPHAN_UNDECIDED` and blocks it. A Host created later with the
same name would start on that PVC: with the flag off, on an empty database.
Delete the orphan PVC, or recreate its Host before turning the flag off.

## Repairs

Every refusal exits before the first move, so the tree is as the old release
left it. Repair before the upgrade when the files you rename are not the
database the running Host opens; otherwise repair after the upgrade, when the
Host Pod is in `Init:Error` and runs no `mcp-host`, so nothing writes to the
PVC. Work from a helper Pod on the Host Pod's node
(the claim is ReadWriteOnce), with the Host image and the PVC mounted
read-write:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: layout-repair-<host>
  namespace: mcp-host
spec:
  nodeName: <node of the Host Pod>
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: { runAsUser: 1001, runAsGroup: 1001, runAsNonRoot: true }
  containers:
    - name: repair
      image: <image of the Host's mcp-host container>
      command: ['sleep', '3600']
      volumeMounts: [{ name: pvc, mountPath: /mnt/pvc }]
  volumes:
    - name: pvc
      persistentVolumeClaim: { claimName: <host>-workspace }
```

Rename, never delete, database files. Keep each database family together:
rename `state.db`, `state.db-wal` and `state.db-shm` to
`state.db.<label>.bak`, `state.db.<label>.bak-wal` and
`state.db.<label>.bak-shm`, so SQLite still finds the journals when the
backup is opened. Do not use `pre-` in the label: `state.db.pre-*.bak` names
are part of the split-layout signature. Delete the helper Pod when done; the
Host Pod retries the init on its own, or delete the Host Pod to retry at once.

**A Host switched from stateless to stateful on v0.10 or v0.11
(`WILL_SUPERSEDE`, no operator step).** A Host created stateless and later
switched to stateful (through the admin API, or by HCC when a
CommunicationChannel, a desktop or a SharedFileSystem co-location rejected
stateless) keeps its old history in `state/state.db` and writes new chats to
a root `state.db`. Every stateless start moves the root database into
`state/`, so the root database is the newer one, and it is the one the Host
serves today. On the first start after the upgrade the merge keeps it,
renames `state/` in one step to `state.db.superseded-<UTC ts>`, leaves
`workspace/` where it is, and exits 0:

- the old history is in `state.db.superseded-<ts>/state.db` (with its
  journals and any `.pre-<ts>.bak` backups); nothing is deleted;
- the old files stay under `workspace/`, which the Host sees as
  `<workspace>/workspace/`. Move them to the root from a helper Pod if the
  Host needs them at their old paths;
- agent file tools cannot read `state.db.superseded-*` or anything under it,
  because the name starts with `state.db`.

To serve the old history instead, swap the two families from a helper Pod
while no Host Pod has the PVC mounted: rename the root family to
`state.db.<label>.bak` names and move the files of
`state.db.superseded-<ts>/` that start with `state.db` to the root.

The same tree is refused (`WILL_REFUSE_F2`) when `workspace/` also holds a
database, or when `state/` and `workspace/` both hold one and the root has
none. Decide which history the Host serves and rename the other families.
The renamed families stay on the PVC; agent file tools cannot read any
`state.db*` name.

**A name in `workspace/` that already exists at the root (`WILL_REFUSE_F3`).**
This includes Hosts the old release already left in `Init:Error` with a
personalization-file collision (#1101). Rename one of the two files.

**A `state/` without a database next to `workspace/`.** A stateless Host that
never started `mcp-host` has an empty `state/`. The tree has no signature, so
the merge exits 0 and the files stay under `workspace/`, which the Host then
sees as `<workspace>/workspace/`. Nothing is lost; move them to the root from
a helper Pod if the Host needs them at their old paths.

Every other refusal line is listed in
[Host Storage Layout](../architecture/host-storage-layout.md#workspace-layout-merge).

## Turning the flag off

The merge is needed once per Host. Once `verify` passes, set
`CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE` to `"false"` in your own overlay
(clerum: `keyper-labs/evenfire-infra`), as a strategic-merge patch on the HCC
Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: host-context-controller
  namespace: control-plane
spec:
  template:
    spec:
      containers:
        - name: host-context-controller
          env:
            - name: CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE
              value: 'false'
```

- Turning it off changes HCC's Host template, so every running Host restarts
  once.
- `kubectl set env` works only until the next apply of the overlay.
- On Minikube the overlays in this repository do not pin the flag, so a new
  setup returns it to `true`.
- After the turn-off, `verify` reports `HOST_LAYOUT_VERIFY=ALREADY_OFF`,
  `FLAG_FALSE_WITH_SPLIT_TREES` if a split tree appeared since, or `FAIL` if
  a PVC could not be read.

## Rollback

Before rolling HCC back to v0.11.x or older, set the flag back to `"true"`
(or remove the patch). The old init re-splits stateless trees, and only a
roll-forward with the merge rendered brings them back to the root. The other
rollback rules are in
[Host Storage Layout](../architecture/host-storage-layout.md#rollback).
