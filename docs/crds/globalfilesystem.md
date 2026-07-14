# GlobalFileSystem CRD Reference

**API Group:** `clerum.io`  
**Version:** `v1alpha1`  
**Scope:** Namespaced  
**Short name:** `gfs`  
**Reconciled by:** host-context-controller `gfsReconciler`

## Purpose

A **brokered global drive** (singleton per cluster intent): PVC plus writer/reader
deployments and a permission store. Clients do not mount the volume directly;
they call the GFS HTTP API. Access is authorized and audited (including a
hash-chained audit log in the controller design).

## Spec fields (summary)

| Area                      | Description                                         |
| ------------------------- | --------------------------------------------------- |
| Layout / root directories | Declared intent for governed layout materialization |
| Storage                   | PVC size / class (see CRD schema)                   |
| Full schema               | `charts/clerum-crds/crds/globalfilesystem.yaml`     |

The reconciler owns securityContext, pull policy, and replica wiring — the CRD
declares intent, not full pod specs.

## Security notes

- Treat GFS as a high-sensitivity data plane.
- Tokens are a ceiling; permission store is re-checked fail-closed on operations.
- See root [Security model](../../README.md#security-model).

## Related

- [CRD index](README.md)
- [gfs-controller](../../gfs-controller/) (service tree)
