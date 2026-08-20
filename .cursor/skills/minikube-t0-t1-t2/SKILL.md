---
name: minikube-t0-t1-t2
description: >-
  Certifies local Minikube T0/T1/T2 lanes for Evenfire. Use when the user asks
  to run, close, or certify T0, T1, T2, "cierra T2", minikube-t2, preflight,
  pre-gate-sync, Real PostgreSQL, or whether a run counts as a T2 verdict; also
  when diagnosing vitest command not found, too many clients already,
  authentication probe unavailable, PROFILE_UNHEALTHY on gfsc-writer/reader,
  hookTimeout CREATE DATABASE, or leftover Vitest JSON reporter exits.
---

# Minikube T0/T1/T2 certification workflow

This is the ONLY supported way to certify the local runtime lanes. It is
development-only, runs against the branch-owned Minikube profile, and produces
a T2 verdict solely through the final exact-head preflight inside the
orchestrator (`T2_PLAN_MODE=false`, plan state `already-synced`).

Anti-patterns, stable codes, and the **observed failure catalog** (host
`vitest` missing vs GFS CrashLoop, `pg` pool leak, GFS leftover after
`images=none`, full-reconcile Postgres overload): see `reference.md`.
Deep contract: `docs/testing/minikube-t2-runbook.md`.

## Step 0 — Preconditions checklist

Before running anything, verify ALL of these:

- [ ] Clean development branch descended from current `origin/dev`
      (`git status --porcelain` empty of unexpected changes; not a protected
      branch).
- [ ] Identify the branch-owned `MINIKUBE_PROFILE` for THIS worktree. Reuse it.
      Do NOT create a new profile because HEAD, gate, or command changed.
- [ ] Confirm the profile is not owned by another active branch/worktree. If
      ownership is ambiguous, stop and use a dedicated profile instead.
- [ ] Every `kubectl` you run manually uses `--context=<owned profile>`.
      Never change the global kubectl current-context.
- [ ] Never read `~/.cache/clerum/minikube-profiles/` directly (HARD DENY —
      it holds private profile state). The harness reads it for you.
- [ ] `gfs/gfsc-writer` AND `gfs/gfsc-reader` are Ready on the owned context.
      T2 preflight fail-louds `PROFILE_UNHEALTHY` if either is not. Do not
      start T2, create a new profile, or reset a PVC to “fix” GFS.
- [ ] `control-postgres` AND `control-api` are Ready before any GFS restore.
      The DSN probe is `kubectl exec` into control-api; a CrashLooping API
      yields `authentication probe unavailable` and must refuse mutation.
- [ ] Host Vitest exists in every package T1 / pre-gate will `npm test`:
      `test -x control-api/node_modules/.bin/vitest` and
      `test -x gfs-controller/node_modules/.bin/vitest` (and any
      `run_if_changed` package). Cluster Ready ≠ host `node_modules`.
- [ ] Do not pass global `ARGS='--skip-port-forwards'` into `make minikube-t2`.
      Hold UI PFs in `branch-profile-pf`. Inner pre-gate-sync may skip PFs.

## Step 1 — Plan (read-only)

```bash
make minikube-t2-preflight MINIKUBE_PROFILE=<owned-profile>
```

This is a planner, NOT a lane. `T2_PREFLIGHT_PASS` is NOT a T2 verdict.
It prints `transition=<state>`; use that in the decision tree below. On an
unbootstrapped profile it fails loud with `BOOTSTRAP_REQUIRED` — that is
expected, not an error to work around.

## Step 2 — Decision tree

```text
transition = already-synced AND T0+T1 already green on this exact HEAD?
  └── yes → make minikube-t2-runtime MINIKUBE_PROFILE=<owned-profile>
            (T2-only close; refused unless marker matches HEAD)
  └── no  → make minikube-t2 MINIKUBE_PROFILE=<owned-profile>
            (full: T0 → bootstrap/reconcile/targeted-sync → T1 → T2 verdict)

transition = full-bootstrap (fresh/uninitialized profile)?
  └── make minikube-t2 runs the supported bootstrap itself
      (its internal planner uses T2_PLAN_MODE=true so full-bootstrap is
      reachable; IMAGE_SOURCE=local is enforced by the orchestrator).

transition = full-reconcile (deploy/* or charts/* changed, OR a required
             deployment is unready on a bootstrapped profile)?
  └── make minikube-t2. Never downgrade an infra change to a
      service-only restart. An unready deployment is repaired inside the
      run (planner full-reconcile + pre-gate GFS restore, including resume
      of an abandoned `gfsc-reader` rollout claim), not by a manual
      script between runs.

transition = targeted-sync (service-only diff)?
  └── make minikube-t2 performs the targeted deploy; record it as a
      targeted sync, never as a full reconcile.
```

Rules that override any shortcut idea:

- T0 and T1 green on the SAME HEAD is the only justification for
  `minikube-t2-runtime`. Do not re-run the full `make minikube-t2` just to
  "close T2" in that situation — use the runtime target **when the Makefile
  defines it**. If `minikube-t2-runtime` is absent, closing T2 is still
  `make minikube-t2`. A `scripts/e2e/*` diff vs `origin/dev` stays
  `full-reconcile` (all-image rebuild); that load can restart Postgres
  (1s `pg_isready` liveness) and fail T1 `CREATE DATABASE` on hookTimeout.
- Never set `T2_RUN_T0=false` / `T2_RUN_T1=false` by hand to skip a lane that
  was not certified on this HEAD; the harness refuses it unless the plan is
  `already-synced`, and evidence must show the earlier green runs.

## Step 3 — T1 specifics (Real PostgreSQL)

T1 runs inside `make minikube-t2`, or explicitly via
`make minikube-t2-real-postgres MINIKUBE_PROFILE=<owned-profile>`.

- T1 is fail-loud: an unavailable DSN, an isolated server that did not start,
  or zero executed tests is FAIL. Never report green from skipped suites. The
  JSON reporter is the suite verdict; a leftover Vitest process exit after a
  complete green reporter is not a failed suite.
- Role-reset suites (cluster-global role drop/rewrite) run against a
  throwaway `postgres:16-alpine`, never the shared `control-postgres`.
- The admin DSN is resolved in-process from the cluster Secret; never print,
  export, or persist it.
- T1 restores branch-profile GFS credentials on exit (canonical
  `reconcile-gfs-deploy-credentials.sh` with `GFS_RESTORE_ACTIVE_NOLOGIN=true`,
  same as the GFS T1 gate), so a T1 run cannot leave `gfsc-reader` NOLOGIN
  and poison the T2 preflight. Do not run that restore by hand. T2
  full-reconcile reaches `full-setup.sh` before pre-gate-sync; that REUSE_DB
  path must pass the same opt-in on both GFS reconcile calls.
- Every harness GFS reconcile first settles Ready-reader leftovers
  (`settle-gfs-reader-rollout.sh`: leftover claim, stale non-current
  ReplicaSets, CrashLoopBackOff pods) and runs with the `gfs-rollout-shim`
  PATH prefix, which replaces the reader `rollout status` wait with the
  readiness poll in `wait-gfs-reader-ready.sh` — HCC's gfsReconciler strips
  the `restartedAt` annotation, so a generation-based wait times out.

## Step 4 — Verdict and evidence reporting

A run is T2 ONLY when the orchestrator prints:

```text
MINIKUBE_T2_PASS
T0=PASS|SKIPPED
T1=PASS|SKIPPED
T2=PASS
Playwright=PASS|NOT_RUN
evidence=<path under .local-notes/infra/runs/>
```

Report to the user exactly these lane statuses plus HEAD, profile, and the
evidence path. `SKIPPED` is legitimate only for T0/T1 previously green on the
same HEAD (say so explicitly). Optional user-facing checks are opt-in:
`T2_HEALTHCHECK_COMMAND`, `T2_PLAYWRIGHT_COMMAND`
(`T2_REQUIRE_PLAYWRIGHT=true` refuses a missing journey).

Evidence stays under the ignored `.local-notes/infra/runs/`. Never commit it.
Before committing anything else, run `make minikube-t2-public-boundary`.

## Step 5 — On failure

Failures print a stable code and a next safe command. Repair the FIRST
reported precondition and re-run the same entry point on the same HEAD.
Do not widen the command, switch clusters, reset PVCs, or delete locks with a
live owner. Match the log string in `reference.md` before touching GFS.

| Signature | First action |
| --- | --- |
| `sh: vitest: command not found` | `npm ci` in that **host** package. Not a Deployment. |
| `too many clients already` / PF `ECONNREFUSED` | Isolated T1 processes; do not raise `max_connections`. |
| leftover Vitest exit after green JSON | Suite PASS; JSON reporter is the verdict. |
| `hookTimeout` + `CREATE DATABASE` | Wait postgres + control-api Ready; T1 only; then T2. |
| `authentication probe unavailable` | Wait control-api Ready, then GFS restore opt-ins. |
| `Pre-gate cluster sync complete` + GFS 0/1 | `images=none` skipped restore; `reference.md` item 6. |
| `PORT_FORWARD_CONFLICT` after T1 PASS | T1 leftover `control-postgres` PF not in `/tmp/pf-<profile>-*.pid`. Not a foreign worktree. Do not kill `branch-profile-pf`. |
| `rollout status` 0 but Ready 0/1 | Trust Ready columns, not the previous exit code. |
| `REAL_PG_SUITE_FAILED` + Codex SQL guess | Codex migrations are not the T1 red. See catalog. |

### GFS writer/reader leftover (recurrent T2 blocker)

`Pre-gate cluster sync complete` is not proof that GFS is Ready. In this
worktree `provision_gfs_serving` runs only when
`incremental_requires_database_reconcile` is true; a scripts-only sync
(`images=none`) skips restore. A prior T1 that exhausted
`control-postgres` (`too many clients already` → dead port-forward) can
leave `gfsc-writer` CrashLoopBackOff and `gfsc-reader` 0/0, and the GFS
DSN probe (`kubectl exec` into Ready `control-api`) then reports
`authentication probe unavailable`.

Once `control-postgres` and `control-api` are Ready on the **same**
profile, restore serving and wait **both** deployments:

```bash
GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true \
CONTEXT=<owned-profile> \
bash deploy/scripts/reconcile-gfs-deploy-credentials.sh
kubectl --context=<owned-profile> -n gfs rollout status deployment/gfsc-writer --timeout=180s
kubectl --context=<owned-profile> -n gfs rollout status deployment/gfsc-reader --timeout=180s
```

Do not create a new profile. Then re-run `make minikube-t2` on the same
HEAD. Full explanations: `reference.md` items 5–6. Prevent recurrence: T1
runs one Vitest process per Real PostgreSQL file.
