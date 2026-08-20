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

Run the read-only preflight first:

```bash
make minikube-t2-preflight MINIKUBE_PROFILE=<generated-profile>
```

The full T2 orchestrator uses the same checks and then performs the selected
state transition:

```bash
make minikube-t2 MINIKUBE_PROFILE=<generated-profile>
```

The profile helper that generated the profile remains the source of truth for
the profile metadata and random localhost port mapping. Do not copy ports from
another worktree or use shared fixed ports.

## State transitions

### Bootstrap

A missing or uninitialized profile has no trusted pre-gate marker, image
manifest, or ready PostgreSQL state. The runner reports `BOOTSTRAP_REQUIRED`
and, when invoked through `make minikube-t2`, runs the supported full setup.
Bootstrap orders Secret/ConfigMap validation, PostgreSQL readiness, migrations
and roles, and only then `pre-gate-sync`. It does not delete a PVC by default.

### Targeted sync

An already healthy profile may use a targeted image/deployment update only when
the marker exactly matches the worktree path and `HEAD`, the image acquisition
manifest is current, and the diff is limited to a known service source change.
The affected deployment must become Ready and its user-facing health check must
pass. This is recorded as a targeted T2, not as a full reconcile.

### Full reconcile

Changes to CRDs, manifests, charts, NetworkPolicies, PVC/storage definitions,
the Minikube overlay, or other infrastructure inputs require a full reconcile.
The runner refuses to downgrade those changes to a service-only restart.

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

After bootstrap or reconcile, `make minikube-t2` calls `pre-gate-sync` with
`--skip-port-forwards`. T1 opens its own `control-postgres` port-forward and
does not inherit Control UI stack forwards. `t2_process_check` accepts only
real `kubectl` port-forward PIDs recorded in the profile cache or legacy
`/tmp/pf-<profile>-*.pid`.

## Preconditions and secrets

The runner checks required namespaces, Services, Secret names, ConfigMap names,
the `control-postgres` PVC/deployment, all required deployment readiness, the
image manifest/source, and profile-owned port-forward processes. Secret values
are never printed. The local Real PostgreSQL lane resolves the
`control-postgres` Secret using the explicit context, constructs its admin DSN
only in process memory, and passes it only to the test process. CI continues to
use `CONTROL_API_REAL_PG_ADMIN_URL` unchanged.

## T0, T1, and T2 boundaries

* **T0** — shell syntax/ShellCheck where available, contract tests, affected
  package builds/typechecks, and `git diff --check`.
* **T1** — the Real PostgreSQL suites execute against the validated local
  `control-postgres`; the lane reports `PASS`, `FAIL`, `SKIPPED`, and `NOT_RUN`
  separately and fails on an unavailable DSN or zero executed tests.
* **T2** — the exact worktree/`HEAD` is deployed to the owned profile, the
  cluster is healthy, readiness and health checks pass, and applicable
  Control UI/Desktop journeys are run through their user-visible paths.

CI, static tests, T1, T2, and Playwright are separate evidence lanes. A green
CI job or unit suite is not proof of T2 runtime behavior.

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
