# Owned Minikube setup for Codex approved tools

The setup source for synthetic subscription consent (`seed.mjs`) is currently
blocked by the local content-control hook. It is deliberately absent. The
prepare command checks that file before any cluster mutation; this harness
must not be reported as runnable or certified until the blocked source is
reviewed and installed. No runtime, account or E2E success is implied by the
hermetic manifest tests.

The intended seed uses existing Control API services to create a fresh Desktop
user/team, encrypted synthetic subscription consent, and the real proxy catalog
sync. It must not approve connectors, bind subscriptions to Hosts or manufacture
business results. Those actions belong to the visible browser journey.

## Entry points

All commands use the verified `MINIKUBE_PROFILE`, matching explicit
`CONTROL_API_REAL_PG_CONTEXT` and the canonical branch mutation lease. Use Node24.

1. `make minikube-build-codex-approved-tools-fixtures` performs five image builds:
   the normal Codex proxy, the deterministic proxy fixture, the MCP fixture,
   the custom-coordinator SDK base, and the approved-tools workflow variant.
   Fixture tags do not replace production image tags. Run before reconcile
   because image acquisition updates the manifest timestamp.
2. Complete the supported profile reconcile and exact-HEAD validation sequence.
3. `make minikube-run-codex-approved-tools` prepares isolated resources, runs the
   visible Playwright runner and restores the original proxy image/environment.
   It can be the required Playwright command inside T2 after image acquisition.
4. Alternatively, `make minikube-prepare-codex-approved-tools` leaves the fixture
   active for investigation. Use `make minikube-restore-codex-approved-tools` with
   the same evidence directory to restore the recorded proxy and stop only this
   run's owned forwards.

Required environment: `APPROVED_TOOLS_CANONICAL_ROOT`, fresh existing child
directory `APPROVED_TOOLS_EVIDENCE_DIR` under canonical `.local-notes/infra/runs`,
`APPROVED_TOOLS_UPSTREAM_MODE=deterministic`, existing admin login variables
`TEST_ADMIN_USERNAME`/`TEST_ADMIN_PASSWORD`, fresh isolated member
`TEST_USER_EMAIL`/`TEST_USER_PASSWORD`, and the owned Control UI/REST/RPC URLs
required by the Playwright runner. Credentials stay in the process environment
and stdin; never put them in scenario metadata, logs or command arguments.

The normal Minikube overlay already enables the Control API, proxy and Host Codex
feature gates. Preparation checks effective running Control API/proxy flags and
the Host config map, and refuses disabled/stale workloads. Apply the supported
overlay/reconcile if those preconditions fail; preparation does not weaken gates.

The three Contexts start with empty connector lists. Hosts have an unassigned
Codex subscription and no fallback provider. McpServer CRDs are available but
not granted; HCC builds their deployments and network boundaries. Server dry-run
and creation roundtrip check that fields survive the installed CRD schemas.

Additional fixture ports are randomly allocated once per fresh run, persisted in
its metadata, and registered with `port-forward-owner.sh` in the profile's owned
PID directory. A collision fails; no port mapping is regenerated. Readiness probes
revalidate the same live process identity. Existing profile `ports.env` stays
unchanged. Restoration rejects foreign worktrees, HEADs, deployments and images.

Scenario metadata is written to `scenarios.json` and passed directly to the runner
in `run` mode. It contains no credentials. State records retain only fixture
identity, ports, original image/pull policy and the non-sensitive NODE_ENV value.
Created CRDs and synthetic database fixtures remain available for diagnosis;
cleanup must explicitly target the listed run-owned resources and seed rows.

Real subscription tests do not use this synthetic prepare path. They require the
separately approved account/preconditions and production proxy image. Refusing
real mode here prevents accidental account use and prevents presenting a fake
upstream result as real-subscription evidence.
