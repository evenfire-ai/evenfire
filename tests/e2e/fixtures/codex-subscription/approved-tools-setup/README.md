# Owned Minikube setup for Codex approved tools

The deterministic setup uses a separate Control API image with a guarded external
OAuth provider fixture. It creates fresh test identities with parameterized transactional SQL and the
existing audit adapter, without changing the production OAuth implementation.
The browser still performs login, consent, connector approvals, subscription
binding and execution. Hermetic lifecycle checks alone do not certify that journey.

The fixture requires `NODE_ENV=test`, `EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE=1`,
a fresh `APPROVED_TOOLS_RUN_ID`, matching branch-owned `MINIKUBE_PROFILE` and
`CONTROL_API_REAL_PG_CONTEXT`, and the pod's `KUBERNETES_SERVICE_HOST`. Preparation
waits for the fixture API rollout and checks its live process marker against the
run, profile, deployment UID and fixture image before creating or cleaning identities.

## Entry points

All commands use the verified `MINIKUBE_PROFILE`, matching explicit
`CONTROL_API_REAL_PG_CONTEXT` and the canonical branch mutation lease. Use Node24.

1. `make minikube-build-codex-approved-tools-fixtures` builds the normal Control API and Codex proxy, their deterministic fixture
   variants, the MCP fixture, the custom-coordinator SDK base, and the
   approved-tools workflow variant.
   Fixture tags do not replace production image tags. Run before reconcile
   because image acquisition updates the manifest timestamp. Preparation checks
   the live image IDs, each image's recorded source revision, and all three derived
   base-image bindings before changing cluster resources.
2. Complete the supported profile reconcile and exact-HEAD validation sequence.
3. `make minikube-run-codex-approved-tools` prepares isolated resources, runs the
   visible Playwright runner and restores the original proxy and Control API images/environments.
   It can be the required Playwright command inside T2 after image acquisition.
4. Alternatively, `make minikube-prepare-codex-approved-tools` leaves the fixture
   active for investigation. Use `make minikube-restore-codex-approved-tools` with
   the same evidence directory to restore the recorded API/proxy and stop only this
   run's owned forwards.

Required environment: `APPROVED_TOOLS_CANONICAL_ROOT`, fresh existing child
directory `APPROVED_TOOLS_EVIDENCE_DIR` under canonical `.local-notes/infra/runs`,
`APPROVED_TOOLS_UPSTREAM_MODE=deterministic`, existing admin login variables
`TEST_ADMIN_USERNAME`/`TEST_ADMIN_PASSWORD`, isolated member and unauthorized-user passwords
`TEST_USER_PASSWORD`/`APPROVED_TOOLS_UNAUTHORIZED_PASSWORD`, and the owned Control UI/REST/RPC URLs
required by the Playwright runner. Preparation assigns fresh `${run}@example.test` and `${run}-unauthorized@example.test`
identities to both setup and the runner. Credentials stay in the process environment
and stdin; never put them in scenario metadata, logs or command arguments.

The normal Minikube overlay already enables the Control API, proxy and Host Codex
feature gates. Preparation checks effective running Control API/proxy flags and
the Host config map, and refuses disabled/stale workloads. Apply the supported
overlay/reconcile if those preconditions fail; preparation does not weaken gates.

The four Contexts start with empty connector lists. Hosts have an unassigned
Codex subscription and no fallback provider. McpServer CRDs are available but
not granted; HCC builds their deployments and network boundaries. Server dry-run
and creation roundtrip check that fields survive the installed CRD schemas.

Additional fixture ports are randomly allocated once per fresh run, persisted in
its metadata, and registered with `port-forward-owner.sh` in the profile's owned
PID directory. A collision fails; no port mapping is regenerated. Readiness probes
revalidate the same live process identity. Existing profile `ports.env` stays
unchanged. Restoration rejects foreign worktrees, deployments, images and
fixture-run markers. A later commit in the same owned worktree is recorded in
the restoration audit; it does not prevent cleanup of verified owned forwards.
Both deployment updates check the live object version and run marker. Original
API image, pull policy and only affected environment keys are captured and
validated for restoration before the first mutation. A refused proxy
restore still attempts owned-forward cleanup and never reports restored=true.

Scenario metadata is written to `scenarios.json` and passed directly to the runner
in `run` mode. It contains no credentials. State records retain only fixture
identity, ports, original image/pull policies and the affected, validated non-sensitive environment values.
Created Kubernetes resources are journaled individually with their server UID
and version. Restoration deletes them in dependency order after checking the
current run labels and UID, using UID/version preconditions. Ambiguous creation
and legacy journals fail closed and require explicit recovery; they are never
deleted by name alone. Each visible subscription creation first reserves `created-connection-<scenario>.json`
in the owned evidence directory. Its optional page callback records only the public
response ID, connection key, display name and creator metadata, bound to the run,
profile, scenario and fixture user, in a flushed `0600` file before subsequent
assertions. It never records credentials. Restoration validates and incorporates
those captures into the identity journal; exact repeated entries are idempotent,
while pending, replaced, foreign or conflicting captures block identity cleanup.
The fixture user binding identifies the run; it does not claim that the fixture
user created the administrative connection (`createdBy` is null). Real mode uses
its existing connection and never opens a capture file.

After owned resources are removed, identity cleanup runs while the fixture API
is still active. Recorded subscriptions are revoked through the normal connection
service, preserving tombstones and audit history. After the database transaction,
the existing allowlist writer must successfully publish the updated runtime
ConfigMap before cleanup reports success. A publication failure remains
recoverable even when the database deletion already committed.
The original API is restored and awaited even if another cleanup
step fails. On a later restore, pending identity cleanup may temporarily reinstall
the fixture only when the live API UID, original image, pull policy and affected
environment still match the recorded snapshot and resource cleanup is complete.
The reinstall uses the current resource version and the same run binding, waits
for Ready and verifies the live marker. Cleanup then retries, and the original API
is restored again even if that attempt fails. Completed identity cleanup does not
reinstall the fixture. A failed resource, identity, deployment or forward cleanup prevents
`restored=true`; its recorded evidence must be resolved before another run.

Real subscription tests do not use this synthetic prepare path. They require the
separately approved account/preconditions and production proxy image. Refusing
real mode here prevents accidental account use and prevents presenting a fake
upstream result as real-subscription evidence.
