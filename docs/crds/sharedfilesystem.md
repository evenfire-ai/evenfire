# SharedFileSystem CRD Reference

**API Group:** `clerum.io`  
**Version:** `v1alpha1`  
**Scope:** Namespaced (must be `mcp-host`)  
**Short name:** `sfs`  
**Reconciled by:** host-context-controller (HCC) `sharedFileSystemReconciler`

## Purpose

A **per-team shared workspace**: a PVC plus a file API, mounted **read-only**
into `mcp-host` pods whose Context references it. Humans and admins write
through the per-SFS workspace-files-controller (wfc). Agents do not mutate the
mount.

For each SharedFileSystem, HCC creates in the `mcp-host` namespace:

- a PVC named `sfs-<hash>-files`;
- a single-replica wfc Deployment `wfc-<hash>`, with a root init container
  that creates `spec.directories` and applies the `spec.security` ownership;
- a ClusterIP Service `wfc-<hash>` and ingress/egress NetworkPolicies.

`<hash>` is the first 10 hex characters of the SHA-256 of
`<namespace>/<name>`.

The wfc does not read the CRD. HCC passes it the SFS name, namespace, and mount
path through `WSF_*` environment variables.

## Spec fields

| Field                       | Type              | Default             | Description                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.size`                 | string            | `20Gi`              | PVC storage request.                                                                                                                                                                                                                                                                |
| `spec.storageClassName`     | string            | cluster default     | StorageClass for the PVC. Omit to use the cluster default.                                                                                                                                                                                                                          |
| `spec.accessModes`          | string[]          | `[ReadWriteOnce]`   | PVC access modes. Enum: `ReadWriteOnce`, `ReadOnlyMany`, `ReadWriteMany`, `ReadWriteOncePod`. RWO works because the wfc is single-replica and consuming `mcp-host` pods co-locate with it through pod affinity. `ReadWriteMany` needs an RWX-capable StorageClass; set it explicitly only when one exists. |
| `spec.annotations`          | map[string]string | none                | Annotations copied onto the PVC.                                                                                                                                                                                                                                                    |
| `spec.directories`          | string[]          | `[]`                | Relative paths the wfc init container pre-creates. Max 64 entries, each max 255 characters. Each path segment must start with a letter, digit, or underscore, and may contain letters, digits, underscores, dots, and hyphens.                                                     |
| `spec.security.runAsUser`   | integer           | `1000`              | Min 1. UID for the wfc pod and the ownership the init container applies.                                                                                                                                                                                                            |
| `spec.security.runAsGroup`  | integer           | `1000`              | Min 1. GID for the wfc pod and the init container ownership.                                                                                                                                                                                                                        |
| `spec.security.fsGroup`     | integer           | value of `runAsGroup` | Min 1. Pod `fsGroup`, so the wfc can write the mounted files. Root (0) is rejected for all three security fields.                                                                                                                                                                   |
| `spec.retainOnDelete`       | boolean           | `true`              | On delete, keep the PVC when `true`. When `false`, HCC deletes the Deployment, Service, and NetworkPolicies, then the PVC last.                                                                                                                                                      |

`size`, `accessModes`, `directories`, and `retainOnDelete` defaults come from
the CRD schema. The `security` defaults are applied by HCC.

**PVC changes after creation.** HCC creates the PVC once and then leaves it
alone. Changing `size`, `storageClassName`, or `accessModes` on an existing
SharedFileSystem does not resize or re-mode the PVC. A change to `directories`
or `security` does re-run the init container's layout and ownership step.

## Status

| Field                        | Type     | Description                                                                                                                                                                                                                |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.phase`               | string   | `Provisioning` \| `Initializing` \| `Ready` \| `Degraded` \| `Failed`. `Ready` means the PVC is bound and the wfc is serving. `Initializing` covers a binding PVC or a wfc that is still starting. `Degraded` means the wfc pod is stuck (for example unschedulable). `Failed` means the reconcile itself errored. |
| `status.pvcName`             | string   | Provisioned PVC name (`sfs-<hash>-files`).                                                                                                                                                                                 |
| `status.capacity`            | string   | Capacity reported by the bound PVC.                                                                                                                                                                                        |
| `status.storageClassName`    | string   | Copied from `spec.storageClassName`; empty when the cluster default is used.                                                                                                                                                                                                     |
| `status.serviceName`         | string   | ClusterIP Service for the per-SFS wfc (`wfc-<hash>`).                                                                                                                                                                      |
| `status.mountedByContexts[]` | object[] | `{namespace, name}` of each Context that references this SFS.                                                                                                                                                              |
| `status.conditions[]`        | object[] | HCC writes one `Reconciled` condition. Reasons include `Ready`, `PVCBinding`, `WfcStarting`, and `ReconcileError`.                                                                                                         |
| `status.lastInitJob`         | object   | `{name, completedAt, error}`. Legacy: seeding moved from a Job into the wfc init container, and HCC no longer writes this field.                                                                                           |

## Additional Printer Columns

`kubectl get sfs -n mcp-host` displays: Phase, PVC, Capacity, Storage Class.

## Attaching to a Context

A Context lists SharedFileSystems in `spec.sharedFileSystems[]` with a `name`
and an absolute `mountPath`. HCC then mounts the PVC read-only into every
`mcp-host` pod whose Host references that Context. The mount follows the PVC,
not the wfc: it is added once the PVC is bound and stays in place across wfc
restarts. See [Context](context.md).

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata:
  name: team-mission
  namespace: mcp-host
spec:
  size: 5Gi
  accessModes:
    - ReadWriteOnce
  directories:
    - docs
    - customer-history
    - runbooks
  security:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  retainOnDelete: true
```

Working sample (SFS plus a Context that mounts it):
[charts/clerum-crds/examples/sharedfilesystem-team-mission.yaml](../../charts/clerum-crds/examples/sharedfilesystem-team-mission.yaml).

Control UI and control-api (`POST /admin/shared-filesystems`) create the same
object. That route accepts `size`, `storageClassName`, `accessModes`,
`directories`, `retainOnDelete`, and `security`.

## Related

- [CRD index](README.md)
- [Context CRD](context.md) — `spec.sharedFileSystems[]`
- [Shared & global files how-to](../how-to/shared-and-global-files.md) — create an SFS, attach it to a Context, upload
- [GlobalFileSystem CRD](globalfilesystem.md) — the separate governed drive
- [workspace-files-controller](../../workspace-files-controller/) (service tree)
