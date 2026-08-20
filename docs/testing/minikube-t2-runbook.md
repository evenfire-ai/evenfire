# Evenfire local Minikube T0/T1/T2 runbook

This runbook describes the public, reproducible development contract for the
Evenfire validation lanes. It deliberately contains no profile names, ports,
URLs, DSNs, credentials, customer data, or raw runtime logs.

## Scope and entry points

The contract is local-development-only. It requires a clean development
branch descended from the current `origin/dev`, a generated profile owned by
that worktree and `HEAD`, and an explicit Kubernetes context for that profile.
It refuses protected branches, production/GKE/Cloudflare contexts, shared
profiles, ambiguous ownership, and Kubernetes contexts whose cluster endpoint
does not resolve to a local Minikube address.

Run the read-only planner first. It is not T0, T1, or T2. Default
`T2_PLAN_MODE=false` fails loud on `full-bootstrap` and never calls
`pre-gate-sync`:

```bash
make minikube-t2-preflight MINIKUBE_PROFILE=<generated-profile>
```

The full orchestrator uses the same checks as a planner (`T2_PLAN_MODE=true`
so `full-bootstrap` is reachable), then performs the selected state
transition, T0, T1, and the exact-head T2 verdict (`T2_PLAN_MODE=false` and
the plan must be `already-synced`):

```bash
make minikube-t2 MINIKUBE_PROFILE=<generated-profile>
```

After T0 and T1 are already green on the same HEAD and owned profile, close
T2 without re-running those lanes:

```bash
make minikube-t2-runtime MINIKUBE_PROFILE=<generated-profile>
```

`make minikube-t2-runtime` is valid only when the pre-gate marker already
matches HEAD. `make minikube-pre-gate-sync` reconciles the profile; it does
not emit a T2 verdict.

The profile helper that generated the profile remains the source of truth for
the profile metadata and random localhost port mapping. Do not copy ports from
another worktree or use shared fixed ports.

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
same time. The lock record contains only local metadata and is removed by
success, failure, timeout, and interrupt traps. A live owner produces
`PROFILE_BUSY`; stale metadata may be reclaimed only after its recorded PID is
no longer running.

The pre-gate marker must contain the current worktree identifier, exact `HEAD`,
cluster fingerprint, and image coordinate. A mismatch stops with a stable
error code instead of allowing a mixed-commit run.

### Orphaned lock recovery

If `PROFILE_BUSY` reports that the lock has no valid owner PID, first verify
that no T2 process owns the profile. After that check, remove only the exact
profile lock directory and retry the same command:

```bash
rm -rf -- "$T2_LOCK_ROOT/<profile>.lock"
```

Never remove a lock with a live owner, and never remove the whole lock root.

## Preconditions and secrets

The runner checks required namespaces, Services, Secret names, ConfigMap names,
the `control-postgres` PVC/deployment, all required deployment readiness, the
image manifest/source, and real `kubectl port-forward` processes for this
profile. The conflict check is a loose argv pre-filter (`kubectl` as argv0 or
path token plus a later standalone `port-forward` token; flags may sit
between them) plus a `comm=kubectl` hardening and a PID allowlist.
Allowed port-forward PIDs live in
`$HOME/.cache/clerum/minikube-profiles/<profile>/pids/*.pid` (and the
legacy `/tmp/pf-<profile>-*.pid` files written by `pf-all-stack.sh`).
`make minikube-t2` invokes `pre-gate-sync` with `--skip-port-forwards` so the
orchestrator does not plant forwards that fail its own T2 check. Secret values
are never printed. The local Real PostgreSQL lane resolves the
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
new reader pod can start and the readiness wait can only time out.
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

* **T0** — shell syntax/ShellCheck where available, contract tests, affected
  package builds/typechecks, and `git diff --check`.
* **T1** — the Real PostgreSQL suites execute against the validated local
  `control-postgres`, except the role-reset suites which use an isolated
  Postgres 16; the lane reports `PASS`, `FAIL`, `SKIPPED`, and `NOT_RUN`
  separately and fails on an unavailable DSN, an isolated server that did not
  start, or zero executed tests. The JSON reporter must be complete and green
  (expected files, executed/passed, zero failures, zero pending), and the
  Vitest process must also exit zero; a green reporter cannot hide teardown,
  worker, OOM, or signal failure.
* **T2** — the final exact-head preflight inside `make minikube-t2` (or
  `make minikube-t2-runtime`): the marker matches this worktree/`HEAD`, the
  image manifest is current, PostgreSQL and required namespaces/Services are
  present, deployments are Ready, and no foreign `kubectl port-forward` owns
  this profile. User-facing health and Control UI/Desktop Playwright journeys
  are opt-in via `T2_HEALTHCHECK_COMMAND` / `T2_PLAYWRIGHT_COMMAND` and are
  recorded as separate evidence statuses (`NOT_RUN` by default;
  `T2_REQUIRE_PLAYWRIGHT=true` refuses a missing journey). Product E2E scripts
  such as `scripts/e2e/e2e-hcc-rollout-readiness.sh` are not T2.

CI, static tests, T1, T2, Playwright, and product E2E scripts are separate
evidence lanes. A green CI job or unit suite is not proof of T2 runtime
behavior. A `T2_PREFLIGHT_PASS` line from the planner is not a T2 verdict.

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
