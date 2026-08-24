# Minikube T0/T1/T2 reference — anti-patterns, codes, recovery

Companion to `SKILL.md`. Source of truth: `scripts/minikube/t2.sh`,
`scripts/minikube/t2-preflight.sh`, `scripts/minikube/t2-common.sh`, and
`docs/testing/minikube-t2-runbook.md`.

## HARD DENY anti-patterns (these burned real sessions)

- **Do not treat `T2_PREFLIGHT_PASS` as T2.** The standalone planner is not a
  lane. Only `MINIKUBE_T2_PASS` from `make minikube-t2` /
  `make minikube-t2-runtime` is a T2 verdict.
- **Do not call `scripts/e2e/e2e-hcc-rollout-readiness.sh` "T2".** It is a
  product E2E lane (e.g. issue #391 readiness), a separate evidence lane.
- **Do not re-run full `make minikube-t2` to "close T2"** when T0 and T1 are
  already green on the same HEAD — use `make minikube-t2-runtime`.
- **Do not `ls`/`cat` `~/.cache/clerum/minikube-profiles/`.** Private profile
  state (ports, pids, markers). The harness is the only reader.
- **Do not hunt for UI port-forwards.** First-hand hold:
  `MINIKUBE_PROFILE=<owned-profile> make -f .local-notes/minikube-profiles/branch.mk branch-profile-pf`
  (implementation `branch-profile.sh` beside it). Run on the host, not a
  sandboxed agent shell. `make minikube-pf-all-bg` is a gate refresh only.
  `branch-profile-pf-health` stops PFs on EXIT. Never shared `:3000`/`:8090`.
- **Do not invent `ADMIN_PASSWORD`** or any credential. When a product E2E
  needs it, load it from the primary checkout `.env`; never echo it.
- **Do not reset PVCs** outside the explicit `T2_RESET_PVC=true` +
  `T2_EXPECTED_PVC_UID=<exact uid>` development path, and **do not use shared
  fixed localhost ports** — only the profile-owned random port mapping.
- **Do not touch another worktree's Minikube profile** (e.g. an NP-08 lane
  profile) or kill its port-forwards, even if it looks idle.
- **Do not pack `kubectl` + `port-forward` + profile name into one wrapper
  argv** when avoidable. `t2_process_check` accepts only real `kubectl`
  processes (`comm=kubectl`) whose PIDs are recorded in the profile cache or
  legacy `/tmp/pf-<profile>-*.pid`; a lookalike wrapper trips
  `PORT_FORWARD_CONFLICT`. The awk pre-filter matches `kubectl` as an argv0
  or path token plus a later standalone `port-forward` token; wrappers that
  only mention those words are rejected by `comm`.
- **Do not commit** `.local-notes/`, lockfiles produced by an incidental
  `npm ci`, generated ports/profile metadata, or anything secret-like. Run
  `make minikube-t2-public-boundary` first.
- **Do not weaken fail-loud T1**: no green on unavailable DSN, zero executed
  tests, or silently skipped suites; the JSON reporter must be complete and
  green, and the Vitest process must also exit zero.
  Role-reset suites stay on the throwaway `postgres:16-alpine` (#412), never
  shared `control-postgres`.
- **Do not treat a T1 `next:` line as a Docker repair license.**
  `REAL_PG_REQUIRED_BUT_UNAVAILABLE` (isolated `postgres:16-alpine` not
  reachable) still means re-enter `make minikube-t2` or
  `make minikube-t2-real-postgres` on the owned profile. Forbidden:
  `docker run` probes, `docker desktop restart` (destroys the Minikube
  container and the owned profile), published-port experiments, and any
  invented networking path between plan and verdict.

## Stable failure codes

| Code | Meaning | Safe next step |
| --- | --- | --- |
| `BOOTSTRAP_REQUIRED` | Profile missing/uninitialized, or the planner produced no transition. Standalone preflight refuses to bootstrap. | Run `make minikube-t2` — its internal planner (`T2_PLAN_MODE=true`) makes `full-bootstrap` reachable and runs the supported setup with `IMAGE_SOURCE=local`. |
| `HEAD_MARKER_MISMATCH` | Pre-gate marker does not match this worktree/HEAD; the final T2 preflight selected something other than `already-synced`. | Re-run `make minikube-t2` on this HEAD so `pre-gate-sync` updates the marker. Never hand-edit the marker. |
| `PORT_FORWARD_CONFLICT` | A port-forward for this profile is owned by a process not recorded for it (or not a real `kubectl`). | Identify the foreign owner; if it belongs to another lane, stop. Do not kill this lane's `branch-profile-pf`. Restore UI PFs with `make -f .local-notes/minikube-profiles/branch.mk branch-profile-pf`. |
| `PROFILE_BUSY` | Profile lock held. Live owner PID → genuinely busy. No valid owner PID → orphaned lock. | Live owner: wait or coordinate; never remove. Orphan: verify no T2 process owns the profile, then remove ONLY `$T2_LOCK_ROOT/<profile>.lock` and retry. Never remove the lock root. |
| `DEVELOPMENT_SCOPE_REQUIRED` | Preflight/final preflight failed a precondition, or T2-only mode was attempted without `already-synced`. | Repair the first reported condition; if T2-only was refused, run full `make minikube-t2`. |
| `ZERO_TESTS_EXECUTED` | A lane was configured off or executed nothing (including a required-but-missing Playwright journey). | Re-run with the lane enabled, or supply the required `T2_PLAYWRIGHT_COMMAND`. |
| `POSTGRES_NOT_READY` | PostgreSQL precondition failed, or a PVC reset was requested without the exact expected UID. | Fix DB readiness; never guess a PVC UID. |
| `REAL_PG_REQUIRED_BUT_UNAVAILABLE` | Isolated T1 `postgres:16-alpine` (or the shared-lane DSN/port-forward) did not become reachable. | Confirm Docker Desktop is up, then re-run `make minikube-t2` or `make minikube-t2-real-postgres` on the owned profile. Do not `docker run`, restart Docker Desktop, or probe published ports. |
| `PROFILE_UNHEALTHY` | A required deployment is unready in a fail-loud check (`T2_PLAN_MODE=false`: standalone preflight or the final exact-head T2), or the opt-in user-facing health command failed. The orchestrator planner never emits this for an unready deployment — it selects `full-reconcile` instead. | Re-run `make minikube-t2` on the same HEAD; the single run reconciles and restores GFS credentials itself. Do not run manual repair scripts between runs. |

## GFS restore pointers (high level, no secrets)

GFS T1 real-Postgres coverage has its own gate
(`make test-gfs-real-postgres-minikube`) against the validated branch-owned
profile. Restore/DSN provisioning for `gfs` is ordered by full-setup /
`pre-gate-sync` (it stays fail-closed until `control-api` is Ready — see the
`minikube-deploy-all` note in the Makefile). Do not hand-provision GFS DSNs,
and never copy DSNs or credentials between namespaces or into evidence.

The harness owns NOLOGIN recovery and abandoned-rollout resume: T1 restores
branch-profile GFS credentials on exit, and `pre-gate-sync` provisions
serving with `GFS_RESTORE_ACTIVE_NOLOGIN=true` and
`GFS_RECOVER_ABANDONED_STATE=true` only in the `minikube-t2` transition.
Other security gates refresh MCP auth with `--skip-gfs` and do not mutate GFS.
The T2 path restarts an unready `gfsc-reader` after restore. A Ready leftover `rollout-running` claim is
settled by `scripts/minikube/settle-gfs-reader-rollout.sh` before
reconcile: it marks the claim ready, scales leftover non-current unready
reader ReplicaSets to 0, and deletes CrashLoopBackOff reader pods so they
re-read the restored Secret without waiting out kubelet backoff. HCC's
gfsReconciler strips the `restartedAt` annotation, so every harness GFS
reconcile runs with the `scripts/minikube/gfs-rollout-shim` PATH prefix:
the reader `rollout status` wait is replaced by the readiness poll in
`scripts/minikube/wait-gfs-reader-ready.sh` instead of chasing the template
generation HCC keeps rewriting. `full-setup.sh` and `pre-gate-sync` also
re-run `sync-auth-key.sh` before each GFS reconcile because the overlay
re-applies `gfs-config.jwt-public-key` empty and a reader pod fails closed
without it. Do not run
`reconcile-gfs-deploy-credentials.sh` or `kubectl rollout restart
deploy/gfsc-reader` by hand as a T2-repair step — re-run the entry point.

## Dual-repo note

This contract belongs to `evenfire-ai/evenfire` only. `evenfire-infra` is a
different repository with different clusters and PR flow. Never point this
harness at an infra cluster, mix PRs across the repos, or present infra
evidence as an evenfire T2 verdict (and vice versa).
