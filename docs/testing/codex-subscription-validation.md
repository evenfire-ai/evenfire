# Codex subscription validation

Evidence lanes for `codex-subscription`. One lane does not stand in for another.

## Image input validation (#650)

The shared package tests V1 golden-hash stability and V2 parsing, source identity,
ordered text/image content and local image/envelope budgets. Its
`fixtures/visual-requests.json` contains real 2x2 PNG/JPEG samples;
`fixtures/canonical-request-hashes.v2.json` freezes the new projection separately.
The image parser validates container structure and dimensions, not decoded pixels.

Capacity checks cover the usual 5 / 9 / 14 MiB target and the hard 16 MiB
per-image / 16 MiB aggregate / 24 MiB envelope ceiling, plus the 2048 px
model bound. Exercise 5 MiB, 12 MiB (exceptional, above 10 MiB), 10+5 MiB
and 3x5 MiB acceptance, plus overflow above 16 MiB. V1 and V2 non-image fields keep a 1 MiB ceiling;
unrelated RPC/Host routes keep 6 MiB. The larger proxy parser must not admit an
anonymous, wrong-scope or admin request, or enlarge V1's effective body limit.
Changing these budgets does not change OAuth, grants, ticket binding, origins,
fallback, or connection selection. Local capacity evidence is separate from
successful image interpretation by a real model.

For an already bootstrapped local profile whose required public images are
present, `MINIKUBE_BUILD_IMAGE_ARGS=--skip-public` forwards the existing builder
option through the public Make entry point. This avoids pulling unrelated demo
images during a full source rebuild. Keep the normal image verification and
runtime readiness gates; this option is not a substitute for bootstrap.
When reconciling an existing profile configured through Control UI, use
`MINIKUBE_REAPPLY_INSTANCES=false` to preserve its Host and other bootstrap
instance configuration. This does not skip core manifests, CRDs, image checks,
or readiness. Leave the default enabled for initial bootstrap. Verify the
Host's provider/model/connection binding before and after the update.

Provider tests must cover both completion methods, direct/tool origins, prompt
context, redacted text parts, repeated bytes from distinct tool calls and the
default-disabled model gate. Proxy conformance inspects the final upstream body,
asserts provenance does not become model input, and retains tools/cancel/SSE
checks. Authorizer tests require a pre-commit exact-envelope check; its PostgreSQL
case must prove rollback against a real transaction. A mocked transaction result
does not satisfy that PostgreSQL gate.

Set `CODEX_IMAGE_INPUT_MODELS` consistently on the owned Host/proxy only after
consumer rollout and a separately authorized neutral-image interoperability check.
The default empty list rejects visual input clearly. No test fixture or passing
conformance suite certifies that the real endpoint or selected model sees images.

Keep browser/Electron evidence separate: visible login and Host selection, upload
through Add context / Upload Files, preview, send, correlated task completion and
visible answer. Assert a business signal tied to the submitted image and current
task; an answer saying it saw an image is insufficient. Do not use SDK text-only
journeys or GFS file upload as substitutes for composer image input. Run the E2E
static auditor on changed browser specs and record external prerequisites rather
than silently skipping them.

### Opt-in Desktop image lane

`desktop-app/test/e2e-playwright/codex-image-input.spec.ts` covers direct PNG/JPEG
uploads through the visible composer, including a 5 MiB JPEG, a 12 MiB PNG
(exceptional), a 10+5 MiB pair, three 5 MiB images, and composer refusals over
16 MiB, over 16 MiB total, a fourth image, and a non-PNG/JPEG type. It creates a fresh 64-bit hexadecimal
challenge rendered only into image pixels. Large cases pad that same image so
the answer stays in pixels while the decoded size matches the hop budget. The
filename and prompt do not carry the answer. An enabled run requires that
answer (hexadecimal case is ignored), a non-error response, no tool steps
substituting OCR/loading for direct image input, and no fallback badge.
The selector's stable data attributes verify the actual selected Host, provider
and model. The disabled mode instead requires the explicit capability error.
Composer budget refusals never send.

This is a real upstream lane, not a mock. Before running it, obtain separate
authorization for runtime, upstream access and the existing login fixture's
stored-session reset. Provision the owned Host and consumers first. Set:

- `E2E_CODEX_IMAGE_INPUT=1` and `CODEX_REAL_UPSTREAM_CONFIRM=1` only for that
  authorized run; `E2E_CODEX_ALLOW_SESSION_RESET=1` acknowledges the fixture's
  session reset.
- `E2E_HOST_REF` to the actual owned Host and `E2E_CODEX_HOST_LABEL` to its
  exact visible label in the Agents list; there is no shared-host default.
- `E2E_CODEX_IMAGE_MODEL` and `E2E_CODEX_IMAGE_MODEL_LABEL` to its model ID and
  visible picker label.
- `E2E_CODEX_IMAGE_MODE=enabled` or `disabled`, matching the provisioned
  capability gate. Run both modes against their appropriate configuration;
  the test does not change deployments or grants.

Install Host dependencies as well as Desktop dependencies: the neutral challenge
uses the existing Host canvas dependency. Node 24 and `verify:electron` remain
mandatory. After loading the approved branch-owned service URLs and prerequisites,
the command from `desktop-app` is:

```bash
node node_modules/@playwright/test/cli.js test \
  --config test/e2e-playwright/playwright.codex-image.config.ts --project codex-image-input
```

The normal Desktop project excludes this spec. Its dedicated config rejects
missing authority, Host/model identity or mode before global setup; it cannot
return a successful all-skipped run. The model ID must be the canonical ID
returned by the runtime, not an alias. Static audit/typecheck and local challenge-image
decoding do not count as browser or real-upstream execution. Typed tool-result
images remain a separate integration/runtime journey; this direct-input test
does not certify GFS producers or retained image history.

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
