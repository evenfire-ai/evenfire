# GFS Permission-Store Credential Lifecycle

How the `gfs_controller` PostgreSQL credential is provisioned, rotated,
detected when broken, and recovered. Written after issue #775, where a
credential drift surfaced to users as `clerum__gfs_resolve → gfsc 503
not_mounted` on every GFS operation.

## The two-step security model

No GFS database credential ever lives in code or in a committed manifest:

1. **Migration `0048_gfs_permission_store`** (control-api,
   `applyGfsPermissionStoreSchema` in `control-api/src/db.ts`) creates the
   `gfs_controller` role **NOLOGIN**, purely as a GRANT target: SELECT on
   `gfs_resources` / `gfs_grants` / `gfs_shares`, INSERT-only on `gfs_audit`,
   column-scoped SELECT on `control_admin_users` / `team_members`, and explicit
   REVOKEs for everything else.
2. **`deploy/scripts/provision-gfs-db.sh`** (CONTEXT-aware, idempotent) grants
   `LOGIN`, rotates the password (`openssl rand -hex 24`), builds the DSN,
   patches it into the `gfs/gfs-controller-db` Secret key `connection-string`,
   stamps the rotation timestamp as the `clerum.io/gfs-dsn-rotated-at`
   annotation, and rolls both gfsc deployments (selector
   `clerum.io/managed-by=host-context-controller`).
3. **host-context-controller** injects the Secret into gfsc pods as the
   `GFS_PG_CONNECTION_STRING` env var via `secretKeyRef`
   (`host-context-controller/src/k8s/gfsFactory.ts`). Env vars resolve at
   **pod creation time** — a Secret rotation only takes effect after the pods
   roll, which is why the provisioning script restarts them.
4. **gfsc** builds its `pg.Pool` from that DSN and consults the permission
   store on every operation (fail closed: any store error maps to
   `GfsError("not_mounted")` HTTP 503 — gfsc never authorizes what it cannot
   verify).

## The manifest is provisioning-owned (the historical reapply hazard)

`deploy/base/gfs/gfs-controller-db.yaml` declares the Secret **without** the
`connection-string` key. This is deliberate: `kubectl apply` performs a
three-way merge and only prunes keys present in `last-applied-configuration`;
since the provisioning script writes the key with `kubectl patch`, a full
overlay apply (`make minikube-deploy-all`, CI applies) can never clobber a
provisioned DSN.

Historically the manifest shipped `connection-string: ""`, so every overlay
apply silently wiped the provisioned credential — the root enabler of issue
#775. If you operate a cluster whose Secret predates this change, the FIRST
apply after upgrading removes the legacy empty key from last-applied (and with
it the provisioned value): re-run the provisioning script immediately after
that first apply. `make minikube-deploy-all` now does this automatically when
the GFS stack is deployed and control-api is Ready.

On a fresh cluster the failure mode is loud by construction: gfsc pods sit in
`CreateContainerConfigError` (missing Secret key) until provisioning runs.

## Drift detection

Readiness (`/readyz`) requires the storage mount AND a healthy permission
store. The store check has two layers (`gfs-controller/src/authz/storeProbe.ts`):

- **Pool ping** (every probe): `SELECT 1` through the shared pool — catches a
  down/unreachable store within one probe period.
- **Fresh-connection credential probe** (amortized, default 60s, tune with
  `GFS_CREDENTIAL_PROBE_INTERVAL_MS`): dials a brand-new client and verifies
  `has_table_privilege(current_user, 'gfs_resources', 'SELECT')`. The pool
  alone cannot see a rotated password — its idle clients authenticated before
  the rotation and the kubelet probe cadence keeps one alive forever. Only
  success is cached; while failing, every probe retries.

Net effect: a stale DSN, a rotated role password, or missing migration-0048
grants flips the pod NotReady within roughly a minute, visibly in
`kubectl get pods -n gfs`, instead of serving chronic 503s to users.

`/readyz` reasons you may see:

| Reason | Meaning |
| --- | --- |
| `storage volume not mounted …` | Drive PVC missing/unmounted (not a credential issue) |
| `permission store unreachable: password authentication failed …` | DSN/password drift — re-run provisioning |
| `permission store unreachable: … coherence check failed … gfs_resources … 0048` | Role exists but the SELECT grants/migration are missing — run control-api migrations, then provisioning |
| `permission store unreachable: … coherence check failed … gfs_audit …` | Audit INSERT grant missing — every request would 503 (audit-write failures propagate); run migrations + provisioning |
| `permission store unreachable: … timed out after Nms` | Black-hole partition (unreachable, not refusing) — the probe hard-bounds connect/query (default 5s) instead of dangling |
| `permission store unreachable: connect ECONNREFUSED …` | PostgreSQL down/unreachable |

## Verification

```bash
MINIKUBE_PROFILE=<profile> make minikube-verify-gfs
# or directly:
CONTEXT=<kube-context> scripts/minikube/verify-gfs.sh
```

Proves, without decoding any credential value: Secret key populated, both gfsc
deployments rolled out, every pod postdates the last rotation annotation, and
every pod Ready. `scripts/minikube/pre-gate-sync.sh` runs it automatically
after rollouts when the GFS stack is present, and provisioning failures abort
setup/pre-gate flows (fail loud — a broken credential guarantees failed gates
and user-facing 503s later).

## Diagnosis runbook (no credential values in logs — ever)

1. `kubectl --context=<ctx> -n gfs get pods` — NotReady/CrashLoop/Config
   errors point at the layer (see reasons table above).
2. `kubectl --context=<ctx> -n gfs logs deploy/gfsc-reader | tail` — look for
   `password authentication failed for user "gfs_controller"`,
   `permission store unreachable`, `not_mounted`.
3. Secret populated? Check **length only**:
   `kubectl --context=<ctx> -n gfs get secret gfs-controller-db -o jsonpath='{.data.connection-string}' | wc -c`
4. Pods older than the last rotation? Compare pod `creationTimestamp` against
   the Secret's `clerum.io/gfs-dsn-rotated-at` annotation (verify-gfs.sh does
   this for you).
5. Migration applied? control-api logs on startup, or check the
   `schema_migrations` row for `0048_gfs_permission_store`.
6. Never print, decode, or paste the DSN, the password, or any bearer token
   into logs, terminals you share, CI output, or GitHub issues. Diagnostics
   use lengths and timestamps.

## Recovery

```bash
CONTEXT=<kube-context> deploy/scripts/provision-gfs-db.sh   # idempotent
MINIKUBE_PROFILE=<profile> make minikube-verify-gfs
```

The script verifies the role exists (fails loud pointing at migration 0048),
rotates the password, patches the Secret, stamps the rotation annotation, and
rolls + waits for both gfsc deployments.

## Credential repair is not resource authorization

After the store is healthy again, an agent host can still receive a legitimate
**403 denial** for a specific file: a host principal resolves only to its own
subject (`gfs-controller/src/authz/subjectResolver.ts`, deny-by-default), and
there is no implicit user→agent delegation. Granting a host access to a
user-selected resource is an explicit governance operation through the
delegation engine (`control-api/src/gfs/delegation.ts`). When validating a
credential repair, use a fixture that IS granted to the host — a 403 on an
ungranted file is the authorization model working, not a regression.
