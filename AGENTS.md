# Evenfire repository instructions

## Local Minikube reuse and ownership

Use an existing healthy, branch-owned Minikube profile for successive local
iterations. Do not create a new profile merely because the current commit,
gate, or test command changes. Preserve the verified profile by passing its
explicit `MINIKUBE_PROFILE` value into the next operation.

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

## Incremental local image updates

For a service-only change in an already healthy profile, rebuild and restart
only the affected workload. Prefer the existing targeted path:

```bash
MINIKUBE_PROFILE=<verified-profile> \
  make minikube-deploy-service SVC=<image-selector> NS=<namespace> \
  MINIKUBE_DEPLOYMENT=<deployment>
```

Examples: `control-api` / `control-plane` / `control-api`,
`external-rest-api` / `profiles` / `external-rest-api`, `rpc-proxy` /
`rpc-proxy` / `rpc-proxy`, and `mcp-host` / `mcp-host` / `chatllm`.
`scripts/minikube/build-images.sh --only=<image-selector>` is the underlying
image-only primitive; do not call the all-image builder for a known
single-service change.

Use `make minikube-pre-gate-sync` for a full T2 gate after T1 passes. It owns
the cluster fingerprint, migration ordering, rollout checks, and runtime
marker. It compares the deployed marker to the current worktree, rebuilds only
the known affected image selectors, and restarts only their deployments. A
fresh profile, an explicit forced sync, or an unmapped runtime path must fall
back to the established complete image build. A service-only T2 may use the
targeted path when the profile is already healthy; record it as a *targeted
T2* and prove the affected deployment is Ready plus its user-facing health
endpoint. Do not report that as a full reconcile.

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
make minikube-t2-preflight
make minikube-t2
```

A fresh or uninitialized profile must complete the supported bootstrap before
`pre-gate-sync` is invoked. The preflight refuses to call that sync on an
incomplete profile. Real PostgreSQL suites are opt-in in the ordinary test
matrix, but a T1 run that requires them must fail when the database/DSN is
unavailable or when zero tests execute; a green run must never be produced by
silently skipping the suites.

T0 (static/unit/contract checks), T1 (real PostgreSQL), T2 (validated runtime),
CI, and Control UI/Desktop Playwright are separate evidence lanes. One lane
does not stand in for another. Private operational state, generated ports,
profile metadata, logs, and evidence belong under the ignored
`.local-notes/infra/runs/` path and must never be committed.

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
