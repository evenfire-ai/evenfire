# SharedFileSystem — shared human-managed files for Contexts

This spec defines a v1 feature that adds a **`SharedFileSystem` CRD** referenced by one or more `Context` CRDs. Each SharedFileSystem is:

- **Readable by all `mcp-host` pods** running under any Context that references it (co-located on the wfc's node; see access modes below).
- **Read-only inside `mcp-host`** (agents cannot mutate files via the mount).
- **Writable by Control-UI admins** through a dedicated per-SharedFileSystem `workspace-files-controller` service. End-user writes through the Desktop App are deferred until intra-team RBAC lands (v2).

A Context can reference **multiple** SharedFileSystems at different mount paths. The same SharedFileSystem can be referenced by **many** Contexts.

> **Status:** proposal / implementation-ready spec (v1).

---

## Goals

- Provide a shared, persistent set of files (notes + many docs) to improve agent context.
- Allow the same workspace to be reused across multiple Contexts (e.g., team mission docs accessible to both customer-support and engineering agents) without duplicating data.
- Support multiple `mcp-host` replicas across different nodes (RWX storage) — **deferred**: the shipped default is `ReadWriteOnce` and consumer `mcp-host` pods are co-located with the wfc pod via a required podAffinity (#592).
- Keep the control plane stable by isolating heavy filesystem IO behind a dedicated service.
- Keep agents read-only at the filesystem level (kernel-enforced — defense in depth against bugs or prompt injection that might cause an agent to write).
- Keep the admin experience declarative: operators configure via CRD; Control UI edits CRDs and uploads files.

## Non-goals (v1)

- File version history / rollback.
- Device-bound or machine-bound browsing tokens.
- Agent writes to context files (even with approval).
- Cross-cluster replication.
- Expose workspace to workflow recipes (run in another namespace so it's problematic).
- RBAC within a team (all users on a team have the same permissions for now).
- **Desktop App write client.** Writes go through Control UI only (admin-authenticated). End-user **writes** are deferred until intra-team RBAC lands. (End-user **reads** have since shipped: `external-rest-api` exposes a session-JWT-gated `external-rest-api → control-api → wfc` read passthrough that hard-rejects anything but `GET`/`HEAD` with `405`.)
- **Per-SharedFileSystem auth grants distinct from Context grants.** When end-user writes do land in v2, the auth rule will be transitive (a user can browse a SharedFileSystem if they have access to any Context that references it). Per-SharedFileSystem grants would not actually prevent leakage (an agent in any referencing Context can read & return the same files via chat) — they would only add admin burden.

---

## High-level architecture

For each `SharedFileSystem`, the Host Context Controller (HCC) reconciles a bundle of resources in the **`mcp-host` namespace**:

1. **PVC** (one per SharedFileSystem)
2. **Root init container** (in the wfc pod) to pre-create the directory layout and apply permissions
3. **`workspace-files-controller` Deployment + Service** (one pod per SharedFileSystem) that mounts the PVC **read-write**
4. **NetworkPolicy** (per wfc) restricting ingress to `app=control-api` only
5. **mcp-host pods** mount each referenced SharedFileSystem PVC **read-only** at the path declared in `Context.spec.sharedFileSystems[].mountPath`

```
┌────────────────────────────────────────────────────────────────────┐
│  mcp-host namespace                                                │
│                                                                    │
│   ┌──────────────────────┐      ┌──────────────────────────────┐   │
│   │ SharedFileSystem A   │      │ wfc-A (per-SFS Deployment)   │   │
│   │   PVC (RWO)          │◄─RW─►│   mounts only SFS A's PVC    │   │
│   └──────────────────────┘      │   Service :8086              │   │
│           ▲                     │   NetPol: from control-api   │   │
│           │ RO                  └──────────────────────────────┘   │
│           │                                                        │
│   ┌──────────────────────┐      ┌──────────────────────────────┐   │
│   │ SharedFileSystem B   │      │ wfc-B (per-SFS Deployment)   │   │
│   │   PVC (RWO)          │◄─RW─►│   mounts only SFS B's PVC    │   │
│   └──────────────────────┘      └──────────────────────────────┘   │
│           ▲                                                        │
│           │ RO                                                     │
│   ┌───────┴──────────────┐                                         │
│   │ mcp-host pod (Host X)│   Host X → Context X → [SFS A, SFS B]   │
│   │   /workspace/sfs-a/  │                                         │
│   │   /workspace/sfs-b/  │                                         │
│   └──────────────────────┘                                         │
└────────────────────────────────────────────────────────────────────┘
```

v1 write path (admin only, via Control UI):

```
Control UI (admin JWT) → control-api → workspace-files-controller (per SFS) → SharedFileSystem PVC
```

End-user read path (shipped; the same chain in write mode is still deferred):

```
Desktop App → external-rest-api → control-api → workspace-files-controller (per SFS) → SharedFileSystem PVC
```

Agent read path:

```
LLM → built-in clerum__context_files_* tools (mcp-host) → RO mounts → mountPaths
```

The mount itself is just bytes on disk — the LLM only sees what's surfaced to it as tools. mcp-host registers a small family of built-in `clerum__context_files_*` tools (next to the existing `clerum__generate_*` tools) that present every mounted SharedFileSystem under one virtual unified root. See **Agent read access** below.

---

## Architecture rationale

The original design intuition is "just attach a PVC to mcp-host, let it own the IO too." The current design (separate wfc service + per-SharedFileSystem PVC + per-SharedFileSystem wfc Deployment) exists for specific, named reasons that are not obvious from the diagram. They are listed here so future contributors don't optimise away something they shouldn't.

### Why a separate wfc service exists at all (instead of file IO inside mcp-host)

Six load-bearing reasons:

1. **PVC mount mechanics demand a writer pod.** PVCs are accessed via pod mounts; mounts are declared at pod-spec time. The "upload file" request from Control UI has to land somewhere with a RW mount of the PVC. _Some_ pod has to be the writer. The choice is whether that pod is mcp-host (combined writer + LLM) or a dedicated wfc.
2. **mcp-host stays RO** → the kernel returns `EROFS` on any write attempt → defense in depth against prompt injection or buggy code that might accidentally register a write tool. With a combined design, "agents are read-only" is enforced only by code convention. With a separate wfc, the kernel enforces it regardless of what mcp-host code does.
3. **Ingress NetworkPolicy lock.** wfc accepts traffic only from `app=control-api`. mcp-host already accepts traffic from rpc-proxy and other paths — putting upload endpoints in mcp-host would expand its attack surface.
4. **Resource isolation.** A 100 MiB upload doesn't share Node event loop / memory budget with active LLM streaming. The LLM's tail latency is independent of file IO load.
5. **Single-writer consistency model.** All writes to a SharedFileSystem serialise through one pod → no write contention, no need for file locks or optimistic concurrency for "Google Drive–style whole-file replace" semantics. (If wfc ever scales to >1 replica per SFS, this becomes nontrivial — v1 stays at 1 replica.)
6. **Threat-model separation.** wfc's job is bounded: validate JWT, do FS IO. mcp-host's job is unbounded LLM orchestration. Different blast radius if either gets exploited.

### Why one wfc per SharedFileSystem (instead of one shared wfc cluster-wide)

Six additional reasons that justify the per-SFS Deployment topology:

7. **K8s pod-spec immutability for PVCs.** A pod can only mount PVCs declared at pod-spec time. To add a new SharedFileSystem to a shared wfc, you must update its pod spec and roll the pod. Every add/remove restarts the shared wfc → brief write downtime for _every_ SharedFileSystem on the cluster. Per-SharedFileSystem wfc avoids this entirely.
8. **Per-SharedFileSystem NetworkPolicy precision.** With per-wfc, each ingress policy is exactly "control-api → this one wfc serving this one SharedFileSystem." With one shared wfc, the network-level policy is "control-api → all SharedFileSystems"; per-SharedFileSystem enforcement happens in code only.
9. **Per-workspace resource limits / quotas.** A high-traffic shared workspace gets its own cgroup; a quiet one doesn't pay for it. Independent CPU/memory budgets.
10. **Per-workspace blast radius.** A bug in file IO that crashes one wfc affects only that SharedFileSystem. Other workspaces keep accepting writes.
11. **Lifecycle cleanup is clean.** `retainOnDelete: false` on a SharedFileSystem → HCC just deletes the wfc Deployment + Service + NetPol + PVC for that SharedFileSystem. No need to mutate a shared Deployment's volume list to drop one mount.
12. **v2 scaling path.** Eventually you might want to HPA-scale a hot SharedFileSystem's wfc independently (e.g., `team-mission` is read-heavy at 9am stand-up). Per-wfc gives you that knob; shared wfc doesn't.

### Why a separate `SharedFileSystem` CRD (instead of inline `Context.spec.filesystem`)

- **Reuse across Contexts.** Most teams want one canonical workspace (mission, runbooks, customer history) shared across many agents/Contexts. Inline-on-Context forces a copy per Context.
- **K8s-native pattern.** This matches `Pod ↔ PVC`: the workload references storage by name; storage has independent lifecycle.
- **Lifecycle independence.** Deleting a Context doesn't delete the workspace. `retainOnDelete` becomes a property of the SharedFileSystem itself (not buried inside whichever Context happened to define it inline).
- **Future "bring your own".** A SharedFileSystem CRD opens the door to future modes: pre-existing PVC, externally-provisioned NFS export, GCS bucket pointer. Inline `spec.filesystem` boxes you into "controller manages it from scratch."

### Why Control-UI-only writes in v1 (no Desktop App write client)

- **Avoid building per-end-user authz before intra-team RBAC exists.** Without RBAC, every team member would have full read+write+delete access to every SharedFileSystem any of their Contexts touches. That's a foot-gun — easier to leave end-user writes off entirely than to ship a hard-to-revoke capability.
- **Control UI is already admin-authenticated.** The token-mint + proxy plumbing on `control-api` is small and can be exercised by the Control UI immediately. The browsing JWT shape we choose now will work unchanged when the Desktop App path is wired up in v2 — only the mint-time AuthZ rule changes.
- **Smaller v1 surface.** No `external-rest-api` route, no per-end-user UI, no team-switch flow. About 30% less code to ship.

---

## Cost analysis

Numbers below are us-central1 GKE pricing (April 2026). The only cost delta between this design and a "mcp-host as writer" alternative is the wfc pod itself; PVC storage, init containers, NetworkPolicies, and internal traffic are identical.

### Per-wfc-pod baseline

Realistic for an idle Express + pino + multipart server:

- Requests: `50m CPU` / `64 MiB memory`
- Limits: `200m CPU` / `128 MiB memory`

| GKE pricing model                | Cost per wfc pod / month |
| -------------------------------- | ------------------------ |
| GKE Standard, on-demand e2 nodes | ~$1.20                   |
| GKE Standard, spot e2 nodes      | ~$0.40                   |
| GKE Autopilot, on-demand         | ~$1.85                   |
| GKE Autopilot, spot              | ~$1.20                   |

### At scale (per-SharedFileSystem wfc, on-demand GKE Standard)

| Active SharedFileSystems | Marginal wfc cost / month | Notes                              |
| ------------------------ | ------------------------- | ---------------------------------- |
| 1                        | ~$1.20                    | Fits in node slack                 |
| 10                       | ~$12                      | Fits in node slack                 |
| 50                       | ~$60                      | Approaches one extra e2-standard-4 |
| 100                      | ~$120                     | ~1.25 extra e2-standard-4 nodes    |
| 500                      | ~$600                     | ~6 extra nodes                     |
| 1000                     | ~$1200                    | ~13 extra nodes                    |

On the current dev cluster (e2-standard-4 nodes), each wfc pod consumes ~1.25% of one node's CPU. There is headroom for ~80 wfc pods before forcing a node scale-up — so up to ~80 SharedFileSystems, marginal cost is **literally $0** (the pods slot into existing slack).

### Storage

GCS FUSE CSI on GCP overlays (vs Filestore Basic HDD's $200/mo minimum):

- ~$0.02/GiB/mo standard storage
- A typical "team docs" SharedFileSystem at 5 GiB → **~$0.10/mo per SharedFileSystem**
- Plus per-operation costs (Class A ops ~$5/M, Class B ~$0.40/M) — negligible at notes-and-docs scale

### Other line items (negligible)

- Artifact Registry image storage for the wfc image: ~$0.015/mo
- Network egress: $0 (all traffic in-cluster, in-region)
- Image pull bandwidth on first pull per node: $0 (in-region)
- LoadBalancer / public IP: $0 (ClusterIP only)

### Comparison to other costs

- One LLM conversation with Claude Opus on a 50k-token context: ~$0.75. One conversation pays for ~3 wfc pods for a month.
- The original spec's Filestore Basic HDD storage was a $200/mo minimum _per Context_ (because of the 1 TiB floor). Switching to GCS FUSE saves ~$200/mo per SharedFileSystem.
- Cluster baseline (4 nodes, idle): ~$390/mo. A 100-SharedFileSystem wfc fleet adds 30% to compute cost.

### Summary

Below ~80 SharedFileSystems on the current dev cluster, the per-SharedFileSystem wfc design costs **zero real dollars** beyond what's already paid for cluster baseline. Above that, ~$1.20/SharedFileSystem/mo on-demand or ~$0.40 on spot. The financial argument for collapsing to a shared wfc only kicks in past ~500 SharedFileSystems.

---

## Kubernetes constraints & invariants

- **PVCs are namespaced.** Pods can only mount PVCs in the same namespace. SharedFileSystem PVCs always live in **`mcp-host`** so wfc + every mcp-host pod can mount them; the SharedFileSystem CRD itself also lives in `mcp-host`.
- **Default access mode is `ReadWriteOnce`** (#592). The wfc Deployment is single-replica (v1) and seeds the PVC via a root **initContainer in the same pod**, and consumer `mcp-host` pods are co-located onto the wfc's node via a required podAffinity — so RWO volumes never need a cross-node Multi-Attach and work on the RWO-only StorageClasses in use (including minikube). **Multi-node readers require RWX semantics and are deferred**: they need an RWX-capable StorageClass (NFS/Filestore/GCS FUSE/EFS/CephFS) and an explicit `spec.accessModes: [ReadWriteMany]`.
- `mcp-host` mounts are **read-only** (`volumeMount.readOnly: true`).
- Each `workspace-files-controller` mount is **read-write** (the only writer for its SharedFileSystem).
- Workflow recipe pods (`sandbox-recipes` namespace) cannot mount SharedFileSystem PVCs by design (cross-namespace mounts are not supported by Kubernetes, and exposing the workspace to recipes is an explicit v1 non-goal).

---

## CRD: `SharedFileSystem` (new)

`apiVersion: clerum.io/v1alpha1`, `kind: SharedFileSystem`, **namespaced**, lives in **`mcp-host`**. The CRD itself carries no namespace validation — an instance created elsewhere is accepted by the API server but is simply ignored, because control-api and HCC only ever operate on the configured `mcp-host` namespace.

### `spec`

- **storage**
  - `size: string` — e.g. `"20Gi"` (defaulted)
  - `storageClassName?: string` — empty means cluster default
  - `accessModes?: string[]` — default `["ReadWriteOnce"]`. Set `["ReadWriteMany"]` explicitly (with an RWX-capable StorageClass) to opt into multi-node mounts.
  - `annotations?: Record<string,string>` — optional PVC annotations

- **layout**
  - `directories: string[]` — relative paths pre-created by the wfc init container (e.g. `["uploads", "agent-output", "notes"]`). Directory paths are validated segment-by-segment and may contain alphanumerics, `_`, `.`, and `-`; absolute paths, `..`, spaces, and shell metacharacters are rejected.

- **posix identity**
  - `security?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }` — applied by the wfc init container; the wfc inherits the same fsGroup so it can write the mounted files.

- **lifecycle**
  - `retainOnDelete?: boolean` — default `true`. When `false`, deleting the SharedFileSystem deletes the PVC.

### `status` (written by HCC)

- `phase: "Provisioning" | "Initializing" | "Ready" | "Degraded" | "Failed"`
- `pvcName: string`
- `capacity?: string`
- `storageClassName?: string`
- `serviceName?: string` (the per-SFS wfc Service name)
- `mountedByContexts?: { namespace: string; name: string }[]` — back-reference for ops debuggability
- `conditions?: []` (standard condition list)

> Note: seeding runs as the wfc controller's root **initContainer** (same pod as
> the server), not a standalone Job. The legacy `status.lastInitJob` field is no
> longer written (the CRD keeps it as an optional field for backward compatibility).

### Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata:
  name: team-mission
  namespace: mcp-host
spec:
  size: 5Gi
  accessModes: [ReadWriteOnce]
  directories: [docs, customer-history, runbooks]
  security:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  retainOnDelete: true
```

---

## CRD: `Context` additions

A new optional `spec.sharedFileSystems` field references one or more SharedFileSystems. The previous inline `spec.filesystem` field is **not** part of v1.

### `spec.sharedFileSystems`

```yaml
spec:
  sharedFileSystems:
    - name: team-mission # SharedFileSystem.metadata.name (must exist in mcp-host)
      mountPath: /workspace/team-mission
    - name: customer-complaints
      mountPath: /workspace/customer-complaints
```

Validation (CRD OpenAPI + reconciler):

- Each entry: `{ name: string (required), mountPath: string (required) }`. SharedFileSystem namespace is implicitly `mcp-host` in v1; field reserved for forward compat if cross-namespace ever lands.
- Mount paths within a single Context must be unique (CRD OpenAPI validates uniqueness on `mountPath`).
- A SharedFileSystem name that doesn't resolve to an existing CRD instance puts the Context's filesystem status into `Degraded` with a clear condition; mcp-host pods don't get the missing mount but otherwise come up normally.

### `status.sharedFileSystems` (per-Context view, written by HCC)

For each referenced SharedFileSystem:

- `name: string`
- `mountPath: string`
- `phase: "Resolving" | "Mounted" | "MissingTarget" | "Failed"`
- `pvcName?: string`

This is a per-Context snapshot of how the references resolved; the source of truth for the SharedFileSystem itself is `SharedFileSystem.status`.

---

## Controller responsibilities (HCC)

### Per-SharedFileSystem reconciliation

For each `SharedFileSystem`:

1. Create/patch the per-SharedFileSystem PVC in `mcp-host` (name: `sfs-<sfsHash>-files`).
2. The wfc pod's root init container seeds the PVC (mounts it RW; creates `directories`; applies sentinel-guarded `chown`/`chmod` per `security`).
3. Create/patch the per-SharedFileSystem `workspace-files-controller` Deployment (`wfc-<sfsHash>`, one replica) and Service (ClusterIP `:8086`).
4. Create/patch the per-SharedFileSystem ingress NetworkPolicy (allow `:8086` from `control-plane / app=control-api`) and egress NetworkPolicy (DNS only).
5. Update `status.phase` (`Provisioning → Initializing → Ready`).
6. On SharedFileSystem deletion: respect `retainOnDelete`. When `false`, delete Deployment, Service, NetworkPolicies, then PVC last.

Generated resources intentionally do not use Kubernetes `ownerReferences`; HCC
cleans them up through `reconcileDelete()` and stable labels. If HCC misses a
delete event while down, clean up the generated resources with:

```bash
kubectl delete deploy,svc,job,netpol \
  -l clerum.io/managed-by=host-context-controller,clerum.io/sharedfilesystem=<name> \
  -n mcp-host
```

### Per-Context reconciliation

For each `Context` with a non-empty `spec.sharedFileSystems`:

1. Resolve each ref → SharedFileSystem CRD instance. Mark missing refs in `status.sharedFileSystems[].phase = MissingTarget`.
2. Patch the mcp-host Deployment (existing host reconciler) to add `volumes[]` + `volumeMounts[]` (RO) for each resolved SharedFileSystem PVC at the requested `mountPath`.
3. Inject the env var `CLERUM_CONTEXT_FILES_MOUNTS` (JSON) into the mcp-host container so the built-in tools can register against the correct mounts. See **Agent read access** below.
4. Update `status.sharedFileSystems[].phase = Mounted` once the rollout completes.

### Reconciliation properties

- **Idempotent** per object (SharedFileSystem or Context).
- Debounced 5s; retries on failure with exponential backoff up to 1 min.
- Adding/removing a SharedFileSystem does NOT affect other SharedFileSystems' wfc pods (each wfc is isolated).
- Adding/removing a SharedFileSystem from `Context.spec.sharedFileSystems` rolls only the per-Host mcp-host Deployment.

---

## `workspace-files-controller` service responsibilities

Each per-SharedFileSystem wfc serves IO for exactly one SharedFileSystem. The wfc knows its identity from env (`WSF_SHARED_FILESYSTEM_NAME`). JWT validation must check the token's `sharedFileSystem` claim matches the wfc's identity (otherwise `403 forbidden`).

- **Token verification**: validate browsing JWT (see Auth section). Reject tokens whose `sharedFileSystem` claim doesn't match this wfc.
- **Path safety**:
  - reject `..` traversal and absolute paths outside the mount root
  - deny unsafe symlinks
- **Streaming IO**: list, stat, download, upload, replace, delete, rename/move, mkdir.
  - "Edit" in v1 is whole-file replace (Google Drive–style): the client uploads a new version that overwrites the existing file. No partial/range writes, no in-place patching.
- **Observability**: latency, bytes, failures, audit fields including `sharedFileSystem`, `subject` (admin user id from JWT), `op`, `path`.

Network posture:

- Cluster-internal Service (`wfc-<sfsHash>.mcp-host.svc:8086`).
- Restrict ingress to only `app=control-api` via NetworkPolicy (defense in depth).

---

## Agent read access (mcp-host built-in tools)

The RO mounts on `mcp-host` are dead bytes unless the LLM has a way to discover and read them. v1 surfaces all SharedFileSystems through a small family of built-in tools registered in `StepMcpRouter` next to the existing `clerum__generate_*` tools — no MCP server, no network hop, just direct filesystem reads from the mounts.

### Tools

All tools are read-only. They present every mounted SharedFileSystem under one **virtual unified root** with the SharedFileSystem `name` as the top-level directory. The mcp-host reader rejects `..`, NUL/control characters, backslashes, symlinks, non-regular files, and paths that resolve outside the SharedFileSystem mount root.

| Tool                         | Purpose                                                                                     | Key params                              |
| ---------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| `clerum__context_files_list` | List entries. At root (`/` or empty) returns the list of available SharedFileSystems.       | `path?` (default ".")                   |
| `clerum__context_files_read` | Return file contents as UTF-8 text. Files larger than the configured read cap are rejected. | `path` (e.g. `team-mission/mission.md`) |

### Discovery and surfacing

- The tools are registered when mcp-host starts with `CLERUM_CONTEXT_FILES_MOUNTS` set to a JSON array describing the mounted SharedFileSystems and their on-disk paths (the host reconciler writes this env var alongside the volumeMounts when `Context.spec.sharedFileSystems` is non-empty):

  ```json
  [
    {
      "name": "team-mission",
      "namespace": "mcp-host",
      "mountPath": "/workspace/team-mission",
      "pvcName": "sfs-team-mission-files"
    },
    {
      "name": "customer-complaints",
      "namespace": "mcp-host",
      "mountPath": "/workspace/customer-complaints",
      "pvcName": "sfs-customer-complaints-files"
    }
  ]
  ```

- mcp-host appends a one-line system-prompt postfix when these tools are registered: _"You have shared filesystems available: `<comma-separated names>`. Use `clerum__context_files_list` to discover files (start at `/` to see workspaces) and `clerum__context_files_read` to read them."_
- With the shipped RWO default, writers and readers share one node and one mount, so writes are visible to readers immediately. If RWX is ever opted into, visibility is bounded by that StorageClass's cache coherency (Filestore: typically a few seconds; GCS FUSE: tunable via mount opts) — a delay that is good-enough for the "notes + docs" workload.

### Limits

- `CLERUM_CONTEXT_FILES_MAX_READ_BYTES` — default `10 MiB` per `read` call. Larger files are rejected before reading.
- `CLERUM_CONTEXT_FILES_MAX_LIST_ENTRIES` — default `1000` per directory listing.

### Files

- `mcp-host/src/workflow/contextFiles.ts` — implementation
- Registered in `mcp-host/src/workflow/internalTools.ts` and dispatched from `stepRouter.ts` exactly like `clerum__generate_*`

### Non-goals (v1)

- Write tools (`clerum__context_files_write`, `_delete`, etc.). The mounts are RO; humans write through the Control UI.
- Auto-loading the entire file index into the system prompt. May land in v2 if LLMs underuse `list`.

---

## Auth & authorization (v1)

### v1: Control-UI-only writes

In v1 the only client of the workspace-files-controller is the **Control UI**, authenticated via the existing admin session.

- Control UI logs in with the existing admin auth flow (`/api/v1/admin/auth/login`). The session token grants admin role.
- When the operator opens the workspace browser for SharedFileSystem `S`, the Control UI calls `POST /api/v1/admin/shared-filesystems/:name/token` on `control-api`. control-api verifies the caller has admin role, then mints a browsing JWT scoped to `S`.
- Control UI then calls the proxy endpoints under `/api/v1/admin/shared-filesystems/:name/proxy/*`, which forward to `wfc-<sfsHash>.mcp-host.svc:8086`.

### End-user access

The end-user **read** path has shipped: `external-rest-api` exposes `GET /api/v1/me/contexts/:contextId/shared-filesystems` and `GET /api/v1/me/contexts/:contextId/shared-filesystems/:sfsName/proxy/*` — session-JWT-gated, forwarding to `control-api`'s `/external/contexts/:id/shared-filesystems` router. The router rejects any method other than `GET`/`HEAD` with `405`, so end-user **writes** remain deferred until intra-team RBAC lands.

When end-user writes do land, `control-api`'s token-mint endpoint adds a non-admin AuthZ branch using a transitive rule: a user can mint a browsing JWT for SharedFileSystem `S` if **any** of these are true (OR logic) for **any Context `C` that has `S` in `spec.sharedFileSystems`**, evaluated under the currently selected team:
  1. Team has direct access to `C`, OR
  2. User has direct access to `C`, OR
  3. User has access to an agent/Host that has access to `C`, OR
  4. Team has access to an agent/Host that has access to `C`.

The browsing JWT shape below is forward-compatible — v2 just changes which subjects can be issued tokens, not what tokens look like.

> **Why transitive auth (in v2):** any user who can chat with an agent under `C` can ask the agent to list and read the entire mounted SharedFileSystem via the built-in tools. Per-SharedFileSystem grants on the browsing endpoint would not actually prevent leakage — they would only add admin burden. The data-classification decision is made at the moment an operator references a SharedFileSystem from a Context.
>
> **Operational guidance:** treat `Context.spec.sharedFileSystems` references as data-classification grants. Do NOT reference a SharedFileSystem from a Context whose audience shouldn't see those files.

### Browsing JWT — exact claim shape (used in both v1 and v2)

```json
{
  "iss": "control-api",
  "aud": "workspace-files-controller",
  "sub": "<userId>",
  "sharedFileSystem": "<name>",
  "sharedFileSystemNamespace": "mcp-host",
  "scopes": ["files:read", "files:write"],
  "iat": 1730000000,
  "exp": 1730000300
}
```

- **TTL:** 300 s (5 min). Caller renews on demand by calling the mint endpoint again — no refresh-token flow.
- **Scopes:** exactly two exist — `files:read` and `files:write`. Delete is gated by `files:write`; there is no separate delete scope.
- **Signing:** RS256, using the RPC keypair (`CONTROL_API_RPC_JWT_PRIVATE_KEY` on `control-api`, `WSF_JWT_PUBLIC_KEY` on `workspace-files-controller`). This is a different keypair from the session JWT (`CONTROL_API_SESSION_JWT_PRIVATE_KEY`); audience separation keeps RPC tokens out of the wfc and vice versa.
- **wfc verification:** check `iss`, `aud`, signature, expiry, and that the token's `sharedFileSystem` / `sharedFileSystemNamespace` claims match this wfc's `WSF_SHARED_FILESYSTEM_NAME` / `WSF_SHARED_FILESYSTEM_NAMESPACE`. Reject session JWTs (different `aud`).
- **Forward-compat:** the mint endpoint issues the full scope set by default; a caller may pass an optional narrower `scopes` array (anything outside the two known scopes → `400 invalid_wfc_browsing_scopes`). Per-operation gating happens server-side once intra-team RBAC lands.
- **Audit:** `control-api` logs the admin user id at mint time; the JWT itself doesn't carry additional context.

---

## Implementation

### Repository layout

| Path                                                         | Purpose                                                                                                                                  | v1?               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `workspace-files-controller/`                                | New TS/Node service. Mirrors the `mcp-host` package layout (Express + pino + vitest). Single image; one Deployment per SharedFileSystem. | yes               |
| `host-context-controller/src/sharedFileSystemReconciler.ts`  | New HCC reconciler watching `SharedFileSystem` CRDs.                                                                                     | yes               |
| `host-context-controller/src/k8s/sharedFileSystemFactory.ts` | Pure builders for PVC, Deployment (+ seeding init container), Service, NetworkPolicies.                                                  | yes               |
| `control-api/src/routes/admin/sharedFilesystems.ts`          | Admin token-mint endpoint + thin proxy to per-SFS wfc.                                                                                   | yes               |
| `control-ui/app/shared-filesystems/`                         | Workspace picker, file tree, viewer, upload/replace/delete dialogs.                                                                      | yes               |
| `mcp-host/src/workflow/contextFiles.ts`                      | Built-in `clerum__context_files_*` tools (list/read) with virtual unified root over multiple RO mounts.                                  | yes               |
| `external-rest-api/src/routes/contextSharedFilesystems.ts`   | Session-JWT-gated read passthrough to `control-api` (GET/HEAD only; writes still deferred).                                              | shipped           |
| `desktop-app/ui/src/features/workspace/`                     | End-user UI (file tree, viewer, upload/replace/delete).                                                                                  | **v2 — deferred** |

### HTTP API: `workspace-files-controller`

Listens on `:8086`. All routes except `/healthz` and `/readyz` require a valid browsing JWT in `Authorization: Bearer <token>` whose `sharedFileSystem` claim matches the wfc's identity. The SharedFileSystem identity comes from the JWT, NOT from URL path.

| Method   | Path                            | Body / Query              | Purpose                                                                              |
| -------- | ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `GET`    | `/v1/files?path=<rel>`          | —                         | List directory entries (name, kind, size, mtime).                                    |
| `GET`    | `/v1/files/stat?path=<rel>`     | —                         | File metadata.                                                                       |
| `GET`    | `/v1/files/download?path=<rel>` | —                         | Stream file contents (`Content-Disposition: attachment`).                            |
| `POST`   | `/v1/files/upload`              | multipart `file` + `path` | Create new file. `409` if exists.                                                    |
| `PUT`    | `/v1/files/replace`             | multipart `file` + `path` | Whole-file replace (Google Drive–style). `404` if missing.                           |
| `POST`   | `/v1/files/mkdir`               | `{path}`                  | Create directory (and parents).                                                      |
| `POST`   | `/v1/files/move`                | `{from, to}`              | Rename or move within the workspace.                                                 |
| `DELETE` | `/v1/files?path=<rel>`          | —                         | Delete file or empty directory. Recursive delete is `?recursive=true` and is logged. |
| `GET`    | `/healthz`                      | —                         | Liveness.                                                                            |
| `GET`    | `/readyz`                       | —                         | Reports PVC mounted + writable.                                                      |

**Response envelope:** `{ok: true, data: ...}` on success, `{ok: false, error: {code, message}}` on failure. Error codes: `path_invalid`, `not_found`, `already_exists`, `not_a_directory`, `not_empty`, `payload_too_large`, `forbidden`, `unauthorized`.

**Limits (v1, configurable via env):**

- `WSF_MAX_UPLOAD_BYTES` — default `100 MiB` per file.
- `WSF_MAX_LIST_ENTRIES` — default `5000` per directory listing.
- `WSF_MAX_PATH_DEPTH` — default `32`.

### `control-api` endpoints (new, admin-only in v1)

All under `/api/v1/admin/shared-filesystems/:name/*`. Admin session-JWT auth handled by upstream middleware.

| Method | Path                                             | Purpose                                                                                                                                                             |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/admin/shared-filesystems`               | List SharedFileSystems (proxies the K8s CRD list).                                                                                                                  |
| `GET`  | `/api/v1/admin/shared-filesystems/:name`         | Get one SharedFileSystem (CRD + status).                                                                                                                            |
| `POST` | `/api/v1/admin/shared-filesystems/:name/token`   | Mint browsing JWT for this SharedFileSystem. Returns `{token, expiresInSeconds, serviceUrl, audience}`. v1: requires admin role. v2: also accepts non-admin via the transitive rule. |
| `*`    | `/api/v1/admin/shared-filesystems/:name/proxy/*` | Thin reverse proxy to `wfc-<sfsHash>.mcp-host.svc:8086`. Does **not** forward the caller's `Authorization`: it mints a fresh browsing JWT bound to this SharedFileSystem and sends that upstream, so the browser never sees a wfc token and the wfc never sees an admin token. Request body is forwarded unchanged. |

The proxy approach keeps the per-SFS wfc reachable only from `control-plane`, simplifying NetworkPolicy. Control UI always traverses `Control UI → control-api → workspace-files-controller`.

### HCC reconciler — `sharedFileSystemReconciler`

**For each `SharedFileSystem`:**

1. **PVC** in `mcp-host`. Name: `sfs-<sfsHash>-files`. Apply size, accessModes, storageClassName, annotations from spec. Single-replica wfc; RWO is safe because seeding co-locates in the controller's root initContainer (same pod ⇒ same node ⇒ same mount).
2. **Seeding init container** in the wfc Deployment pod (image `busybox:1.36`, root, minimal caps). Runs `mkdir -p` + a sentinel-guarded `chown -R`/`chmod` per `spec.security`; the kubelet runs it to completion before the serving container starts (same pod => same node => same RWO mount).
3. **Deployment** `wfc-<sfsHash>` (one replica) running `workspace-files-controller`. Mounts PVC RW. SecurityContext from `spec.security`. Env: `WSF_MOUNT_PATH`, `WSF_SHARED_FILESYSTEM_NAME`, `WSF_SHARED_FILESYSTEM_NAMESPACE`, `WSF_JWT_PUBLIC_KEY` (from `mcp-host-config`), `WSF_MAX_*` limits.
4. **Service** `wfc-<sfsHash>` ClusterIP `:8086`.
5. **NetworkPolicy** `wfc-<sfsHash>-ingress` (allow `:8086` from `control-plane / app=control-api`) + `wfc-<sfsHash>-egress` (DNS only).
6. **Status reconciliation**: write `status.{phase, pvcName, capacity, storageClassName, serviceName, conditions, mountedByContexts}`. Phase transitions: `Provisioning → Initializing → Ready` (or `Failed`/`Degraded`).

**For each `Context`:** the existing host reconciler resolves `spec.sharedFileSystems[*].name` to PVCs and patches the per-Host mcp-host Deployment with RO mounts at the requested `mountPath`. It also writes `CLERUM_CONTEXT_FILES_MOUNTS` JSON env so the built-in tools register correctly.

Reconciliation is **per-object idempotent**, debounced 5s, retries on failure with exponential backoff up to 1 min.

### NetworkPolicies

| Name                         | Namespace       | Effect                                                                                |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `wfc-<sfsHash>-ingress`      | `mcp-host`      | Allow `:8086` from `control-plane` / `app=control-api`. Deny everything else.         |
| `wfc-<sfsHash>-egress`       | `mcp-host`      | Allow DNS to `kube-system`. Nothing else.                                             |
| `control-api → wfc` (egress) | `control-plane` | Allow `:8086` to `mcp-host` namespace, pod selector `app=workspace-files-controller`. |
| `mcp-host RO mounts`         | `mcp-host`      | No new policy needed — mounts are purely volume-level.                                |

All three per-SFS policies are runtime-managed by HCC. The `control-api → wfc` egress policy lives in `deploy/base/control-plane/networkpolicies.yaml` (control-api egress is namespace-scoped, not per-SFS).

### Storage classes per environment

| Overlay                | Class               | Notes                                                                                                                                               |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minikube`             | `standard` (RWO)    | RWX is hard locally; v1 runs at `replicas: 1` with RWO — safe because the initContainer co-locates seeding in the controller pod (no Multi-Attach). |
| `gcp-prod` / `gcp-dev` | RWO block storage   | RWO is the shipped default (#592); no RWX StorageClass is enabled on any cluster today. A GCS FUSE CSI class (RWX semantics, ~$0.02/GiB/mo vs Filestore Basic HDD's ~$200/mo minimum) is the deferred escalation path. |

### Path safety (server-side, mandatory)

All paths arriving from clients are normalised and validated before any FS call:

1. Reject any path containing `..`, NUL, or backslash.
2. `path.posix.normalize` then `path.posix.resolve(mountRoot, rel)`; reject if the resolved path doesn't have `mountRoot` as prefix.
3. Reject symlinks: when listing/streaming, `lstat` first; if `isSymbolicLink()` return `path_invalid`.
4. Enforce `WSF_MAX_PATH_DEPTH`.

### Lifecycle

- **SharedFileSystem create**: full reconcile; status moves through `Provisioning → Initializing → Ready`.
- **Context references**: a Context referencing a SharedFileSystem that doesn't yet exist gets `MissingTarget` status; once the SharedFileSystem appears, the next Context reconcile mounts it RO into the mcp-host pod (rolls the per-Host Deployment).
- **SharedFileSystem delete**: respect `spec.retainOnDelete`. Default `true` for v1. When `false`, HCC deletes Deployment, Service, NetworkPolicies, then PVC last.
- **Context delete**: patches the mcp-host Deployment to drop those volumes/volumeMounts. SharedFileSystem PVCs are unaffected (lifecycle independent of any single Context).

### Phased rollout

| Phase  | Scope                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1** | New `SharedFileSystem` CRD + `Context.spec.sharedFileSystems`. HCC reconciler creating PVC + wfc Deployment (with a seeding init container) per SharedFileSystem; status reaches `Initializing`. No service yet.   |
| **P2** | `workspace-files-controller` service: list/stat/download/healthz only. HCC reconciler creates per-SFS Deployment + Service + NetworkPolicies. control-api token-mint + proxy. Read-only Control UI workspace view. |
| **P3** | upload/replace/mkdir/move/delete. Control UI write actions.                                                                                                                                                        |
| **P4** | mcp-host RO mount injection (multi-mount via `Context.spec.sharedFileSystems`) + built-in `clerum__context_files_*` tools with virtual unified root. End-to-end with agent reads.                                  |
| **P5** | E2E suite, NetworkPolicy enforcement verification, GCP-dev soak.                                                                                                                                                   |

### Test strategy

- **Unit (workspace-files-controller):** path-safety table-driven tests, JWT verification (including SFS-name claim mismatch → 403), error-envelope shape, limit enforcement, symlink rejection.
- **Unit (HCC reconciler):** factory functions for PVC/Job/Deployment/Service/NetworkPolicies; per-Context mount-injection logic; phase transitions; missing-target handling.
- **Unit (mcp-host built-in tools):** path-safety reuse, virtual-root `list("/")` returns SharedFileSystem names, `read("sfs-name/file")` resolves correctly, oversized reads are rejected, and list/read operations refuse unsafe paths and symlinks.
- **Integration (control-api):** admin token-mint (admin role required in v1), proxy passthrough to per-SFS wfc.
- **E2E (`tests/e2e/shared-filesystems/` — planned, not yet written):** create SharedFileSystem; create Context referencing it; wait for `phase=Ready`; upload/replace/list/delete via Control-UI-equivalent HTTP path; verify mcp-host pod sees the file at `mountPath`; verify mcp-host cannot write (EROFS); verify the LLM can list and read via `clerum__context_files_*`. Run on minikube (RWO/single-replica) and GCP-dev (GCS FUSE) profiles.
- **Multi-ref E2E:** create two SharedFileSystems; create one Context referencing both; verify virtual unified root behaviour.
- **Sharing E2E:** create one SharedFileSystem; create two Contexts both referencing it; verify both Contexts' mcp-host pods see the same files.
- **Observability assertions:** Prometheus counters for ops/bytes/errors; pino structured logs include `sharedFileSystem`, `subject`, `op`, `path`, `bytes`, `durationMs`.

---

## Operations & failure modes

- **Storage misconfigured / unavailable** (no usable StorageClass, PVC never binds) → `SharedFileSystem.status.phase = Failed` with actionable condition/reason.
- **Seeding init container fails** -> the wfc pod CrashLoops in init; the SFS does not reach `Ready`.
- **wfc unhealthy** → `phase = Degraded` for that SharedFileSystem only. Other SharedFileSystems unaffected. RO mounts on mcp-host remain readable (kernel-level, independent of wfc).
- **Cross-Context exposure (operator-driven)** → if `Context: intern-agent` references `SharedFileSystem: secret-financials`, anyone with intern-agent chat access can ask the agent to read those files. **No auth check prevents this.** Operator discipline on `sharedFileSystems` references is the only mitigation. See "Operational guidance" in Authorization.
- **Missing target** → a Context referencing a non-existent SharedFileSystem starts up without that mount and writes `status.sharedFileSystems[].phase = MissingTarget`. Once the target appears, next reconcile mounts it.

---

## Related docs

- **[Context CRD reference](../crds/context.md)** (will be updated to include `spec.sharedFileSystems` once implemented)
- **[SharedFileSystem CRD reference](../crds/sharedfilesystem.md)** (new — created with v1)
- Root [Security model](../../README.md#security-model)
- [SharedFileSystem CRD](../crds/sharedfilesystem.md)
