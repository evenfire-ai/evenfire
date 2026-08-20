# Minikube T0/T1/T2 reference — anti-patterns, codes, recovery

Companion to `SKILL.md`. Source of truth: `scripts/minikube/t2.sh`,
`scripts/minikube/t2-preflight.sh`, `scripts/minikube/t2-common.sh`,
`scripts/e2e/minikube-real-postgres.sh`, and
`docs/testing/minikube-t2-runbook.md`.

## HARD DENY anti-patterns (these burned real sessions)

- **Do not treat `T2_PREFLIGHT_PASS` as T2.** The standalone planner is not a
  lane. Only `MINIKUBE_T2_PASS` from `make minikube-t2` /
  `make minikube-t2-runtime` is a T2 verdict.
- **Do not call `scripts/e2e/e2e-hcc-rollout-readiness.sh` "T2".** It is a
  product E2E lane, a separate evidence lane.
- **Do not re-run full `make minikube-t2` to "close T2"** when T0 and T1 are
  already green on the same HEAD **and** the Makefile has
  `minikube-t2-runtime` — use that target. If the Makefile has no
  `minikube-t2-runtime`, closing T2 is still `make minikube-t2`; expect
  `full-reconcile` when `scripts/e2e/*` differs from `origin/dev`.
- **Do not `ls`/`cat` `~/.cache/clerum/minikube-profiles/`.** Private profile
  state (ports, pids, markers). The harness is the only reader.
- **Do not invent `ADMIN_PASSWORD`** or any credential. When a product E2E
  needs it, load it from the primary checkout `.env`; never echo it.
- **Do not reset PVCs** outside the explicit `T2_RESET_PVC=true` +
  `T2_EXPECTED_PVC_UID=<exact uid>` development path, and **do not use shared
  fixed localhost ports** — only the profile-owned random port mapping.
- **Do not touch another worktree's Minikube profile** or kill its
  port-forwards, even if it looks idle.
- **Do not pack `kubectl` + `port-forward` + profile name into one wrapper
  argv** when avoidable. `t2_process_check` accepts only real `kubectl`
  processes (`comm=kubectl`) whose PIDs are recorded in the profile cache or
  legacy `/tmp/pf-<profile>-*.pid`; a lookalike wrapper trips
  `PORT_FORWARD_CONFLICT`.
- **Do not commit** `.local-notes/`, lockfiles produced by an incidental
  `npm ci`, generated ports/profile metadata, or anything secret-like. Run
  `make minikube-t2-public-boundary` first.
- **Do not weaken fail-loud T1**: no green on unavailable DSN, zero executed
  tests, or silently skipped suites; the JSON reporter is the suite verdict,
  not a leftover Vitest process exit after a complete green reporter.
  Role-reset suites stay on the throwaway `postgres:16-alpine`, never shared
  `control-postgres`.
- **Do not pass global `ARGS='--skip-port-forwards'` into `make minikube-t2`.**
  That kills the profile UI port-forwards. Inner `pre-gate-sync` may use
  `GATE=minikube-t2 ARGS='--skip-port-forwards'`. Hold UI PFs in a dedicated
  `branch-profile-pf` session.
- **Do not treat host `npm test` failures as cluster CrashLoops.** T1 and
  `pre-gate-sync` run Vitest in the **worktree package directory**, not inside
  a Deployment.

## Stable failure codes

| Code | Meaning | Safe next step |
| --- | --- | --- |
| `BOOTSTRAP_REQUIRED` | Profile missing/uninitialized, or the planner produced no transition. Standalone preflight refuses to bootstrap. | Run `make minikube-t2` — its internal planner (`T2_PLAN_MODE=true`) makes `full-bootstrap` reachable and runs the supported setup with `IMAGE_SOURCE=local`. |
| `HEAD_MARKER_MISMATCH` | Pre-gate marker does not match this worktree/HEAD; the final T2 preflight selected something other than `already-synced`. | Re-run `make minikube-t2` on this HEAD so `pre-gate-sync` updates the marker. Never hand-edit the marker. |
| `PORT_FORWARD_CONFLICT` | A `kubectl port-forward` argv mentions this profile/context, but its PID is not in `$T2_PROFILE_ROOT/<profile>/pids/*.pid` or `/tmp/pf-<profile>-*.pid`. After a green T1 this is often the leftover `control-postgres` forward (or a `kubectl` child that survived T1 cleanup), not another worktree. Held `branch-profile-pf` UI forwards are this worktree — do not kill them as "foreign". | If the owner is this worktree's T1 Postgres forward: T1 must write `/tmp/pf-<profile>-t1-control-postgres.pid` and reap orphans on exit. If it is another lane, stop. Do not create a new profile. Then re-run T2 on the same HEAD. |
| `PROFILE_BUSY` | Profile lock held. Live owner PID → genuinely busy. No valid owner PID → orphaned lock. | Live owner: wait or coordinate; never remove. Orphan: verify no T2 process owns the profile, then remove ONLY `$T2_LOCK_ROOT/<profile>.lock` and retry. Never remove the lock root. |
| `DEVELOPMENT_SCOPE_REQUIRED` | Preflight/final preflight failed a precondition, or T2-only mode was attempted without `already-synced`. | Repair the first reported condition; if T2-only was refused, run full `make minikube-t2`. |
| `ZERO_TESTS_EXECUTED` | A lane was configured off or executed nothing (including a required-but-missing Playwright journey). | Re-run with the lane enabled, or supply the required `T2_PLAYWRIGHT_COMMAND`. |
| `POSTGRES_NOT_READY` | PostgreSQL precondition failed, or a PVC reset was requested without the exact expected UID. | Fix DB readiness; never guess a PVC UID. |
| `PROFILE_UNHEALTHY` | A required deployment is unready in a fail-loud check (`T2_PLAN_MODE=false`: standalone preflight or the final exact-head T2), or the opt-in user-facing health command failed. The orchestrator planner never emits this for an unready deployment — it selects `full-reconcile` instead. | If the unready names are `gfs/gfsc-writer` and/or `gfs/gfsc-reader`, see catalog item **GFS leftover**. Never a new profile or PVC reset. |
| `REAL_PG_SUITE_FAILED` | An isolated T1 file returned non-green JSON, zero tests, or failed to start. The path in the message is the **host test file**, not a Deployment. | Read the first failing file's cause in this catalog (`vitest` missing, hookTimeout, pool leak) before touching the cluster. |

## Observed failure catalog (explain before "fixing" the cluster)

These recurred on the Codex-subscription Minikube lane. Same signature later
is the **same class**, not a new product bug. Repair the first matching item.
Do not create a profile, reset a PVC, skip T1, raise `max_connections`, or
blame Codex SQL / migrations `00a0–00a3`.

### 1. `sh: vitest: command not found`

**Where it appears:** `pre-gate-sync` `run_if_changed <pkg> "npm test"` (seen
on `external-rest-api`), or T1 `npm test` in `gfs-controller/` /
`control-api/`.

**Cause:** T1 and pre-gate unit tests run on the **host** via `package.json`
`"test": "vitest run"`. npm only puts `vitest` on PATH when that package's
`node_modules/.bin` exists. Missing `npm ci` in **that directory** → exit 127.
This is the same class as Desktop `verify:electron`: install incomplete, not
a product failure.

**Not this:** GFS Deployment CrashLoop, Codex OAuth, a bad DSN, or
`REAL_PG_SUITE_FAILED` meaning the in-cluster `gfs-controller` image. The
suite name (`subjectResolver.realPostgres…`) is the file that never started.

**Recovery:** `test -x <pkg>/node_modules/.bin/vitest` or `npm ci` in that
package directory only. Do not rebuild images or restore GFS for this. It
"comes back" whenever another package is selected by `run_if_changed` without
deps, or `node_modules` was deleted — not because the earlier diagnosis was
wrong.

**Never:** `kubectl` debug of `gfsc-writer` for this string; installing
vitest globally; treating a later T2 log that does **not** contain this
string as a recurrence.

### 2. `too many clients already` → dead Postgres port-forward

**Cause:** One Vitest process with `fileParallelism: false` still gives each
file its own module registry. Each Real PostgreSQL file re-instantiates
`control-api/src/db.ts` (`createCorePool()`, ~max 10) and never closes the
singleton. ~25 shared files exhaust live `control-postgres` `max_connections`.
Typical first blow-up: `gfsReadiness` `CREATE DATABASE`. Then the local
port-forward dies (`ECONNREFUSED`) and the GFS DSN probe refuses.

**Not this:** Codex SQL, migration order (`0099` < `00a0–00a3` <
`0100_seed_minimax_allowed_model`), or CI (CI uses empty throwaway PG16 and
does not see this).

**Recovery / prevention:** T1 runs **one Vitest process per file** (same
pattern as `gfs-real-pg-minikube-gate.sh`) against live `control-postgres`.
Role-reset suites (`db.realPostgresMigration`, `gfsReaderRole`) stay on
throwaway `postgres:16-alpine`. Port-forward retry reuses the same
`LOCAL_PORT` so the DSN stays valid. `ensure_control_postgres_forward`
between files.

**Rejected "fixes":** skip T1; run all suites on throwaway PG; raise
`max_connections`; PVC reset; require `pool.end()` in every `afterAll`
(cannot close the `src/db.ts` singleton from tests).

### 3. Leftover Vitest exit after a green JSON reporter

**Cause:** After a green `--reporter=json`, a leftover pool hits `DROP
DATABASE` / SQLSTATE `57P01` and Vitest's process exit is non-zero.

**Rule:** the JSON reporter is the suite verdict. Ignore leftover process
exit when JSON is complete and green (`leftover Vitest exit after green JSON
reporter`). Zero tests or skips in JSON remain FAIL.

### 4. `hookTimeout` on `CREATE DATABASE` (gfs-controller T1)

**Signature:** `gfs-controller/src/db/renamePublication.realPostgres.integration.test.ts`
`beforeAll` `CREATE DATABASE` exceeds `hookTimeout` (60s when
`CONTROL_API_REAL_PG_ADMIN_URL` is set); remaining tests skipped →
`REAL_PG_SUITE_FAILED`.

**Cause:** Postgres was overloaded, usually right after `full-reconcile`
(all-image build + restart of ~9 deployments). `control-postgres` liveness
is `pg_isready` with a **1s** timeout; under load it restarts. `control-api`
then CrashLoops (`Connection terminated due to connection timeout`).
`CREATE DATABASE` from T1 waits out the hook.

**Not this:** a logic bug in `renamePublication` or missing `vitest` (that
fails in milliseconds with `command not found`).

**Recovery:** wait until `control-postgres` **and** `control-api` are Ready
on the owned profile. Restore GFS only after that (item 5). Re-run **T1
only** (`make minikube-t2-real-postgres`) before another full `make
minikube-t2`. Do not start restore or T2 while `control-api` is 0/1.

### 5. `gfs/gfs-controller-db authentication probe unavailable`

**Cause:** The probe is `kubectl exec` into **Ready `control-api`**, not into
Postgres and not into `gfsc-writer`. If `control-api` is CrashLoop, restore
**must refuse** (fail-closed). A prior item-2 or item-4 outage leaves
`gfsc-writer` CrashLoopBackOff and `gfsc-reader` 0/0.

**Recovery (same profile, after postgres + control-api Ready):**

```bash
GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true \
CONTEXT=<owned-profile> \
bash deploy/scripts/reconcile-gfs-deploy-credentials.sh
kubectl --context=<owned-profile> -n gfs rollout status deployment/gfsc-writer --timeout=180s
kubectl --context=<owned-profile> -n gfs rollout status deployment/gfsc-reader --timeout=180s
```

Wait **both** writer and reader 1/1. Do not hand-run this while control-api
is 0/1.

### 6. `Pre-gate cluster sync complete` while GFS is down

**Cause:** In this worktree `provision_gfs_serving` runs only when
`incremental_requires_database_reconcile` is true. A scripts-only sync
(`images=none`) skips GFS restore and can still print success. Standalone /
final preflight uses `T2_PLAN_MODE=false`, so unready `gfsc-writer` /
`gfsc-reader` become `PROFILE_UNHEALTHY` instead of planner `full-reconcile`.

**Not this:** proof that GFS is Ready. Confirm with
`kubectl --context=<profile> -n gfs get deploy gfsc-writer gfsc-reader`.

**Recovery:** item 5 on the same profile, then `make minikube-t2`. Optional
harness follow-up (separate commit): always call `provision_gfs_serving` in
`pre-gate-sync.sh`; orchestrator planner already uses `T2_PLAN_MODE=true`.

### 7. `rollout status` exit 0 while Ready is 0/1

**Cause:** A wrapper continued after restore failed because the shell lacked
`set -e`, or a previous ReplicaSet reported success while the live deploy
was still 0/1.

**Rule:** the Ready column on `gfsc-writer`, `gfsc-reader`, `control-api`,
and `control-postgres` is the truth, not the previous command's exit code.

### 8. Eternal `full-reconcile` after a T1-harness change

**Cause:** Diff vs `origin/dev` under `scripts/e2e/*` (isolated T1 processes,
contract greps) is classified as infrastructure. Some worktrees' Makefile
**has no** `minikube-t2-runtime`. Then every `make minikube-t2` rebuilds all
images and restarts deployments even when T1 just passed on this HEAD — which
re-triggers item 4.

**Rule:** that classification is correct; do not downgrade infra to
`targeted-sync`. After a green standalone T1, still run `make minikube-t2` to
close T2, but expect image rebuild. Docker cache may make builds `DONE 0.0s`;
the rollout restart is still the load spike. Do not skip T1 inside that
orchestrator run unless the Makefile supports certified `minikube-t2-runtime`
and the marker is `already-synced` on this HEAD.

### 9. Name collision: `gfs-controller` package vs GFS deployments

| Name | What it is |
| --- | --- |
| `gfs-controller/` | Host npm package. T1 `npm test` lives here. |
| `gfs/gfsc-writer`, `gfs/gfsc-reader` | Cluster Deployments. T2 Ready precondition. |
| `gfs/gfs-controller-db` | Secret; DSN probe execs into **control-api**. |

Ready cluster ≠ host `node_modules`. Missing vitest ≠ writer CrashLoop.

### 10. Codex SQL / MiniMax seed is not the T1 red

Migration order `0099` < `00a0–00a3` (Codex) < `0100_seed_minimax_allowed_model`
is required and is **not** the pool-leak or vitest-missing failure. Do not
revert Codex SQL to "fix" T1. Product invariants stay: materializer
`WHERE enabled AND NOT (provider = 'codex-subscription' AND stale)`; host
save for Codex broker-backed omits `secretRef`; `exchangeDeviceCode` success
is `{ kind: 'ok'; parsed: ParsedCodexToken }`.

## GFS restore pointers (high level, no secrets)

GFS T1 real-Postgres coverage has its own gate
(`make test-gfs-real-postgres-minikube`) against the validated branch-owned
profile. Restore/DSN provisioning for `gfs` is ordered by full-setup /
`pre-gate-sync` (it stays fail-closed until `control-api` is Ready — see the
`minikube-deploy-all` note in the Makefile). Do not hand-provision GFS DSNs,
and never copy DSNs or credentials between namespaces or into evidence.

The harness owns NOLOGIN recovery and abandoned-rollout resume: T1 restores
branch-profile GFS credentials on exit, and `pre-gate-sync` **should**
provision serving with `GFS_RESTORE_ACTIVE_NOLOGIN=true` and
`GFS_RECOVER_ABANDONED_STATE=true` in every plan. In the current evenfire
scripts, `provision_gfs_serving` is gated on
`incremental_requires_database_reconcile`; a scripts-only sync can skip it.
Settle Ready-reader leftovers with `settle-gfs-reader-rollout.sh` when that
helper exists. HCC's gfsReconciler strips `restartedAt`, so a
generation-based reader `rollout status` wait can time out; prefer the
readiness poll when `wait-gfs-reader-ready.sh` is present. The
`gfs-rollout-shim` PATH prefix replaces the reader wait with that poll.

## Dual-repo note

This contract belongs to `evenfire-ai/evenfire` only. `evenfire-infra` is a
different repository with different clusters and PR flow. Never point this
harness at an infra cluster, mix PRs across the repos, or present infra
evidence as an evenfire T2 verdict (and vice versa).
