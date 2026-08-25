# Evenfire local Minikube T0/T1/T2 runbook

This runbook describes the public, reproducible development contract for the
Evenfire validation lanes. It deliberately contains no profile names, ports,
URLs, DSNs, credentials, customer data, or raw runtime logs.

## Scope and entry points

The contract is local-development-only. It requires a clean development
branch descended from the current `origin/dev`, a generated profile owned by
that canonical worktree path plus branch, and an explicit Kubernetes context
for that profile. Exact-HEAD freshness is proved by the deployed marker and
gate evidence, not by reallocating a profile after every commit.
It refuses protected branches, production/GKE/Cloudflare contexts, shared
profiles, ambiguous ownership, and Kubernetes contexts whose cluster endpoint
does not resolve to a local Minikube address.

Run the cluster-read-only planner first. It may write ignored local
lock/evidence metadata, but it does not mutate the cluster and is not T0, T1,
or T2. Default
`T2_PLAN_MODE=false` fails loud on `full-bootstrap` and never calls
`pre-gate-sync`:

```bash
MINIKUBE_PROFILE=<generated-profile> CONTROL_API_REAL_PG_CONTEXT=<generated-context> \
  make minikube-t2-preflight
```

The full orchestrator uses the same checks as a planner (`T2_PLAN_MODE=true`
so `full-bootstrap` is reachable), then performs the selected state
transition, T0, T1, and the exact-head T2 verdict (`T2_PLAN_MODE=false` and
the plan must be `already-synced`):

```bash
MINIKUBE_PROFILE=<generated-profile> CONTROL_API_REAL_PG_CONTEXT=<generated-context> \
  make minikube-t2
```

After T0 and T1 are already green on the same HEAD and owned profile, close
T2 without re-running those lanes:

```bash
MINIKUBE_PROFILE=<generated-profile> CONTROL_API_REAL_PG_CONTEXT=<generated-context> \
  make minikube-t2-runtime
```

`make minikube-t2-runtime` is valid only when the pre-gate marker already
matches HEAD. `make minikube-pre-gate-sync GATE=<non-T2-gate>` reconciles the
profile for a named non-T2 gate; it does not emit a T2 verdict. Its reserved
`GATE=minikube-t2` form is callable only from the internal canonical
orchestrator delegation and fails closed when invoked standalone. Never use
pre-gate-sync to bootstrap, close, or certify T2.

The profile helper that generated the profile remains the source of truth for
the profile metadata and random localhost port mapping. Resolve it from the
primary checkout `.local-notes/minikube-profiles/branch.mk`. A legacy creation
SHA is historical metadata; it does not override stable worktree+branch
ownership. Persisted `ports.env` is allocated once. Missing, corrupt, or
ambiguous metadata fails closed; never regenerate or copy another lane's ports.

## State transitions

### Bootstrap

A missing or uninitialized profile has no trusted pre-gate marker, image
manifest, or ready PostgreSQL state. Standalone `make minikube-t2-preflight`
reports `BOOTSTRAP_REQUIRED` and stops. `make minikube-t2` uses planner mode
(`T2_PLAN_MODE=true`) so that transition is reachable and then runs the
supported full setup. Bootstrap orders Secret/ConfigMap validation, PostgreSQL
readiness, migrations and roles, and only then `pre-gate-sync`. It does not
delete a PVC by default.

### Targeted sync

When the pre-gate marker already matches the current worktree path and `HEAD`,
the planner selects `already-synced` and `make minikube-t2` skips setup and
`pre-gate-sync`. That is the T2-runtime precondition.

An already healthy profile whose marker is stale may use a targeted
image/deployment update only when the diff since `origin/dev` is limited to a
known service, package, harness, or documentation change. The affected
deployment must become Ready and its user-facing health check must pass. This
is recorded as a targeted sync, not as a full reconcile and not as T2.

### Full reconcile

Changes under `deploy/` or `charts/` (CRDs, manifests, NetworkPolicies,
PVC/storage definitions, the Minikube overlay) require a full reconcile when
the marker does not already match HEAD. Harness, documentation, Makefile, and
`scripts/e2e` diffs do not force a full reconcile. The runner refuses to
downgrade a `deploy/` or `charts/` change to a service-only restart.

A bootstrapped profile with an unready required deployment also selects
`full-reconcile` — but only in the orchestrator planner (`T2_PLAN_MODE=true`),
with a reason that names the unready deployment. The planner must never stop
with `PROFILE_UNHEALTHY` before a transition is selected: that turned every
mid-run failure into a manual repair script followed by another full run.
The standalone `make minikube-t2-preflight` and the final exact-head T2 check
(`T2_PLAN_MODE=false`) remain fail-loud if a deployment is still unready
after the reconcile.

## Ownership and concurrency

The lock is keyed by repository, branch, `HEAD`, and profile, while the
profile-level lock prevents two processes from mutating one profile at the
same time. The active lock is `$T2_LOCK_ROOT/<profile>.lock`; its record
contains only local metadata and is removed by success, failure, timeout, and
interrupt traps. A live owner produces `PROFILE_BUSY`; stale metadata may be
reclaimed only after its recorded PID is no longer running. Reclaimers
serialize through the atomic sibling directory
`$T2_LOCK_ROOT/<profile>.reclaim`, never a child of the active lock. A
concurrent loser fails closed and never removes either the stale directory or
the winner's replacement lock.

The pre-gate marker must contain the current worktree identifier, exact `HEAD`,
cluster fingerprint, image coordinate, and the exact `imagesGeneratedAt` value
from the image manifest. A mismatch—including a new image acquisition at the
same HEAD—stops with a stable error code instead of allowing a mixed-commit run.

Mutating image acquisition/builds and targeted deploys are children of that
same exact profile lease. Public Make targets acquire it; private body targets,
`pull-images.sh`, and `build-images.sh` validate the inherited token again
before the first Docker,
Minikube, or Kubernetes operation. `build-images.sh --verify-only` is the
read-only exception. Empty/unknown selectors fail before the lease or runtime
is touched. The legacy `scripts/minikube/setup.sh` path is protected the same
way for both `--build` and no-build invocations and requires matching explicit
branch-profile/context variables; it never defaults to the shared
`clerum-test` profile. The published-image puller bounds parallelism to 1-64,
retries to 1-10, and retry delay to 0-300 seconds; empty successful
`minikube docker-env` output is a hard failure.

### Orphaned lock recovery

If `PROFILE_BUSY` reports that the lock has no valid owner PID, or that a stale
reclaim is already in progress, first verify that the recorded owner PID is not
alive, that no reclaimer process is alive, and that no other session is
mutating the profile. A `$T2_LOCK_ROOT/<profile>.reclaim` sibling directory can
remain after a reclaimer is killed and is intentionally not auto-reclaimed.
After those checks, operate only on the two exact profile paths:

```bash
rmdir -- "$T2_LOCK_ROOT/<profile>.reclaim"
rm -rf -- "$T2_LOCK_ROOT/<profile>.lock"
```

Use only the command for a path that exists: if only the claim exists, run
`rmdir`; if only the lock exists, run `rm -rf`; if both exist, remove the empty
claim first and then the stale lock. `rmdir` is preferred for the claim because
it must be empty. Never remove either path with a live owner/reclaimer, and
never remove the whole lock root.

## Preconditions and secrets

The runner checks required namespaces, Services, Secret names, ConfigMap names,
the `control-postgres` PVC/deployment, all required deployment readiness, the
image manifest/source, and real `kubectl port-forward` processes for this
profile. The conflict check is a loose argv pre-filter (`kubectl` as argv0 or
path token plus a later standalone `port-forward` token; flags may sit
between them), followed by exact `comm`, argv, PID/start-time, profile,
context, canonical worktree, Service, and port bindings. Each live process
must have exactly one atomic `0600` ownership record under
`$HOME/.cache/clerum/minikube-profiles/<profile>/pids/`. A live legacy
`/tmp/pf-<profile>-*.pid` record cannot be adopted or killed because it lacks
the full binding; dead legacy records may be pruned. Registered pidfiles are
also checked when `ps` no longer lists a child, and a successful user-facing
health probe is followed by exact process/start-time/argv revalidation.
`make minikube-t2` invokes `pre-gate-sync` with `--skip-port-forwards` so the
orchestrator does not plant forwards that fail its own T2 check. Secret values
are never printed.

Docker endpoint discovery runs before isolation and accepts only an explicit
local Unix socket or loopback TCP endpoint. The endpoint is then pinned while
Docker uses an empty task-local config; ambient auth, credential helpers,
custom headers, and context precedence do not cross that boundary. Public
pulls remain unauthenticated. A private pull must opt in with an explicit
`MINIKUBE_DOCKER_AUTH_CONFIG`, scoped only to that pull. Docker probes, pulls,
builds, Minikube image operations, Minikube status/docker-env, Kubernetes node
inventory, and targeted health commands all have validated finite deadlines
and process-group cleanup on timeout or interrupt.

The local Real PostgreSQL lane resolves the
`control-postgres` Secret using the explicit context, constructs its admin DSN
only in process memory, and passes it only to the shared-server suites. Suites
that drop or rewrite cluster-global roles (`db.realPostgresMigration`,
`gfsReaderRole`) run against a throwaway `postgres:16-alpine` container so they
never share live `control-postgres` (#412). CI continues to use
`CONTROL_API_REAL_PG_ADMIN_URL` unchanged.

GFS runtime credentials are self-healing inside the single run. The
gfs-controller shared suites exercise cluster-global role names, so the T1
lane restores the branch-profile GFS credentials on exit (success, failure,
or interrupt) using the canonical
`deploy/scripts/reconcile-gfs-deploy-credentials.sh` with
`GFS_RESTORE_ACTIVE_NOLOGIN=true` and `GFS_RECOVER_ABANDONED_STATE=true` —
the same contract as the standalone GFS T1 gate, plus resume of a leftover
`rollout-running` claim from a timed-out prior setup. The T2 profile lock
makes that recover safe: the prior process is dead. When `gfsc-reader`
is already Ready, `scripts/minikube/settle-gfs-reader-rollout.sh` marks
the leftover reader claim ready before reconcile, scales to 0 any leftover
non-current ReplicaSet that contributes no Ready pod (its live unready pod
would otherwise keep the stale-pod recovery pending forever), and deletes
CrashLoopBackOff reader pods so they re-read the restored Secret without
waiting out kubelet backoff. HCC's gfsReconciler owns the reader Deployment
template and strips the `restartedAt` annotation `kubectl rollout restart`
adds, so a generation-based `kubectl rollout status` chases flapping
revisions until timeout; every harness GFS reconcile therefore runs with the
`scripts/minikube/gfs-rollout-shim` PATH prefix, which intercepts exactly
the reader `rollout status` wait and judges readiness instead
(`scripts/minikube/wait-gfs-reader-ready.sh`: desired replicas Ready and no
live non-terminating unready reader pod). A reader pod also fails closed
when `gfs-config.jwt-public-key` is empty — the overlay re-applies the base
ConfigMap with an empty value — so `full-setup.sh` and `pre-gate-sync` re-run
`scripts/minikube/sync-auth-key.sh` before each GFS reconcile; otherwise no
new reader pod can start and the readiness wait can only time out. Auth sync
commits a SHA-256 convergence annotation only after every active Deployment
binding whose effective source is
`mcp-host-config.CLERUM_AUTH_JWT_PUBLIC_KEY`—including Workspace Files
Controllers—and the exact `gfsc-writer`/`gfsc-reader` consumers prove through
a stdin-only in-process check that they loaded the target public key. A
matching ConfigMap without that annotation is an interrupted rollout and is
resumed; it is never treated as converged.
`pre-gate-sync` provisions GFS serving with the same opt-ins only in the
`minikube-t2` transition (including its "no cluster sync required" fast path).
Other platform security gates refresh MCP auth with `--skip-gfs` and do not
mutate the GFS plane. After a successful T2 restore, it restarts an unready
`gfsc-reader`, deletes its live unready pods once, and waits on the same
readiness contract. `full-setup.sh` on the REUSE_DB / T2 full-reconcile
path passes the same opt-ins on both GFS reconcile calls, because setup runs
before pre-gate-sync and must not abort on a NOLOGIN reader or an abandoned
reader rollout. The recovery helper restores a
NOLOGIN role only from the committed Secret DSN and still fails loud when
that credential cannot authenticate; a missing or unreadable required Secret
also fails the T1 cleanup instead of producing a green run. No password is
ever invented and no DSN is printed.

The composed GFS recovery decision table is:

| Observed state | Authoritative action | Safety boundary |
| --- | --- | --- |
| `gfs-config` or the GFS reader Deployment is absent | Skip GFS recovery | The profile has no adopted GFS serving plane. |
| Reader is Ready and the reader Secret says `rollout-running` | `settle-gfs-reader-rollout.sh` marks the claim ready | Preserve the Ready reader; do not trigger a second restart. |
| A non-current reader ReplicaSet has no Ready pod, including an empty `readyReplicas` field | Scale that ReplicaSet to zero | Never scale the current revision; leave terminating pods alone. |
| A live reader pod is `CrashLoopBackOff`, unready, and not terminating | Delete that pod once | Kubelet backoff is reset so it can re-read restored credentials. |
| Desired reader replicas are not Ready, or a live non-terminating reader is unready | Reconcile with the GFS rollout shim, then converge and wait | Do not mark the credential rollout ready from an unready observation. |
| Source auth Secret/key or GFS ConfigMap is missing/empty during a strict GFS sync | Fail before any consumer patch or restart | `--require-gfs` makes an empty source fail closed. |
| Caller supplies an explicit reader rollout timeout | Honor that timeout; an omitted timeout defaults to 600 seconds | The shim never silently floors a caller's fail-fast timeout. |
| Gate is not `minikube-t2` | Refresh MCP auth with `--skip-gfs` only | Security gates cannot patch GFS Secrets/ConfigMaps or delete/restart GFS pods. |

The executable composition contract in
`scripts/tests/test-minikube-gfs-provision-order.sh` verifies the T2 order
`sync-auth-key → settle → reconcile-with-shim-on-PATH → converge` and the
non-T2 scope guard.

## T0, T1, and T2 boundaries

- **T0** — shell syntax/ShellCheck where available, contract tests, affected
  package builds/typechecks, and `git diff --check`.
* **T1** — the Real PostgreSQL suites execute against the validated local
  `control-postgres`, except the role-reset suites which use an isolated
  Postgres 16; the lane reports `PASS`, `FAIL`, `SKIPPED`, and `NOT_RUN`
  separately and fails on an unavailable DSN, an isolated server that did not
  start, or zero executed tests. A fast Node/package/Docker preflight runs
  before T0. T1 is serial by contract (`VITEST_MAX_WORKERS=1`, no file
  parallelism). The JSON reporter must be complete and green, its
  `testResults[].name` set must exactly equal the selected physical files, and
  the Vitest process must also exit zero; a green reporter cannot hide
  teardown, worker, OOM, signal, or partial-selection failure.
* **T2** — the final exact-head preflight inside `make minikube-t2` (or
  `make minikube-t2-runtime`): the marker matches this worktree/`HEAD`, the
  image manifest is current, PostgreSQL and required namespaces/Services are
  present, deployments are Ready, and no foreign `kubectl port-forward` owns
  this profile. A targeted sync requires a bounded user-facing journey via
  `T2_HEALTHCHECK_COMMAND`; other transitions may leave it opt-in. Control
  UI/Desktop Playwright remains opt-in via `T2_PLAYWRIGHT_COMMAND`. Both are
  recorded as separate evidence statuses (`NOT_RUN` when optional;
  `T2_REQUIRE_PLAYWRIGHT=true` refuses a missing journey). Product E2E scripts
  such as `scripts/e2e/e2e-hcc-rollout-readiness.sh` are not T2.

CI, static tests, T1, T2, Playwright, and product E2E scripts are separate
evidence lanes. A green CI job or unit suite is not proof of T2 runtime
behavior. A `T2_PREFLIGHT_PASS` line from the planner is not a T2 verdict.

## NP-08 security evidence gates

The NP-08 runtime conformance helpers are intentionally branch-owned, local
T2 adjuncts rather than shared CI jobs. They require an explicit Minikube
context and must never target GKE, Clerum-dev, Clerum-prod, or a shared
profile:

- `scripts/security/verify-np08-hcc-authz.sh` is the read-only deployment
  conformance check (Gate F). Invoke it with
  `--context <profile-context> --read-only --redact-identifiers`.
- `scripts/security/run-np08-synthetic-gate.sh` runs the repository-owned
  two-Context authorization matrix without Kubernetes writes (Gate E). Give it
  the same explicit context and a summary path below the ignored run directory.
- `scripts/security/scan-np08-evidence.sh` scans already-redacted API/log
  evidence. Its fixture regression runs in public CI; production-like evidence
  is scanned only after a local T2 run and must never contain Secret values.

The canonical T2 journey remains
`scripts/e2e/e2e-np08-hcc-authorization.sh`; these helpers do not replace it.
That journey observes the existing Host access-token lineage. It may reread a
newer persisted access token only when the sole `hostRefs` entry,
`recipeNamespace`, and `recipeName` exactly match the mounted access-token
binding. It never reads a
refresh token or calls refresh/reissue; mcp-host remains the sole writer of the
single-use lineage. Before fixture mutation it requires the in-pod runtime
health endpoint, and a 401 triggers a bounded access-state reread rather than a
second writer.
Their manual status must be recorded as `PASS`, `FAIL`, or `NOT_RUN` in the
sanitized run evidence rather than inferred from unit or CI results.

## Recovery and retry

Every phase has a bounded timeout. Failures name the first failing precondition,
emit a stable code, and show the next safe command. The runner never waits
indefinitely for a rollout that cannot start because a Secret, PVC, image, or
deployment prerequisite is absent.

PVC deletion is never automatic. A destructive reset requires an explicit
development-only flag and the exact expected PVC UID; a mismatched UID is
refused. An interrupted bootstrap leaves the profile intact and can be safely
retried after the reported prerequisite is repaired. Do not reuse evidence
from a different `HEAD` or profile.

REUSE_DB recovery fences all four database writers—HCC, workflow-recipes,
trace-maintenance-worker, and control-api—before migrations, role provisioning,
or the recovery overlay. The interrupted `HEAD` remains historical state for
the owned profile/context/worktree/branch; exact-head freshness is decided by
the pre-gate marker and image stamp. The trace worker is not considered fenced
until its Deployment reports zero desired replicas and no matching pods remain.
The incremental planner treats a changed image stamp as stale in both local and
GHCR modes, even when the recorded gitHead is unchanged.

Retry by phase. During a T1 failure, iterate with
`minikube-t2-real-postgres`, then run one full `minikube-t2` certification once
green. After exact-head T0/T1 lane evidence is already `PASS`, a failure in
NP08, a user-facing health check, or Playwright is repaired and retried with
`minikube-t2-runtime` on the same profile/context; repeating T0/T1 adds cost
without new evidence. A bootstrap, marker, infrastructure, or final-preflight
failure still uses the full target.

## Evidence and redaction

Each run writes a sanitized `evidence.json` below the ignored local path
`.local-notes/infra/runs/<timestamp>-<sha>/`. It contains branch/`HEAD`,
`origin/dev`, merge-base, worktree path, profile/context identifiers,
fingerprint and image-manifest references, phase timestamps, lane statuses,
test counts, and references to local log files. It never contains Secret
values, DSNs, tokens, kubeconfig data, private URLs, user data, screenshots, or
raw logs. Run the public-boundary contract before committing:

```bash
make minikube-t2-public-boundary
```

The boundary check fails if its base ref cannot be resolved, scans committed,
staged, working-tree, and non-ignored untracked files, and rejects credentialed
or private PostgreSQL URLs as well as other sensitive runtime artifacts.

If ownership, scope, or redaction cannot be proved, stop and preserve the
reported code; do not widen the command to another cluster.

### Deferred NP-08 hardening

The following items are deliberately deferred because they change a security
contract or require a separate rollout. They remain tracked follow-ups and are
not evidence that PR1's credential disclosure fix is incomplete.

| Follow-up                                                                                                                                              | Owner / scope                                    | Required completion evidence                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve HCC lineage through refresh/reissue without carrying `aud=host-context-controller` or `mcp:credential:read` on the longer-lived refresh token | Control API + HCC, separate auth-contract change | Issuance, refresh, reissue, expiry, and wrong-route negative tests; explicit rollout/rollback matrix; HCC accepts only the short-lived access credential.                               |
| Replace the anonymous global metadata inventory with an authenticated system principal for `mcp-proxy`, then retire the v1 route                       | HCC + gateway + mcp-proxy, PR2                   | A dedicated service identity and least-privilege route; no Host access; destination-bound grant/revision; proxy migration and v1 tombstone tests; both rendered and live policy proofs. |
| Add bounded rate limiting to unauthenticated diagnostic/metadata routes without breaking readiness, metrics, or the retained proxy compatibility lane  | HCC/gateway operations                           | Per-route load/availability tests, probe compatibility evidence, normalized 429 contract, and a rollback-safe gateway rollout.                                                          |

The first item is intentionally not a follow-up patch in PR1: changing refresh
claims changes token consumers and revocation semantics. The second is the
accepted PR2 residual: the current global response is metadata-only and must
not be described as a credential-disclosure path. The third is deferred rather
than guessed because an overly broad limiter could take down health probes or
the still-supported inventory consumer.
