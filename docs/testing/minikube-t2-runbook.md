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

## T0, T1, and T2 boundaries

* **T0** — shell syntax/ShellCheck where available, contract tests, affected
  package builds/typechecks, and `git diff --check`.
* **T1** — the Real PostgreSQL suites execute against the validated local
  `control-postgres`, except the role-reset suites which use an isolated
  Postgres 16; the lane reports `PASS`, `FAIL`, `SKIPPED`, and `NOT_RUN`
  separately and fails on an unavailable DSN, an isolated server that did not
  start, or zero executed tests. The JSON reporter is the suite verdict
  (expected files, executed/passed, zero failures, zero pending); a leftover
  Vitest process exit after a complete green reporter is not a failed suite.
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
