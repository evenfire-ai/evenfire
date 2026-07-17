# How to: shared and global files

evenfire has two ways to give agents files, with different trust models:

- **SharedFileSystem (SFS)** — a per-team workspace. Humans and admins write to
  it; agents in a Context that mounts it get it **read-only**.
- **GlobalFileSystem (GFS)** — a brokered, audited drive. Nothing mounts the
  volume except the broker; every read and write goes through an API that
  authorizes per operation and audits the decision.

## SharedFileSystem — a read-only team workspace

### 1. Create the workspace

Apply a `SharedFileSystem` (or use **Control UI → Shared Files → New**):

```yaml
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata:
  name: team-mission
  namespace: mcp-host
spec:
  size: 20Gi
```

`host-context-controller` provisions the PVC and a per-SFS
`workspace-files-controller` that serves the write API. The default PVC is
`ReadWriteOnce` (single-node); for multi-node, set a `ReadWriteMany`
StorageClass via `spec.accessModes`.

### 2. Attach it to a Context

A Context mounts SFSes read-only, by name and path
(`spec.sharedFileSystems`):

```yaml
spec:
  sharedFileSystems:
    - name: team-mission
      mountPath: /shared/mission
```

`mountPath` values must be unique within a Context, and each SFS must already
exist in the `mcp-host` namespace. Every agent (`Host`) using this Context now
sees the workspace read-only at that path.

### 3. Put files in it

Humans and admins write through the workspace API: in Control UI, open the
Shared Filesystem and upload — the request is proxied through control-api to the
per-SFS controller. Agents **cannot** write: their mount is read-only, so an
agent reads the files with its file tools but never mutates them.

## GlobalFileSystem — a brokered, audited drive

A `GlobalFileSystem` is a drive that **no agent, UI, or service mounts** — only
its broker (`gfs-controller`) touches the volume. Everyone else goes through an
HTTP API, and that indirection is the point:

- **Authorized per operation.** Every request is checked against a Postgres
  permission store, deny-by-default, on every call; the bearer token is an
  upper bound on authority, never a grant. An absent resource and an
  unauthorized one are indistinguishable (both `403`).
- **Audited.** Every decision — allow, deny, or error — is written to an
  append-only audit log before the operation is served; no operation runs
  un-audited.
- **Addressed by URI.** Files are named `gfs://<drive>/<resource>` and resolved
  through the API; an agent that holds a grant reads (and, where granted,
  writes) through the broker.

Create one with a `GlobalFileSystem` CRD and manage access from Control UI's
Global Files area. For the full API, the writer/reader roles, and the
authorization chain, see [`gfs-controller`](../../gfs-controller/README.md) and
the [GlobalFileSystem CRD](../crds/globalfilesystem.md).

## Which one?

- Reach for **SharedFileSystem** when a team needs a simple bundle of reference
  files, mounted read-only into the agent.
- Reach for **GlobalFileSystem** when access must be brokered and audited per
  operation, with no volume mounted into the agent at all.

## Related

- [SharedFileSystem CRD](../crds/sharedfilesystem.md) · [GlobalFileSystem CRD](../crds/globalfilesystem.md)
- [Context CRD](../crds/context.md) — how an agent's Context mounts an SFS
- [workspace-files-controller](../../workspace-files-controller/README.md) · [gfs-controller](../../gfs-controller/README.md)
