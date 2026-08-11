# GFS Permission-Store Credential Lifecycle

How the `gfs_controller` PostgreSQL credential is provisioned, rotated,
detected when broken, and recovered. Written after issue #775, where a
credential drift surfaced to users as `clerum__gfs_resolve → gfsc 503
not_mounted` on every GFS operation.

## The two-step security model

No GFS database credential ever lives in code or in a committed manifest:

1. Existing migrations create the writer `gfs_controller` role; the additive
   reader-role migration creates `gfs_controller_reader`. Both begin as
   `NOLOGIN` GRANT targets. Writer retains mutation authority required by GFSC;
   reader receives authorization reads, append-only audit access, `NOINHERIT`,
   and no memberships or manifest authority.
2. **`deploy/scripts/provision-gfs-db.sh`** requires one explicit mode:
   `stage-writer`, `stage-reader`, `rotate-reader`, or `rotate-writer`. Normal
   deployment runs `stage-writer` and then `stage-reader`; both preserve valid
   credentials. `stage-writer` atomically adopts a legacy writer Secret that
   predates lifecycle annotations only after strict DSN, real SCRAM authentication,
   privilege-contract, empty-pending, and resourceVersion checks. It never rotates
   the password or restarts the writer. `stage-reader` performs a directed reader
   restart only when an existing reader already consumes a newly committed
   reader credential and is stale for that credential.
   Reader rotation targets only `gfsc-reader`, and writer rotation targets only
   `gfsc-writer`. No mode uses a broad selector.
3. **host-context-controller** injects the independent reader/writer Secrets into gfsc pods as the
   `GFS_PG_CONNECTION_STRING` env var via `secretKeyRef`
   (`host-context-controller/src/k8s/gfsFactory.ts`). Env vars resolve at
   **pod creation time** — a Secret rotation only takes effect after the pods
   roll, which is why the provisioning script restarts them.
4. **gfsc** builds its `pg.Pool` from that DSN and consults the permission
   store on every operation (fail closed: any store error maps to
   `GfsError("not_mounted")` HTTP 503 — gfsc never authorizes what it cannot
   verify).

## Deployment and rotation order

Normal dev/prod order is: migrations, runtime-role reconciliation, apply the
central `reconcile-gfs-deploy-credentials.sh` entrypoint, then apply
the environment overlay. This sequence does not rotate an already-valid role.
The reconciler migrates legacy writer apply ownership, bootstraps the writer
with explicit `rotate-writer` only when its connection key is empty, validates
non-rotating `stage-writer`, and declares/stages the reader.
On fresh cutover the overlay creates the reader with the staged identity; on
recovery, `stage-reader` may restart only a stale `gfsc-reader` that already
references the committed reader Secret.

Credential changes use the Secret lifecycle `ready → pending → applying →
rollout-pending → rollout-running → ready`. A second process cannot adopt
`applying`. After confirming that the previous process has ended, recover an
abandoned apply or rollout with the same explicit mode plus
`GFS_RECOVER_ABANDONED_STATE=true`; the persisted candidate is resumed instead
of generating another credential.

Legacy adoption reads resourceVersion, lifecycle, active DSN, pending candidate,
and rotation timestamp from one Kubernetes GET. Its JSON Patch tests that exact
resourceVersion, so a concurrent rotation wins and adoption writes nothing. If
an old Secret lacks the timestamp, adoption does not invent pod freshness: each
live writer pod must be Ready and prove, through a no-output stdin comparison,
that its loaded environment contains the exact authenticated DSN. The oldest
matching pod creation time becomes the conservative freshness boundary. No pod
is restarted. If no writer deployment exists yet, the adoption time is safe
because every future pod will necessarily be newer.

Every database-recreation path runs `preflight-gfs-db-reset.sh` before scaling
down or deleting the PVC. The preflight intentionally does not authenticate to
PostgreSQL, because reset and WAL recovery must remain usable when the database
is unavailable or corrupt. It reads one Kubernetes snapshot per Secret and
fails closed unless writer and reader are both `ready`, have no pending
candidate, and contain a structurally valid active DSN for the exact expected
role, Service endpoint, port, and database.

After PostgreSQL is recreated and Ready, all reset paths call the single
`converge-control-db-after-reset.sh` entrypoint. It applies migrations,
reconciles runtime roles, waits for Control API, opts into
`GFS_RESTORE_ACTIVE_NOLOGIN=true`, and runs the real Service/SCRAM verifier.
Every initial or `replacement-bound` convergence attempt first scales Control
API to zero and waits for its Pods to terminate. PostgreSQL connection strings
are Secret-backed environment variables captured at Pod creation, so patching
the runtime Secret cannot repair a container that started with the pre-reset
credential. Runtime roles and Secrets are reconciled only behind that fence;
the saved replica count is then restored, creating Pods with the current DSN.
Migration Job Pods intentionally share `app=control-api` for NetworkPolicy
access, so the fence excludes Pods carrying `clerum.io/component`; a completed
migration Pod awaiting TTL cleanup cannot delay runtime writer quiescence.
After Control API is Ready and while GFSC remains at zero, convergence invokes
the canonical `sync-auth-key.sh --require-gfs` path. It must copy the non-empty
`rpc-proxy-secrets.RPC_PROXY_JWT_PUBLIC_KEY` authority into
`gfs-config.jwt-public-key` before GFS credentials are restored or either GFSC
deployment is scaled up. Missing source or target resources abort recovery and
retain the fail-closed replica state; no reset path patches the key ad hoc.
Any later convergence failure reasserts the Control API fence together with the
other database-dependent controllers and waits for the Control API Pods to
terminate before returning.
That reset-only restoration requires lifecycle `ready`, no candidate, the
exact disabled-role privilege contract, and the unchanged committed DSN;
normal deploys cannot reactivate a disabled role. The shared sequence is used
by local, dev, prod, and full-setup `--reset-db` paths so no caller can report
success after only a partial database rebuild. Automatic destructive WAL
recovery is intentionally disabled: replacing control-DB storage always
requires the exact observed PVC UID. Resume stays bound to that original
authorization and may converge the replacement, but it may never scrub a
different PVC.

For an existing minikube profile with Ready control-api, full setup, pre-gate
sync, and `minikube-deploy-all` complete the same reader staging before the full
overlay. A fresh profile first declares the Secrets and remains fail-closed;
after migrations it runs `rotate-writer` only if the writer key is empty, then
runs `stage-writer` and `stage-reader`. A non-empty writer key is validated and
preserved; a legacy Secret receives the CAS-protected lifecycle annotation and,
only when absent, a conservative pod-backed rotation timestamp.

`rotate-reader` performs an availability-preserving directed reader rollout with
`maxUnavailable: 0` and `maxSurge: 1`. Successful local probes do not guarantee
zero interruption in dev or prod. `rotate-writer` performs a directed singleton-writer rollout
and therefore has a bounded write interruption; it is not zero-downtime. HCC,
not either rotation mode, owns full GFSC image/template rollout ordering.

Both roles require `USAGE` and `SELECT`, but not `UPDATE`, on
`gfs_audit_sequence_no_seq`. Reader also requires `NOINHERIT` and zero role
memberships.

## The manifest is provisioning-owned (the historical reapply hazard)

`deploy/base/gfs/gfs-controller-db.yaml` declares the Secret **without** the
`connection-string` key. This is deliberate: `kubectl apply` performs a
three-way merge and only prunes keys present in `last-applied-configuration`;
since the provisioning script writes the key with `kubectl patch`, a full
overlay apply (`make minikube-deploy-all`, CI applies) can never clobber a
provisioned DSN.

Historically the manifest shipped `connection-string: ""`, so every overlay
apply silently wiped the provisioned credential — the root enabler of issue
#775. `deploy/scripts/apply-gfs-writer-secret.sh` makes that historical first
upgrade safe: for an existing Secret it first replaces only the legacy
`last-applied-configuration` record with the keyless manifest, then performs
the normal apply. The live DSN is never removed. Fresh bootstrap skips that
migration and creates the empty fail-closed Secret normally. Dev/prod CI, GCP
Make targets, full setup, pre-gate sync, and `minikube-deploy-all` all use this
single helper before an overlay can prune legacy ownership.

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
CONTEXT=<kube-context> deploy/scripts/provision-gfs-db.sh rotate-reader
# Use rotate-writer only when writer repair is explicitly required.
MINIKUBE_PROFILE=<profile> make minikube-verify-gfs
```

The script verifies the role exists (writer migration 0048; reader migration 0071),
rotates the password, patches the Secret, stamps the rotation annotation, and
rolls and waits only for the selected gfsc Deployment.

## Credential repair is not resource authorization

HCC rollback retains both database roles and their Kubernetes objects. Capture
the exact pre-cutover revision and immutable images, use `rollout undo` with
that revision, prove old HCC reconciles through the writer compatibility
identity, and reapply the candidate through the normal branch-owned helper.
Do not use an ad hoc rollback manifest or remove the additive reader state.

After the store is healthy again, an agent host can still receive a legitimate
**403 denial** for a specific file: a host principal resolves only to its own
subject (`gfs-controller/src/authz/subjectResolver.ts`, deny-by-default), and
there is no implicit user→agent delegation. Granting a host access to a
user-selected resource is an explicit governance operation through the
delegation engine (`control-api/src/gfs/delegation.ts`). When validating a
credential repair, use a fixture that IS granted to the host — a 403 on an
ungranted file is the authorization model working, not a regression.

## Legacy `standalone` grant cutover

`host:1st:mcp-host/standalone` is a retired fleet-wide principal. Managed Hosts
authenticate only as their exact `host:1st:<namespace>/<name>` subject, future
Hosts inherit nothing, and the legacy subject is never an authorization
fallback. Legacy rows remain visible for inventory until their individual
replacements have been reviewed; their presence does not make them effective.

Migration is deliberately separate from deployment. Dev and production
workflows must not infer recipients, fan a grant out to every Host, or mutate
grants automatically. Before the identity cutover in an environment that may
contain legacy rows:

1. Build Control API and run `scripts/gfs-legacy-standalone-grants.mjs report`
   against HTTPS or a loopback port-forward, using the CLI's private local
   authentication-file option.
2. Save the emitted `mappingTemplate` as a reviewed JSON document. For each
   legacy grant, name only the exact active Host subjects approved to receive
   it. An empty target list is valid and means no replacement grant.
3. Run the CLI's `apply` mode with that mapping and `--confirm-reviewed`, then
   rerun `report`.
4. Resolve every failed or unexpected mapping explicitly. Do not broaden a
   mapping merely to make the report empty, and securely remove temporary
   local authentication and mapping artifacts afterward.

The CLI enforces private-file permissions and bounded mappings; its header
documents the complete invocation. Apply creates only approved individual
grants, rejects managed-agent permissions beyond `read` and `write`, and does
not delete or rewrite the source legacy row. If a mapping is incomplete at
cutover, the affected agent loses that legacy access by design (fail closed):
no data is deleted and no permission is silently inherited. Treat the reviewed
report as an environment rollout precondition while keeping apply an explicit
operator action rather than a deployment side effect.
