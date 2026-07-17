# GlobalFileSystem CRD Reference

**API Group:** `clerum.io`  
**Version:** `v1alpha1`  
**Scope:** Namespaced  
**Short name:** `gfs`  
**Reconciled by:** host-context-controller `gfsReconciler`

## Purpose

A **brokered global drive** — one governed file tree per cluster (singleton
intent), read and written by both humans and agents under a single
deny-by-default permission model. It's a distinct storage plane from the
per-workload PVCs a `WorkflowRecipe` declares and from a
[SharedFileSystem](sharedfilesystem.md)'s per-team read tree — GFS does not
replace either.

Nothing mounts the drive's PVC directly. The reconciler provisions a PVC plus
a single-replica **writer** `gfs-controller` (**gfsc**) Deployment and N
read-only **reader** replicas; every client — humans through the Control UI,
agents through built-in tools — reaches the drive exclusively through gfsc's
HTTP API. gfsc checks every operation against the **permission store** (a
Postgres-backed grant/share table, not the registry) before allowing it, and
records it to a hash-chained audit log.

### Concepts

- **`gfs://` references.** Every file and folder gets a permanent
  `gfs://<drive>/<resourceId>` URI (`gfs-controller/src/api/read.ts`), stable
  across renames/moves — usable for deep links and for sharing one resource
  with someone who has no access to its parent folder.
- **Grant vs. share.** A **grant** authorizes a *folder* (and everything
  under it); a **share** authorizes a single resource by its reference, for
  someone without folder access. Both are rows in the permission store, not
  filesystem ACLs (`gfs-controller/src/authz/`).
- **`manage_acl`.** Holding this permission on a folder makes you able to
  grant/revoke access to it — a permission, not a fixed "owner" role.
- **Fail-closed tokens.** A caller's token is a ceiling, not a grant by
  itself — gfsc re-checks the permission store on every operation
  (`gfs-controller/src/authz/tokenCeiling.ts`).

## Spec fields

| Field                            | Type     | Required | Default           | Description                                                                                                                                                                                      |
| --------------------------------- | -------- | -------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.storage.size`               | string   | yes      | --                 | PVC requested storage for the drive's flat blob layout (e.g. `"500Gi"`).                                                                                                                          |
| `spec.storage.storageClassName`   | string   | no       | `standard-rwo`     | StorageClass for the drive PVC. RWX (`clerum-gcsfuse`) is a deferred escalation — set explicitly only when such a class exists.                                                                  |
| `spec.storage.accessModes`        | string[] | no       | `[ReadWriteOnce]`  | The single-replica writer and co-located readers work on RWO-only StorageClasses; `ReadWriteMany` requires an RWX-capable class.                                                                 |
| `spec.layout.rootDirectories`     | string[] | no       | `[]`               | Absolute seed paths (e.g. `/org`), max 64. Materialized as governed resources in the permission store by control-api once the writer reports `Ready` — not written directly by the reconciler. |
| `spec.security.runAsUser`         | integer  | no       | --                 | POSIX UID applied to the gfsc pods and the init Job.                                                                                                                                              |
| `spec.security.fsGroup`           | integer  | no       | --                 | Supplemental group applied so gfsc can read/write the mounted drive.                                                                                                                              |
| `spec.readerReplicas`             | integer  | no       | `2`                | Number of read-only gfsc reader replicas. The writer is always exactly 1 — GFS is a single-writer drive; only readers scale.                                                                     |
| `spec.retainOnDelete`             | boolean  | no       | `true`             | When `false`, deleting the CRD tears down the Deployments, Service, NetworkPolicies, and PVC (PVC last).                                                                                          |

Full OpenAPI schema: `charts/clerum-crds/crds/globalfilesystem.yaml`. The
reconciler owns pod-level detail the CRD doesn't expose — securityContext
defaults beyond the fields above, image pull policy, and replica wiring for
anything other than `readerReplicas`.

## Status

| Field                 | Type     | Description                                                                                                                    |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `status.phase`         | string   | `Provisioning \| Initializing \| Ready \| Degraded \| Failed`.                                                                    |
| `status.pvcName`       | string   | The provisioned PVC name.                                                                                                         |
| `status.serviceName`   | string   | ClusterIP Service serving gfsc **reads** through the writer + readers.                                                            |
| `status.serviceUrl`    | string   | In-cluster base URL of the read Service (e.g. `http://gfsc.gfs.svc.cluster.local:8087`). Mutations go through a separate writer-only Service, not this URL. |
| `status.conditions[]`  | object[] | Standard `{type, status, reason, message, lastTransitionTime}` condition list.                                                    |

## Additional Printer Columns

`kubectl get globalfilesystems` displays: Phase, PVC, Service URL.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: GlobalFileSystem
metadata:
  name: gfs
  namespace: gfs
spec:
  storage:
    size: 1Gi
    storageClassName: standard # minikube; GKE overlays use standard-rwo
    accessModes:
      - ReadWriteOnce
  layout:
    rootDirectories:
      - /org
      - /system/published-workflow-artifacts
  security:
    runAsUser: 1000
    fsGroup: 1000
  readerReplicas: 1 # minikube is resource-constrained; writer is always 1
  retainOnDelete: true
```

Working sample:
[deploy/overlays/minikube/instances/globalfilesystem.yaml](../../deploy/overlays/minikube/instances/globalfilesystem.yaml).

## Security notes

- Treat GFS as a high-sensitivity data plane.
- Tokens are a ceiling; the permission store is re-checked fail-closed on
  every operation, not just at token-mint time.
- See root [Security model](../../README.md#security-model).

## Related

- [SharedFileSystem CRD](sharedfilesystem.md) — the other, per-team read-only
  storage plane; not replaced by GFS
- [CRD index](README.md)
- [Shared & global files how-to](../how-to/shared-and-global-files.md) — SFS vs GFS, and when to use each
- [gfs-controller](../../gfs-controller/) (service tree)
