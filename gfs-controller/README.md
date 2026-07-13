# GFS Controller

`gfs-controller` (gfsc) is the brokered HTTP file API over the GlobalFileSystem
drive. It is the only workload that mounts the drive PVC — every other actor
(agents, control-api, UIs) reaches the drive through this API, never by
mounting the volume. Authorization is decided against a Postgres permission
store on every operation, and every decision is audited.

## How It Works

Two roles, created by the host-context-controller `gfsReconciler` from the
[GlobalFileSystem CRD](../docs/crds/globalfilesystem.md):

- **writer** — exactly one replica, mounts the PVC read-write, serves the write
  routes (create / replace / delete).
- **reader** — `readerReplicas` replicas, mount the PVC read-only. Write verbs
  are not registered and return 404; the blob store refuses writes outright.

Every request runs a fail-closed chain, in order:

1. **Bearer token** — RS256 JWT verified against `GFS_JWT_PUBLIC_KEY`
   (`kid`, signature, `aud`, issuer `control-api`, expiry) → 401 on any failure.
2. **Subject resolution** — the principal is expanded to its subject set
   (self + teams) from the store; a store error is a 503, never a guess.
3. **Token ceiling** (`src/authz/tokenCeiling.ts`) — the token is an _upper
   bound on authority, never a grant_: the op's scope bit (`gfs.read`,
   `gfs.write`, …) must be present **and**, when the token carries
   `pathBindings`, some binding must cover the resource path with the matching
   permission. Neither alone authorizes.
4. **Permission store** (`src/authz/permissionClient.ts`) — the source of
   truth, re-checked on every op. Deny by default; a store error is a 503
   (`gfsc` never falls back to the token's claims).

Steps 3 and 4 must **both** allow. Authorization runs before any metadata is
revealed, so an absent resource and an unauthorized one are indistinguishable
(both 403). The `drive` comes from the token claim, never the query string.

**Decision cache** — a short-TTL cache (default 5 s) short-cuts repeated
identical lookups. It starts **bypassed** and is only enabled once the Postgres
LISTEN/NOTIFY invalidation fan-out is healthy; any grant/share write flushes it
(revocation is immediate, not TTL-bound), and a degraded LISTEN connection puts
it back into bypass. Cache hits are still audited.

**Audit** — every decision (allow, deny, error) is one INSERT-only row in
`gfs_audit`, written under the least-privilege `gfs_controller` DB role
(INSERT-only on the audit table; no write on grants/shares). An audit-write
failure propagates — no un-audited op is served. `src/audit/chain.ts` provides
the SHA-256 `prevHash → rowHash` chain hashing and verification: the log is
tamper-**evident**, not WORM. Live rows currently carry a per-row content hash;
full `prev_hash` chaining of inserted rows is not yet wired into the write path.

Quota primitives (byte/object ceilings, per-subject rate limiter) exist in
`src/quota/` with a `quota_exceeded` → 429 mapping, but are not yet enforced in
the serving path.

## Endpoints

| Route                                 | Method | Purpose                                         |
| ------------------------------------- | ------ | ----------------------------------------------- |
| `/healthz`                            | GET    | Liveness                                        |
| `/readyz`                             | GET    | Fail-closed readiness (see below)               |
| `/metrics`                            | GET    | Prometheus SLIs                                 |
| `/v1/resources/:rid`                  | GET    | Stat                                            |
| `/v1/resources/:rid/children`         | GET    | List children                                   |
| `/v1/resources/:rid/content`          | GET    | Download bytes                                  |
| `/v1/resolve?uri=gfs://<drive>/<rid>` | GET    | Resolve a `gfs://` URI (drive must match token) |
| `/v1/accessible`                      | GET    | Resources visible to the caller (paginated)     |
| `/v1/resources/:parentId/children`    | POST   | Create file/directory (writer only)             |
| `/v1/resources/:rid/content`          | PUT    | Replace content (writer only)                   |
| `/v1/resources/:rid`                  | DELETE | Soft-delete (writer only)                       |

Agent principals (`sub` prefixed `host:`) must include an integer `ifMatch`
field (the resource `version`) in the JSON request body on replace and delete —
omitting it is a 412. There is no ETag: content responses carry the version in
the `X-Gfs-Version` response header, and the only request headers the service
reads are `Authorization` and `x-request-id`. Mutation bodies are capped at
16 MiB.

## Configuration

Required values fail loud at startup in production; `GFS_DEV_MODE=true`
relaxes them for local runs only.

| Variable                    | Explanation                                                                                                                    | Default          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `GFS_PORT`                  | HTTP listen port                                                                                                               | `8087`           |
| `GFS_STORAGE_PATH`          | Drive PVC mount path (required; dev default `/tmp/gfs-data`)                                                                   | —                |
| `GFS_STORAGE_ROLE`          | `writer` (RW, single replica) or `reader` (RO)                                                                                 | `writer`         |
| `GFS_PG_CONNECTION_STRING`  | Permission-store DSN — the least-privilege `gfs_controller` role (required)                                                    | —                |
| `GFS_JWT_PUBLIC_KEY`        | RS256 public key (PEM) verifying gfs access tokens; required to serve in production. In dev mode an empty key runs probes-only | —                |
| `GFS_TOKEN_AUDIENCE`        | Expected `aud` on inbound tokens                                                                                               | `gfs-controller` |
| `GFS_DRIVE_NAME`            | Drive this gfsc serves (a cluster singleton in the open-source release)                                                        | `main`           |
| `GFS_DECISION_CACHE_TTL_MS` | Decision-cache TTL; bounds staleness even with no invalidation signal                                                          | `5000`           |
| `GFS_DEV_MODE`              | Relax required vars for local runs and tests                                                                                   | `false`          |

## Readiness

`/readyz` is fail-closed: 200 only when the drive volume is mounted at
`GFS_STORAGE_PATH` **and** the permission store answers `SELECT 1`. gfsc never
reports ready when it could not verify the store — it can never serve requests
it cannot authorize. A fresh checkout ships empty key/DSN placeholders, so gfsc
stays not-ready until deploy provisioning populates them.

## Testing

```bash
npm install
npm test   # vitest — 18 test files (authz, audit, api, db, storage, quota, auth, metrics, server, single-writer)
```

## Deployment

The writer/reader Deployments, Service, PVC, and workload NetworkPolicies are
**not** static manifests — HCC's `gfsReconciler` creates them from the
GlobalFileSystem CRD instance. [`deploy/base/gfs/`](../deploy/base/gfs/) ships
the namespace default-deny floor plus the config those pods consume: the JWT
public key ConfigMap (`gfs-config`) and the `gfs-controller-db` Secret (both
placeholders, populated by `make <env>-gen-keys` / DB provisioning). Agents
consume this API through mcp-host's `clerum__gfs_*` tools.
