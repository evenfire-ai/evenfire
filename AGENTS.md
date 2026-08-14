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
