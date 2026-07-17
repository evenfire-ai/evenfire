# SharedFileSystem CRD Reference

**API Group:** `clerum.io`  
**Version:** `v1alpha1`  
**Scope:** Namespaced (typically `mcp-host`)  
**Short name:** `sfs`  
**Reconciled by:** host-context-controller (+ per-SFS `workspace-files-controller`)

## Purpose

A **per-team shared workspace**: PVC + file API, mounted **read-only** into
`mcp-host` pods for Contexts that reference it. Humans/admins write via the
workspace-files controller; agents do not mutate the mount.

## Spec fields (summary)

| Field                   | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `spec.size`             | PVC request (default e.g. `20Gi`)                                |
| `spec.storageClassName` | StorageClass for the PVC                                         |
| Additional fields       | See CRD OpenAPI: `charts/clerum-crds/crds/sharedfilesystem.yaml` |

Contexts attach SFS entries via their own spec (mount path + reference) — see
[Context](context.md) and feature docs when present on your version.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata:
  name: team-mission
  namespace: mcp-host
spec:
  size: 20Gi
```

Working sample:  
[charts/clerum-crds/examples/sharedfilesystem-team-mission.yaml](../../charts/clerum-crds/examples/sharedfilesystem-team-mission.yaml).

## Related

- [CRD index](README.md)
- [Shared & global files how-to](../how-to/shared-and-global-files.md) — create an SFS, attach it to a Context, upload
- [workspace-files-controller](../../workspace-files-controller/) (service tree)
