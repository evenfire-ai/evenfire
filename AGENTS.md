# Evenfire repository instructions

## Local Minikube reuse and ownership

Use an existing healthy, branch-owned Minikube profile for successive local
iterations. Do not create a new profile merely because the current commit,
gate, or test command changes. Preserve the verified profile by passing its
explicit `MINIKUBE_PROFILE` value into the next operation.

Resolve that profile through the primary checkout
`.local-notes/minikube-profiles/branch.mk`; do not derive a profile from the
current `HEAD` or invent ports. Profile identity is stable for the canonical
worktree path plus branch, while deployed freshness is owned by the exact
`gitHead` + `worktreeId` + `clusterFingerprint` marker. A creation SHA in
legacy profile metadata is historical, not a reason to allocate another
profile. Reuse the persisted `ports.env` byte-for-byte; missing, corrupt, or
ambiguous ownership metadata must fail closed instead of regenerating ports.

Before reusing a profile, record and compare all of the following:

- active worktree path, branch, `HEAD`, and `origin/dev`;
- target Minikube profile and explicit Kubernetes context;
- the pre-gate state marker: `worktreeId`, `gitHead`, and
  `clusterFingerprint`;
- profile status and currently running profile, pre-gate-sync, and
  port-forward processes.

Reusing a profile is allowed only when it remains clearly owned by the active
worktree/lane. If it belongs to another active branch or task, or ownership is
ambiguous, do not touch it: use a dedicated profile instead. A fresh profile is
also required when the selected profile is missing or unhealthy. Never use
shared fixed localhost ports for branch-owned profiles; use the profile-owned
random port mapping already recorded for that profile.

Port-forwards are owned by atomic `0600` records bound to the exact profile,
context, canonical worktree, namespace, Service, local/remote ports, PID,
process start time, and `kubectl` argv. Never kill or adopt a live legacy
`/tmp/pf-*.pid` process: it lacks enough provenance and must fail closed.

All image builds and targeted deploys must enter through the documented Make
targets or the T2 orchestrator so they inherit the exact live profile mutation
lease. Calling `scripts/minikube/build-images.sh` directly is unsupported for
mutating work; `--verify-only` is the read-only exception. Docker and Minikube
operations must use finite deadlines. Docker endpoint discovery must resolve
to an explicit local Unix socket or loopback TCP endpoint before switching to
an empty task-local Docker config. Ambient registry credentials are never
copied; a private pull requires an explicit `MINIKUBE_DOCKER_AUTH_CONFIG`.

## Incremental local image updates

For a service-only change in an already healthy profile, rebuild and restart
only the affected workload. Prefer the existing targeted path:

```bash
MINIKUBE_PROFILE=<verified-profile> \
  make minikube-deploy-service SVC=<image-selector> NS=<namespace> \
  DEPLOYMENT=<deployment>
```

Examples: `control-api` / `control-plane` / `control-api`,
`external-rest-api` / `profiles` / `external-rest-api`, `rpc-proxy` /
`rpc-proxy` / `rpc-proxy`, and `mcp-host` / `mcp-host` / `chatllm`.
`scripts/minikube/build-images.sh --only=<image-selector>` is the underlying
image-only primitive; do not call the all-image builder for a known
single-service change.

Use `make minikube-pre-gate-sync` to reconcile the owned profile after T1
inputs change. It owns the cluster fingerprint, migration ordering, rollout
checks, and runtime marker. It is not a T2 verdict. It compares the deployed
marker to the current worktree, rebuilds only the known affected image
selectors, and restarts only their deployments. A fresh profile, an explicit
forced sync, or an unmapped runtime path must fall back to the established
complete image build. A service-only update may use the targeted path when the
profile is already healthy; record it as a *targeted sync* and prove the
affected deployment is Ready plus its user-facing health endpoint. Do not
report that as a full reconcile or as T2.

Expect a full reconcile when deployment manifests, CRDs, charts, network
policy, or other infrastructure inputs changed; do not replace that safe path
with partial image updates. Every `kubectl` invocation must use the verified
context explicitly.

## Local Minikube T0/T1/T2 validation contract

The T0/T1/T2 validation tooling is development-only. It must run only from a
clean development branch descended from the current `origin/dev`, against the
branch-owned Minikube profile and its explicit Kubernetes context. It is not a
production, GKE, Cloudflare, staging, shared-cluster, or customer-data
runbook.

Use these canonical entry points:

```text
MINIKUBE_PROFILE=<verified-profile> CONTROL_API_REAL_PG_CONTEXT=<verified-context> make minikube-t2-preflight
MINIKUBE_PROFILE=<verified-profile> CONTROL_API_REAL_PG_CONTEXT=<verified-context> make minikube-t2
MINIKUBE_PROFILE=<verified-profile> CONTROL_API_REAL_PG_CONTEXT=<verified-context> make minikube-t2-runtime
```

`make minikube-t2-preflight` is a cluster-read-only planner; it may write its
ignored local lock/evidence metadata. It is not T0, T1, or T2.
With the default `T2_PLAN_MODE=false` it fails loud on an unbootstrapped
profile and does not call `pre-gate-sync`. `make minikube-t2` is the full
orchestrator: T0, the selected bootstrap/reconcile, T1, then T2. A T2 verdict
is produced only by the final exact-head preflight inside that orchestrator
(`T2_PLAN_MODE=false` with plan state `already-synced`; `T2_PLAN_MODE=true` is
only the internal planner so `full-bootstrap` is reachable).
`make minikube-pre-gate-sync` alone never constitutes T2 evidence.
Follow the rule `.cursor/rules/minikube-t0-t1-t2.mdc` and the skill
`.cursor/skills/minikube-t0-t1-t2/SKILL.md` for the certification workflow.

After T0 and T1 are already green on the same HEAD and owned profile, close
T2 with `make minikube-t2-runtime` (`T2_RUN_T0=false T2_RUN_T1=false`). That
path is valid only when the pre-gate marker already matches HEAD
(`already-synced`). Do not set those flags to skip an uncertified lane.

A fresh or uninitialized profile must complete the supported bootstrap. The
standalone preflight refuses to call `pre-gate-sync` on an incomplete profile;
`make minikube-t2` runs the supported setup when its planner selects
`full-bootstrap`. The single run is self-healing: when a bootstrapped profile
has an unready required deployment, the orchestrator planner selects
`full-reconcile` (naming the deployment) instead of failing
`PROFILE_UNHEALTHY` before a transition exists; the T1 lane restores
branch-profile GFS credentials on exit and `pre-gate-sync` provisions GFS
serving with `GFS_RESTORE_ACTIVE_NOLOGIN=true` and
`GFS_RECOVER_ABANDONED_STATE=true` in the `minikube-t2` transition, so other
security gates do not mutate GFS and no manual repair script belongs between
plan and verdict. Harness GFS reconciles settle
Ready-reader leftovers first (`settle-gfs-reader-rollout.sh`) and wait on
reader readiness through the `gfs-rollout-shim` PATH prefix instead of a
generation-based `rollout status`, because HCC's gfsReconciler strips the
`restartedAt` annotation and makes that wait time out. The standalone preflight and
the final exact-head T2 check stay fail-loud on an unready deployment.
Real PostgreSQL suites are opt-in in the ordinary test
matrix, but a T1 run that requires them must fail when the database/DSN is
unavailable or when zero tests execute; a green run must never be produced by
silently skipping the suites. The JSON reporter must be complete and green,
must identify the exact selected physical files, and the Vitest process must
also exit zero; a green reporter cannot hide a teardown, worker, OOM, signal,
or partial-selection failure. Run the local Node/package/Docker preflight
before expensive T0 work. T1 is serial by safety contract
(`VITEST_MAX_WORKERS=1`, no file parallelism); do not widen it for speed.
Suites that drop or rewrite cluster-global roles must use the harness throwaway
Postgres 16, never the shared `control-postgres`.

NP08 observes the existing Host access-token lineage and may reread a newer,
same-binding persisted access token. It must never consume a refresh token,
call refresh/reissue, or weaken single-use rotation. After T0/T1 have emitted
an exact-head lane attestation, failures in NP08, a user-facing health check, or
Playwright retry through `minikube-t2-runtime`; T1 failures may use the
standalone Real PostgreSQL target while iterating, followed by one full
certification run once green.

T0 (static/unit/contract checks), T1 (real PostgreSQL), T2 (validated runtime),
CI, Control UI/Desktop Playwright, and product E2E scripts such as
`scripts/e2e/e2e-hcc-rollout-readiness.sh` are separate evidence lanes. One
lane does not stand in for another. User-facing health is mandatory and bounded
for a `targeted-sync` transition via `T2_HEALTHCHECK_COMMAND`; it remains
opt-in for bootstrap, full reconcile, and already-synced runs. Playwright is
opt-in via `T2_PLAYWRIGHT_COMMAND` (`T2_REQUIRE_PLAYWRIGHT=true` refuses
`NOT_RUN`). Private operational state,
generated ports, profile metadata, logs, and evidence belong under the ignored
`.local-notes/infra/runs/` path and must never be committed.

## Desktop Electron installation invariant

Electron's `postinstall` downloads the runtime used by Desktop tests and the
local T2 gate. When that script does not run, `npm ci` still exits 0 and the
missing runtime only surfaces later as a test failure that looks like a product
bug. Nothing in `package.json` can force the script to run, so the invariant is
enforced by verification rather than by configuration: `npm run verify:electron`
resolves `require('electron')` and fails when the runtime is absent. Desktop
validation must use Node 24, which is the CI and runtime contract. Do not
install `desktop-app` with `--ignore-scripts`, and do not count a Desktop
test/build result until these checks succeed from `desktop-app`:

```bash
node --version  # must report v24.x
npm run verify:electron
```

If it fails with `Electron failed to install correctly`, the dependency install
is incomplete, not a product failure. Stop the gate, switch to Node 24, remove
only the generated `desktop-app/node_modules/electron` directory, rerun `npm
ci` with lifecycle scripts enabled, and rerun the checks. Do not set
`ELECTRON_SKIP_BINARY_DOWNLOAD`, point
`ELECTRON_OVERRIDE_DIST_PATH` at an unverified binary, or report green evidence
from a missing runtime. A verified local cache may be used only when its
version and checksum are recorded in the run evidence.

## Branch naming

Do not create new branches with agent/vendor prefixes such as `codex/*`,
`claude/*`, `openai/*`, `anthropic/*`, `antrophic/*`, or any other Frontier
Labs reference. Use repository-standard conventional prefixes instead:
`feat/*`, `fix/*`, `hotfix/*`, `chore/*`, `docs/*`, `test/*`, `refactor/*`,
`ci/*`, `build/*`, `perf/*`, or `revert/*`, choosing the one that describes
the change. This rule applies to new branches; it does not retroactively
rewrite branches that already exist outside the task's scope.

## Logging standard

Use structured service logging for production Node.js/runtime code. Pino is
the repository reference implementation: `control-api` already exposes a
redacting root Pino logger and `workspace-files-controller` uses Pino with
`pino-http`. The repository does not use Winston. Other services currently
have local structured adapters (for example, `mcp-host`, HCC, workflow
recipes, and the workflow approval reader); those adapters remain the local
boundary until a separately scoped service migration is approved.

The choice is about the logging contract, not a blanket dependency migration:
structured JSON, explicit levels, contextual fields/child loggers,
`LOG_LEVEL` filtering, and secret-safe redaction. Direct `console.*` calls in
production code bypass those guarantees; in `control-api` they also bypass
Pino's redaction list. Winston or a new ad-hoc logger must not be introduced
to solve a one-file cleanup.

When modifying an individual file:

- In production Node.js code, use the existing logger or structured adapter
  for that service. Do not bypass it with `console.log`, `console.info`,
  `console.warn`, `console.error`, `console.debug`, or `console.trace`.
- Map levels consistently: `log`/`info` → `info`, `warn` → `warn`,
  `error` → `error`, and `debug`/`trace` → the adapter's debug/trace level.
  Pass fields as structured data; pass errors as an error field (for Pino,
  `{ err }`) rather than interpolating them into a string.
- Preserve the service's redaction, correlation, and JSON-output behavior.
  Never log tokens, credentials, authorization headers, DSNs, private URLs,
  cookies, keys, or raw request/response bodies.
- Scope the cleanup to the file already being changed and the minimum import
  or adapter support it needs. Do not sweep neighboring files, start a
  repository-wide migration, or add a second logging convention as collateral
  work.
- Direct `console.*`/`process.stdout` is allowed only inside a logger adapter,
  an explicit CLI/bootstrap path that runs before a logger exists, tests,
  E2E/fixtures, or intentional development-only diagnostics. Do not import a
  server logger into browser/renderer bundles; use their existing client
  logging boundary.
