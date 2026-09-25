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
- **Do not derive a new profile from the current HEAD.** Resolve the profile
  through the primary checkout helper. Worktree + branch own profile identity;
  the exact-head marker owns deployed freshness and `ports.env` is persistent.
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
- **Do not mutate the test runner's Git checkout.** Minikube contract fixtures
  that need a branch/HEAD must use the temporary-repository helper at
  `scripts/tests/lib/minikube-fixture-repo.sh`, set `T2_PROJECT_DIR` to that
  fixture, and prove the host checkout is unchanged. This is mandatory for
  detached-head CI runs; restoring a branch in `trap cleanup` is not isolation.
  Also do not edit tracked files in the live T2 worktree while
  `make minikube-t2` is running. Fixtures hash host `status --porcelain` at
  init (`minikube_test_assert_host_unchanged`) and fail with
  `fixture mutated the host checkout working tree`. Observed collateral:
  `test-minikube-build-section-headers.sh` then reports
  `build-images.sh: No such file or directory` (rc=127) because the temp
  fixture repo was removed. The orchestrator also fails closed on a dirty
  tree (`DEVELOPMENT_SCOPE_REQUIRED` / `worktree is dirty`). Finish the
  edit, commit or stash, then re-enter T2.
- **Do not run mutating `build-images.sh` or `pull-images.sh` directly.** Use
  the public Make target or T2 orchestrator so the exact
  worktree/profile/context lease is inherited. Only `--verify-only` is
  lease-exempt.
- **Do not use a remote/ambiguous Docker endpoint or inherit ambient registry
  auth.** The harness accepts local Unix sockets and loopback TCP endpoints,
  pins the resolved endpoint before isolation, and requires an explicit
  `MINIKUBE_DOCKER_AUTH_CONFIG` for private pulls.
- **Do not pack `kubectl` + `port-forward` + profile name into one wrapper
  argv** when avoidable. `t2_process_check` accepts only real `kubectl`
  processes (`comm=kubectl`) with exactly one complete structured ownership
  record in the profile cache; a lookalike wrapper or live legacy `/tmp`
  pidfile trips `PORT_FORWARD_CONFLICT`. The awk pre-filter matches `kubectl`
  as an argv0 or path token plus a later standalone `port-forward` token;
  wrappers that only mention those words are rejected by `comm`.
  Registered pidfiles are checked even when `ps` no longer lists a child,
  and a successful user-facing health probe is followed by an exact
  process/start-time/argv revalidation.
- **Do not commit** `.local-notes/`, lockfiles produced by an incidental
  `npm ci`, generated ports/profile metadata, or anything secret-like. Run
  `make minikube-t2-public-boundary` first.
- **Do not weaken fail-loud T1**: no green on unavailable DSN, zero executed
  tests, or silently skipped suites; the JSON reporter must be complete and
  green, must name the exact physical file set, and the Vitest process must
  also exit zero. Do not override its one-worker/no-file-parallelism contract.
  Role-reset suites stay on the throwaway `postgres:16-alpine` (#412), never
  shared `control-postgres`.
- **Do not treat a T1 `next:` line as a Docker repair license.**
  `REAL_PG_REQUIRED_BUT_UNAVAILABLE` (isolated `postgres:16-alpine` not
  reachable) still means re-enter `make minikube-t2` or
  `make minikube-t2-real-postgres` on the owned profile. Forbidden:
  `docker run` probes, `docker desktop restart` (destroys the Minikube
  container and the owned profile), published-port experiments, and any
  invented networking path between plan and verdict.
- **Do not treat `sh: vitest: command not found` / `minikube-pre-gate-sync`
  Error 127 as GFS, `PROFILE_UNHEALTHY`, or a product bug.** Planner PASS
  plus Ready deployments only prove the cluster. `pre-gate-sync`
  `run_if_changed` then runs **host** `npm test` in the changed package.
  `LOCAL_DEPENDENCY_MISSING` / `[real-pg-preflight] PASS packages=2` only
  checked `control-api` and `gfs-controller`. Install every remaining
  pre-gate package before re-entering T2; installing only the failing
  directory dies on the next `run_if_changed`.
- **Do not let NP08 refresh or reissue the Host lineage.** It may observe a
  fresher persisted access token only when its Host/recipe binding exactly
  matches the mounted token. Refresh tokens remain owned by mcp-host.

## Host npm vs cluster Ready (observed 2026-09-25)

`[real-pg-preflight] PASS node=24 workers=1 packages=2` is **not** a host-runner
certificate for `pre-gate-sync`. `scripts/e2e/real-postgres-local-preflight.sh`
only requires executable `node_modules/.bin/vitest` plus resolvable `vitest`
and `pg` in `control-api` and `gfs-controller`.

After planner PASS, image inventory OK, and every required Deployment Ready,
`pre-gate-sync` `run_if_changed` still runs **host** `npm test` in each changed
directory (`scripts/minikube/pre-gate-sync.sh`):

- `packages/workflow-runtime-core` (`npm test && npm run build`)
- `packages/network-policy-core` (`node --test`, not vitest)
- `control-api`
- `external-rest-api`
- `rpc-proxy`
- `mcp-host`
- `host-context-controller`
- `workflow-recipes`
- `packages/workflow-sdk`
- `workflow-approval-request-reader`
- `control-ui`
- `desktop-app` (Node 24 + `npm run verify:electron`; do not `--ignore-scripts`)

`gfs-controller` is **not** on this list. Observed aborts: `external-rest-api`
then `rpc-proxy` (`sh: vitest: command not found` →
`make[1]: *** [minikube-pre-gate-sync] Error 127` →
`make: *** [minikube-t2] Error 2`). That signature has **no** T2 stable code
and no `next:` line. Cluster Ready ≠ host runner.

Repair on the same HEAD and owned profile: `npm ci` in the named directory
**and every remaining** package that lacks `node_modules/.bin/vitest`.
Installing only the failing package dies on the next `run_if_changed`. Then
re-enter `make minikube-t2`. T1 has not run if this abort is after bootstrap.
Forbidden: new profile, PVC reset, `docker desktop restart`, `docker run`
probes, treating Error 127 as GFS/`PROFILE_UNHEALTHY`.

`PROFILE_METADATA_MISSING` (unreadable `profile.env` / ports) is raised as
`PROFILE_OWNERSHIP_MISMATCH`. Resolve or generate metadata via the primary
checkout `branch.mk` (`branch-profile-start`). Never invent ports or
`ls`/`cat` `~/.cache/clerum/minikube-profiles/`.

## Stable failure codes

| Code | Meaning | Safe next step |
| --- | --- | --- |
| `LOCAL_DEPENDENCY_MISSING` | Node/package-local dependencies, Python, Docker, kubectl, Minikube, or another required local tool is unavailable. T1 preflight (`packages=2`) only checks `control-api` and `gfs-controller` for host `vitest`+`pg`. | Repair the named local prerequisite (`npm ci` in that package). Then `npm ci` every remaining pre-gate package in the Host npm section before re-entering T2. The preflight never auto-installs and never covers `external-rest-api` / `rpc-proxy` / `mcp-host` / … |
| `minikube-pre-gate-sync` Error 127 / `sh: vitest: command not found` | Host `npm test` in a `run_if_changed` package after planner PASS and Ready deployments. **Not** a T2 stable code. | `npm ci` the named dir **and every remaining** pre-gate package, then `make minikube-t2` on the same HEAD/profile. Not GFS, not a new profile. |
| `UNSUPPORTED_T1_CONCURRENCY` | A caller attempted more than one T1 worker. | Remove the override or set `VITEST_MAX_WORKERS=1`; T1 role/fixture mutation is serial by contract. |
| `PROFILE_OWNERSHIP_MISMATCH` | Profile metadata, context, worktree, or branch does not match this lane. Includes wrapped `PROFILE_METADATA_MISSING` (unreadable `profile.env` / ports). | Resolve through the primary-checkout `branch.mk` helper (`branch-profile-start` when metadata is missing). Never invent ports, adopt a foreign profile, or `ls`/`cat` `~/.cache/clerum/minikube-profiles/`. |
| `PROFILE_LOCK_REQUIRED` | A mutating child did not inherit the exact parent lease. | Invoke the public Make target/orchestrator; do not fabricate or bypass its lock token. |
| `DOCKER_ENDPOINT_REQUIRED` / `DOCKER_ENDPOINT_UNSAFE` / `DOCKER_ENDPOINT_MISMATCH` | Docker did not resolve exactly one approved local endpoint, or isolation selected a different endpoint. | Select a local Docker Desktop/rootless context or set an explicit local `DOCKER_HOST`; do not weaken the endpoint check. |
| `DOCKER_CONFIG_REQUIRED` / `REGISTRY_AUTH_REQUIRED` | A Docker operation lacks its empty task-local config, or a private pull lacks an explicit readable auth config. | Use the canonical Make/orchestrator path; for a genuinely private source, pass only the intended config directory through `MINIKUBE_DOCKER_AUTH_CONFIG`. |
| `MINIKUBE_PULL_CONFIG_INVALID` | Published-image pull parallelism, retry count, or retry delay is outside its finite range. | Correct the override (`parallelism 1-64`, retries 1-10, delay 0-300 seconds); never disable the bound. |
| `DOCKER_ENV_UNRESOLVED` | Minikube returned no usable Docker environment, including a successful empty response. | Repair the profile/runtime endpoint and retry the same owned Make target; no image pull may proceed. |
| `DOCKER_DEADLINE_INVALID` | A runtime deadline/retry value is malformed or exceeds its finite maximum. | Remove the override or set it within the documented range; do not disable the deadline. |
| `BOOTSTRAP_REQUIRED` | Profile missing/uninitialized, or the planner produced no transition. Standalone preflight refuses to bootstrap. | Run `MINIKUBE_PROFILE=<owned> CONTROL_API_REAL_PG_CONTEXT=<owned> make minikube-t2`; its internal planner makes `full-bootstrap` reachable. |
| `HEAD_MARKER_MISMATCH` | Pre-gate marker does not match this worktree/HEAD; the final T2 preflight selected something other than `already-synced`. | Re-run the full target on this HEAD so `pre-gate-sync` updates the marker. Never hand-edit the marker. |
| `IMAGE_MANIFEST_MISMATCH` | Deployed image provenance or the manifest `generated` stamp does not match the exact marker/worktree state. | Re-run the full target for the same owned profile; do not relabel or hand-edit the manifest. |
| `PORT_FORWARD_CONFLICT` | A port-forward for this profile is owned by a process not recorded for it (or not a real `kubectl`). | Identify the foreign owner; if it belongs to another lane, stop. Do not kill this lane's `branch-profile-pf`. Restore UI PFs with `make -f .local-notes/minikube-profiles/branch.mk branch-profile-pf`. |
| `PROFILE_BUSY` | Profile lock held. Live owner PID → genuinely busy. No valid owner PID → orphaned lock. | Live owner: wait or coordinate; never remove. Orphan: verify no T2 process owns the profile, then remove ONLY `$T2_LOCK_ROOT/<profile>.lock` and retry. Never remove the lock root. |
| `DEVELOPMENT_SCOPE_REQUIRED` | Preflight/final preflight failed a precondition, T2-only mode was attempted without `already-synced`, or the worktree is dirty (`worktree is dirty`). | Repair the first reported condition. If dirty: commit or stash, do not edit during the run, then re-enter T2. If T2-only was refused, run full `make minikube-t2`. |
| `CERTIFICATION_REQUIRED` | Runtime-only was requested without valid exact-head T0/T1 evidence for the full ownership tuple. | Run the full target once; do not hand-create or copy evidence. |
| `SECRET_MISSING` / `CONFIGMAP_MISSING` | A required named runtime input is absent or unreadable. | Reconcile the same owned profile through the full target; never invent values. |
| `ZERO_TESTS_EXECUTED` | A lane was configured off or executed nothing (including a required-but-missing Playwright journey). | Re-run with the lane enabled, or supply the required `T2_PLAYWRIGHT_COMMAND`. |
| `REAL_PG_REQUIRED_BUT_UNAVAILABLE` | The explicit context, isolated PostgreSQL, DSN route, or exact-head database precondition is unavailable. | Re-enter `make minikube-t2` or `make minikube-t2-real-postgres` on the owned profile. Do not `docker run`, restart Docker Desktop, or probe published ports. |
| `REAL_PG_REPORT_INCOMPLETE` | Vitest JSON did not prove the exact expected physical files. | Repair test selection/reporter output; do not accept suite counters as file identity. |
| `REAL_PG_SUITE_FAILED` | Reporter, test assertions, process exit, or parent result contract failed. | Iterate with standalone T1; once green, run full T2 for final exact-head lane evidence. |
| `POSTGRES_NOT_READY` | PostgreSQL precondition failed, or a PVC reset was requested without the exact expected UID. | Fix DB readiness; never guess a PVC UID. |
| `PROFILE_UNHEALTHY` | A required deployment is unready in a fail-loud check (`T2_PLAN_MODE=false`: standalone preflight or the final exact-head T2), the mandatory targeted-sync health command is missing, or a supplied user-facing health command failed or timed out. The orchestrator planner never emits this merely for an unready deployment — it selects `full-reconcile` instead. | For a targeted sync, supply the affected service's profile-owned `T2_HEALTHCHECK_COMMAND`; otherwise repair the reported health failure. Re-run on the same HEAD and profile. Do not run manual repair scripts between runs. |
| `NP08_HCC_AUTHORIZATION_FAILED` | The deployed Host-to-HCC authorization journey or cleanup failed after T0/T1 passed. | Repair the first NP08 failure, then use `minikube-t2-runtime` on the exact same profile/HEAD; never refresh/reissue in the test. |
| `PLAYWRIGHT_FAILED` | The opt-in user-visible journey failed after runtime and lane evidence passed. | Repair the journey and retry with `minikube-t2-runtime` on the same exact tuple. |

## Stale-lock reclaim layout

The active profile lock is `$T2_LOCK_ROOT/<profile>.lock`. The atomic stale
reclaim claim is its sibling `$T2_LOCK_ROOT/<profile>.reclaim`, never a child of
the active lock. A reclaimer terminated abruptly may leave that sibling
directory, so it is intentionally fail-closed rather than silently adopted.

Before manual recovery, verify all of the following:

- the recorded lock owner PID is not alive;
- no stale-lock reclaimer process is alive;
- no other session is mutating the profile.

After those checks, operate only on the two exact paths. Prefer `rmdir` for the
empty claim:

```bash
rmdir -- "$T2_LOCK_ROOT/<profile>.reclaim"
rm -rf -- "$T2_LOCK_ROOT/<profile>.lock"
```

If only the claim exists, run only the `rmdir`; if only the lock exists, run
only the `rm -rf`. Never remove either path with a live owner/reclaimer and
never remove all of `T2_LOCK_ROOT`.

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
gfsReconciler now preserves the `restartedAt` annotation. Every harness GFS
reconcile still runs with the `scripts/minikube/gfs-rollout-shim` PATH prefix:
the reader `rollout status` wait is replaced by the readiness poll in
`scripts/minikube/wait-gfs-reader-ready.sh` so leftover ReplicaSets cannot
turn a generation wait into a timeout. `full-setup.sh` and `pre-gate-sync` also
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
