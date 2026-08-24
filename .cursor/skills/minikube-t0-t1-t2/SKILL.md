---
name: minikube-t0-t1-t2
description: Certifies local Minikube T0/T1/T2 lanes for the Evenfire repository. Use when the user asks to run, close, or certify T0, T1, T2, "cierra T2", minikube-t2, certification, preflight, pre-gate-sync, Real PostgreSQL suites, or asks whether a run counts as a T2 verdict.
---

# Minikube T0/T1/T2 certification workflow

This is the ONLY supported way to certify the local runtime lanes. It is
development-only, runs against the branch-owned Minikube profile, and produces
a T2 verdict solely through the final exact-head preflight inside the
orchestrator (`T2_PLAN_MODE=false`, plan state `already-synced`).

Anti-patterns and failure codes: see `reference.md` in this skill directory.
Deep contract: `docs/testing/minikube-t2-runbook.md`.

## Step 0 — Preconditions checklist

Before running anything, verify ALL of these:

- [ ] Clean development branch descended from current `origin/dev`
      (`git status --porcelain` empty of unexpected changes; not a protected
      branch).
- [ ] Identify the branch-owned `MINIKUBE_PROFILE` for THIS worktree. Reuse it.
      Do NOT create a new profile because HEAD, gate, or command changed.
      Resolve it with the primary checkout `.local-notes/minikube-profiles/branch.mk`;
      profile identity is stable for canonical worktree + branch, while the
      pre-gate marker—not a profile-name SHA—proves exact-HEAD freshness. The
      marker must also match the image manifest's exact `imagesGeneratedAt`
      stamp; a new image acquisition on the same HEAD is not already-synced.
- [ ] Confirm the profile is not owned by another active branch/worktree. If
      ownership is ambiguous, stop and use a dedicated profile instead.
- [ ] Every `kubectl` you run manually uses `--context=<owned profile>`.
      Never change the global kubectl current-context.
- [ ] Docker resolves to a local Unix socket or loopback TCP endpoint. The
      harness pins that endpoint into an empty task-local config; do not use a
      remote Docker context or copy ambient registry credentials into it.
- [ ] Mutating image acquisition/builds use the public Make target/orchestrator
      and inherit its exact profile lease. Do not call `build-images.sh` or
      `pull-images.sh` directly; `--verify-only` is the read-only exception.
- [ ] Never read `~/.cache/clerum/minikube-profiles/` directly (HARD DENY —
      it holds private profile state). The harness reads it for you.

## Step 1 — Plan (read-only)

```bash
MINIKUBE_PROFILE=<owned-profile> CONTROL_API_REAL_PG_CONTEXT=<owned-profile> \
  make minikube-t2-preflight
```

This is a planner, NOT a lane. `T2_PREFLIGHT_PASS` is NOT a T2 verdict.
It prints `transition=<state>`; use that in the decision tree below. On an
unbootstrapped profile it fails loud with `BOOTSTRAP_REQUIRED` — that is
expected, not an error to work around.

## Step 2 — Decision tree

```text
transition = already-synced AND T0+T1 already green on this exact HEAD?
  └── yes → MINIKUBE_PROFILE=<owned-profile> CONTROL_API_REAL_PG_CONTEXT=<owned-profile>
            make minikube-t2-runtime
            (T2-only close; refused unless marker matches HEAD)
  └── no  → MINIKUBE_PROFILE=<owned-profile> CONTROL_API_REAL_PG_CONTEXT=<owned-profile>
            make minikube-t2
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
  "close T2" in that situation — use the runtime target.
- Never set `T2_RUN_T0=false` / `T2_RUN_T1=false` by hand to skip a lane that
  was not certified on this HEAD; the harness refuses it unless the plan is
  `already-synced`, and evidence must show the earlier green runs.

## Step 3 — T1 specifics (Real PostgreSQL)

T1 runs inside `make minikube-t2`, or explicitly via
`MINIKUBE_PROFILE=<owned-profile> CONTROL_API_REAL_PG_CONTEXT=<owned-profile>
make minikube-t2-real-postgres`.

- The orchestrator runs a fast Node/package/Docker preflight before T0. Fix
  that first instead of paying T0/bootstrap cost for a missing local dependency.
  Docker probes, pulls, builds, image loads, Minikube metadata reads, and the
  targeted user-facing health command are bounded and terminate their process
  groups on timeout or interrupt.
- T1 is intentionally serial (`VITEST_MAX_WORKERS=1`, no file parallelism).
  The Real PostgreSQL fixtures and cluster-global roles make wider concurrency
  unsafe, not an optimization.
- T1 is fail-loud: an unavailable DSN, an isolated server that did not start,
  or zero executed tests is FAIL. Never report green from skipped suites. The
  JSON reporter must be complete and green, must identify exactly every
  selected physical file, and the Vitest process must also exit zero; a green
  reporter cannot hide teardown, worker, OOM, signal, or partial-selection
  failure.
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
NP08_HCC_AUTHORIZATION=PASS
Health=PASS|NOT_RUN
Playwright=PASS|NOT_RUN
evidence=<path under .local-notes/infra/runs/>
```

Report to the user exactly these lane statuses plus HEAD, profile, and the
evidence path. `SKIPPED` is legitimate only for T0/T1 previously green on the
same HEAD (say so explicitly). `T2_HEALTHCHECK_COMMAND` is mandatory for
`targeted-sync` and bounded by `T2_HEALTHCHECK_TIMEOUT_SECONDS` (default 120s);
it is optional for other transitions. `T2_PLAYWRIGHT_COMMAND` remains opt-in
(`T2_REQUIRE_PLAYWRIGHT=true` refuses a missing journey).

Evidence stays under the ignored `.local-notes/infra/runs/`. Never commit it.
Before committing anything else, run `make minikube-t2-public-boundary`.

The final exact-head check also rejects a marker whose `imagesGeneratedAt`
does not equal the current image manifest. During REUSE_DB recovery, the
durable fence covers HCC, workflow-recipes, trace-maintenance-worker, and
control-api; a changed HEAD on the same owned lane is historical state, not a
reason to discard recovery evidence.

## Step 5 — On failure

Failures print a stable code and a next safe command. Repair the FIRST
reported precondition on the same HEAD. While debugging T1, use the standalone
Real PostgreSQL target; finish with one full certification run. If T0/T1 lane
evidence is already green and NP08, health, or Playwright fails, retry with
`minikube-t2-runtime` on the same profile instead of repeating T0/T1. NP08 may
observe a newer same-binding access token but must never refresh/reissue or
consume the Host refresh-token lineage.
Do not widen the command, switch clusters, reset PVCs, or delete locks with a
live owner. Code-by-code guidance is in `reference.md`.
