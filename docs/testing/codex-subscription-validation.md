# Codex subscription validation

Evidence lanes for `codex-subscription`. One lane does not stand in for another.

## Lanes

- **T0** — unit, schema, hash, contracts, typecheck, lint, build. The
  aggregator is `make test-codex-subscription-t0`. It fails when a required
  suite is missing, executes zero tests, reports skipped/todo cases, or
  exits non-zero. Flag-off compatibility still uses `make test-unit-all`,
  `make test-contracts`, and `make build-preflight`.
- **T1** — real PostgreSQL. `CONTROL_API_REAL_PG_REQUIRED=1`. A missing DSN,
  skipped suite, or zero tests is FAIL.
- **Manifest** — Kustomize, images, ServiceAccount/RBAC, secrets, gateways,
  NetworkPolicy. No cluster.
- **T2** — exact-HEAD on a branch-owned Minikube profile. Full reconcile for
  this change (CRDs, manifests, policies, image matrix).
- **Browser/Electron** — visible login and journeys. Node 24 and
  `npm run verify:electron` first.
- **Upstream real** — opt-in only with `CODEX_REAL_UPSTREAM_CONFIRM=1` and an
  approved account. Never satisfied by a mock.
- **Load/compromise** — limits, backpressure, cancel, and contained pivot probes.

## Freeze fixture

`tests/e2e/fixtures/codex-subscription/sanitized-upstream-contract.json` and
`docs/architecture/codex-subscription-transport-contract.md` are the Phase 0
contract. The freeze test is
`tests/e2e/integration/codex-subscription-contract-freeze.test.ts`.

## Commands

```bash
make test-codex-subscription-t0

cd tests/e2e
npm test -- --run integration/codex-subscription-contract-freeze.test.ts
```

Live upstream is the Playwright connection lane (`codex-subscription-connection.spec.ts`)
against a signed-in Control UI. There is no standalone
`e2e-codex-subscription-real-upstream.sh` script.

## Subscription catalog reconciliation cron

`control-api/src/services/subscriptionCatalogSyncCron.ts` re-reads both
subscription catalogs on an interval, so a model an upstream publishes after a
grant's handshake reaches the runtime allowlist without an operator pressing
anything. It is off by default: `SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED` and
`SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS` in
`deploy/base/control-plane/configmaps.yaml` carry the deployment's choice, and
the interval has a 15-minute floor because each tick costs one upstream call
per connection and a Grok refresh rotates the refresh token.

Two suites, and neither stands in for the other:

- **Unit** — `control-api/src/services/__tests__/subscriptionCatalogSyncCron.test.ts`.
  Owns the tick's decision table against doubles: the advisory lock, the
  broker/status skips, per-connection failure isolation, the `never_synced`
  rule that decides whether the ConfigMap is republished, and the first-run
  jitter.
- **T1** — `control-api/test/services.subscriptionCatalogSyncCron.realPostgres.integration.test.ts`,
  under `CONTROL_API_REAL_PG_REQUIRED=1`. Owns what doubles cannot reach:
  rows landing in `grok_catalog_models`, the `grok-subscription` union rebuilt
  in `llm_allowed_models`, a model that vanished upstream stale-flagged in the
  catalog and disabled in the union, and an identical second tick recording a
  fresh outcome without duplicating rows. The grant is created through the
  device flow rather than by writing credential rows, so the tick's own
  refresh-token rotation runs against a fingerprint it can match. Only xAI's
  HTTP endpoints and the Kubernetes ConfigMap writer are doubled.

Run the T1 suite the way the lane does, against a real PostgreSQL 16:

```bash
cd control-api && CONTROL_API_REAL_PG_ADMIN_URL="$DSN" CONTROL_API_REAL_PG_REQUIRED=1 npx vitest run --no-file-parallelism --maxWorkers=1 realPostgres
```

## On-demand catalog re-sync

The same re-read is available to an operator from the grant modal's **Sync catalog**
button. Three lanes own three different claims about it, and none substitutes for
another.

- **Proxy, hermetic** — `codex-llm-proxy/test/runtimePath.hermetic.e2e.test.ts`,
  describe `hermetic catalog re-read`. Owns "the re-read returns a model the upstream
  published after the handshake". This is the **only** place in the repository where that
  is provable: `CODEX_CATALOG_ORIGIN` is frozen in `codex-llm-proxy/src/originPolicy.ts`
  as part of the SSRF boundary, and the in-process `fetchFn`/`lookup` seam in that file is
  the one thing that redirects it at the fixture. The fixture serves a second model when
  `CODEX_TEST_UPSTREAM_EXTRA_MODEL` is set; unset keeps the single-model reply every other
  case expects. The fixture's `models` counter is the liveness witness.
- **T1** — the cron suite above. Owns the rows and the union allowlist.
- **Control UI Playwright** —
  `tests/e2e/playwright/control-ui/codex-subscription-catalog-resync.spec.ts`. Owns the
  affordance and the operator's verdict: the button exists on a connected grant and
  nowhere else, the click issues exactly one `POST .../catalog/sync`, a 200 advances
  `catalogRevision`, and the modal ends on a success toast or a non-empty error banner
  rather than a spinner. **It cannot prove a new model appears**: that lane deploys no
  fake upstream, so the grant talks to the frozen origin.

## Plugin Workload SDK Desktop lanes

Three Desktop/Electron journeys exercise `codex-subscription` through the
Plugin Workload SDK. Each has its own spec and its own Make target, because
their preconditions are mutually exclusive. None of them starts Minikube or
creates grants — the T2/T3 profile lane must have provisioned those already.

### Happy path

```bash
E2E_PLUGIN_SDK_WRITE_CONFIRM=1 \
E2E_PLUGIN_SDK_EXPECT_PROVIDER=codex-subscription \
CONTROL_UI_BASE_URL=http://127.0.0.1:<random-control-ui-port> \
CONTROL_API_BASE_URL=http://127.0.0.1:<random-control-api-port> \
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<random-external-rest-port> \
RPC_PROXY_BASE_URL=http://127.0.0.1:<random-rpc-port> \
KUBECONTEXT=<branch-profile-context> \
make test-e2e-plugin-workload-sdk-desktop
```

`E2E_PLUGIN_SDK_EXPECT_PROVIDER` is **mandatory and has no default**. It
declares which provider the run is meant to exercise, and the precondition
asserts the live recipe declares exactly that one. Without it the spec used to
accept `openai`, `claude` or `codex-subscription` and skip its Codex assertions
when the recipe was not Codex — so a run against the OpenAI recipe that
`seed-e2e-data.sh` provisions by default went green while proving nothing about
Codex. Declare the provider you intend to evidence; a mismatch now fails the
precondition instead of quietly narrowing the run.

### No-grant guard lane

`plugin-workload-sdk-no-grant-guard.spec.ts` is the regression test for the
symptom of issue #533: a Codex recipe whose execution binding is missing must
report `awaiting_policy`, never `validated`. It is mutually exclusive with the
happy path — that one requires the recipe to reach `validated`, this one
requires it not to.

```bash
E2E_PLUGIN_SDK_WRITE_CONFIRM=1 \
E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME=<codex-recipe-without-binding> \
E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE=<its-app-title> \
CONTROL_UI_BASE_URL=http://127.0.0.1:<random-control-ui-port> \
CONTROL_API_BASE_URL=http://127.0.0.1:<random-control-api-port> \
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<random-external-rest-port> \
RPC_PROXY_BASE_URL=http://127.0.0.1:<random-rpc-port> \
KUBECONTEXT=<branch-profile-context> \
make test-e2e-plugin-workload-sdk-desktop-no-grant
```

Both variables above are **mandatory**: the spec has no default recipe and fails
loudly when either is missing, and it refuses to run against the happy path's
recipe even if pointed at it. `E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAMESPACE` is the
one optional knob and defaults to `sandbox-recipes` — set it explicitly when the
ungranted fixture lives elsewhere, or the lane will look for the right recipe
name in the wrong namespace. This target takes no
`E2E_PLUGIN_SDK_EXPECT_PROVIDER`: no provider is supposed to be reached, so
there is none to declare. **Provisioning a Codex recipe with no execution
binding is operator work** — the lane will not create one, and a lane that
cannot find its fixture fails rather than skipping.

### Codex fallback lane

`plugin-workload-sdk-codex-fallback.spec.ts` closes acceptance criterion 8 of
issue #533: a real journey where an eligible Codex failure reaches the
authorized non-Codex fallback. It runs against the **granted** happy-path
recipe, because the fallback needs a working ordered target list.

```bash
E2E_PLUGIN_SDK_WRITE_CONFIRM=1 \
E2E_PLUGIN_SDK_EXPECT_PROVIDER=codex-subscription \
CONTROL_UI_BASE_URL=http://127.0.0.1:<random-control-ui-port> \
CONTROL_API_BASE_URL=http://127.0.0.1:<random-control-api-port> \
EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<random-external-rest-port> \
RPC_PROXY_BASE_URL=http://127.0.0.1:<random-rpc-port> \
KUBECONTEXT=<branch-profile-context> \
make test-e2e-plugin-workload-sdk-desktop-codex-fallback
```

**This lane mutates cluster state.** It scales `control-plane/codex-llm-proxy`
to zero replicas so the primary target fails with a class the failover engine
accepts, then restores it to one. The restore runs twice — in the spec's
`finally` and again in a Make-level `EXIT` trap — and both report loudly on
failure. If you ever see `[E2E-GUARD] FAILED to restore
control-plane/codex-llm-proxy`, restore it before running any other lane on
that profile: every Codex journey after it would fail for the wrong reason.

`E2E_PLUGIN_SDK_EXPECT_PROVIDER` must be exactly `codex-subscription`; the
target rejects any other value, because a non-Codex primary would make the
journey vacuous. The recipe knobs are shared with the happy path and carry
**silent defaults** — `E2E_PLUGIN_SDK_RECIPE_NAME` defaults to
`evenfire-prompt-notify-app`, `E2E_PLUGIN_SDK_RECIPE_NAMESPACE` to
`sandbox-recipes`, and `E2E_PLUGIN_SDK_APP_TITLE` to `Prompt & Notify`. Set
them explicitly whenever your fixture differs, or the lane looks for the wrong
app in the Desktop catalog and fails at the card locator rather than at a
precondition.

The grant must expose **at least two ordered prompt targets**, Codex first and
a non-Codex provider second. The spec asserts that before injecting the fault:
a single-target grant would let the journey pass while proving nothing, so it
fails as a precondition instead.
